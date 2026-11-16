import { accessRequestList } from "@petri/contracts";
import type { Metadata } from "next";
import {
	DateStamp,
	Hand,
	Label,
	Sketch,
} from "../../../components/notebook/index.tsx";
import { apiGet } from "../../../lib/api.ts";
import { requestCookie } from "../../../lib/session.ts";
import keyStyles from "../api-keys/keys.module.css";
import styles from "../dashboard.module.css";
import { Decide } from "./decide.tsx";

export const metadata: Metadata = { title: "Access requests" };

export default async function AccessRequestsPage({
	searchParams,
}: {
	searchParams: Promise<{ code?: string }>;
}) {
	const cookie = await requestCookie();
	const { items } = await apiGet("/api/v1/access-requests", accessRequestList, {
		...(cookie && { cookie }),
	});
	const { code } = await searchParams;
	const match = code && items.find((item) => item.userCode === code);

	return (
		<>
			<Hand as="h1">Access requests</Hand>
			<p className={styles.lead}>
				Coding assistants ask here for an API key. Grant a request only if its
				code matches the one your assistant shows you; the key then appears on
				the API keys page, where it can be revoked.
			</p>
			{code && !match && (
				<p role="status" className={styles.error}>
					No open request with the code <code>{code}</code>: it may have expired
					or been decided already.
				</p>
			)}

			{items.length === 0 ? (
				<div className={styles.empty}>
					<Sketch kind="dish" />
					<p>No one is asking for access.</p>
				</div>
			) : (
				<ul className={keyStyles.keys}>
					{items.map((item) => (
						<li key={item.id} className={keyStyles.key}>
							<div className={keyStyles.head}>
								<strong>{item.name}</strong>
								<code>{item.userCode}</code>
								{item === match && <Label>your code</Label>}
							</div>
							{item.reason && (
								<p className={styles.description}>{item.reason}</p>
							)}
							<dl className={keyStyles.dates}>
								<div>
									<dt>Asked</dt>
									<dd>
										<DateStamp date={item.createdAt} />
									</dd>
								</div>
								<div>
									<dt>From</dt>
									<dd>
										<code>{item.address}</code>
									</dd>
								</div>
								{item.userAgent && (
									<div>
										<dt>Client</dt>
										<dd>{item.userAgent}</dd>
									</div>
								)}
								<div>
									<dt>Open until</dt>
									<dd>
										<DateStamp date={item.expiresAt} />
									</dd>
								</div>
							</dl>
							<Decide request={item} />
						</li>
					))}
				</ul>
			)}
		</>
	);
}
