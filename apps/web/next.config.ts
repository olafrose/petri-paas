import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/** Where the web server reaches the API (server-side only). */
const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

const config: NextConfig = {
	// Self-contained server bundle for the container image (task 1.9).
	output: "standalone",
	outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
	poweredByHeader: false,
	// Don't generate AGENTS.md on startup.
	agentRules: false,
	// Workspace packages are TypeScript sources; compile them like app code.
	transpilePackages: ["@petri/contracts"],
	turbopack: {
		resolveAlias: {
			"@petri/contracts": "../../packages/contracts/src/index.ts",
		},
	},
	// The browser talks to the API through this app, so the admin panel and
	// the API share one origin and the session cookie.
	async rewrites() {
		return [
			{ source: "/api/v1/:path*", destination: `${apiUrl}/api/v1/:path*` },
		];
	},
	// Type-checking runs separately (pnpm typecheck), with the whole repo.
	typescript: { ignoreBuildErrors: true },
};

export default config;
