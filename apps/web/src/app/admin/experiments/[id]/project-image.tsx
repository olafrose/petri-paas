"use client";

import type { ImageRef, Project } from "@petri/contracts";
import { useRouter } from "next/navigation";
import { type ChangeEvent, useId, useState } from "react";
import { Button } from "../../../../components/notebook/index.tsx";
import { apiSend } from "../../../../lib/client-api.ts";
import styles from "../../dashboard.module.css";

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * The project's preview image for the gallery: shown, replaced or removed.
 * The API checks the file's content; the size is checked here first only
 * to answer at once.
 */
export function ProjectImage({
	projectId,
	name,
	image,
}: {
	projectId: string;
	name: string;
	image: ImageRef | null;
}) {
	const router = useRouter();
	const inputId = useId();
	const [pending, setPending] = useState<"upload" | "remove" | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function upload(event: ChangeEvent<HTMLInputElement>) {
		const input = event.currentTarget;
		const file = input.files?.[0];
		if (!file) return;
		setError(null);
		if (file.size > MAX_BYTES) {
			setError("The image is larger than 2 MB");
			input.value = "";
			return;
		}
		setPending("upload");
		const result = await apiSend<Project>(
			"PUT",
			`/api/v1/projects/${projectId}/image`,
			file,
		);
		setPending(null);
		input.value = "";
		if (!result.ok) {
			setError(result.message);
			return;
		}
		router.refresh();
	}

	async function remove() {
		setPending("remove");
		setError(null);
		const result = await apiSend<Project>(
			"DELETE",
			`/api/v1/projects/${projectId}/image`,
		);
		setPending(null);
		if (!result.ok) setError(result.message);
		router.refresh();
	}

	return (
		<div className={styles.imageBlock}>
			{image ? (
				// biome-ignore lint/performance/noImgElement: served by the API, sized
				<img
					className={styles.preview}
					src={image.url}
					width={image.width}
					height={image.height}
					alt={`Preview of ${name}`}
				/>
			) : (
				<p className={styles.soft}>
					No image yet; the gallery card shows the text only.
				</p>
			)}
			<div className={styles.actions}>
				{/* Visually hidden; its label, styled as a button, opens the picker. */}
				<input
					id={inputId}
					className={styles.hidden}
					type="file"
					accept="image/png,image/jpeg,image/webp"
					onChange={upload}
					disabled={pending !== null}
				/>
				<label htmlFor={inputId} className={styles.fileButton}>
					{pending === "upload"
						? "Uploading…"
						: image
							? "Replace image"
							: "Upload image"}
				</label>
				{image && (
					<Button
						variant="secondary"
						onClick={remove}
						disabled={pending !== null}
					>
						{pending === "remove" ? "Removing…" : "Remove"}
					</Button>
				)}
				<span className={styles.soft}>
					PNG, JPEG or WebP, up to 2 MB. Wide images (about 1200×630) suit cards
					and link previews.
				</span>
			</div>
			{error && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
		</div>
	);
}
