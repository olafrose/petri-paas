"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../../../../components/notebook/index.tsx";
import { apiSend } from "../../../../lib/client-api.ts";
import styles from "../../dashboard.module.css";

type Change = "extend" | "permanent" | "temporary";

const LABELS: Record<Change, { idle: string; pending: string }> = {
	extend: { idle: "Extend", pending: "Extending…" },
	permanent: { idle: "Keep", pending: "Keeping…" },
	temporary: { idle: "Make temporary", pending: "Making temporary…" },
};

/**
 * Switches a culture between temporary and permanent. A temporary one
 * can also be extended. Extending and making temporary both give it
 * `hours` from now.
 */
export function LifecycleActions({
	id,
	mode,
	hours,
}: {
	id: string;
	mode: "temporary" | "permanent";
	hours: number;
}) {
	const router = useRouter();
	const [pending, setPending] = useState<Change | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function change(to: Change) {
		setPending(to);
		setError(null);
		const result = await apiSend("PATCH", `/api/v1/deployments/${id}`, {
			lifecycle:
				to === "permanent"
					? { mode: "permanent" }
					: { mode: "temporary", ttlHours: hours },
		});
		setPending(null);
		if (!result.ok) setError(result.message);
		router.refresh();
	}

	const offered: Change[] =
		mode === "temporary" ? ["extend", "permanent"] : ["temporary"];
	return (
		<>
			{offered.map((to) => (
				<Button
					key={to}
					variant="secondary"
					onClick={() => change(to)}
					disabled={pending !== null}
				>
					{pending === to ? LABELS[to].pending : LABELS[to].idle}
				</Button>
			))}
			{error && (
				<span role="alert" className={styles.error}>
					{error}
				</span>
			)}
		</>
	);
}
