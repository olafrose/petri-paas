import type { Database } from "@petri/database";
import type { JobQueue } from "@petri/jobs";
import type { DockerRuntime } from "@petri/runtime";
import type { Logger } from "pino";
import type { EdgeRouting } from "../edge-routing.ts";
import {
	deploymentDeleteHandler,
	deploymentStartHandler,
	deploymentStopHandler,
} from "./deployment-actions.ts";
import { deploymentLogsHandler } from "./deployment-logs.ts";
import {
	type DeploymentRunSettings,
	deploymentRunHandler,
} from "./deployment-run.ts";
import { pingHandler } from "./ping.ts";

/** Registers a handler for every job type the worker processes. */
export async function registerHandlers(
	queue: JobQueue,
	deps: {
		db: Database;
		log: Logger;
		runtime: DockerRuntime;
		edge: EdgeRouting;
		settings: DeploymentRunSettings;
	},
) {
	await queue.work(
		"system.ping",
		withLogging(deps.log, "system.ping", pingHandler(deps.db)),
	);
	// Two deployments at a time: builds are heavy on a small host.
	await queue.work(
		"deployment.run",
		withLogging(deps.log, "deployment.run", deploymentRunHandler(deps)),
		{ concurrency: 2 },
	);
	// The owner's actions. Each holds a database connection while it has
	// the deployment's lock.
	await queue.work(
		"deployment.stop",
		withLogging(deps.log, "deployment.stop", deploymentStopHandler(deps)),
		{ concurrency: 2 },
	);
	await queue.work(
		"deployment.start",
		withLogging(deps.log, "deployment.start", deploymentStartHandler(deps)),
		{ concurrency: 2 },
	);
	await queue.work(
		"deployment.delete",
		withLogging(deps.log, "deployment.delete", deploymentDeleteHandler(deps)),
		{ concurrency: 2 },
	);
	// Someone waits for these: polled often, never behind a build.
	await queue.work(
		"deployment.logs",
		withLogging(deps.log, "deployment.logs", deploymentLogsHandler(deps)),
		{ concurrency: 2, pollingIntervalSeconds: 0.5 },
	);
}

function withLogging<Job extends { id: string; retryCount: number }>(
	log: Logger,
	name: string,
	handler: (job: Job) => Promise<void>,
) {
	return async (job: Job) => {
		const jobLog = log.child({
			job: name,
			jobId: job.id,
			attempt: job.retryCount + 1,
		});
		const startedAt = performance.now();
		jobLog.debug("job started");
		try {
			await handler(job);
			jobLog.info(
				{ ms: Math.round(performance.now() - startedAt) },
				"job completed",
			);
		} catch (error) {
			jobLog.error({ err: error }, "job failed");
			throw error;
		}
	};
}
