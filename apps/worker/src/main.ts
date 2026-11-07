import { loadConfigOrExit } from "@petri/config";
import { createDatabase } from "@petri/database";
import { JobQueue } from "@petri/jobs";
import { DockerRuntime } from "@petri/runtime";
import { pino } from "pino";
import { workerConfigSchema } from "./config.ts";
import { registerHandlers } from "./handlers/index.ts";

// The API applies database migrations on startup; the worker relies on it.
const config = loadConfigOrExit(workerConfigSchema);
const log = pino({ level: config.LOG_LEVEL, base: { service: "worker" } });
const db = createDatabase(config.DATABASE_URL);

const queue = await JobQueue.start({
	connectionString: config.DATABASE_URL,
	onError: (error) => log.error({ err: error }, "job queue error"),
});
await registerHandlers(queue, {
	db,
	log,
	runtime: new DockerRuntime(config.DOCKER_HOST),
	settings: {
		workspaceDir: config.WORKSPACE_DIR,
		logsDir: config.LOGS_DIR,
		uploadsDir: config.UPLOADS_DIR,
		buildkitHost: config.BUILDKIT_HOST,
		buildctlPath: config.BUILDCTL_PATH,
		workerContainer: config.WORKER_CONTAINER,
	},
});
log.info("worker started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, async () => {
		log.info({ signal }, "shutting down; waiting for running jobs");
		// Jobs still running after the timeout are retried by the next worker.
		await queue.stop({ graceful: true, timeoutMs: 30_000 });
		await db.$client.end();
		log.info("worker stopped");
	});
}
