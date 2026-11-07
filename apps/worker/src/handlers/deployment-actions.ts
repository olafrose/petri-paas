import { createWriteStream, type WriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	builds,
	type Database,
	type DeploymentStatus,
	deployments,
	type Transaction,
} from "@petri/database";
import {
	changeStatus,
	InvalidTransitionError,
	previewUrl,
	updateStatus,
} from "@petri/deployment-core";
import type { JobHandler } from "@petri/jobs";
import { type DockerRuntime, networkName } from "@petri/runtime";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { EdgeRouting } from "../edge-routing.ts";
import {
	checkHealth,
	choosePort,
	imageName,
	ownerMessage,
	StepFailure,
} from "./app-runtime.ts";
import { withDeploymentLock } from "./deployment-lock.ts";
import type { DeploymentRunSettings } from "./deployment-run.ts";

/*
 * The owner's actions on a deployment. The API sets the new status and
 * queues the job in one transaction; the job does the Docker part. Each
 * job first checks that the deployment is still in that status, so a job
 * that arrives late (the owner already started it again, or deleted it)
 * does nothing.
 */

export type DeploymentActionSettings = Pick<
	DeploymentRunSettings,
	"logsDir" | "uploadsDir" | "workerContainer" | "health"
>;

interface Deps {
	db: Database;
	runtime: DockerRuntime;
	edge: EdgeRouting;
	log: Logger;
	settings: DeploymentActionSettings;
}

async function findDeployment(
	db: Database | Transaction,
	deploymentId: string,
) {
	const [row] = await db
		.select()
		.from(deployments)
		.where(eq(deployments.id, deploymentId));
	return row;
}

/**
 * Takes the app off its preview hostname and stops it. Its container and
 * image are kept for starting it again.
 */
export function deploymentStopHandler(
	deps: Deps,
): JobHandler<"deployment.stop"> {
	const { db, runtime, edge } = deps;

	return async (job) => {
		const { deploymentId } = job.data;
		const log = deps.log.child({ deploymentId });
		await withDeploymentLock(db, deploymentId, async (tx) => {
			const deployment = await findDeployment(tx, deploymentId);
			if (deployment?.status !== "stopped") {
				log.info(
					{ status: deployment?.status },
					"deployment is not stopped; nothing to do",
				);
				return;
			}
			await edge.unpublish(deploymentId);
			await tx
				.update(deployments)
				.set({ routeId: null })
				.where(eq(deployments.id, deploymentId));
			// With restarts enabled ("unless-stopped"), it also stays stopped
			// when Docker or the host restarts.
			await runtime.stop(deploymentId);
			log.info("app stopped");
		});
	};
}

/**
 * Starts a stopped app again, without a rebuild, and health-checks it as
 * on its first start: deploying → health_check → ready, or failed with
 * the reason. The app's output on a failed start goes to the log of the
 * build it runs; its container is kept, stopped.
 */
export function deploymentStartHandler(
	deps: Deps,
): JobHandler<"deployment.start"> {
	const { db, runtime, edge, settings } = deps;

	return async (job) => {
		const { deploymentId } = job.data;
		const log = deps.log.child({ deploymentId });
		let current: DeploymentStatus | undefined;
		let published = false;
		let buildLog: WriteStream | undefined;
		const note = (line: string) => buildLog?.write(`[petri] ${line}\n`);

		try {
			const started = await withDeploymentLock(db, deploymentId, async (tx) => {
				const deployment = await findDeployment(tx, deploymentId);
				// `health_check`: an earlier attempt died during the check.
				if (
					deployment?.status !== "deploying" &&
					deployment?.status !== "health_check"
				) {
					log.info(
						{ status: deployment?.status },
						"deployment is not starting; nothing to do",
					);
					return null;
				}
				current = deployment.status;

				const container = await runtime.inspect(deploymentId);
				if (!container?.buildId) {
					throw new StepFailure(
						"The app's container no longer exists; deploy it again",
					);
				}
				buildLog = createWriteStream(
					join(settings.logsDir, `${container.buildId}.log`),
					{ flags: "a", mode: 0o640 },
				);
				note("Starting the app again");
				const [build] = await tx
					.select({ port: builds.port })
					.from(builds)
					.where(eq(builds.id, container.buildId));
				const port =
					build?.port ??
					(await choosePort(
						runtime,
						imageName(deploymentId, container.buildId),
						deployment.internalPort,
						note,
					));
				await runtime.disableRestarts(deploymentId);
				await runtime.start(deploymentId);
				if (current === "deploying") {
					const message = `Waiting for the app to answer on port ${port}`;
					await changeStatus(tx, deploymentId, "health_check", {
						message,
						expectedFrom: ["deploying"],
					});
					current = "health_check";
					note(message);
				}
				return { port, deployment };
			});
			if (!started) return;

			const healthy = await checkHealth(
				runtime,
				settings,
				deploymentId,
				networkName(deploymentId),
				started.port,
				job.signal,
			);
			if (!healthy.healthy) {
				const output = await runtime.logs(deploymentId, 50).catch(() => "");
				if (output)
					buildLog?.write(`[petri] Last output of the app:\n${output}`);
				throw new StepFailure(healthy.reason);
			}

			await runtime.enableRestarts(deploymentId);
			published = true;
			const routeId = await edge.publish(started.deployment, started.port);
			const url = previewUrl(
				edge.settings.previewBaseUrl,
				started.deployment.subdomain,
			);
			await updateStatus(db, deploymentId, "ready", {
				message: `Ready at ${url}`,
				data: { url },
				expectedFrom: ["health_check"],
				updates: { routeId },
			});
			note("Ready");
			log.info("deployment ready");
		} catch (error) {
			if (published) {
				// Otherwise the next route sync removes it.
				await edge
					.unpublish(deploymentId)
					.catch((err) => log.warn({ err }, "removing the route failed"));
			}
			// Failed before knowing the status: let the job retry.
			if (current === undefined) throw error;
			const now = await findDeployment(db, deploymentId);
			if (error instanceof InvalidTransitionError || now?.status !== current) {
				// Changed elsewhere, e.g. deleted by the owner. Stop quietly.
				note(`Stopped: the deployment is now "${now?.status ?? "gone"}"`);
				return;
			}

			await runtime.stop(deploymentId, 2).catch(() => {});
			const message = ownerMessage(error);
			if (!message) log.error({ err: error, step: current }, "start failed");
			const reason =
				message ?? "An internal error occurred; see the worker logs";
			note(`Failed: ${reason}`);
			try {
				await updateStatus(db, deploymentId, "failed", {
					message: reason,
					data: { step: current },
					expectedFrom: [current],
				});
			} catch (statusError) {
				if (!(statusError instanceof InvalidTransitionError)) throw statusError;
			}
		} finally {
			if (buildLog) {
				const stream = buildLog;
				await new Promise((resolve) => stream.end(resolve));
			}
		}
	};
}

/**
 * Removes everything the deployment ran on: its route, container,
 * network, the images of all its builds and its uploaded archive. The deployment, its
 * builds, history and build logs remain; it ends as `deleted`.
 *
 * Errors are thrown so the job is retried. A deployment job still running
 * notices the deletion and removes whatever it creates itself.
 */
export function deploymentDeleteHandler(
	deps: Deps,
): JobHandler<"deployment.delete"> {
	const { db, runtime, edge, settings } = deps;

	return async (job) => {
		const { deploymentId } = job.data;
		const log = deps.log.child({ deploymentId });
		await withDeploymentLock(db, deploymentId, async (tx) => {
			const deployment = await findDeployment(tx, deploymentId);
			if (deployment?.status !== "deleting") {
				log.info(
					{ status: deployment?.status },
					"deployment is not being deleted; nothing to do",
				);
				return;
			}

			// Left connected if the worker died during a health check; the
			// network can't be removed while it is.
			if (settings.workerContainer) {
				await runtime
					.disconnect(networkName(deploymentId), settings.workerContainer)
					.catch(() => {});
			}
			// Also takes the edge proxy off the network, which is needed to
			// remove it.
			await edge.unpublish(deploymentId);
			await runtime.removeContainer(deploymentId);
			await runtime.removeNetwork(deploymentId);
			const buildRows = await tx
				.select({ id: builds.id })
				.from(builds)
				.where(eq(builds.deploymentId, deploymentId));
			for (const build of buildRows) {
				await runtime.removeImage(imageName(deploymentId, build.id));
			}
			if (deployment.source.type === "zip") {
				await rm(
					join(settings.uploadsDir, `${deployment.source.uploadId}.zip`),
					{ force: true },
				);
			}

			await changeStatus(tx, deploymentId, "deleted", {
				message: "Deleted",
				expectedFrom: ["deleting"],
				updates: { imageId: null, containerId: null, routeId: null },
			});
			log.info("deployment deleted");
		});
	};
}
