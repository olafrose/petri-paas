import {
	builds,
	type Database,
	type DeploymentStatus,
	deployments,
	type Transaction,
} from "@petri/database";
import { changeStatus } from "@petri/deployment-core";
import type { JobHandler } from "@petri/jobs";
import type { DockerRuntime } from "@petri/runtime";
import {
	and,
	eq,
	inArray,
	isNotNull,
	lte,
	notExists,
	or,
	type SQL,
} from "drizzle-orm";
import type { Logger } from "pino";
import type { EdgeRouting } from "../edge-routing.ts";
import {
	type DeploymentActionSettings,
	removeApp,
} from "./deployment-actions.ts";
import { withDeploymentLock } from "./deployment-lock.ts";

/*
 * Temporary deployments past `expiresAt` become `expired`: first the
 * status, so nothing routes them again, then their container, network
 * and images go. The history, builds, build logs and the uploaded
 * archive stay, so a redeploy can grow them again.
 *
 * Only a deployment at rest expires: one being built, started or
 * deleted, or one growing a new batch next to its ready version, waits
 * for the next run.
 */

/** Statuses a deployment expires from. */
const EXPIRABLE = [
	"ready",
	"stopped",
	"failed",
] as const satisfies readonly DeploymentStatus[];

interface Deps {
	db: Database;
	runtime: DockerRuntime;
	edge: EdgeRouting;
	log: Logger;
	settings: Pick<DeploymentActionSettings, "workerContainer">;
}

export interface ExpiryResult {
	/** Expired in this run. */
	expired: string[];
	/** Whose container, network and images were removed. */
	removed: string[];
	/** Whose removal failed; the next run tries again. */
	failed: string[];
}

export function deploymentExpireHandler(
	deps: Deps,
): JobHandler<"deployment.expire"> {
	return async () => {
		const result = await expireDeployments(deps);
		if (result.expired.length > 0 || result.failed.length > 0) {
			deps.log.info(result, "expired deployments");
		}
	};
}

/**
 * Expires the deployments due at `now`, then removes the apps of expired
 * deployments: those just expired and any an earlier run couldn't finish
 * (their container, image or route is still recorded).
 */
export async function expireDeployments(
	deps: Deps,
	now = new Date(),
): Promise<ExpiryResult> {
	const { db, log } = deps;
	const result: ExpiryResult = { expired: [], removed: [], failed: [] };

	const due = await db
		.select({ id: deployments.id })
		.from(deployments)
		.where(isDue(db, now));
	for (const { id } of due) {
		const expired = await withDeploymentLock(db, id, (tx) =>
			expire(tx, id, now),
		);
		if (expired) result.expired.push(id);
	}

	const leftovers = await db
		.select({ id: deployments.id })
		.from(deployments)
		.where(
			and(
				eq(deployments.status, "expired"),
				or(
					isNotNull(deployments.containerId),
					isNotNull(deployments.imageId),
					isNotNull(deployments.routeId),
				),
			),
		);
	const toRemove = new Set([...result.expired, ...leftovers.map((d) => d.id)]);
	for (const id of toRemove) {
		try {
			const removed = await withDeploymentLock(db, id, (tx) =>
				removeExpired(deps, tx, id),
			);
			if (removed) result.removed.push(id);
		} catch (error) {
			log.warn(
				{ err: error, deploymentId: id },
				"removing an expired app failed",
			);
			result.failed.push(id);
		}
	}
	return result;
}

/** Temporary, past its time, at rest, and no build of it unfinished. */
function isDue(db: Database | Transaction, now: Date): SQL | undefined {
	return and(
		eq(deployments.lifecycleMode, "temporary"),
		lte(deployments.expiresAt, now),
		inArray(deployments.status, EXPIRABLE),
		notExists(
			db
				.select({ id: builds.id })
				.from(builds)
				.where(
					and(
						eq(builds.deploymentId, deployments.id),
						inArray(builds.status, ["queued", "running"]),
					),
				),
		),
	);
}

/**
 * Checked again under the lock, holding the row: the owner may have
 * extended it, or started a redeploy, meanwhile.
 */
async function expire(tx: Transaction, id: string, now: Date) {
	const [row] = await tx
		.select({ expiresAt: deployments.expiresAt })
		.from(deployments)
		.where(and(eq(deployments.id, id), isDue(tx, now)))
		.for("update");
	if (!row?.expiresAt) return false;
	await changeStatus(tx, id, "expired", {
		message: "Expired: its time was up",
		data: { expiresAt: row.expiresAt.toISOString() },
		expectedFrom: EXPIRABLE,
	});
	return true;
}

async function removeExpired(deps: Deps, tx: Transaction, id: string) {
	const [row] = await tx
		.select({ status: deployments.status })
		.from(deployments)
		.where(eq(deployments.id, id));
	// Redeployed or deleted meanwhile: that takes care of it.
	if (row?.status !== "expired") return false;
	await removeApp(deps, tx, id);
	await tx
		.update(deployments)
		.set({ containerId: null, imageId: null, routeId: null })
		.where(eq(deployments.id, id));
	return true;
}
