"use client";

import type { DeploymentEvent } from "@petri/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LogView } from "../../../../components/notebook/index.tsx";
import styles from "../../dashboard.module.css";

/**
 * The deployment's history, followed live: the events stream resumes
 * after the last event already shown, and every new status (or step of
 * a new batch) reloads the page's server data (status stamp, actions).
 */
export function Timeline({
	deploymentId,
	initial,
}: {
	deploymentId: string;
	initial: DeploymentEvent[];
}) {
	const router = useRouter();
	const [events, setEvents] = useState(initial);
	// Times in the viewer's time zone, which only the browser knows: shown
	// once mounted, so server and browser render the same first.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	// Read once per connection, so page refreshes don't reconnect.
	const lastShown = useRef(initial.at(-1)?.id ?? 0);
	lastShown.current = events.at(-1)?.id ?? lastShown.current;

	useEffect(() => {
		const after = lastShown.current;
		const source = new EventSource(
			`/api/v1/deployments/${deploymentId}/events/stream?after=${after}`,
		);
		source.addEventListener("deployment-event", (message) => {
			const event = JSON.parse(message.data) as DeploymentEvent;
			setEvents((current) =>
				current.some((existing) => existing.id === event.id)
					? current
					: [...current, event],
			);
			// Statuses, the steps of a new batch next to a ready culture, a
			// changed lifetime, and repairs by the worker.
			if (["status", "build", "lifecycle", "recovery"].includes(event.type)) {
				router.refresh();
			}
		});
		return () => source.close();
	}, [deploymentId, router]);

	if (events.length === 0) {
		return <p className={styles.soft}>Nothing recorded yet.</p>;
	}
	return (
		<ol className={styles.timeline}>
			{events.map((event) => {
				const data = event.data as {
					to?: string;
					failed?: boolean;
					/** The app's last output, when it crashed. */
					output?: string;
				} | null;
				const failed = data?.to === "failed" || data?.failed === true;
				return (
					<li key={event.id} className={styles.event}>
						<time className={styles.eventTime} dateTime={event.createdAt}>
							{mounted
								? new Date(event.createdAt).toLocaleTimeString("en-GB")
								: ""}
						</time>
						<div>
							<span className={failed ? styles.eventFailed : undefined}>
								{event.message}
							</span>
							{data?.output && (
								<div className={styles.eventOutput}>
									<LogView text={data.output} />
								</div>
							)}
						</div>
					</li>
				);
			})}
		</ol>
	);
}
