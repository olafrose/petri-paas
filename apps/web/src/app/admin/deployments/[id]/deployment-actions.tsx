"use client";

import type { DeploymentAction } from "@petri/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../../../../components/notebook/index.tsx";
import { apiSend } from "../../../../lib/client-api.ts";
import styles from "../../dashboard.module.css";

/** The actions the API offers for the current status. */
export function DeploymentActions({
	id,
	actions,
}: {
	id: string;
	actions: DeploymentAction[];
}) {
	const router = useRouter();
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function run(action: "stop" | "start" | "delete") {
		if (
			action === "delete" &&
			!window.confirm(
				"Delete this deployment? Its app, image and upload are removed; the history stays.",
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

	// Redeploy has no endpoint yet (phase 5).
	const offered = actions.filter((action) => action !== "redeploy");
	if (offered.length === 0) return null;

	return (
		<div className={styles.actions}>
			{offered.includes("start") && (
				<Button onClick={() => run("start")} disabled={pending !== null}>
					{pending === "start" ? "Starting…" : "Start"}
				</Button>
			)}
			{offered.includes("stop") && (
				<Button
					variant="secondary"
					onClick={() => run("stop")}
					disabled={pending !== null}
				>
					{pending === "stop" ? "Stopping…" : "Stop"}
				</Button>
			)}
			{offered.includes("delete") && (
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
