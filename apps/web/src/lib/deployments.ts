import type { Deployment, DeploymentStatus } from "@petri/contracts";

/** Statuses in which the deployment is still changing by itself. */
const ACTIVE: readonly DeploymentStatus[] = [
	"queued",
	"cloning",
	"building",
	"deploying",
	"health_check",
	"deleting",
];

export const isActive = (status: DeploymentStatus) => ACTIVE.includes(status);

/** Where the source came from, in a few words. */
export function sourceLabel(deployment: Deployment): string {
	const { source } = deployment;
	if (source.type === "zip") return "ZIP upload";
	const repository = source.repository
		.replace(/^https:\/\//, "")
		.replace(/\.git$/, "");
	return `${repository} @ ${source.ref}`;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long a temporary deployment has left, e.g. "2 days", "5 hours",
 * "40 minutes"; null for a permanent one or one that can't expire any
 * more (expired, being deleted).
 */
export function timeLeft(
	deployment: Pick<Deployment, "expiresAt" | "status">,
	now = Date.now(),
): string | null {
	if (!deployment.expiresAt) return null;
	if (["expired", "deleting", "deleted"].includes(deployment.status)) {
		return null;
	}
	const ms = Date.parse(deployment.expiresAt) - now;
	if (ms <= 0) return "moments";
	const plural = (n: number, unit: string) =>
		`${n} ${unit}${n === 1 ? "" : "s"}`;
	// Rounded: just extended by 48 hours reads "48 hours", not 47.
	if (ms >= 48 * HOUR_MS) return plural(Math.round(ms / (24 * HOUR_MS)), "day");
	if (ms >= HOUR_MS) return plural(Math.round(ms / HOUR_MS), "hour");
	return plural(Math.max(1, Math.round(ms / 60_000)), "minute");
}

/** Expires within a day: worth a mark in lists. */
export function expiresSoon(
	deployment: Pick<Deployment, "expiresAt" | "status">,
	now = Date.now(),
): boolean {
	return (
		timeLeft(deployment, now) !== null &&
		Date.parse(deployment.expiresAt as string) - now < 24 * HOUR_MS
	);
}
