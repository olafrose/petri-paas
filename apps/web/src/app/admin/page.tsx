import { type Deployment, deploymentList, projectList } from "@petri/contracts";
import type { Metadata } from "next";
import { AutoRefresh } from "../../components/auto-refresh.tsx";
import {
	ButtonLink,
	DateStamp,
	ExperimentNumber,
	Hand,
	Label,
	Sketch,
} from "../../components/notebook/index.tsx";
import { apiGet } from "../../lib/api.ts";
import { isActive } from "../../lib/deployments.ts";
import { requestCookie } from "../../lib/session.ts";
import styles from "./dashboard.module.css";
import { DeploymentList, lastChange } from "./deployment-list.tsx";

export const metadata: Metadata = { title: "Lab notebook" };

export default async function ExperimentsPage() {
	const cookie = await requestCookie();
	const options = cookie ? { cookie } : {};
	const [{ items: projects }, { items: deployments }] = await Promise.all([
		apiGet("/api/v1/projects", projectList, options),
		apiGet("/api/v1/deployments", deploymentList, options),
	]);

	// Newest first (as the API lists them); deleted ones only counted.
	const byProject = new Map<string, Deployment[]>();
	for (const deployment of deployments) {
		const list = byProject.get(deployment.projectId) ?? [];
		list.push(deployment);
		byProject.set(deployment.projectId, list);
	}
	const anyActive = deployments.some((d) => isActive(d.status));

	return (
		<>
			<AutoRefresh active={anyActive} />
			<div className={styles.titleRow}>
				<Hand as="h1">Experiments</Hand>
				<span className={styles.titleActions}>
					<ButtonLink variant="secondary" href="/admin/projects/new">
						New experiment
					</ButtonLink>
					<ButtonLink href="/admin/deploy">New deployment</ButtonLink>
				</span>
			</div>

			{projects.length === 0 ? (
				<div className={styles.empty}>
					<Sketch kind="dish" />
					<p>
						No experiments yet. Start one with your{" "}
						<a href="/admin/deploy">first deployment</a>.
					</p>
				</div>
			) : (
				<ul className={styles.entries}>
					{projects.map((project) => {
						const all = byProject.get(project.id) ?? [];
						const shown = all.filter((d) => d.status !== "deleted");
						const deleted = all.length - shown.length;
						return (
							<li key={project.id} className={styles.entry}>
								<div className={styles.entryHead}>
									<span className={styles.entryTitle}>
										<ExperimentNumber number={project.number} />
										<Hand as="h2">
											<a
												className={styles.entryLink}
												href={`/admin/projects/${project.id}`}
											>
												{project.name}
											</a>
										</Hand>
									</span>
									<span className={styles.entryMeta}>
										{project.visibility === "private" && <Label>private</Label>}
										<DateStamp date={lastChange(project, all)} />
									</span>
								</div>
								{project.description && (
									<p className={styles.description}>{project.description}</p>
								)}
								{shown.length === 0 ? (
									<p className={styles.soft}>No running deployments.</p>
								) : (
									<DeploymentList deployments={shown} />
								)}
								{deleted > 0 && (
									<p className={styles.soft}>
										{deleted} deleted deployment{deleted === 1 ? "" : "s"}
									</p>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</>
	);
}
