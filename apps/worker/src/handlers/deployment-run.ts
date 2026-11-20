import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	buildImage,
	extractZip,
	fetchGitSource,
	type GitFetchOptions,
} from "@petri/build-engine";
import {
	builds,
	type Database,
	type DeploymentSource,
	type DeploymentStatus,
	deployments,
} from "@petri/database";
import {
	InvalidTransitionError,
	isBuildStep,
	previewUrl,
	recordBuildEvent,
	updateStatus,
} from "@petri/deployment-core";
import type { JobHandler } from "@petri/jobs";
import {
	containerName,
	DockerApiError,
	type DockerRuntime,
	networkName,
	nextContainerName,
} from "@petri/runtime";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Logger } from "pino";
import type { EdgeRouting } from "../edge-routing.ts";
import {
	imageName as buildImageName,
	checkHealth,
	choosePort,
	type HealthSettings,
	ownerMessage,
	StepFailure,
} from "./app-runtime.ts";
import { withDeploymentLock } from "./deployment-lock.ts";

export interface DeploymentRunSettings extends HealthSettings {
	workspaceDir: string;
	logsDir: string;
	uploadsDir: string;
	buildkitHost: string;
	buildctlPath: string;
	buildTimeoutMs?: number;
	/** For tests: options passed through to the Git fetch. */
	git?: Partial<GitFetchOptions>;
}

interface Deps {
	db: Database;
	runtime: DockerRuntime;
	edge: EdgeRouting;
	log: Logger;
	settings: DeploymentRunSettings;
}

type DeploymentRow = typeof deployments.$inferSelect;

/** One build of a deployment, as both ways of running it need it. */
interface Run extends Deps {
	job: Parameters<JobHandler<"deployment.run">>[0];
	deployment: DeploymentRow;
	buildId: string;
	/** What this build is built from (see `builds.source`). */
	source: DeploymentSource;
}

/** Builds that haven't ended yet. */
const UNFINISHED = ["queued", "running"] as const;

/**
 * Runs one build of a deployment: fetch → build → start → health check →
 * ready. Each step is recorded in the deployment's history.
 *
 * A deployment that isn't running (new, stopped, failed, expired) goes
 * through the build statuses from `queued`; on failure it ends as
 * `failed`. A ready one (a redeploy) stays ready: the new version is
 * built and started next to it and replaces it only once healthy.
 *
 * Either way, a failure keeps the build log and removes whatever this
 * attempt started. If the owner stops or deletes the deployment
 * meanwhile, the job notices and stops.
 */
export function deploymentRunHandler(deps: Deps): JobHandler<"deployment.run"> {
	const { db } = deps;

	return async (job) => {
		const { deploymentId, buildId } = job.data;
		const log = deps.log.child({ deploymentId, buildId });
		const [deployment] = await db
			.select()
			.from(deployments)
			.where(eq(deployments.id, deploymentId));
		if (!deployment) {
			log.info("deployment no longer exists; nothing to do");
			return;
		}
		const [build] = await db
			.select()
			.from(builds)
			.where(eq(builds.id, buildId));
		if (!build) {
			log.info("build no longer exists; nothing to do");
			return;
		}
		const run: Run = {
			...deps,
			log,
			job,
			deployment,
			buildId,
			source: build.source ?? deployment.source,
		};

		if (
			deployment.status === "ready" &&
			(UNFINISHED as readonly string[]).includes(build.status)
		) {
			await runNextToReady(run);
			return;
		}

		let status: DeploymentStatus = deployment.status;
		if (isBuildStep(status)) {
			// An earlier attempt died mid-way (worker restart). Start over.
			await updateStatus(db, deploymentId, "failed", {
				message: `The worker stopped during "${status}"; starting over`,
				expectedFrom: [status],
			});
			await updateStatus(db, deploymentId, "queued", {
				message: "Retrying",
				expectedFrom: ["failed"],
			});
			status = "queued";
		}
		if (status !== "queued") {
			log.info({ status }, "deployment is not queued; nothing to do");
			// E.g. a redeploy of a ready deployment that was stopped before
			// its job began.
			await db
				.update(builds)
				.set({ status: "cancelled", finishedAt: new Date() })
				.where(and(eq(builds.id, buildId), inArray(builds.status, UNFINISHED)));
			await removeUnusedUpload(run, deployment.source);
			return;
		}
		await runQueued(run);
	};
}

/**
 * The deployment goes through the build statuses, from `queued` to
 * `ready` or `failed`. An app it ran before (stopped, failed) is replaced
 * when the new one is created.
 */
async function runQueued(run: Run) {
	const { db, runtime, edge, deployment, buildId, log } = run;
	const deploymentId = deployment.id;
	const workspace = await openWorkspace(run);
	const { note } = workspace;
	let current: DeploymentStatus = "queued";
	const created: Created = {
		container: false,
		network: false,
		image: false,
		route: false,
	};

	const advance = async (
		to: DeploymentStatus,
		message: string,
		extra: Parameters<typeof updateStatus>[3] = { message },
	) => {
		await updateStatus(db, deploymentId, to, {
			...extra,
			message,
			expectedFrom: [current],
		});
		current = to;
		note(message);
	};

	try {
		await advance("cloning", "Fetching source");
		await markRunning(run, workspace);
		const fetchWatch = watchStatus(db, deploymentId, "cloning", run.job.signal);
		await fetchSource(run, workspace, fetchWatch.signal).finally(
			fetchWatch.stop,
		);

		await advance("building", "Building image");
		const buildWatch = watchStatus(
			db,
			deploymentId,
			"building",
			run.job.signal,
		);
		await buildFromSource(run, workspace, buildWatch.signal).finally(
			buildWatch.stop,
		);

		await advance("deploying", "Starting the app");
		const { imageId, port } = await loadImage(run, workspace);
		created.image = true;
		const network = await runtime.ensureNetwork(deploymentId);
		created.network = true;
		const containerId = await runtime.createContainer({
			deploymentId,
			buildId,
			image: workspace.imageName,
			network,
		});
		created.container = true;
		await runtime.start(deploymentId);

		await advance(
			"health_check",
			`Waiting for the app to answer on port ${port}`,
			{
				message: "",
				updates: { imageId, containerId },
			},
		);
		const healthy = await checkHealth(
			runtime,
			run.settings,
			containerName(deploymentId),
			network,
			port,
			run.job.signal,
		);
		if (!healthy.healthy) {
			const output = await runtime.logs(deploymentId, 50).catch(() => "");
			if (output) note(`Last output of the app:\n${output}`);
			throw new StepFailure(healthy.reason);
		}

		// Routed only now: a broken app is never reachable.
		await runtime.enableRestarts(deploymentId);
		created.route = true;
		const routeId = await edge.publish(deployment, port);
		const url = previewUrl(edge.settings.previewBaseUrl, deployment.subdomain);
		await advance("ready", `Ready at ${url}`, {
			message: "",
			data: { url },
			updates: { routeId, source: run.source },
		});
		await db
			.update(builds)
			.set({ status: "succeeded", finishedAt: new Date(), imageId })
			.where(eq(builds.id, buildId));
		await removeOldVersions(run);
		log.info("deployment ready");
	} catch (error) {
		await removeCreated(run, workspace.imageName, created);

		const [now] = await db
			.select({ status: deployments.status })
			.from(deployments)
			.where(eq(deployments.id, deploymentId));
		const changedElsewhere =
			error instanceof InvalidTransitionError ||
			(now !== undefined && now.status !== current);
		if (changedElsewhere) {
			// Changed elsewhere, e.g. deleted by the owner. Stop quietly.
			note(`Stopped: the deployment is now "${now?.status ?? "gone"}"`);
			await finishBuild(run, { status: "cancelled" });
			return;
		}

		const reason = failureReason(run, error, current);
		note(`Failed: ${reason}`);
		await finishBuild(run, { status: "failed", errorMessage: reason });
		try {
			await updateStatus(db, deploymentId, "failed", {
				message: reason,
				data: { step: current },
				expectedFrom: [current],
			});
		} catch (statusError) {
			if (!(statusError instanceof InvalidTransitionError)) throw statusError;
		}
	} finally {
		await workspace.close();
	}
}

/**
 * A redeploy of a ready deployment: it stays ready, and the old version
 * keeps answering, while the new one is built and started next to it on
 * its network (`nextContainerName`). Once the new app passes its health
 * check, the route switches to it and the old app is removed; the new
 * one then takes the deployment's container name. A failure removes only
 * the new app.
 *
 * The steps go to the history without changing the status.
 */
async function runNextToReady(run: Run) {
	const { db, runtime, edge, settings, deployment, buildId, log } = run;
	const deploymentId = deployment.id;
	const next = nextContainerName(deploymentId);
	const network = networkName(deploymentId);
	const workspace = await openWorkspace(run);
	const { note } = workspace;
	// Stopping or deleting the deployment cancels the new version.
	const watch = watchStatus(db, deploymentId, "ready", run.job.signal);
	const previousPort = await currentPort(run);
	let step: DeploymentStatus = "cloning";
	const created = { image: false, container: false };
	let routedToNext = false;
	let oldRemoved = false;

	const record = async (
		message: string,
		data: Record<string, unknown> = {},
	) => {
		note(message);
		await recordBuildEvent(db, deploymentId, {
			message,
			data: { buildId, ...data },
		});
	};

	try {
		await markRunning(run, workspace);
		await record("Growing a new batch; the current one keeps answering");
		await record("New batch: fetching source", { step });
		await fetchSource(run, workspace, watch.signal);

		step = "building";
		await record("New batch: building image", { step });
		await buildFromSource(run, workspace, watch.signal);

		step = "deploying";
		await record("New batch: starting the app", { step });
		const { imageId, port } = await loadImage(run, workspace);
		created.image = true;
		// The network exists while the deployment is ready; if it was
		// deleted meanwhile, creating the container fails, as it should.
		await runtime.createContainer({
			deploymentId,
			buildId,
			name: next,
			image: workspace.imageName,
			network,
		});
		created.container = true;
		await runtime.startContainer(next);

		step = "health_check";
		await record(`New batch: waiting for the app to answer on port ${port}`, {
			step,
		});
		const healthy = await checkHealth(
			runtime,
			settings,
			next,
			network,
			port,
			watch.signal,
		);
		if (!healthy.healthy) {
			const output = await runtime.logs(deploymentId, 50, next).catch(() => "");
			if (output) note(`Last output of the app:\n${output}`);
			throw new StepFailure(healthy.reason);
		}
		watch.stop();

		// The switch, holding the deployment's lock: a stop, start or
		// delete, and the route sync, wait for it.
		const url = previewUrl(edge.settings.previewBaseUrl, deployment.subdomain);
		await withDeploymentLock(db, deploymentId, async (tx) => {
			const [now] = await tx
				.select({ status: deployments.status })
				.from(deployments)
				.where(eq(deployments.id, deploymentId));
			if (now?.status !== "ready") throw new Cancelled();

			await runtime.enableRestarts(deploymentId, next);
			routedToNext = true;
			await edge.publish(deployment, port, next);
			await runtime.removeContainer(deploymentId);
			oldRemoved = true;
			await runtime.renameContainer(next, containerName(deploymentId));
			const routeId = await edge.publish(deployment, port);
			routedToNext = false;

			const container = await runtime.inspect(deploymentId);
			await tx
				.update(builds)
				.set({ status: "succeeded", finishedAt: new Date(), imageId })
				.where(eq(builds.id, buildId));
			await tx
				.update(deployments)
				.set({
					source: run.source,
					imageId,
					containerId: container?.id ?? null,
					routeId,
				})
				.where(eq(deployments.id, deploymentId));
			await recordBuildEvent(tx, deploymentId, {
				message: `Ready at ${url} with the new batch`,
				data: { buildId, url },
			});
		});
		note("Ready with the new batch");
		await removeOldVersions(run);
		log.info("redeployed");
	} catch (error) {
		if (oldRemoved) {
			// Rare: Docker failed between removing the old app and naming
			// the new one. Rather than guess what runs, start clean.
			await switchFailed(run, workspace, error);
			return;
		}
		if (routedToNext && previousPort) {
			await edge
				.publish(deployment, previousPort)
				.catch((err) => log.warn({ err }, "restoring the route failed"));
		}
		if (created.container) {
			await runtime
				.removeContainerNamed(next)
				.catch((err) => log.warn({ err }, "removing the new app failed"));
		}
		if (created.image) {
			await runtime
				.removeImage(workspace.imageName)
				.catch((err) => log.warn({ err }, "removing the new image failed"));
		}

		const [now] = await db
			.select({ status: deployments.status })
			.from(deployments)
			.where(eq(deployments.id, deploymentId));
		if (error instanceof Cancelled || now?.status !== "ready") {
			const status = now?.status ?? "gone";
			note(`Stopped: the deployment is now "${status}"`);
			await finishBuild(run, { status: "cancelled" });
			await recordBuildEvent(db, deploymentId, {
				message: `New batch cancelled: the culture is now ${status}`,
				data: { buildId },
			});
			return;
		}

		const reason = failureReason(run, error, step);
		note(`Failed: ${reason}`);
		await finishBuild(run, { status: "failed", errorMessage: reason });
		await recordBuildEvent(db, deploymentId, {
			message: `New batch failed: ${reason}. The current one keeps answering`,
			data: { buildId, step, failed: true },
		});
	} finally {
		watch.stop();
		await workspace.close();
	}
}

/** The deployment changed status while its new version was being built. */
class Cancelled extends Error {}

/**
 * The old app is gone and the new one may be half switched: remove both
 * and fail the deployment, so the owner can redeploy from a clean state.
 */
async function switchFailed(run: Run, workspace: Workspace, error: unknown) {
	const { db, runtime, edge, deployment, log } = run;
	const deploymentId = deployment.id;
	log.error({ err: error }, "switching to the new version failed");
	await edge.unpublish(deploymentId).catch(() => {});
	for (const name of [
		containerName(deploymentId),
		nextContainerName(deploymentId),
	]) {
		await runtime.removeContainerNamed(name).catch(() => {});
	}
	await runtime.removeImage(workspace.imageName).catch(() => {});
	const reason = "Switching to the new batch failed; see the worker logs";
	workspace.note(`Failed: ${reason}`);
	await finishBuild(run, { status: "failed", errorMessage: reason });
	try {
		await updateStatus(db, deploymentId, "failed", {
			message: reason,
			data: { step: "deploying", buildId: run.buildId },
			expectedFrom: ["ready"],
			updates: { routeId: null, containerId: null, imageId: null },
		});
	} catch (statusError) {
		if (!(statusError instanceof InvalidTransitionError)) throw statusError;
	}
}

interface Workspace {
	source: string;
	imageArchive: string;
	imageName: string;
	logPath: string;
	note: (line: string) => void;
	write: (text: string) => void;
	close: () => Promise<void>;
}

/** A fresh directory for the build and its log, opened for appending. */
async function openWorkspace(run: Run): Promise<Workspace> {
	const { settings, buildId, deployment } = run;
	const workspace = join(settings.workspaceDir, buildId);
	const source = join(workspace, "source");
	const logPath = join(settings.logsDir, `${buildId}.log`);
	await rm(workspace, { recursive: true, force: true });
	await mkdir(source, { recursive: true });
	await mkdir(settings.logsDir, { recursive: true });
	const buildLog = createWriteStream(logPath, { flags: "a", mode: 0o640 });
	return {
		source,
		imageArchive: join(workspace, "image.tar"),
		imageName: buildImageName(deployment.id, buildId),
		logPath,
		note: (line) => buildLog.write(`[petri] ${line}\n`),
		write: (text) => buildLog.write(text),
		close: async () => {
			await new Promise((resolve) => buildLog.end(resolve));
			await rm(workspace, { recursive: true, force: true });
		},
	};
}

async function markRunning(run: Run, workspace: Workspace) {
	await run.db
		.update(builds)
		.set({
			status: "running",
			startedAt: new Date(),
			logPath: workspace.logPath,
		})
		.where(eq(builds.id, run.buildId));
}

async function fetchSource(
	run: Run,
	workspace: Workspace,
	signal: AbortSignal,
) {
	const { db, source, settings, buildId } = run;
	if (source.type === "git") {
		const { commit } = await fetchGitSource({
			repository: source.repository,
			ref: source.ref,
			destination: workspace.source,
			signal,
			onOutput: workspace.note,
			...settings.git,
		});
		await db.update(builds).set({ commit }).where(eq(builds.id, buildId));
		workspace.note(`Fetched ${source.ref} at ${commit}`);
	} else {
		const archive = join(settings.uploadsDir, `${source.uploadId}.zip`);
		const { files } = await extractZip(archive, workspace.source);
		workspace.note(`Extracted ${files} files`);
	}
}

async function buildFromSource(
	run: Run,
	workspace: Workspace,
	signal: AbortSignal,
) {
	const { db, settings, deployment, source, buildId } = run;
	await buildImage({
		sourceDir: workspace.source,
		directory: source.directory,
		imageName: workspace.imageName,
		outputFile: workspace.imageArchive,
		buildArgs: deployment.buildOptions.args,
		buildkitHost: settings.buildkitHost,
		buildctlPath: settings.buildctlPath,
		signal,
		...(settings.buildTimeoutMs && { timeoutMs: settings.buildTimeoutMs }),
		onLog: (line) => workspace.write(`${line}\n`),
	});
	await db
		.update(builds)
		.set({ provider: "dockerfile" })
		.where(eq(builds.id, buildId));
}

/** Loads the built image into Docker and finds the app's port. */
async function loadImage(run: Run, workspace: Workspace) {
	const { db, runtime, deployment, buildId } = run;
	const imageId = await runtime.loadImage(
		workspace.imageArchive,
		workspace.imageName,
	);
	await rm(workspace.imageArchive, { force: true });
	const port = await choosePort(
		runtime,
		workspace.imageName,
		deployment.internalPort,
		workspace.note,
	);
	await db.update(builds).set({ port }).where(eq(builds.id, buildId));
	return { imageId, port };
}

/** The port the running version answers on, to route back to it. */
async function currentPort(run: Run): Promise<number | null> {
	const [build] = await run.db
		.select({ port: builds.port })
		.from(builds)
		.where(
			and(
				eq(builds.deploymentId, run.deployment.id),
				eq(builds.status, "succeeded"),
			),
		)
		.orderBy(desc(builds.createdAt), desc(builds.id))
		.limit(1);
	return build?.port ?? run.deployment.internalPort;
}

async function finishBuild(
	run: Run,
	result: { status: "failed" | "cancelled"; errorMessage?: string },
) {
	await run.db
		.update(builds)
		.set({ ...result, finishedAt: new Date() })
		.where(eq(builds.id, run.buildId));
	await removeUnusedUpload(run, run.deployment.source);
}

function failureReason(run: Run, error: unknown, step: DeploymentStatus) {
	const message = ownerMessage(error);
	if (!message) run.log.error({ err: error, step }, "deployment step failed");
	return message ?? "An internal error occurred; see the worker logs";
}

/**
 * The new version is live: the images of earlier builds and an archive
 * it replaced are no longer needed.
 */
async function removeOldVersions(run: Run) {
	const { db, runtime, deployment, buildId, log } = run;
	try {
		const older = await db
			.select({ id: builds.id })
			.from(builds)
			.where(
				and(
					eq(builds.deploymentId, deployment.id),
					eq(builds.status, "succeeded"),
					ne(builds.id, buildId),
				),
			);
		for (const build of older) {
			await runtime.removeImage(buildImageName(deployment.id, build.id));
		}
		await removeUnusedUpload(run, run.source, deployment.source);
	} catch (error) {
		// The reconciliation job (reconcile.ts) removes leftovers.
		log.warn({ err: error }, "removing the old version failed");
	}
}

/**
 * Removes the archive of `unused` unless it is the one `kept` (by
 * default: this build's archive, unless the deployment still uses it).
 */
async function removeUnusedUpload(
	run: Run,
	kept: DeploymentSource,
	unused: DeploymentSource = run.source,
) {
	if (unused.type !== "zip") return;
	if (kept.type === "zip" && kept.uploadId === unused.uploadId) return;
	await rm(join(run.settings.uploadsDir, `${unused.uploadId}.zip`), {
		force: true,
	});
}

/**
 * Aborts when the deployment leaves the given status (e.g. the owner
 * deleted it), so a long fetch or build stops early instead of running to
 * the end. Call `stop()` when the step is done.
 */
function watchStatus(
	db: Database,
	deploymentId: string,
	expected: DeploymentStatus,
	parent: AbortSignal,
	intervalMs = 2000,
) {
	const controller = new AbortController();
	const timer = setInterval(async () => {
		const [row] = await db
			.select({ status: deployments.status })
			.from(deployments)
			.where(eq(deployments.id, deploymentId))
			.catch(() => []);
		if (row && row.status !== expected) controller.abort();
	}, intervalMs);
	return {
		signal: AbortSignal.any([parent, controller.signal]),
		stop: () => clearInterval(timer),
	};
}

/** What this attempt created, so a failure removes exactly that. */
interface Created {
	container: boolean;
	network: boolean;
	image: boolean;
	route: boolean;
}

async function removeCreated(run: Run, imageName: string, created: Created) {
	const { runtime, edge, deployment, log } = run;
	try {
		// First: the edge proxy on the network keeps it from being removed.
		if (created.route) await edge.unpublish(deployment.id);
		if (created.container) await runtime.removeContainer(deployment.id);
		if (created.network) await runtime.removeNetwork(deployment.id);
		if (created.image) await runtime.removeImage(imageName);
	} catch (error) {
		// The reconciliation job (reconcile.ts) removes leftovers.
		log.warn(
			{ err: error instanceof DockerApiError ? error.message : error },
			"cleanup failed",
		);
	}
}
