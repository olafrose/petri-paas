import type { QueueOptions } from "pg-boss";
import { z } from "zod";

/**
 * Every job type: its payload schema and queue settings. Payloads are
 * validated when sent and again when processed.
 */
export const jobs = {
	/** Round trip through the worker; used to check that it is alive. */
	"system.ping": {
		data: z.object({ requestedAt: z.iso.datetime() }),
		queue: {
			retryLimit: 2,
			retryDelay: 5,
			expireInSeconds: 60,
			retentionSeconds: 24 * 60 * 60,
			deleteAfterSeconds: 24 * 60 * 60,
		},
	},
	/** Fetch, build, run and health-check one build of a deployment. */
	"deployment.run": {
		data: z.object({ deploymentId: z.uuid(), buildId: z.uuid() }),
		queue: {
			// A failed build fails the deployment; the owner redeploys. The
			// one retry covers a worker that died mid-job.
			retryLimit: 1,
			retryDelay: 10,
			// Longer than the 15-minute build timeout plus the other steps.
			expireInSeconds: 30 * 60,
			retentionSeconds: 7 * 24 * 60 * 60,
			deleteAfterSeconds: 7 * 24 * 60 * 60,
		},
	},
	/** Stops a deployment's app (the API already set it to `stopped`). */
	"deployment.stop": {
		data: z.object({ deploymentId: z.uuid() }),
		queue: {
			retryLimit: 3,
			retryDelay: 5,
			expireInSeconds: 2 * 60,
			retentionSeconds: 7 * 24 * 60 * 60,
			deleteAfterSeconds: 7 * 24 * 60 * 60,
		},
	},
	/** Starts a stopped app again and health-checks it; no rebuild. */
	"deployment.start": {
		data: z.object({ deploymentId: z.uuid() }),
		queue: {
			// A failed start fails the deployment; the retry covers a worker
			// that died mid-job.
			retryLimit: 1,
			retryDelay: 10,
			// Longer than the health check timeout.
			expireInSeconds: 5 * 60,
			retentionSeconds: 7 * 24 * 60 * 60,
			deleteAfterSeconds: 7 * 24 * 60 * 60,
		},
	},
	/** Removes a deployment's container, network and images. */
	"deployment.delete": {
		data: z.object({ deploymentId: z.uuid() }),
		queue: {
			// Nothing else finishes a deletion: keep trying through a Docker
			// outage (about an hour in total).
			retryLimit: 8,
			retryDelay: 15,
			retryBackoff: true,
			retryDelayMax: 15 * 60,
			expireInSeconds: 5 * 60,
			retentionSeconds: 7 * 24 * 60 * 60,
			deleteAfterSeconds: 7 * 24 * 60 * 60,
		},
	},
} satisfies Record<string, { data: z.ZodType; queue: QueueOptions }>;

export type JobName = keyof typeof jobs;
export type JobData<Name extends JobName> = z.infer<
	(typeof jobs)[Name]["data"]
>;
