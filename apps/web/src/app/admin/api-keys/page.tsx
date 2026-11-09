import { type ApiKey, apiKeyList, settings } from "@petri/contracts";
import type { Metadata } from "next";
import { DateStamp, Hand, Label } from "../../../components/notebook/index.tsx";
import { apiGet } from "../../../lib/api.ts";
import { requestCookie } from "../../../lib/session.ts";
import styles from "../dashboard.module.css";
import { CreateKey } from "./create-key.tsx";
import keyStyles from "./keys.module.css";
import { RevokeKey } from "./revoke-key.tsx";

export const metadata: Metadata = { title: "API keys" };

const isUsable = (key: ApiKey, now: number) =>
	!key.revokedAt && !(key.expiresAt && Date.parse(key.expiresAt) <= now);

export default async function ApiKeysPage() {
	const cookie = await requestCookie();
	const options = cookie ? { cookie } : {};
	const [{ items }, { publicUrl }] = await Promise.all([
		apiGet("/api/v1/api-keys", apiKeyList, options),
		apiGet("/api/v1/settings", settings, options),
	]);
	const now = Date.now();
	const usable = items.filter((key) => isUsable(key, now));
	const unusable = items.filter((key) => !isUsable(key, now));

	return (
		<>
			<Hand as="h1">API keys</Hand>
			<p className={styles.lead}>
				For coding assistants and scripts: they deploy through the API with a
				key, limited to what its scopes allow. Keys can't manage keys.
			</p>

			<section className={styles.section}>
				<Hand as="h2">New key</Hand>
				<CreateKey publicUrl={publicUrl} />
			</section>

			<section className={styles.section}>
				<Hand as="h2">Keys in use</Hand>
				{usable.length === 0 ? (
					<p className={styles.soft}>No keys yet.</p>
				) : (
					<KeyList keys={usable} now={now} />
				)}
				{unusable.length > 0 && (
					<details className={styles.deleted}>
						<summary>
							{unusable.length} revoked or expired key
							{unusable.length === 1 ? "" : "s"}
						</summary>
						<KeyList keys={unusable} now={now} />
					</details>
				)}
			</section>
		</>
	);
}

function KeyList({ keys, now }: { keys: ApiKey[]; now: number }) {
	return (
		<ul className={keyStyles.keys}>
			{keys.map((key) => (
				<li key={key.id} className={keyStyles.key}>
					<div className={keyStyles.head}>
						<strong>{key.name}</strong>
						<code>{key.prefix}…</code>
						{key.revokedAt && <Label>revoked</Label>}
						{!key.revokedAt &&
							key.expiresAt &&
							Date.parse(key.expiresAt) <= now && <Label>expired</Label>}
					</div>
					<div className={keyStyles.scopes}>
						{key.scopes.map((scope) => (
							<Label key={scope}>{scope}</Label>
						))}
					</div>
					<dl className={keyStyles.dates}>
						<div>
							<dt>Created</dt>
							<dd>
								<DateStamp date={key.createdAt} />
							</dd>
						</div>
						<div>
							<dt>Last used</dt>
							<dd>
								{key.lastUsedAt ? <DateStamp date={key.lastUsedAt} /> : "never"}
							</dd>
						</div>
						<div>
							<dt>{key.revokedAt ? "Revoked" : "Expires"}</dt>
							<dd>
								{key.revokedAt ? (
									<DateStamp date={key.revokedAt} />
								) : key.expiresAt ? (
									<DateStamp date={key.expiresAt} />
								) : (
									"never"
								)}
							</dd>
						</div>
					</dl>
					{!key.revokedAt && <RevokeKey id={key.id} name={key.name} />}
				</li>
			))}
		</ul>
	);
}
