import {
	builds,
	type Database,
	type DeploymentStatus,
	deployments,
} from "@petri/database";
import type { PreviewRoute } from "@petri/edge-proxy";
import { networkName } from "@petri/runtime";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import type { EdgeRouting } from "./edge-routing.ts";
import { withDeploymentLock } from "./handlers/deployment-lock.ts";

/**
 * The deployment and start jobs set a route during these statuses, just
 * before `ready`: a sync must not take it away.
 */
const PUBLISHING: readonly DeploymentStatus[] = ["deploying", "health_check"];

export interface SyncResult {
	added: string[];
	removed: string[];
	/** Caddy had lost its settings (it restarted); all routes were loaded. */
	reloaded: boolean;
}

/**
 * Makes the edge proxy route exactly the ready deployments, as recorded
 * in the database. Caddy keeps routes only in memory, so this runs when
 * the worker starts and every few minutes after.
 *
 * Each change re-checks the deployment's status under its lock: a
 * deployment stopped or deleted meanwhile is not routed again.
 */
export async function syncRoutes(
	db: Database,
	edge: EdgeRouting,
	log: Logger,
): Promise<SyncResult> {
	const desired = await readyRoutes(db, edge, log);
	const actual = await edge.proxy.listRoutes();
	const statuses = await statusesOf(
		db,
		actual.map((route) => route.deploymentId),
	);
	const isPublishing = (route: PreviewRoute) =>
		PUBLISHING.includes(statuses.get(route.deploymentId) as DeploymentStatus);
	const result: SyncResult = { added: [], removed: [], reloaded: false };

	const trusted = await edge.proxy.trustedProxies();
	if (!sameSet(trusted, edge.settings.trustedProxies)) {
		await edge.proxy.configure({
			trustedProxies: edge.settings.trustedProxies,
			routes: [
				...desired.values(),
				...actual.filter(
					(route) => !desired.has(route.deploymentId) && isPublishing(route),
				),
			],
		});
		result.reloaded = true;
		result.added = [...desired.keys()].filter(
			(id) => !actual.some((route) => route.deploymentId === id),
		);
	} else {
		for (const [id, route] of desired) {
			const current = actual.find((entry) => entry.deploymentId === id);
			if (current && sameRoute(current, route)) continue;
			const added = await withDeploymentLock(db, id, async (tx) => {
				const [row] = await tx
					.select({ status: deployments.status })
					.from(deployments)
					.where(eq(deployments.id, id));
				if (row?.status !== "ready") return false;
				await edge.proxy.setRoute(route);
				return true;
			});
			if (added) result.added.push(id);
		}
		for (const route of actual) {
			const id = route.deploymentId;
			if (desired.has(id) || isPublishing(route)) continue;
			const removed = await withDeploymentLock(db, id, async (tx) => {
				const [row] = await tx
					.select({ status: deployments.status })
					.from(deployments)
					.where(eq(deployments.id, id));
				if (
					row?.status === "ready" ||
					PUBLISHING.includes(row?.status as DeploymentStatus)
				) {
					return false;
				}
				await edge.unpublish(id);
				return true;
			});
			if (removed) result.removed.push(id);
		}
	}

	// The edge proxy loses its networks if its container is recreated.
	const joined = new Set(await edge.networks());
	for (const id of desired.keys()) {
		if (!joined.has(networkName(id))) await edge.connect(id);
	}

	if (result.reloaded || result.added.length > 0 || result.removed.length > 0) {
		log.info(result, "edge proxy routes synced");
	}
	return result;
}

/** The route every ready deployment should have. */
async function readyRoutes(db: Database, edge: EdgeRouting, log: Logger) {
	// Each ready deployment runs its latest successful build.
	const rows = await db
		.selectDistinctOn([deployments.id], {
			id: deployments.id,
			subdomain: deployments.subdomain,
			buildPort: builds.port,
			configuredPort: deployments.internalPort,
		})
		.from(deployments)
		.innerJoin(builds, eq(builds.deploymentId, deployments.id))
		.where(and(eq(deployments.status, "ready"), eq(builds.status, "succeeded")))
		.orderBy(deployments.id, desc(builds.createdAt), desc(builds.id));

	const routes = new Map<string, PreviewRoute>();
	for (const row of rows) {
		// Builds from before ports were recorded: the configured port.
		const port = row.buildPort ?? row.configuredPort;
		if (!port) {
			log.warn({ deploymentId: row.id }, "no known port; not routed");
			continue;
		}
		routes.set(row.id, edge.route(row, port));
	}
	return routes;
}

async function statusesOf(db: Database, ids: string[]) {
	if (ids.length === 0) return new Map<string, DeploymentStatus>();
	const rows = await db
		.select({ id: deployments.id, status: deployments.status })
		.from(deployments)
		.where(inArray(deployments.id, ids));
	return new Map(rows.map((row) => [row.id, row.status]));
}

function sameSet(a: string[], b: string[]) {
	return a.length === b.length && a.every((entry) => b.includes(entry));
}

function sameRoute(a: PreviewRoute, b: PreviewRoute) {
	return (
		a.hostname === b.hostname &&
		a.upstream.host === b.upstream.host &&
		a.upstream.port === b.upstream.port
	);
}
