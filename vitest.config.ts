import { configDefaults, defineConfig } from "vitest/config";

// Unit tests: no external services needed.
export default defineConfig({
	test: {
		include: ["{apps,packages}/*/src/**/*.test.ts"],
		exclude: [...configDefaults.exclude, "**/*.int.test.ts"],
		passWithNoTests: true,
	},
});
