import type { Deployment } from "@petri/contracts";
import { StatusStamp } from "../../components/notebook/index.tsx";
import { sourceLabel } from "../../lib/deployments.ts";
import styles from "./dashboard.module.css";

/** A project's deployments: status, name (to its page), source, Open. */
export function DeploymentList({ deployments }: { deployments: Deployment[] }) {
	return (
		<ul className={styles.deployments}>
			{deployments.map((deployment) => (
				<li key={deployment.id} className={styles.deployment}>
					<StatusStamp status={deployment.status} />
					<a
						className={styles.deploymentName}
						href={`/admin/deployments/${deployment.id}`}
					>
						{deployment.name}
					</a>
					<span className={styles.source}>{sourceLabel(deployment)}</span>
					{deployment.status === "ready" && (
						<a
							className={styles.open}
							href={deployment.url}
							target="_blank"
							rel="noopener"
						>
							Open ↗
						</a>
					)}
				</li>
			))}
		</ul>
	);
}

/** When a project last changed: its own fields or any deployment. */
export function lastChange(
	project: { updatedAt: string },
	deployments: Deployment[],
): string {
	return [project.updatedAt, ...deployments.map((d) => d.updatedAt)].reduce(
		(latest, date) => (Date.parse(date) > Date.parse(latest) ? date : latest),
	);
}
