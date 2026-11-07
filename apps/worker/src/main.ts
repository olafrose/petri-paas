import { loadConfigOrExit } from "@petri/config";
import { createDatabase } from "@petri/database";
import { CaddyEdgeProxy } from "@petri/edge-proxy";
import { JobQueue } from "@petri/jobs";
import { DockerRuntime } from "@petri/runtime";
import { pino } from "pino";
import { workerConfigSchema } from "./config.ts";
import { EdgeRouting } from "./edge-routing.ts";
import { registerHandlers } from "./handlers/index.ts";
import { syncRoutes } from "./route-sync.ts";

/** How often routes are checked against the database. */
const ROUTE_SYNC_MS = 30_000;

// The API applies database migrations on startup; the worker relies on it.
const config = loadConfigOrExit(workerConfigSchema);
const log = pino({ level: config.LOG_LEVEL, base: { service: "worker" } });
const db = createDatabase(config.DATABASE_URL);

const runtime = new DockerRuntime(config.DOCKER_HOST);
const edge = new EdgeRouting(
	new CaddyEdgeProxy(config.EDGE_ADMIN_SOCKET),
	runtime,
	{
		previewBaseUrl: config.PREVIEW_BASE_URL,
		edgeContainer: config.EDGE_CONTAINER,
		trustedProxies: config.EDGE_TRUSTED_PROXIES,
	},
);

// Caddy keeps routes only in memory; bring them back after it restarted.
// A failed sync doesn't stop the worker: builds go on, the next try fixes
// the routes.
let syncing = false;
async function sync() {
	if (syncing) return;
	syncing = true;
	try {
		await syncRoutes(db, edge, log);
	} catch (error) {
		log.error({ err: error }, "edge proxy route sync failed");
	} finally {
		syncing = false;
	}
}
await sync();
const syncTimer = setInterval(sync, ROUTE_SYNC_MS);

const queue = await JobQueue.start({
	connectionString: config.DATABASE_URL,
	onError: (error) => log.error({ err: error }, "job queue error"),
});
await registerHandlers(queue, {
	db,
	log,
	runtime,
	edge,
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
		clearInterval(syncTimer);
		// Jobs still running after the timeout are retried by the next worker.
		await queue.stop({ graceful: true, timeoutMs: 30_000 });
		await db.$client.end();
		log.info("worker stopped");
	});
}
