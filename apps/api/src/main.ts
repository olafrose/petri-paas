import { loadConfigOrExit } from "@petri/config";
import { createDatabase, migrateDatabase } from "@petri/database";
import { buildApp } from "./app.ts";
import { apiConfigSchema } from "./config.ts";

const config = loadConfigOrExit(apiConfigSchema);
const db = createDatabase(config.DATABASE_URL);
await migrateDatabase(db);

const app = await buildApp({ db, logger: { level: config.LOG_LEVEL } });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, async () => {
		app.log.info({ signal }, "shutting down");
		await app.close();
		await db.$client.end();
	});
}

await app.listen({ host: config.API_HOST, port: config.API_PORT });
