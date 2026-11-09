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
