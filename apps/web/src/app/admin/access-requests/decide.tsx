"use client";

import type { AccessRequest } from "@petri/contracts";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button, Field } from "../../../components/notebook/index.tsx";
import { apiSend } from "../../../lib/client-api.ts";
import { SCOPES } from "../../../lib/scopes.ts";
import styles from "../dashboard.module.css";

/**
 * Grants a request, with the requested scopes or fewer and an optional
 * expiry, or denies it. The assistant collects the key itself.
 */
export function Decide({ request }: { request: AccessRequest }) {
	const router = useRouter();
	const [pending, setPending] = useState<"grant" | "deny" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [fields, setFields] = useState<Record<string, string>>({});
	const requested = SCOPES.filter(({ scope }) =>
		request.scopes.includes(scope),
	);

	async function grant(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const data = new FormData(event.currentTarget);
		const days = String(data.get("expiresInDays") ?? "").trim();
		await send("grant", {
			scopes: data.getAll("scopes"),
			...(days && { expiresInDays: Number(days) }),
		});
	}

	async function deny() {
		if (!window.confirm(`Deny “${request.name}” access?`)) return;
		await send("deny");
	}

	async function send(action: "grant" | "deny", body?: object) {
		setPending(action);
		setError(null);
		setFields({});
		const result = await apiSend(
			"POST",
			`/api/v1/access-requests/${request.id}/${action}`,
			body,
		);
		setPending(null);
		if (!result.ok) {
			setError(result.message);
			setFields(result.fields);
			return;
		}
		router.refresh();
	}

	return (
		<form className={styles.form} onSubmit={grant} noValidate>
			<fieldset className={styles.group}>
				<legend>Scopes</legend>
				{requested.map(({ scope, text }) => (
					<label key={scope} className={styles.radio}>
						<input type="checkbox" name="scopes" value={scope} defaultChecked />
						<code>{scope}</code> {text}
					</label>
				))}
				{fields.scopes && <span className={styles.error}>{fields.scopes}</span>}
			</fieldset>
			<Field
				label="Key expires after (days)"
				hint="Optional: empty for a key that doesn't expire"
				error={fields.expiresInDays}
			>
				<input name="expiresInDays" type="number" min={1} max={3650} />
			</Field>
			{error && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
			<div className={styles.actions}>
				<Button type="submit" disabled={pending !== null}>
					{pending === "grant" ? "Granting…" : "Grant"}
				</Button>
				<Button variant="danger" onClick={deny} disabled={pending !== null}>
					{pending === "deny" ? "Denying…" : "Deny"}
				</Button>
			</div>
		</form>
	);
}
