import type { DeploymentStatus } from "@petri/database";

/*
 * Deployment lifecycle. The worker drives the build path; users trigger
 * actions (stop, start, redeploy, delete); expiry comes from the cleanup
 * job (phase 5).
 *
 *   queued → cloning → building → deploying → health_check → ready
 *      any step ─────────────────────────────────────────→ failed
 *   ready → stopped → deploying (start, no rebuild)
 *   ready | stopped | failed | expired → queued (redeploy)
 *   ready | stopped | failed → expired
 *   anything not yet deleting → deleting → deleted
 */

/** Steps that the deployment job is working on. */
export const ACTIVE_STATUSES = [
	"queued",
	"cloning",
	"building",
	"deploying",
	"health_check",
] as const satisfies readonly DeploymentStatus[];

const BUILD_STEPS = [
	"cloning",
	"building",
	"deploying",
	"health_check",
] as const;

/** Allowed next statuses for each status. Anything else is refused. */
export const TRANSITIONS: Readonly<
	Record<DeploymentStatus, readonly DeploymentStatus[]>
> = {
	queued: ["cloning", "failed", "deleting"],
	cloning: ["building", "failed", "deleting"],
	building: ["deploying", "failed", "deleting"],
	// Also reached from `stopped` when starting without a rebuild.
	deploying: ["health_check", "failed", "deleting"],
	health_check: ["ready", "failed", "deleting"],
	// `failed` here: the container crashed after becoming ready.
	ready: ["stopped", "failed", "queued", "expired", "deleting"],
	stopped: ["deploying", "queued", "expired", "deleting"],
	failed: ["queued", "expired", "deleting"],
	expired: ["queued", "deleting"],
	deleting: ["deleted"],
	deleted: [],
};

export function canTransition(
	from: DeploymentStatus,
	to: DeploymentStatus,
): boolean {
	return TRANSITIONS[from].includes(to);
}

export function isActive(status: DeploymentStatus): boolean {
	return (ACTIVE_STATUSES as readonly DeploymentStatus[]).includes(status);
}

export function isBuildStep(status: DeploymentStatus): boolean {
	return (BUILD_STEPS as readonly DeploymentStatus[]).includes(status);
}

/** What a user can ask for. Each maps to one target status. */
export type DeploymentAction = "stop" | "start" | "redeploy" | "delete";

const ACTION_TARGETS: Readonly<Record<DeploymentAction, DeploymentStatus>> = {
	stop: "stopped",
	start: "deploying",
	redeploy: "queued",
	delete: "deleting",
};

/**
 * Statuses an action is offered from. Narrower than the transition table:
 * e.g. `deploying` is reachable from `queued` paths, but "start" only
 * makes sense for a stopped deployment.
 */
const ACTION_SOURCES: Readonly<
	Record<DeploymentAction, readonly DeploymentStatus[]>
> = {
	stop: ["ready"],
	start: ["stopped"],
	redeploy: ["ready", "stopped", "failed", "expired"],
	delete: [
		"queued",
		"cloning",
		"building",
		"deploying",
		"health_check",
		"ready",
		"stopped",
		"failed",
		"expired",
	],
};

export function actionTarget(action: DeploymentAction): DeploymentStatus {
	return ACTION_TARGETS[action];
}

export function canPerform(
	action: DeploymentAction,
	status: DeploymentStatus,
): boolean {
	return ACTION_SOURCES[action].includes(status);
}

/** Actions to offer for a deployment in this status. */
export function availableActions(status: DeploymentStatus): DeploymentAction[] {
	return (Object.keys(ACTION_SOURCES) as DeploymentAction[]).filter((action) =>
		canPerform(action, status),
	);
}
