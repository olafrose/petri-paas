"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button, Field } from "../../../../components/notebook/index.tsx";
import { apiSend } from "../../../../lib/client-api.ts";
import styles from "../../dashboard.module.css";

/** The preview address `url` would have with another subdomain. */
export function addressWith(url: string, subdomain: string): string {
	const address = new URL(url);
	const [, ...rest] = address.hostname.split(".");
	address.hostname = [subdomain, ...rest].join(".");
	return address.toString();
}

/**
 * Renames a culture, or moves its preview to another subdomain. The new
 * address is shown before saving; the old one stops answering.
 */
export function RenameForm({
	id,
	name,
	subdomain,
	url,
}: {
	id: string;
	name: string;
	subdomain: string;
	url: string;
}) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [newName, setNewName] = useState(name);
	const [newSubdomain, setNewSubdomain] = useState(subdomain);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [fields, setFields] = useState<Record<string, string>>({});

	function close() {
		setOpen(false);
		setNewName(name);
		setNewSubdomain(subdomain);
		setError(null);
		setFields({});
	}

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const change = {
			...(newName.trim() !== name && { name: newName.trim() }),
			...(newSubdomain.trim() !== subdomain && {
				subdomain: newSubdomain.trim(),
			}),
		};
		if (Object.keys(change).length === 0) {
			close();
			return;
		}
		setPending(true);
		setError(null);
		setFields({});
		const result = await apiSend("PATCH", `/api/v1/deployments/${id}`, change);
		setPending(false);
		if (!result.ok) {
			setError(result.message);
			setFields(result.fields);
			return;
		}
		setOpen(false);
		router.refresh();
	}

	if (!open) {
		return (
			<div>
				<Button variant="secondary" onClick={() => setOpen(true)}>
					Rename
				</Button>
			</div>
		);
	}

	const moved = newSubdomain.trim() !== subdomain;
	let preview: string | undefined;
	try {
		preview = moved ? addressWith(url, newSubdomain.trim()) : undefined;
	} catch {
		// Not a valid hostname yet; the API says why on saving.
	}
	return (
		<form className={styles.form} onSubmit={onSubmit} noValidate>
			<div className={styles.inline}>
				<Field label="Name" error={fields.name}>
					<input
						name="name"
						value={newName}
						onChange={(event) => setNewName(event.target.value)}
						required
					/>
				</Field>
				<Field
					label="Subdomain"
					hint="Lower case, digits and dashes"
					error={fields.subdomain}
				>
					<input
						name="subdomain"
						value={newSubdomain}
						onChange={(event) => setNewSubdomain(event.target.value)}
						required
					/>
				</Field>
			</div>
			{moved && (
				<p className={styles.soft}>
					New address: <code>{preview ?? "…"}</code>. The current one, {url},
					stops answering and is free for another culture.
				</p>
			)}
			{error && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
			<div>
				<Button type="submit" disabled={pending}>
					{pending ? "Saving…" : "Save"}
				</Button>{" "}
				<Button variant="secondary" onClick={close} disabled={pending}>
					Cancel
				</Button>
			</div>
		</form>
	);
}
