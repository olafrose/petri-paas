import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Database, publishEvent } from "@petri/database";
import {
	type JobHandler,
	RUNTIME_LOGS_READY,
	type RuntimeLogsResult,
	runtimeLogsPath,
} from "@petri/jobs";
import { DockerApiError, type DockerRuntime } from "@petri/runtime";

/** At most this much output per answer; older lines are cut. */
export const MAX_RUNTIME_LOG_BYTES = 1024 * 1024;
/** Answers older than this were read, or nobody waits for them anymore. */
const KEEP_ANSWERS_MS = 5 * 60 * 1000;

/**
 * Answers the API's request for an app's last lines of output: writes
 * them to the logs volume and says so. The API has no Docker access.
 */
export function deploymentLogsHandler(deps: {
	db: Database;
	runtime: DockerRuntime;
	settings: { logsDir: string };
}): JobHandler<"deployment.logs"> {
	const { db, runtime, settings } = deps;
	return async (job) => {
		const { deploymentId, requestId, lines } = job.data;
		const path = runtimeLogsPath(settings.logsDir, requestId);
		await mkdir(dirname(path), { recursive: true });
		await removeOldAnswers(dirname(path));

		const result: RuntimeLogsResult = {
			deploymentId,
			container: null,
			text: "",
			truncated: false,
			writtenAt: new Date().toISOString(),
		};
		const container = await runtime.inspect(deploymentId);
		if (container) {
			const output = await runtime.logs(deploymentId, lines).catch((error) => {
				// Removed in the meantime.
				if (error instanceof DockerApiError && error.status === 404)
					return null;
				throw error;
			});
			if (output !== null) {
				const { text, truncated } = keepEnd(shortenTimes(output));
				Object.assign(result, {
					container: { status: container.status, running: container.running },
					text,
					truncated,
				});
			}
		}

		// Written whole or not at all: the API may look for it any moment.
		const partial = `${path}.partial`;
		await writeFile(partial, JSON.stringify(result));
		await rename(partial, path);
		await publishEvent(db, { type: RUNTIME_LOGS_READY, requestId });
	};
}

/** Docker's times (2026-11-09T21:04:05.123456789Z) to whole seconds. */
export function shortenTimes(text: string): string {
	return text.replace(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.\d+Z /gm, "$1Z ");
}

/** The end of the text, within MAX_RUNTIME_LOG_BYTES, cut at a line. */
export function keepEnd(text: string, maxBytes = MAX_RUNTIME_LOG_BYTES) {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return { text, truncated: false };
	let start = bytes.length - maxBytes;
	// Not inside a character: skip UTF-8 continuation bytes.
	while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
	const end = bytes.subarray(start).toString("utf8");
	const newline = end.indexOf("\n");
	return {
		text: newline === -1 ? end : end.slice(newline + 1),
		truncated: true,
	};
}

async function removeOldAnswers(dir: string) {
	const cutoff = Date.now() - KEEP_ANSWERS_MS;
	for (const name of await readdir(dir)) {
		const file = join(dir, name);
		const info = await stat(file).catch(() => null);
		if (info && info.mtimeMs < cutoff) await rm(file, { force: true });
	}
}
