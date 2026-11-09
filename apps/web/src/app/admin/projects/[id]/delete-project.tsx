"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../../../../components/notebook/index.tsx";
import { apiSend } from "../../../../lib/client-api.ts";
import styles from "../../dashboard.module.css";

/**
 * Deletes the project, once all its deployments are deleted: the API
 * refuses (409) while any of them may still have a running app, since
 * the project's records are petri.'s only reference to it.
 */
export function DeleteProject({
	id,
	label,
	remaining,
}: {
	id: string;
	/** E.g. EXP-007 "Dashboard". */
	label: string;
	/** Deployments not yet deleted. */
	remaining: number;
}) {
	const router = useRouter();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function remove() {
		if (
			!window.confirm(
				`Delete ${label}? Its notes and the history of its deployments are removed for good. Its number isn't used again.`,
			)
		) {
			return;
		}
		setPending(true);
		setError(null);
		const result = await apiSend("DELETE", `/api/v1/projects/${id}`);
		setPending(false);
		if (result.ok) {
			router.push("/admin");
			return;
		}
		setError(result.message);
		router.refresh();
	}

	return (
		<div className={styles.actions}>
			<Button
				variant="danger"
				onClick={remove}
				disabled={pending || remaining > 0}
				aria-describedby={remaining > 0 ? `${id}-delete-note` : undefined}
			>
				{pending ? "Deleting…" : "Delete experiment"}
			</Button>
			{remaining > 0 && (
				<span id={`${id}-delete-note`} className={styles.soft}>
					Delete its{" "}
					{remaining === 1 ? "deployment" : `${remaining} deployments`} first:
					until then, petri. needs this experiment's records to find and remove
					what they run.
				</span>
			)}
			{error && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
		</div>
	);
}
