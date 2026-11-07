import {
	type Database,
	type Transaction,
	withTransaction,
} from "@petri/database";
import { sql } from "drizzle-orm";

/**
 * Runs `work` in a transaction holding the deployment's lock, so actions
 * on one deployment never overlap: e.g. after a quick stop and start, the
 * stop can't reach Docker after the start. Unlike the row lock, it doesn't
 * hold up the API. `work` uses only `tx`: one connection per lock.
 */
export function withDeploymentLock<T>(
	db: Database,
	deploymentId: string,
	work: (tx: Transaction) => Promise<T>,
): Promise<T> {
	return withTransaction(db, async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`deployment:${deploymentId}`}, 0))`,
		);
		return work(tx);
	});
}
