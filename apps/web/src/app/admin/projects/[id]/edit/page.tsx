import type { Metadata } from "next";
import {
	ExperimentNumber,
	Hand,
} from "../../../../../components/notebook/index.tsx";
import styles from "../../../dashboard.module.css";
import { loadProject } from "../../load-project.ts";
import { ProjectForm } from "../../project-form.tsx";

export const metadata: Metadata = { title: "Edit experiment" };

export default async function EditProjectPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const { project, deployments } = await loadProject(id);
	// Deleted deployments can't be shown; one already featured stays listed.
	const featuredOptions = deployments
		.filter(
			(d) => d.status !== "deleted" || d.id === project.featuredDeploymentId,
		)
		.map((d) => ({
			id: d.id,
			label: `${d.name} (${d.status.replace("_", " ")})`,
		}));

	return (
		<>
			<p className={styles.soft}>
				<a href="/admin">Experiments</a> /{" "}
				<a href={`/admin/projects/${project.id}`}>{project.name}</a> /
			</p>
			<div className={styles.titleRow}>
				<span className={styles.entryTitle}>
					<ExperimentNumber number={project.number} />
					<Hand as="h1">Edit</Hand>
				</span>
			</div>
			<ProjectForm project={project} featuredOptions={featuredOptions} />
		</>
	);
}
