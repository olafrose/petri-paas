import type { Database } from "@petri/database";
import type { JobHandler } from "@petri/jobs";
import type { Logger } from "pino";
import type { EdgeRouting } from "../edge-routing.ts";
import { routeReady } from "../route-sync.ts";
import { withDeploymentLock } from "./deployment-lock.ts";

/**
 * Moves a ready deployment's route to its new subdomain. The route is
 * replaced in place (same id), so the old address stops answering in the
 * same step. Under the deployment's lock: a redeploy's switch and the
 * route sync see either the old route or the new one.
 *
 * Not ready: nothing to do. A build or start that will route it reads
 * the subdomain under the same lock.
 */
export function deploymentRouteHandler(deps: {
	db: Database;
	edge: EdgeRouting;
	log: Logger;
}): JobHandler<"deployment.route"> {
	const { db, edge } = deps;

	return async (job) => {
		const { deploymentId } = job.data;
		const log = deps.log.child({ deploymentId });
		const routed = await withDeploymentLock(db, deploymentId, (tx) =>
			routeReady(tx, edge, log, deploymentId),
		);
		log.info({ routed }, routed ? "route moved" : "not ready; not routed");
	};
}
