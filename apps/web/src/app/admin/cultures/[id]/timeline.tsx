"use client";

import type { DeploymentEvent } from "@petri/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import styles from "../../dashboard.module.css";

/**
 * The deployment's history, followed live: the events stream resumes
 * after the last event already shown, and every new status reloads the
 * page's server data (status stamp, actions).
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
			if (event.type === "status") router.refresh();
		});
		return () => source.close();
	}, [deploymentId, router]);

	if (events.length === 0) {
		return <p className={styles.soft}>Nothing recorded yet.</p>;
	}
	return (
		<ol className={styles.timeline}>
			{events.map((event) => {
				const to = (event.data as { to?: string } | null)?.to;
				return (
					<li key={event.id} className={styles.event}>
						<time className={styles.eventTime} dateTime={event.createdAt}>
							{mounted
								? new Date(event.createdAt).toLocaleTimeString("en-GB")
								: ""}
						</time>
						<span className={to === "failed" ? styles.eventFailed : undefined}>
							{event.message}
						</span>
					</li>
				);
			})}
		</ol>
	);
}
