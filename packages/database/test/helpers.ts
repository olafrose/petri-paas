import { sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, inject } from "vitest";
import { createDatabase, type Database } from "../src/client.ts";
import { isConstraintViolation } from "../src/errors.ts";

// Set by global-setup.ts for each test run.
declare module "vitest" {
	export interface ProvidedContext {
		databaseUrl: string;
	}
}

/**
 * Connects to the test run's database and empties all tables before each
 * test. Call once at the top of a test file.
 */
export function useTestDatabase(): Database {
	const db = createDatabase(inject("databaseUrl"));

	beforeEach(async () => {
		await db.execute(sql`
			truncate projects, deployments, builds, deployment_events, api_keys
			restart identity cascade
		`);
	});

	afterAll(async () => {
		await db.$client.end();
	});

	return db;
}

/** Asserts that a query fails because of the named constraint. */
export async function expectConstraintViolation(
	query: PromiseLike<unknown>,
	constraint: string,
) {
	const error: unknown = await Promise.resolve(query).then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(error, `expected a violation of ${constraint}`).toBeDefined();
	expect(
		isConstraintViolation(error, constraint),
		`expected a violation of ${constraint}, got: ${String(error)}`,
	).toBe(true);
}
