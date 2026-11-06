import { loadConfigOrExit } from "@petri/config";
import { createDatabase, migrateDatabase } from "@petri/database";
import { JobQueue } from "@petri/jobs";
import { buildApp } from "./app.ts";
import { createAuth } from "./auth/auth.ts";
import { apiConfigSchema, oidcOptions } from "./config.ts";

const config = loadConfigOrExit(apiConfigSchema);
const db = createDatabase(config.DATABASE_URL);
await migrateDatabase(db);

const auth = createAuth({
	db,
	publicUrl: config.PUBLIC_URL,
	secret: config.AUTH_SECRET,
	oidc: oidcOptions(config),
});
const jobs = await JobQueue.start({
	connectionString: config.DATABASE_URL,
	maxConnections: 2,
});
const app = await buildApp({
	db,
	auth,
	jobs,
	publicUrl: config.PUBLIC_URL,
	trustProxy: config.TRUST_PROXY,
	logger: { level: config.LOG_LEVEL },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, async () => {
		app.log.info({ signal }, "shutting down");
		await app.close();
		await jobs.stop();
		await db.$client.end();
	});
}

await app.listen({ host: config.API_HOST, port: config.API_PORT });
