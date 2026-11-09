import { type Deployment, deploymentList, projectList } from "@petri/contracts";
import type { Metadata } from "next";
import { AutoRefresh } from "../../components/auto-refresh.tsx";
import {
	ButtonLink,
	DateStamp,
	Hand,
	Label,
	Sketch,
	StatusStamp,
} from "../../components/notebook/index.tsx";
import { apiGet } from "../../lib/api.ts";
import { isActive, sourceLabel } from "../../lib/deployments.ts";
import { requestCookie } from "../../lib/session.ts";
import styles from "./dashboard.module.css";

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
				<ButtonLink href="/admin/deploy">New deployment</ButtonLink>
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
									<Hand as="h2">{project.name}</Hand>
									<span className={styles.entryMeta}>
										{project.visibility === "private" && <Label>private</Label>}
										<DateStamp date={project.updatedAt} />
									</span>
								</div>
								{project.description && (
									<p className={styles.description}>{project.description}</p>
								)}
								{shown.length === 0 ? (
									<p className={styles.soft}>No running deployments.</p>
								) : (
									<ul className={styles.deployments}>
										{shown.map((deployment) => (
											<li key={deployment.id} className={styles.deployment}>
												<StatusStamp status={deployment.status} />
												<a
													className={styles.deploymentName}
													href={`/admin/deployments/${deployment.id}`}
												>
													{deployment.name}
												</a>
												<span className={styles.source}>
													{sourceLabel(deployment)}
												</span>
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
