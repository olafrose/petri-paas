"use client";

import type { CreatedApiKey, Scope } from "@petri/contracts";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button, Field } from "../../../components/notebook/index.tsx";
import { apiSend } from "../../../lib/client-api.ts";
import styles from "../dashboard.module.css";
import keyStyles from "./keys.module.css";

const SCOPES: { scope: Scope; text: string }[] = [
	{
		scope: "deploy:read",
		text: "See projects, deployments, logs and settings",
	},
	{ scope: "deploy:create", text: "Create projects and deployments" },
	{ scope: "deploy:update", text: "Edit projects; stop and start deployments" },
	{ scope: "deploy:delete", text: "Delete projects and deployments" },
];

/**
 * Creates a key and shows it once, with a copy button and a curl line
 * that uses it. The API stores only its hash.
 */
export function CreateKey({ publicUrl }: { publicUrl: string }) {
	const router = useRouter();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [fields, setFields] = useState<Record<string, string>>({});
	const [created, setCreated] = useState<CreatedApiKey | null>(null);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = event.currentTarget;
		const data = new FormData(form);
		const days = String(data.get("expiresInDays") ?? "").trim();
		setPending(true);
		setError(null);
		setFields({});
		const result = await apiSend<CreatedApiKey>("POST", "/api/v1/api-keys", {
			name: String(data.get("name") ?? "").trim(),
			scopes: data.getAll("scopes"),
			...(days && { expiresInDays: Number(days) }),
		});
		setPending(false);
		if (!result.ok) {
			setError(result.message);
			setFields(result.fields);
			return;
		}
		form.reset();
		setCreated(result.data);
		router.refresh();
	}

	if (created) {
		const curl = `curl -H "Authorization: Bearer ${created.key}" ${publicUrl}/api/v1/projects`;
		return (
			<div className={keyStyles.created} role="status">
				<p>
					<strong>“{created.apiKey.name}” is ready.</strong> Copy the key now:
					it is shown only this once.
				</p>
				<Secret label="Key" copyLabel="Copy key" value={created.key} />
				<Secret label="Try it" copyLabel="Copy curl command" value={curl} />
				<div>
					<Button variant="secondary" onClick={() => setCreated(null)}>
						Done
					</Button>
				</div>
			</div>
		);
	}

	return (
		<form className={styles.form} onSubmit={onSubmit} noValidate>
			<Field
				label="Name"
				hint="Who or what uses it, e.g. “laptop assistant”"
				error={fields.name}
			>
				<input name="name" maxLength={100} required />
			</Field>
			<fieldset className={styles.group}>
				<legend>Scopes</legend>
				{SCOPES.map(({ scope, text }) => (
					<label key={scope} className={styles.radio}>
						<input
							type="checkbox"
							name="scopes"
							value={scope}
							defaultChecked={scope !== "deploy:delete"}
						/>
						<code>{scope}</code> {text}
					</label>
				))}
				{fields.scopes && <span className={styles.error}>{fields.scopes}</span>}
			</fieldset>
			<Field
				label="Expires after (days)"
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
			<div>
				<Button type="submit" disabled={pending}>
					{pending ? "Creating…" : "Create key"}
				</Button>
			</div>
		</form>
	);
}

/** A read-only value with a copy button. */
function Secret({
	label,
	copyLabel,
	value,
}: {
	label: string;
	copyLabel: string;
	value: string;
}) {
	const [copied, setCopied] = useState<"yes" | "no" | null>(null);

	async function copy() {
		// The clipboard needs HTTPS (or localhost); otherwise select it.
		const ok = await navigator.clipboard
			?.writeText(value)
			.then(() => true)
			.catch(() => false);
		setCopied(ok ? "yes" : "no");
	}

	return (
		<div className={keyStyles.secret}>
			<Field
				label={label}
				hint={
					copied === "yes"
						? "Copied."
						: copied === "no"
							? "Couldn't copy here; select the text and copy it."
							: "Shown only now."
				}
			>
				<input
					readOnly
					value={value}
					onFocus={(event) => event.currentTarget.select()}
				/>
			</Field>
			<Button variant="secondary" onClick={copy} aria-label={copyLabel}>
				Copy
			</Button>
		</div>
	);
}
