"use client";

import type { ErrorResponse } from "@petri/contracts";
import { useCallback, useEffect, useState } from "react";
import { Button, LogView } from "../../../../components/notebook/index.tsx";
import styles from "../../dashboard.module.css";

type State =
	| { kind: "loading" }
	| { kind: "loaded"; text: string; status: string; at: Date }
	/** No container, or the worker didn't answer: the API says which. */
	| { kind: "unavailable"; message: string; failed: boolean };

/**
 * The app's last lines of output, fetched through the worker (the API
 * has no Docker access). Loaded once; refreshed on request, since every
 * load asks the worker.
 */
export function RuntimeLog({ deploymentId }: { deploymentId: string }) {
	const [state, setState] = useState<State>({ kind: "loading" });

	const load = useCallback(async () => {
		setState({ kind: "loading" });
		const response = await fetch(
			`/api/v1/deployments/${deploymentId}/logs?source=runtime&lines=200`,
		).catch(() => null);
		if (!response) {
			setState({
				kind: "unavailable",
				message: "petri. can't be reached.",
				failed: true,
			});
			return;
		}
		if (!response.ok) {
			const body = (await response
				.json()
				.catch(() => null)) as ErrorResponse | null;
			setState({
				kind: "unavailable",
				message:
					body?.error.message ?? `The request failed (${response.status}).`,
				failed: body?.error.code !== "no_container",
			});
			return;
		}
		setState({
			kind: "loaded",
			text: (await response.text()).trimEnd(),
			status: response.headers.get("x-container-status") ?? "unknown",
			at: new Date(),
		});
	}, [deploymentId]);

	useEffect(() => {
		load();
	}, [load]);

	return (
		<>
			<div className={styles.logBar}>
				<span className={styles.soft}>
					{state.kind === "loading" && "Asking the worker…"}
					{state.kind === "loaded" &&
						`As of ${state.at.toISOString().slice(11, 19)} · app ${state.status} · up to 200 lines, times in UTC`}
				</span>
				<Button
					variant="secondary"
					onClick={load}
					disabled={state.kind === "loading"}
				>
					Refresh
				</Button>
			</div>
			{state.kind === "unavailable" && (
				<p className={state.failed ? styles.error : styles.soft}>
					{state.message}
				</p>
			)}
			{state.kind === "loaded" &&
				(state.text ? (
					<LogView text={state.text} />
				) : (
					<p className={styles.soft}>The app hasn't written anything yet.</p>
				))}
		</>
	);
}
