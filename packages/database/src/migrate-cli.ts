// Applies pending migrations to DATABASE_URL: `pnpm db:migrate`.
import { databaseSchema, loadConfigOrExit } from "@petri/config";
import { createDatabase, migrateDatabase } from "./client.ts";

const config = loadConfigOrExit(databaseSchema);
const db = createDatabase(config.DATABASE_URL);

try {
	await migrateDatabase(db);
	console.log("Migrations applied.");
} finally {
	await db.$client.end();
}
