import { useTestDatabase } from "@petri/database/testing";
import { afterAll, beforeAll } from "vitest";
import { buildApp } from "../src/app.ts";

/** A ready API instance on the test database. Call once per test file. */
export function useTestApp() {
	const db = useTestDatabase();
	let app: Awaited<ReturnType<typeof buildApp>>;

	beforeAll(async () => {
		app = await buildApp({ db });
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	return {
		db,
		get app() {
			return app;
		},
	};
}
