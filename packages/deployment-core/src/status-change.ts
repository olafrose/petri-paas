import {
	type Database,
	type DeploymentStatus,
	deploymentEvents,
	deployments,
	publishEvent,
	type Transaction,
	withTransaction,
} from "@petri/database";
import { eq } from "drizzle-orm";
import { canTransition } from "./state-machine.ts";

export class DeploymentNotFoundError extends Error {
	readonly deploymentId: string;

	constructor(deploymentId: string) {
		super(`Deployment ${deploymentId} not found`);
		this.name = "DeploymentNotFoundError";
		this.deploymentId = deploymentId;
	}
}

export class InvalidTransitionError extends Error {
	readonly from: DeploymentStatus;
	readonly to: DeploymentStatus;

	constructor(from: DeploymentStatus, to: DeploymentStatus) {
		super(`A deployment cannot go from "${from}" to "${to}"`);
		this.name = "InvalidTransitionError";
		this.from = from;
		this.to = to;
	}
}

/** Columns that may change together with the status. */
export type DeploymentUpdates = Partial<
	Pick<
		typeof deployments.$inferInsert,
		"imageId" | "containerId" | "routeId" | "expiresAt"
	>
>;

export interface StatusChange {
	/** Shown in the deployment's history, e.g. "Build failed: …". */
	message: string;
	/** Extra details for the history entry. Never put secrets here. */
	data?: Record<string, unknown>;
	/**
	 * Apply only if the deployment is currently in one of these statuses.
	 * Guards against acting on stale information, e.g. a worker finishing
	 * a step after the owner deleted the deployment.
	 */
	expectedFrom?: readonly DeploymentStatus[];
	updates?: DeploymentUpdates;
}

/** Published as a live event after every status change. */
export interface DeploymentStatusEvent {
	type: "deployment.status";
	deploymentId: string;
	projectId: string;
	eventId: number;
	from: DeploymentStatus;
	to: DeploymentStatus;
	message: string;
	[key: string]: unknown;
}

/**
 * The only way to change a deployment's status. In one transaction: locks
 * the deployment, checks the transition, updates it, records a history
 * entry and publishes a live event (delivered on commit).
 */
export async function changeStatus(
	tx: Transaction,
	deploymentId: string,
	to: DeploymentStatus,
	change: StatusChange,
): Promise<DeploymentStatusEvent> {
	const [current] = await tx
		.select({ status: deployments.status, projectId: deployments.projectId })
		.from(deployments)
		.where(eq(deployments.id, deploymentId))
		.for("update");
	if (!current) throw new DeploymentNotFoundError(deploymentId);

	const from = current.status;
	if (change.expectedFrom && !change.expectedFrom.includes(from)) {
		throw new InvalidTransitionError(from, to);
	}
	if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);

	await tx
		.update(deployments)
		.set({ ...change.updates, status: to })
		.where(eq(deployments.id, deploymentId));

	const [event] = await tx
		.insert(deploymentEvents)
		.values({
			deploymentId,
			type: "status",
			message: change.message,
			data: { from, to, ...change.data },
		})
		.returning({ id: deploymentEvents.id });
	if (!event) throw new Error("insert returned no row");

	const published: DeploymentStatusEvent = {
		type: "deployment.status",
		deploymentId,
		projectId: current.projectId,
		eventId: event.id,
		from,
		to,
		message: change.message,
	};
	await publishEvent(tx, published);
	return published;
}

/** `changeStatus` in a transaction of its own. */
export function updateStatus(
	db: Database,
	deploymentId: string,
	to: DeploymentStatus,
	change: StatusChange,
): Promise<DeploymentStatusEvent> {
	return withTransaction(db, (tx) =>
		changeStatus(tx, deploymentId, to, change),
	);
}
