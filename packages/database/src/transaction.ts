import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type { Database } from "./client.ts";
import { schema } from "./client.ts";

/** A database handle bound to one open transaction. */
export type Transaction = NodePgDatabase<typeof schema> & {
	$client: pg.PoolClient;
};

/**
 * Runs `work` in a transaction on a dedicated connection. Unlike Drizzle's
 * `db.transaction`, the connection is exposed (`tx.$client`), so other
 * libraries such as pg-boss can write in the same transaction.
 */
export async function withTransaction<T>(
	db: Database,
	work: (tx: Transaction) => Promise<T>,
): Promise<T> {
	const client = await db.$client.connect();
	try {
		await client.query("begin");
		const tx = drizzle({ client, schema, casing: "snake_case" });
		const result = await work(tx);
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}
