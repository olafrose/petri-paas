"use client";

import type { DeploymentAction } from "@petri/contracts";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "../../../../components/notebook/index.tsx";
import { apiSend } from "../../../../lib/client-api.ts";
import styles from "../../dashboard.module.css";

/**
 * The actions the API offers for the current status (no redeploy while a
 * build runs). Redeploy builds the culture again; a ZIP culture can bring
 * a new archive for it.
 */
export function DeploymentActions({
	id,
	actions,
	zip,
}: {
	id: string;
	actions: DeploymentAction[];
	/** Built from a ZIP archive: offer a new one for the redeploy. */
	zip: boolean;
}) {
	const router = useRouter();
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const archiveInput = useRef<HTMLInputElement>(null);

	async function redeploy() {
		const archive = archiveInput.current?.files?.[0];
		setPending("redeploy");
		setError(null);
		let result: Awaited<ReturnType<typeof apiSend>>;
		if (archive) {
			const upload = new FormData();
			upload.set("archive", archive);
			result = await apiSend(
				"POST",
				`/api/v1/deployments/${id}/upload`,
				upload,
			);
		} else {
			result = await apiSend("POST", `/api/v1/deployments/${id}/redeploy`);
		}
		setPending(null);
		if (result.ok && archiveInput.current) archiveInput.current.value = "";
		if (!result.ok) setError(result.message);
		router.refresh();
	}

	async function run(action: "stop" | "start" | "delete") {
		if (
			action === "delete" &&
			!window.confirm(
				"Delete this culture? Its app, image and upload are removed; the history stays.",
			)
		) {
			return;
		}
		setPending(action);
		setError(null);
		const result =
			action === "delete"
				? await apiSend("DELETE", `/api/v1/deployments/${id}`)
				: await apiSend("POST", `/api/v1/deployments/${id}/${action}`);
		setPending(null);
		if (!result.ok) setError(result.message);
		router.refresh();
	}

	if (actions.length === 0) return null;

	return (
		<div className={styles.actions}>
			{actions.includes("redeploy") && (
				<>
					<Button
						variant={actions.includes("start") ? "secondary" : "primary"}
						onClick={redeploy}
						disabled={pending !== null}
					>
						{pending === "redeploy" ? "Redeploying…" : "Redeploy"}
					</Button>
					{zip && (
						<label className={styles.soft}>
							New archive (optional){" "}
							<input
								ref={archiveInput}
								type="file"
								accept=".zip,application/zip"
								disabled={pending !== null}
							/>
						</label>
					)}
				</>
			)}
			{actions.includes("start") && (
				<Button onClick={() => run("start")} disabled={pending !== null}>
					{pending === "start" ? "Starting…" : "Start"}
				</Button>
			)}
			{actions.includes("stop") && (
				<Button
					variant="secondary"
					onClick={() => run("stop")}
					disabled={pending !== null}
				>
					{pending === "stop" ? "Stopping…" : "Stop"}
				</Button>
			)}
			{actions.includes("delete") && (
				<Button
					variant="danger"
					onClick={() => run("delete")}
					disabled={pending !== null}
				>
					{pending === "delete" ? "Deleting…" : "Delete"}
				</Button>
			)}
			{error && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
		</div>
	);
}
