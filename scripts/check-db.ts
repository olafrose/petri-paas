// Verifies that the configured database is reachable: `pnpm dev:check-db`.
import { databaseSchema, loadConfigOrExit } from "@petri/config";
import pg from "pg";

const config = loadConfigOrExit(databaseSchema);
const client = new pg.Client({ connectionString: config.DATABASE_URL });

try {
	await client.connect();
	const { rows } = await client.query<{ version: string }>(
		"select current_setting('server_version') as version",
	);
	console.log(`Connected to PostgreSQL ${rows[0]?.version}`);
} catch (error) {
	// Connection failures to "localhost" arrive as an AggregateError (one
	// error per resolved address) with an empty message of its own.
	const reasons =
		error instanceof AggregateError
			? error.errors.map((inner: Error) => inner.message)
			: [(error as Error).message];
	console.error(`Database check failed: ${reasons.join("; ")}`);
	process.exitCode = 1;
} finally {
	await client.end();
}
