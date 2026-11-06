import { configDefaults, defineConfig } from "vitest/config";
import { sharedConfig } from "./vitest.shared.ts";

// Unit tests: no external services needed.
export default defineConfig({
	...sharedConfig,
	test: {
		include: ["{apps,packages}/*/src/**/*.test.ts"],
		exclude: [...configDefaults.exclude, "**/*.int.test.ts"],
		passWithNoTests: true,
	},
});
