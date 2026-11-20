import {
	buildList,
	deployment,
	deploymentEventList,
	project,
	TTL_HOURS,
} from "@petri/contracts";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
	DateStamp,
	experimentLabel,
	Hand,
	Label,
	MarginNote,
	StatusStamp,
} from "../../../../components/notebook/index.tsx";
import { ApiRequestError, apiGet } from "../../../../lib/api.ts";
import { isActive, timeLeft } from "../../../../lib/deployments.ts";
import { requestCookie } from "../../../../lib/session.ts";
import styles from "../../dashboard.module.css";
import { BuildHistory } from "./build-history.tsx";
import { BuildLog } from "./build-log.tsx";
import { DeploymentActions } from "./deployment-actions.tsx";
import { LifecycleActions } from "./lifecycle-actions.tsx";
import { RuntimeLog } from "./runtime-log.tsx";
import { Timeline } from "./timeline.tsx";

export const metadata: Metadata = { title: "Culture" };

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
	const [owner, history, buildHistory] = await Promise.all([
		apiGet(`/api/v1/projects/${current.projectId}`, project, options),
		apiGet(
			`/api/v1/deployments/${id}/events?limit=500`,
			deploymentEventList,
			options,
		),
		apiGet(`/api/v1/deployments/${id}/builds`, buildList, options),
	]);
	const { source, latestBuild } = current;
	const active = isActive(current.status);
	// A redeploy of a ready culture: the new build runs next to it.
	const building =
		latestBuild?.status === "queued" || latestBuild?.status === "running";
	const newBatchFailed =
		current.status === "ready" && latestBuild?.status === "failed";
	const left = timeLeft(current);
	// The API refuses changes once it expired or is being deleted.
	const lifecycleChangeable = !["expired", "deleting", "deleted"].includes(
		current.status,
	);

	return (
		<>
			<p className={styles.soft}>
				<a href="/admin">Experiments</a> /{" "}
				<a href={`/admin/experiments/${owner.id}`}>
					{experimentLabel(owner.number)} {owner.name}
				</a>
			</p>
			<div className={styles.titleRow}>
				<Hand as="h1">{current.name}</Hand>
				<StatusStamp status={current.status} />
			</div>
			{building && current.status === "ready" && (
				<p>
					<MarginNote>growing a new batch</MarginNote>{" "}
					<span className={styles.soft}>
						— the current one keeps answering until the new one is healthy
					</span>
				</p>
			)}

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
					<span className={styles.lifecycle}>
						<Label>{current.lifecycleMode}</Label>
						{left ? (
							<span className={styles.soft}>
								expires in {left}
								{current.expiresAt && (
									<>
										{" "}
										(<DateStamp date={current.expiresAt} />)
									</>
								)}
							</span>
						) : (
							current.status === "expired" && (
								<span className={styles.soft}>
									its time was up; Redeploy grows it again
								</span>
							)
						)}
						{lifecycleChangeable && (
							<LifecycleActions
								id={current.id}
								mode={current.lifecycleMode}
								hours={TTL_HOURS.default}
							/>
						)}
					</span>
				</dd>
				<dt>Created</dt>
				<dd>
					<DateStamp date={current.createdAt} />
				</dd>
				{latestBuild?.errorMessage && (
					<>
						<dt>{newBatchFailed ? "Last redeploy" : "Error"}</dt>
						<dd className={styles.error}>
							{latestBuild.errorMessage}
							{newBatchFailed && " (the previous batch keeps answering)"}
						</dd>
					</>
				)}
			</dl>

			<DeploymentActions
				id={current.id}
				actions={current.actions}
				zip={source.type === "zip"}
			/>

			<section className={styles.section}>
				<Hand as="h2">History</Hand>
				<Timeline deploymentId={current.id} initial={history.items} />
			</section>

			<section className={styles.section}>
				<Hand as="h2">App output</Hand>
				{/* Asked again whenever the status or the running batch changes. */}
				<RuntimeLog
					key={`${current.status}:${latestBuild?.id}:${latestBuild?.status}`}
					deploymentId={current.id}
				/>
			</section>

			<section className={styles.section}>
				<Hand as="h2">Builds</Hand>
				<BuildHistory builds={buildHistory.items} />
			</section>

			<section className={styles.section}>
				<Hand as="h2">Build log</Hand>
				{latestBuild ? (
					<BuildLog
						key={latestBuild.id}
						deploymentId={current.id}
						buildId={latestBuild.id}
						live={active || building}
					/>
				) : (
					<p className={styles.soft}>No build yet.</p>
				)}
			</section>
		</>
	);
}
