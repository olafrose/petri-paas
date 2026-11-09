import { defineConfig, devices } from "@playwright/test";
import { ownerSession } from "./tests/helpers.ts";

/*
 * End-to-end tests: a browser against the whole stack (web, API, worker,
 * BuildKit, Docker, the edge proxy). Run them with `pnpm test:e2e`, which
 * starts everything on a throwaway database (scripts/e2e.sh).
 */
export default defineConfig({
	testDir: "tests",
	// One stack, shared: tests run one after another.
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	reporter: [["list"], ["html", { open: "never", outputFolder: "report" }]],
	outputDir: "results",
	use: {
		baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3300",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		// Signs in once: the API allows only a few sign-ins a minute.
		{ name: "sign-in", testMatch: /sign-in\.setup\.ts$/ },
		{
			name: "desktop",
			use: { ...devices["Desktop Chrome"], storageState: ownerSession },
			dependencies: ["sign-in"],
		},
	],
});
