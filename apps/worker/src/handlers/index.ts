import type { Database } from "@petri/database";
import type { JobQueue } from "@petri/jobs";
import type { Logger } from "pino";
import { pingHandler } from "./ping.ts";

/** Registers a handler for every job type the worker processes. */
export async function registerHandlers(
	queue: JobQueue,
	{ db, log }: { db: Database; log: Logger },
) {
	await queue.work(
		"system.ping",
		withLogging(log, "system.ping", pingHandler(db)),
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
