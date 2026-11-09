"use client";

import type { Deployment } from "@petri/contracts";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button, Field } from "../../../components/notebook/index.tsx";
import { apiSend } from "../../../lib/client-api.ts";
import styles from "../dashboard.module.css";

type Source = "git" | "zip";

/**
 * Deploys from a Git repository or a ZIP archive, with the same settings
 * as the API. The API validates; its messages appear next to the fields.
 */
export function DeployForm({
	projects,
	initialProject,
}: {
	projects: { slug: string; name: string }[];
	initialProject: string;
}) {
	const router = useRouter();
	const [source, setSource] = useState<Source>("git");
	const [mode, setMode] = useState<"temporary" | "permanent">("temporary");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [fields, setFields] = useState<Record<string, string>>({});

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const text = (name: string) => {
			const value = String(form.get(name) ?? "").trim();
			return value === "" ? undefined : value;
		};
		const port = text("port");
		const settings = {
			project: text("project"),
			name: text("name"),
			subdomain: text("subdomain"),
			build: { strategy: "auto", ...(port && { port: Number(port) }) },
			lifecycle:
				mode === "permanent"
					? { mode }
					: { mode, ttlHours: Number(text("ttlHours") ?? 48) },
		};

		setPending(true);
		setError(null);
		setFields({});
		let result: Awaited<ReturnType<typeof apiSend<Deployment>>>;
		if (source === "git") {
			result = await apiSend<Deployment>("POST", "/api/v1/deployments", {
				...settings,
				source: {
					type: "git",
					repository: text("repository"),
					ref: text("ref"),
					...(text("directory") && { directory: text("directory") }),
				},
			});
		} else {
			const archive = form.get("archive");
			if (!(archive instanceof File) || archive.size === 0) {
				setPending(false);
				setFields({ archive: "Choose a ZIP file" });
				return;
			}
			const upload = new FormData();
			upload.set(
				"settings",
				JSON.stringify({
					...settings,
					...(text("directory") && { directory: text("directory") }),
				}),
			);
			upload.set("archive", archive);
			result = await apiSend<Deployment>(
				"POST",
				"/api/v1/deployments/upload",
				upload,
			);
		}
		setPending(false);

		if (result.ok) {
			router.push(`/admin/deployments/${result.data.id}`);
			return;
		}
		setError(result.message);
		setFields(result.fields);
	}

	// The API reports field paths like "source.repository" or "project".
	const fieldError = (...paths: string[]) =>
		paths.map((path) => fields[path]).find(Boolean);

	return (
		<form className={styles.form} onSubmit={onSubmit} noValidate>
			<fieldset className={styles.tabs}>
				<legend className={styles.hidden}>Source</legend>
				<button
					type="button"
					className={styles.tab}
					aria-pressed={source === "git"}
					onClick={() => setSource("git")}
				>
					From Git
				</button>
				<button
					type="button"
					className={styles.tab}
					aria-pressed={source === "zip"}
					onClick={() => setSource("zip")}
				>
					ZIP upload
				</button>
			</fieldset>

			{source === "git" ? (
				<>
					<Field
						label="Repository"
						hint="HTTPS URL of a public Git repository"
						error={fieldError("source.repository", "source")}
					>
						<input
							name="repository"
							type="url"
							placeholder="https://github.com/you/app"
							required
						/>
					</Field>
					<div className={styles.inline}>
						<Field
							label="Branch, tag or commit"
							error={fieldError("source.ref")}
						>
							<input name="ref" defaultValue="main" required />
						</Field>
						<Field
							label="Directory"
							hint="Optional: where the Dockerfile is"
							error={fieldError("source.directory")}
						>
							<input name="directory" placeholder="e.g. app" />
						</Field>
					</div>
				</>
			) : (
				<>
					<Field
						label="ZIP archive"
						hint="Up to 100 MB, with a Dockerfile"
						error={fieldError("archive")}
					>
						<input name="archive" type="file" accept=".zip,application/zip" />
					</Field>
					<Field
						label="Directory"
						hint="Optional: where the Dockerfile is inside the archive"
						error={fieldError("directory")}
					>
						<input name="directory" placeholder="e.g. app" />
					</Field>
				</>
			)}

			<Field
				label="Project"
				hint="Lower case, digits and dashes. A new name creates the project."
				error={fieldError("project")}
			>
				<input
					name="project"
					list="projects"
					defaultValue={initialProject}
					placeholder="e.g. dashboard-concept"
					required
				/>
			</Field>
			<datalist id="projects">
				{projects.map((project) => (
					<option key={project.slug} value={project.slug}>
						{project.name}
					</option>
				))}
			</datalist>

			<div className={styles.inline}>
				<Field
					label="Name"
					hint={
						source === "git" ? "Optional: defaults to the branch" : "Optional"
					}
					error={fieldError("name")}
				>
					<input name="name" />
				</Field>
				<Field
					label="Port"
					hint="Optional: taken from EXPOSE"
					error={fieldError("build.port")}
				>
					<input name="port" type="number" min={1} max={65535} />
				</Field>
			</div>

			<Field
				label="Subdomain"
				hint="Optional: generated from project and name"
				error={fieldError("subdomain")}
			>
				<input name="subdomain" />
			</Field>

			<fieldset className={styles.group}>
				<legend>Lifecycle</legend>
				<label className={styles.radio}>
					<input
						type="radio"
						name="mode"
						checked={mode === "temporary"}
						onChange={() => setMode("temporary")}
					/>
					Temporary, for
					<input
						name="ttlHours"
						type="number"
						min={1}
						max={720}
						defaultValue={48}
						disabled={mode !== "temporary"}
						style={{ width: "5em" }}
					/>
					hours
				</label>
				<label className={styles.radio}>
					<input
						type="radio"
						name="mode"
						checked={mode === "permanent"}
						onChange={() => setMode("permanent")}
					/>
					Permanent
				</label>
				<span className={styles.soft}>
					Temporary deployments are removed automatically once expiry is
					implemented (phase 5).
				</span>
			</fieldset>

			{error && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
			<div>
				<Button type="submit" disabled={pending}>
					{pending ? "Deploying…" : "Deploy"}
				</Button>
			</div>
		</form>
	);
}
