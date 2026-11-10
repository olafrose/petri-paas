"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../../../components/notebook/index.tsx";
import { apiSend } from "../../../lib/client-api.ts";
import styles from "../dashboard.module.css";

export function RevokeKey({ id, name }: { id: string; name: string }) {
	const router = useRouter();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function revoke() {
		if (
			!window.confirm(
				`Revoke the key “${name}”? Anything using it stops working at once.`,
			)
		) {
			return;
		}
		setPending(true);
		setError(null);
		const result = await apiSend("DELETE", `/api/v1/api-keys/${id}`);
		setPending(false);
		if (!result.ok) setError(result.message);
		router.refresh();
	}

	return (
		<div className={styles.actions}>
			<Button variant="danger" onClick={revoke} disabled={pending}>
				{pending ? "Revoking…" : "Revoke"}
			</Button>
			{error && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
		</div>
	);
}
