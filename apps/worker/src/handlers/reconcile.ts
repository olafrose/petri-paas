import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	builds,
	type Database,
	type DeploymentStatus,
	deploymentEvents,
	deployments,
	publishEvent,
	type Transaction,
} from "@petri/database";
import { changeStatus } from "@petri/deployment-core";
import { type JobHandler, jobs } from "@petri/jobs";
import {
	containerName,
	type DockerRuntime,
	type ManagedResource,
	networkName,
	nextContainerName,
} from "@petri/runtime";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { EdgeRouting } from "../edge-routing.ts";
import { imageName } from "./app-runtime.ts";
import type { DeploymentActionSettings } from "./deployment-actions.ts";
import { withDeploymentLock } from "./deployment-lock.ts";

/*
 * Repairs what went wrong outside a request, by comparing the database
 * with Docker:
 *
 * - A build step that has lasted longer than its job can live: the
 *   worker died during it. The culture fails ("interrupted"); a new batch
 *   next to a ready culture fails, and the ready version stays.
 * - A ready culture whose container is gone, or was found not running at
 *   two runs in a row (it crashed for good, or keeps restarting), fails,
 *   with the app's last output in its history. Two runs, because right
 *   after a host restart Docker may not have started the apps yet.
 * - Containers, networks and images that no culture should have are
 *   removed: leftovers of a cleanup step that failed.
 *
 * Every change is written to the culture's history. Resources of
 * cultures this database doesn't know are left alone: on a development
 * machine, tests and end-to-end runs share Docker with databases of
 * their own.
 */

/** Longest a build step lasts: as long as its job can live (30 minutes). */
export const STUCK_AFTER_MS =
	jobs["deployment.run"].queue.expireInSeconds * 1000;

/** Statuses the deployment and start jobs work through. */
const BUILD_STEPS = [
	"cloning",
	"building",
	"deploying",
	"health_check",
] as const satisfies readonly DeploymentStatus[];

/** Their resources belong to the delete or expiry job. */
const GONE: readonly DeploymentStatus[] = ["expired", "deleted"];

interface Deps {
	db: Database;
	runtime: DockerRuntime;
	edge: EdgeRouting;
	log: Logger;
	settings: Pick<DeploymentActionSettings, "workerContainer" | "logsDir"> & {
		workspaceDir: string;
	};
}

/** What one run remembers for the next. */
export interface ReconcileMemory {
	/** Ready cultures whose app was not running at the last run. */
	down: Set<string>;
}

export interface ReconcileResult {
	/** Failed in a build step the worker didn't finish. */
	interrupted: string[];
	/** Whose new batch, next to the ready version, was interrupted. */
	interruptedBatches: string[];
	/** Ready, but their app is gone or not running. */
	crashed: string[];
	/** Not running at this run; failed if still so at the next. */
	down: string[];
	/** Containers, networks and images removed as leftovers. */
	removed: string[];
	/** Cultures with resources in Docker that the database doesn't know. */
	unknown: string[];
	/** Cultures whose repair failed; the next run tries again. */
	errors: string[];
}

export const newMemory = (): ReconcileMemory => ({ down: new Set() });

export function deploymentReconcileHandler(
	deps: Deps,
): JobHandler<"deployment.reconcile"> {
	const memory = newMemory();
	return async () => {
		const result = await reconcile(deps, memory);
		const changed = Object.entries(result).some(
			([key, ids]) => key !== "unknown" && ids.length > 0,
		);
		if (changed) deps.log.info(result, "reconciled");
	};
}

export async function reconcile(
	deps: Deps,
	memory: ReconcileMemory,
	now = new Date(),
): Promise<ReconcileResult> {
	const result: ReconcileResult = {
		interrupted: [],
		interruptedBatches: [],
		crashed: [],
		down: [],
		removed: [],
		unknown: [],
		errors: [],
	};
	const attempt = async (id: string, work: () => Promise<void>) => {
		try {
			await work();
		} catch (error) {
			deps.log.warn({ err: error, deploymentId: id }, "reconciling failed");
			result.errors.push(id);
		}
	};

	const cutoff = new Date(now.getTime() - STUCK_AFTER_MS);
	for (const id of await stuckCultures(deps.db, cutoff)) {
		await attempt(id, async () => {
			if (await interrupt(deps, id, cutoff)) result.interrupted.push(id);
		});
	}
	for (const build of await stuckBuilds(deps.db, cutoff)) {
		await attempt(build.deploymentId, async () => {
			if (await interruptBatch(deps, build.id, build.deploymentId, cutoff)) {
				result.interruptedBatches.push(build.deploymentId);
			}
		});
	}

	const ready = await deps.db
		.select({ id: deployments.id })
		.from(deployments)
		.where(eq(deployments.status, "ready"));
	for (const id of memory.down) {
		if (!ready.some((row) => row.id === id)) memory.down.delete(id);
	}
	for (const { id } of ready) {
		await attempt(id, async () => {
			const found = await checkApp(deps, memory, id);
			if (found === "crashed") result.crashed.push(id);
			if (found === "down") result.down.push(id);
		});
	}

	const resources = await listResources(deps.runtime);
	const known = await deps.db
		.select({ id: deployments.id })
		.from(deployments)
		.where(
			resources.size > 0
				? inArray(deployments.id, [...resources.keys()])
				: sql`false`,
		);
	for (const [id, owned] of resources) {
		if (!known.some((row) => row.id === id)) {
			result.unknown.push(id);
			continue;
		}
		await attempt(id, async () => {
			result.removed.push(...(await removeLeftovers(deps, id, owned)));
		});
	}
	return result;
}

/**
 * In a build step since before `cutoff`. The step's start is the
 * culture's last status change.
 */
function stuckSince(cutoff: Date) {
	return and(
		inArray(deployments.status, BUILD_STEPS),
		lt(
			sql`coalesce((select max(${deploymentEvents.createdAt}) from ${deploymentEvents} where ${deploymentEvents.deploymentId} = ${deployments.id} and ${deploymentEvents.type} = 'status'), ${deployments.updatedAt})`,
			cutoff.toISOString(),
		),
	);
}

async function stuckCultures(db: Database, cutoff: Date) {
	const rows = await db
		.select({ id: deployments.id })
		.from(deployments)
		.where(stuckSince(cutoff));
	return rows.map((row) => row.id);
}

/** Running since before `cutoff`, next to a culture that isn't building. */
async function stuckBuilds(db: Database, cutoff: Date) {
	return db
		.select({ id: builds.id, deploymentId: builds.deploymentId })
		.from(builds)
		.innerJoin(deployments, eq(deployments.id, builds.deploymentId))
		.where(
			and(
				eq(builds.status, "running"),
				lt(builds.startedAt, cutoff),
				eq(deployments.status, "ready"),
			),
		);
}

/**
 * The worker died during a build step: the culture fails. A container it
 * started stays, stopped (as after a failed start); a redeploy replaces
 * it.
 */
async function interrupt(deps: Deps, id: string, cutoff: Date) {
	const { db, runtime } = deps;
	return withDeploymentLock(db, id, async (tx) => {
		const [row] = await tx
			.select({ status: deployments.status })
			.from(deployments)
			.where(and(eq(deployments.id, id), stuckSince(cutoff)));
		if (!row) return false;
		const step = row.status;
		const unfinished = await failUnfinishedBuilds(tx, id, step);
		await changeStatus(tx, id, "failed", {
			message: `Interrupted: the worker stopped during "${step}". Redeploy to grow it again`,
			data: { step, interrupted: true },
			expectedFrom: [step],
		});
		if (step === "deploying" || step === "health_check") {
			await runtime.stop(id, 2);
		}
		await removeWorkspaces(deps, unfinished);
		return true;
	});
}

/**
 * The worker died while growing a new batch next to a ready culture: the
 * batch fails, the ready version keeps answering.
 */
async function interruptBatch(
	deps: Deps,
	buildId: string,
	id: string,
	cutoff: Date,
) {
	const { db, runtime } = deps;
	return withDeploymentLock(db, id, async (tx) => {
		const [row] = await tx
			.select({ id: builds.id })
			.from(builds)
			.innerJoin(deployments, eq(deployments.id, builds.deploymentId))
			.where(
				and(
					eq(builds.id, buildId),
					eq(builds.status, "running"),
					lt(builds.startedAt, cutoff),
					eq(deployments.status, "ready"),
				),
			);
		if (!row) return false;
		const unfinished = await failUnfinishedBuilds(tx, id, "a new batch");
		await runtime.removeContainerNamed(nextContainerName(id));
		await runtime.removeImage(imageName(id, buildId));
		await record(tx, id, {
			message:
				"New batch interrupted: the worker stopped. The current one keeps answering",
			data: { buildId, failed: true, interrupted: true },
		});
		await removeWorkspaces(deps, unfinished);
		return true;
	});
}

/** Marks the culture's queued and running builds failed; returns them. */
async function failUnfinishedBuilds(
	tx: Transaction,
	id: string,
	during: string,
) {
	const failed = await tx
		.update(builds)
		.set({
			status: "failed",
			errorMessage: "Interrupted: the worker stopped",
			finishedAt: new Date(),
		})
		.where(
			and(
				eq(builds.deploymentId, id),
				inArray(builds.status, ["queued", "running"]),
			),
		)
		.returning({ id: builds.id, logPath: builds.logPath });
	for (const build of failed) {
		if (!build.logPath) continue;
		await appendFile(
			build.logPath,
			`[petri] Failed: interrupted, the worker stopped during ${during}\n`,
		).catch(() => {});
	}
	return failed;
}

async function removeWorkspaces(deps: Deps, unfinished: { id: string }[]) {
	for (const build of unfinished) {
		await rm(join(deps.settings.workspaceDir, build.id), {
			recursive: true,
			force: true,
		});
	}
}

/**
 * A ready culture's app: gone, or not running at this run and the last,
 * fails it. Returns what was found.
 */
async function checkApp(
	deps: Deps,
	memory: ReconcileMemory,
	id: string,
): Promise<"running" | "down" | "crashed" | null> {
	const { db, runtime, edge } = deps;
	return withDeploymentLock(db, id, async (tx) => {
		const [row] = await tx
			.select({ status: deployments.status })
			.from(deployments)
			.where(eq(deployments.id, id));
		if (row?.status !== "ready") {
			memory.down.delete(id);
			return null;
		}
		const app = await runtime.inspect(id);
		if (app?.status === "running") {
			memory.down.delete(id);
			return "running";
		}
		if (app && !memory.down.has(id)) {
			memory.down.add(id);
			return "down";
		}
		memory.down.delete(id);

		let message: string;
		let output = "";
		if (!app) {
			message = "The app's container is gone. Redeploy to grow it again";
		} else {
			output = await runtime.logs(id, 50).catch(() => "");
			message =
				app.status === "restarting"
					? `The app keeps crashing (restarted ${app.restartCount} times)`
					: app.oomKilled
						? "The app was stopped for using more memory than allowed"
						: `The app stopped with exit code ${app.exitCode}`;
			// No more restarts: it stays stopped, with its output.
			await runtime.stop(id, 2);
		}
		await edge.unpublish(id);
		await changeStatus(tx, id, "failed", {
			message,
			data: {
				crashed: true,
				...(output && { output: lastLines(output, 20) }),
			},
			expectedFrom: ["ready"],
			updates: {
				routeId: null,
				...(!app && { containerId: null }),
			},
		});
		return "crashed";
	});
}

/** The end of the app's output, short enough for a history entry. */
function lastLines(output: string, count: number) {
	return output.trimEnd().split("\n").slice(-count).join("\n").slice(-4000);
}

interface Owned {
	containers: ManagedResource[];
	network: boolean;
	images: ManagedResource[];
}

/** Docker's petri. resources, by culture. */
async function listResources(runtime: DockerRuntime) {
	const [containers, networks, images] = await Promise.all([
		runtime.listContainers(),
		runtime.listNetworks(),
		runtime.listImages(),
	]);
	const byCulture = new Map<string, Owned>();
	const of = (id: string) => {
		let owned = byCulture.get(id);
		if (!owned) {
			owned = { containers: [], network: false, images: [] };
			byCulture.set(id, owned);
		}
		return owned;
	};
	for (const container of containers) {
		of(container.deploymentId).containers.push(container);
	}
	for (const network of networks) {
		if (network.name === networkName(network.deploymentId)) {
			of(network.deploymentId).network = true;
		}
	}
	for (const image of images) of(image.deploymentId).images.push(image);
	return byCulture;
}

/**
 * Removes what the culture shouldn't have, as found again under its
 * lock. An expired or deleted culture has nothing. Any other keeps its
 * container and network, a new batch while a build is unfinished, and
 * the images its containers run or an unfinished build loads.
 */
async function removeLeftovers(deps: Deps, id: string, owned: Owned) {
	const { db, runtime, edge, settings } = deps;
	return withDeploymentLock(db, id, async (tx) => {
		const [row] = await tx
			.select({ status: deployments.status })
			.from(deployments)
			.where(eq(deployments.id, id));
		if (!row || row.status === "deleting") return [];
		const unfinished = await tx
			.select({ id: builds.id })
			.from(builds)
			.where(
				and(
					eq(builds.deploymentId, id),
					inArray(builds.status, ["queued", "running"]),
				),
			);
		const removed: string[] = [];

		if (GONE.includes(row.status)) {
			for (const container of owned.containers) {
				await runtime.removeContainerNamed(container.name);
				removed.push(container.name);
			}
			if (owned.network) {
				// The edge proxy and the worker hold on to the network.
				await edge.unpublish(id);
				if (settings.workerContainer) {
					await runtime
						.disconnect(networkName(id), settings.workerContainer)
						.catch(() => {});
				}
				await runtime.removeNetwork(id);
				removed.push(networkName(id));
			}
			for (const image of owned.images) {
				await runtime.removeImage(image.name);
				removed.push(image.name);
			}
			if (removed.length > 0) {
				await tx
					.update(deployments)
					.set({ containerId: null, imageId: null, routeId: null })
					.where(eq(deployments.id, id));
			}
		} else {
			const next = nextContainerName(id);
			if (
				unfinished.length === 0 &&
				owned.containers.some((container) => container.name === next)
			) {
				await runtime.removeContainerNamed(next);
				removed.push(next);
			}
			// Read again: the containers may have changed since the listing.
			const inUse = new Set<string>();
			for (const name of [containerName(id), next]) {
				const container = await runtime.inspectContainer(name);
				if (container?.buildId) inUse.add(container.buildId);
			}
			for (const build of unfinished) inUse.add(build.id);
			for (const image of owned.images) {
				if (image.buildId && inUse.has(image.buildId)) continue;
				await runtime.removeImage(image.name);
				removed.push(image.name);
			}
		}

		if (removed.length > 0) {
			await record(tx, id, {
				message: `Removed leftovers: ${removed.join(", ")}`,
				data: { removed },
			});
		}
		return removed;
	});
}

/** A history entry for a repair that doesn't change the status. */
async function record(
	tx: Transaction,
	id: string,
	entry: { message: string; data: Record<string, unknown> },
) {
	const [event] = await tx
		.insert(deploymentEvents)
		.values({ deploymentId: id, type: "recovery", ...entry })
		.returning({ id: deploymentEvents.id });
	if (!event) throw new Error("insert returned no row");
	await publishEvent(tx, {
		type: "deployment.recovery",
		deploymentId: id,
		eventId: event.id,
		message: entry.message,
	});
}
