import { deployment, deploymentEventList, project } from "@petri/contracts";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
	DateStamp,
	experimentLabel,
	Hand,
	Label,
	StatusStamp,
} from "../../../../components/notebook/index.tsx";
import { ApiRequestError, apiGet } from "../../../../lib/api.ts";
import { isActive } from "../../../../lib/deployments.ts";
import { requestCookie } from "../../../../lib/session.ts";
import styles from "../../dashboard.module.css";
import { BuildLog } from "./build-log.tsx";
import { DeploymentActions } from "./deployment-actions.tsx";
import { RuntimeLog } from "./runtime-log.tsx";
import { Timeline } from "./timeline.tsx";

export const metadata: Metadata = { title: "Deployment" };

export default async function DeploymentPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const cookie = await requestCookie();
	const options = cookie ? { cookie } : {};
	const current = await apiGet(
		`/api/v1/deployments/${id}`,
		deployment,
		options,
	).catch((error: unknown) => {
		if (error instanceof ApiRequestError && [400, 404].includes(error.status))
			notFound();
		throw error;
	});
	const [owner, history] = await Promise.all([
		apiGet(`/api/v1/projects/${current.projectId}`, project, options),
		apiGet(
			`/api/v1/deployments/${id}/events?limit=500`,
			deploymentEventList,
			options,
		),
	]);
	const { source, latestBuild } = current;
	const active = isActive(current.status);

	return (
		<>
			<p className={styles.soft}>
				<a href="/admin">Experiments</a> /{" "}
				<a href={`/admin/projects/${owner.id}`}>
					{experimentLabel(owner.number)} {owner.name}
				</a>
			</p>
			<div className={styles.titleRow}>
				<Hand as="h1">{current.name}</Hand>
				<StatusStamp status={current.status} />
			</div>

			<dl className={styles.facts}>
				<dt>Preview</dt>
				<dd>
					{current.status === "ready" ? (
						<a href={current.url} target="_blank" rel="noopener">
							{current.url} ↗
						</a>
					) : (
						<span className={styles.soft}>
							{current.url} (answers when ready)
						</span>
					)}
				</dd>
				<dt>Source</dt>
				<dd>
					{source.type === "git" ? (
						<>
							{source.repository} @ <code>{source.ref}</code>
							{latestBuild?.commit && (
								<>
									{" "}
									· commit <code>{latestBuild.commit.slice(0, 10)}</code>
								</>
							)}
							{source.directory && (
								<>
									{" "}
									· in <code>{source.directory}</code>
								</>
							)}
						</>
					) : (
						<>
							ZIP upload
							{source.directory && (
								<>
									{" "}
									· in <code>{source.directory}</code>
								</>
							)}
						</>
					)}
				</dd>
				<dt>Lifecycle</dt>
				<dd>
					{current.lifecycleMode === "permanent" ? (
						<Label>permanent</Label>
					) : (
						<>
							<Label>temporary</Label>{" "}
							{current.expiresAt && (
								<span className={styles.soft}>
									until <DateStamp date={current.expiresAt} />
								</span>
							)}
						</>
					)}
				</dd>
				<dt>Created</dt>
				<dd>
					<DateStamp date={current.createdAt} />
				</dd>
				{latestBuild?.errorMessage && (
					<>
						<dt>Error</dt>
						<dd className={styles.error}>{latestBuild.errorMessage}</dd>
					</>
				)}
			</dl>

			<DeploymentActions id={current.id} actions={current.actions} />

			<section className={styles.section}>
				<Hand as="h2">History</Hand>
				<Timeline deploymentId={current.id} initial={history.items} />
			</section>

			<section className={styles.section}>
				<Hand as="h2">App output</Hand>
				{/* Asked again whenever the status changes. */}
				<RuntimeLog key={current.status} deploymentId={current.id} />
			</section>

			<section className={styles.section}>
				<Hand as="h2">Build log</Hand>
				{latestBuild ? (
					<BuildLog
						deploymentId={current.id}
						buildId={latestBuild.id}
						live={active}
					/>
				) : (
					<p className={styles.soft}>No build yet.</p>
				)}
			</section>
		</>
	);
}
