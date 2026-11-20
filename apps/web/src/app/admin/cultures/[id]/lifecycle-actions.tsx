"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../../../../components/notebook/index.tsx";
import { apiSend } from "../../../../lib/client-api.ts";
import styles from "../../dashboard.module.css";

/**
 * For a temporary culture: Extend gives it another `hours` from now;
 * Keep makes it permanent.
 */
export function LifecycleActions({ id, hours }: { id: string; hours: number }) {
	const router = useRouter();
	const [pending, setPending] = useState<"extend" | "keep" | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function change(action: "extend" | "keep") {
		setPending(action);
		setError(null);
		const result = await apiSend("PATCH", `/api/v1/deployments/${id}`, {
			lifecycle:
				action === "extend"
					? { mode: "temporary", ttlHours: hours }
					: { mode: "permanent" },
		});
		setPending(null);
		if (!result.ok) setError(result.message);
		router.refresh();
	}

	return (
		<>
			<Button
				variant="secondary"
				onClick={() => change("extend")}
				disabled={pending !== null}
			>
				{pending === "extend" ? "Extending…" : "Extend"}
			</Button>
			<Button
				variant="secondary"
				onClick={() => change("keep")}
				disabled={pending !== null}
			>
				{pending === "keep" ? "Keeping…" : "Keep"}
			</Button>
			{error && (
				<span role="alert" className={styles.error}>
					{error}
				</span>
			)}
		</>
	);
}
