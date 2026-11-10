import type { Deployment, Project } from "@petri/contracts";
import type { Metadata } from "next";
import { AutoRefresh } from "../../../../components/auto-refresh.tsx";
import {
	ButtonLink,
	DateStamp,
	ExperimentNumber,
	experimentLabel,
	Hand,
	Label,
} from "../../../../components/notebook/index.tsx";
import { Notes } from "../../../../components/notes.tsx";
import { isActive } from "../../../../lib/deployments.ts";
import styles from "../../dashboard.module.css";
import { DeploymentList, lastChange } from "../../deployment-list.tsx";
import { loadProject } from "../load-project.ts";
import { DeleteProject } from "./delete-project.tsx";
import { ProjectImage } from "./project-image.tsx";

export const metadata: Metadata = { title: "Experiment" };

/** Whether, and why (not), the gallery shows the project. */
function galleryNote(project: Project, deployments: Deployment[]) {
	const featured = deployments.find(
		(d) => d.id === project.featuredDeploymentId,
	);
	if (project.visibility === "private") {
		return "Private: not shown in the gallery.";
	}
	if (!featured) {
		return "Not in the gallery yet: choose a featured deployment under Edit.";
	}
	if (featured.status !== "ready") {
		return `Not in the gallery while “${featured.name}” is ${featured.status.replace("_", " ")}.`;
	}
	return `In the gallery, with “${featured.name}”.`;
}

export default async function ProjectPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const { project, deployments } = await loadProject(id);
	const shown = deployments.filter((d) => d.status !== "deleted");
	const deleted = deployments.filter((d) => d.status === "deleted");

	return (
		<>
			<AutoRefresh active={deployments.some((d) => isActive(d.status))} />
			<p className={styles.soft}>
				<a href="/admin">Experiments</a> /
			</p>
			<div className={styles.titleRow}>
				<span className={styles.entryTitle}>
					<ExperimentNumber number={project.number} />
					<Hand as="h1">{project.name}</Hand>
				</span>
				<span className={styles.titleActions}>
					<ButtonLink
						variant="secondary"
						href={`/admin/projects/${project.id}/edit`}
					>
						Edit
					</ButtonLink>
					<ButtonLink href={`/admin/deploy?project=${project.slug}`}>
						New deployment
					</ButtonLink>
				</span>
			</div>

			{project.description && (
				<p className={styles.lead}>{project.description}</p>
			)}
			<dl className={styles.facts}>
				<dt>Visibility</dt>
				<dd>
					<Label>{project.visibility}</Label>{" "}
					<span className={styles.soft}>
						{galleryNote(project, deployments)}
					</span>
				</dd>
				<dt>Slug</dt>
				<dd>
					<code>{project.slug}</code>
				</dd>
				<dt>Started</dt>
				<dd>
					<DateStamp date={project.createdAt} />
				</dd>
				<dt>Last change</dt>
				<dd>
					<DateStamp date={lastChange(project, deployments)} />
				</dd>
			</dl>

			<section className={styles.section}>
				<Hand as="h2">Deployments</Hand>
				{shown.length === 0 ? (
					<p className={styles.soft}>No running deployments.</p>
				) : (
					<DeploymentList deployments={shown} />
				)}
				{deleted.length > 0 && (
					<details className={styles.deleted}>
						<summary>
							{deleted.length} deleted deployment
							{deleted.length === 1 ? "" : "s"} (history kept)
						</summary>
						<DeploymentList deployments={deleted} />
					</details>
				)}
			</section>

			<section className={styles.section}>
				<Hand as="h2">Preview image</Hand>
				<ProjectImage
					projectId={project.id}
					name={project.name}
					image={project.image}
				/>
			</section>

			<section className={styles.section}>
				<Hand as="h2">Notes</Hand>
				{project.notes.trim() ? (
					<Notes markdown={project.notes} />
				) : (
					<p className={styles.soft}>
						No notes yet.{" "}
						<a href={`/admin/projects/${project.id}/edit`}>Add some</a> — only
						you see them.
					</p>
				)}
			</section>

			<section className={styles.section}>
				<DeleteProject
					id={project.id}
					label={`${experimentLabel(project.number)} “${project.name}”`}
					remaining={shown.length}
				/>
			</section>
		</>
	);
}
