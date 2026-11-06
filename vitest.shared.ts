import { defaultServerConditions } from "vite";
import type { ViteUserConfig } from "vitest/config";

/**
 * Resolve workspace packages to their TypeScript sources (the
 * `@petri/source` export condition), so tests never need a build first.
 */
export const sharedConfig = {
	ssr: {
		resolve: {
			conditions: ["@petri/source", ...defaultServerConditions],
		},
	},
} satisfies ViteUserConfig;
