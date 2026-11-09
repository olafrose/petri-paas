"use client";

import type { Project } from "@petri/contracts";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import {
	Button,
	ButtonLink,
	Field,
} from "../../../components/notebook/index.tsx";
import { apiSend } from "../../../lib/client-api.ts";
import styles from "../dashboard.module.css";

type Visibility = Project["visibility"];

/**
 * Creates a project (no `project`) or edits one. The API validates; its
 * messages appear next to the fields.
 */
export function ProjectForm({
	project,
	featuredOptions = [],
}: {
	project?: Project;
	/** Deployments that can be featured in the gallery (edit only). */
	featuredOptions?: { id: string; label: string }[];
}) {
	const router = useRouter();
	const [visibility, setVisibility] = useState<Visibility>(
		project?.visibility ?? "public",
	);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [fields, setFields] = useState<Record<string, string>>({});

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const text = (name: string) => String(form.get(name) ?? "");
		const values = {
			name: text("name").trim(),
			description: text("description").trim(),
			visibility,
			notes: text("notes"),
		};

		setPending(true);
		setError(null);
		setFields({});
		const result = project
			? await apiSend<Project>("PATCH", `/api/v1/projects/${project.id}`, {
					...values,
					featuredDeploymentId: text("featured") || null,
				})
			: await apiSend<Project>("POST", "/api/v1/projects", {
					...values,
					...(text("slug").trim() && { slug: text("slug").trim() }),
				});
		setPending(false);

		if (result.ok) {
			router.push(`/admin/projects/${result.data.id}`);
			router.refresh();
			return;
		}
		setError(result.message);
		setFields(result.fields);
	}

	return (
		<form className={styles.form} onSubmit={onSubmit} noValidate>
			<Field label="Name" error={fields.name}>
				<input
					name="name"
					defaultValue={project?.name}
					maxLength={100}
					required
				/>
			</Field>
			{!project && (
				<Field
					label="Slug"
					hint="Optional: derived from the name. Used in preview addresses; can't be changed later."
					error={fields.slug}
				>
					<input name="slug" placeholder="e.g. dashboard-concept" />
				</Field>
			)}
			<Field
				label="Description"
				hint="A sentence or two; shown in the gallery"
				error={fields.description}
			>
				<textarea
					name="description"
					rows={2}
					maxLength={500}
					defaultValue={project?.description}
				/>
			</Field>

			<fieldset className={styles.group}>
				<legend>Visibility</legend>
				<label className={styles.radio}>
					<input
						type="radio"
						name="visibility"
						checked={visibility === "public"}
						onChange={() => setVisibility("public")}
					/>
					Public: shown in the gallery
				</label>
				<label className={styles.radio}>
					<input
						type="radio"
						name="visibility"
						checked={visibility === "private"}
						onChange={() => setVisibility("private")}
					/>
					Private: not in the gallery
				</label>
				<span className={styles.soft}>
					Either way, preview addresses work for anyone who knows them.
				</span>
				{fields.visibility && (
					<span className={styles.error}>{fields.visibility}</span>
				)}
			</fieldset>

			{project && (
				<Field
					label="Featured deployment"
					hint="The one the gallery shows, while it is ready"
					error={fields.featuredDeploymentId}
				>
					<select
						name="featured"
						defaultValue={project.featuredDeploymentId ?? ""}
					>
						<option value="">None</option>
						{featuredOptions.map((option) => (
							<option key={option.id} value={option.id}>
								{option.label}
							</option>
						))}
					</select>
				</Field>
			)}

			<Field
				label="Notes"
				hint="Markdown. Only you see them; they never reach the gallery."
				error={fields.notes}
			>
				<textarea
					name="notes"
					rows={12}
					defaultValue={project?.notes}
					className={styles.mono}
				/>
			</Field>

			{error && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
			<div className={styles.actions}>
				<Button type="submit" disabled={pending}>
					{pending ? "Saving…" : project ? "Save" : "Create experiment"}
				</Button>
				<ButtonLink
					variant="secondary"
					href={project ? `/admin/projects/${project.id}` : "/admin"}
				>
					Cancel
				</ButtonLink>
			</div>
		</form>
	);
}
