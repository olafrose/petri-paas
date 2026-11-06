import { defineConfig } from "vitest/config";

// Integration tests: need PostgreSQL (TEST_DATABASE_URL, defaulting to the
// dev database from infrastructure/compose/dev.yml). A temporary database
// is created for each run and dropped afterwards.
export default defineConfig({
	test: {
		include: ["{apps,packages}/*/src/**/*.int.test.ts"],
		globalSetup: ["packages/database/test/global-setup.ts"],
		// Test files share one database and reset it between tests.
		fileParallelism: false,
	},
});
