"use client";

import { useEffect, useRef, useState } from "react";
import { LogView } from "../../../../components/notebook/index.tsx";
import styles from "../../dashboard.module.css";

/**
 * A build's log. Loaded once, and while `live` followed: each request
 * asks only for what was added since the last one.
 */
export function BuildLog({
	deploymentId,
	buildId,
	live,
}: {
	deploymentId: string;
	buildId: string;
	live: boolean;
}) {
	const [text, setText] = useState("");
	const [loaded, setLoaded] = useState(false);
	// Where the next request continues; kept across restarts of the effect.
	const offset = useRef(0);

	useEffect(() => {
		let stopped = false;
		let busy = false;
		async function load() {
			// One request at a time: overlapping ones would repeat a chunk.
			if (busy) return;
			busy = true;
			try {
				await fetchMore();
			} finally {
				busy = false;
			}
		}
		async function fetchMore() {
			const response = await fetch(
				`/api/v1/deployments/${deploymentId}/logs?build=${buildId}&offset=${offset.current}`,
			).catch(() => null);
			if (stopped || !response?.ok) return;
			const chunk = await response.text();
			if (stopped) return;
			offset.current = Number(
				response.headers.get("x-log-offset") ?? offset.current,
			);
			if (chunk) setText((current) => current + chunk);
			setLoaded(true);
		}
		load();
		const timer = live ? setInterval(load, 2000) : undefined;
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [deploymentId, buildId, live]);

	if (!loaded) return <p className={styles.soft}>Loading…</p>;
	if (!text) return <p className={styles.soft}>The log is empty so far.</p>;
	return <LogView text={text} />;
}
