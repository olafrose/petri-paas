import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	BuildError,
	buildImage,
	extractZip,
	fetchGitSource,
	type GitFetchOptions,
	SourceError,
} from "@petri/build-engine";
import {
	builds,
	type Database,
	type DeploymentStatus,
	deployments,
} from "@petri/database";
import {
	InvalidTransitionError,
	isBuildStep,
	updateStatus,
} from "@petri/deployment-core";
import type { JobHandler } from "@petri/jobs";
import {
	DockerApiError,
	type DockerRuntime,
	LimitsNotEnforcedError,
	waitForHealthy,
} from "@petri/runtime";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";

export interface DeploymentRunSettings {
	workspaceDir: string;
	logsDir: string;
	uploadsDir: string;
	buildkitHost: string;
	buildctlPath: string;
	/** Set when the worker runs in a container (see WORKER_CONTAINER). */
	workerContainer?: string | undefined;
	buildTimeoutMs?: number;
	health?: { timeoutMs?: number; intervalMs?: number };
	/** For tests: options passed through to the Git fetch. */
	git?: Partial<GitFetchOptions>;
}

/** A step failed for a reason worth showing the owner. */
class StepFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StepFailure";
	}
}

/** Errors whose message is written for the owner. */
function ownerMessage(error: unknown): string | null {
	if (
		error instanceof StepFailure ||
		error instanceof SourceError ||
		error instanceof BuildError ||
		error instanceof LimitsNotEnforcedError
	) {
		return error.message;
	}
	return null;
}

/**
 * Runs one build of a deployment: fetch → build → start → health check →
 * ready. Each step is recorded in the deployment's history. On failure the
 * deployment ends as `failed` with the reason, the build log is kept and
 * whatever this attempt started is removed.
 *
 * If the owner deletes the deployment meanwhile, the next status change is
 * refused and the job stops.
 */
export function deploymentRunHandler(deps: {
	db: Database;
	runtime: DockerRuntime;
	log: Logger;
	settings: DeploymentRunSettings;
}): JobHandler<"deployment.run"> {
	const { db, runtime, settings } = deps;

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
			return;
		}

		const workspace = join(settings.workspaceDir, buildId);
		const source = join(workspace, "source");
		const imageArchive = join(workspace, "image.tar");
		const imageName = `petri/${deploymentId}:${buildId}`;
		const logPath = join(settings.logsDir, `${buildId}.log`);
		let current: DeploymentStatus = "queued";
		const created = { container: false, network: false, image: false };

		await rm(workspace, { recursive: true, force: true });
		await mkdir(source, { recursive: true });
		await mkdir(settings.logsDir, { recursive: true });
		const buildLog = createWriteStream(logPath, { flags: "a", mode: 0o640 });
		const note = (line: string) => buildLog.write(`[petri] ${line}\n`);

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
			await db
				.update(builds)
				.set({ status: "running", startedAt: new Date(), logPath })
				.where(eq(builds.id, buildId));

			if (deployment.source.type === "git") {
				const watch = watchStatus(db, deploymentId, "cloning", job.signal);
				const { commit } = await fetchGitSource({
					repository: deployment.source.repository,
					ref: deployment.source.ref,
					destination: source,
					signal: watch.signal,
					onOutput: note,
					...settings.git,
				}).finally(watch.stop);
				await db.update(builds).set({ commit }).where(eq(builds.id, buildId));
				note(`Fetched ${deployment.source.ref} at ${commit}`);
			} else {
				const archive = join(
					settings.uploadsDir,
					`${deployment.source.uploadId}.zip`,
				);
				const { files } = await extractZip(archive, source);
				note(`Extracted ${files} files`);
			}

			await advance("building", "Building image");
			const watch = watchStatus(db, deploymentId, "building", job.signal);
			await buildImage({
				sourceDir: source,
				directory: deployment.source.directory,
				imageName,
				outputFile: imageArchive,
				buildArgs: deployment.buildOptions.args,
				buildkitHost: settings.buildkitHost,
				buildctlPath: settings.buildctlPath,
				signal: watch.signal,
				...(settings.buildTimeoutMs && { timeoutMs: settings.buildTimeoutMs }),
				onLog: (line) => buildLog.write(`${line}\n`),
			}).finally(watch.stop);
			await db
				.update(builds)
				.set({ provider: "dockerfile" })
				.where(eq(builds.id, buildId));

			await advance("deploying", "Starting the app");
			const imageId = await runtime.loadImage(imageArchive, imageName);
			created.image = true;
			await rm(imageArchive, { force: true });
			const port = await choosePort(
				runtime,
				imageName,
				deployment.internalPort,
				note,
			);
			const network = await runtime.ensureNetwork(deploymentId);
			created.network = true;
			const containerId = await runtime.createContainer({
				deploymentId,
				buildId,
				image: imageName,
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
				settings,
				deploymentId,
				network,
				port,
				job.signal,
			);
			if (!healthy.healthy) {
				const output = await runtime.logs(deploymentId, 50).catch(() => "");
				if (output)
					buildLog.write(`[petri] Last output of the app:\n${output}`);
				throw new StepFailure(healthy.reason);
			}

			await advance("ready", "Ready");
			await db
				.update(builds)
				.set({ status: "succeeded", finishedAt: new Date(), imageId })
				.where(eq(builds.id, buildId));
			log.info("deployment ready");
		} catch (error) {
			await removeCreated(runtime, deploymentId, imageName, created, log);

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
				await db
					.update(builds)
					.set({ status: "cancelled", finishedAt: new Date() })
					.where(eq(builds.id, buildId));
				return;
			}

			const message = ownerMessage(error);
			if (!message)
				log.error({ err: error, step: current }, "deployment step failed");
			const reason =
				message ?? "An internal error occurred; see the worker logs";
			note(`Failed: ${reason}`);
			await db
				.update(builds)
				.set({ status: "failed", finishedAt: new Date(), errorMessage: reason })
				.where(eq(builds.id, buildId));
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
			await new Promise((resolve) => buildLog.end(resolve));
			await rm(workspace, { recursive: true, force: true });
		}
	};
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

/** The configured port, or the one the image declares with EXPOSE. */
async function choosePort(
	runtime: DockerRuntime,
	imageName: string,
	configured: number | null,
	note: (line: string) => void,
): Promise<number> {
	if (configured) return configured;
	const exposed = await runtime.exposedPorts(imageName);
	const [first] = exposed;
	if (first === undefined) {
		throw new StepFailure(
			"No port known: set build.port, or add EXPOSE <port> to the Dockerfile",
		);
	}
	if (exposed.length > 1) {
		note(
			`The image exposes ${exposed.join(", ")}; using ${first} (set build.port to choose)`,
		);
	}
	return first;
}

async function checkHealth(
	runtime: DockerRuntime,
	settings: DeploymentRunSettings,
	deploymentId: string,
	network: string,
	port: number,
	signal: AbortSignal,
) {
	// In a container, the worker must join the app's network to reach it.
	if (settings.workerContainer) {
		await runtime.connect(network, settings.workerContainer);
	}
	try {
		const address = await waitForAddress(runtime, deploymentId, network);
		return await waitForHealthy({
			url: `http://${address}:${port}/`,
			signal,
			...settings.health,
			isRunning: async () => {
				const current = await runtime.inspect(deploymentId);
				return {
					running: current?.running ?? false,
					exitCode: current?.exitCode ?? -1,
					oomKilled: current?.oomKilled ?? false,
				};
			},
		});
	} finally {
		if (settings.workerContainer) {
			await runtime
				.disconnect(network, settings.workerContainer)
				.catch(() => {});
		}
	}
}

/**
 * The app's address on its network. A container that already stopped has
 * none; report why it stopped instead.
 */
async function waitForAddress(
	runtime: DockerRuntime,
	deploymentId: string,
	network: string,
): Promise<string> {
	for (let attempt = 0; attempt < 20; attempt++) {
		const state = await runtime.inspect(deploymentId);
		const address = state?.addresses[network];
		if (state?.running && address) return address;
		if (state && !state.running && state.status !== "created") {
			throw new StepFailure(
				state.oomKilled
					? "The app was stopped for using more memory than allowed"
					: `The app stopped with exit code ${state.exitCode}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new StepFailure("The app's container did not get a network address");
}

async function removeCreated(
	runtime: DockerRuntime,
	deploymentId: string,
	imageName: string,
	created: { container: boolean; network: boolean; image: boolean },
	log: Logger,
) {
	try {
		if (created.container) await runtime.removeContainer(deploymentId);
		if (created.network) await runtime.removeNetwork(deploymentId);
		if (created.image) await runtime.removeImage(imageName);
	} catch (error) {
		// Reconciliation (phase 5) catches leftovers.
		log.warn(
			{ err: error instanceof DockerApiError ? error.message : error },
			"cleanup failed",
		);
	}
}
