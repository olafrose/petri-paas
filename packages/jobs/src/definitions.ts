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
} satisfies Record<string, { data: z.ZodType; queue: QueueOptions }>;

export type JobName = keyof typeof jobs;
export type JobData<Name extends JobName> = z.infer<
	(typeof jobs)[Name]["data"]
>;
