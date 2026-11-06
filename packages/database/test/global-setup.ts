import pg from "pg";
import type { TestProject } from "vitest/node";
import { createDatabase, migrateDatabase } from "../src/client.ts";

declare module "vitest" {
	export interface ProvidedContext {
		databaseUrl: string;
	}
}

const DEFAULT_URL = "postgres://petri:petri@localhost:5432/petri";

/** Creates a migrated, throw-away database for one test run. */
export default async function setup(project: TestProject) {
	const serverUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_URL;
	const name = `petri_test_${process.pid}_${Date.now()}`;

	await withAdminClient(serverUrl, (client) =>
		client.query(`create database "${name}"`),
	);

	const url = new URL(serverUrl);
	url.pathname = `/${name}`;
	const db = createDatabase(url.toString());
	try {
		await migrateDatabase(db);
	} finally {
		await db.$client.end();
	}

	project.provide("databaseUrl", url.toString());

	return async () => {
		await withAdminClient(serverUrl, (client) =>
			client.query(`drop database "${name}" with (force)`),
		);
	};
}

async function withAdminClient(
	connectionString: string,
	run: (client: pg.Client) => Promise<unknown>,
) {
	const client = new pg.Client({ connectionString });
	await client.connect();
	try {
		await run(client);
	} finally {
		await client.end();
	}
}
