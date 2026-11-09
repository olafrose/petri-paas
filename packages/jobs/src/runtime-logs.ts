import { join } from "node:path";
import { z } from "zod";

/*
 * The answer to a `deployment.logs` job. The worker writes it as a file
 * on the logs volume, which the API mounts read-only, then publishes
 * RUNTIME_LOGS_READY. Events are best effort, so the API also looks for
 * the file. The worker removes old answers.
 */

/** Event type published once the answer is written. */
export const RUNTIME_LOGS_READY = "deployment.logs.ready";

/** Where the answer to a request is written. */
export const runtimeLogsPath = (logsDir: string, requestId: string) =>
	join(logsDir, "runtime", `${requestId}.json`);

export const runtimeLogsResult = z.object({
	deploymentId: z.uuid(),
	/** Null when the deployment has no container. */
	container: z.object({ status: z.string(), running: z.boolean() }).nullable(),
	/** The last lines, each starting with its time (UTC). */
	text: z.string(),
	/** Whether older lines were cut to stay within the size limit. */
	truncated: z.boolean(),
	writtenAt: z.iso.datetime(),
});

export type RuntimeLogsResult = z.infer<typeof runtimeLogsResult>;
