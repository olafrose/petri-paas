import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as authSchema from "./auth-schema.ts";
import * as appSchema from "./schema.ts";

export const schema = { ...appSchema, ...authSchema };

export type Database = NodePgDatabase<typeof schema> & { $client: pg.Pool };

/**
 * Creates a connection pool and Drizzle client. The pool is exposed as
 * `db.$client` so other libraries (pg-boss) can share it; call
 * `db.$client.end()` on shutdown.
 */
export function createDatabase(connectionString: string): Database {
	const pool = new pg.Pool({ connectionString });
	return drizzle({ client: pool, schema, casing: "snake_case" });
}

/** SQL migrations live next to `src/` and `dist/`, so this works for both. */
const migrationsFolder = new URL("../migrations", import.meta.url).pathname;

/** Applies all pending migrations. Safe to run on every start. */
export async function migrateDatabase(db: Database): Promise<void> {
	await migrate(db, { migrationsFolder });
}
