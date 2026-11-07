import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commonSchema, databaseSchema, previewSchema } from "@petri/config";
import { z } from "zod";

const dataDir = (name: string) => join(tmpdir(), `petri-${name}`);

/** In development, buildctl from scripts/install-buildctl.sh. */
const repoBuildctl = new URL("../../../.tools/bin/buildctl", import.meta.url)
	.pathname;
const defaultBuildctl = existsSync(repoBuildctl) ? repoBuildctl : "buildctl";

/** In development, the socket of the edge proxy from dev.yml. */
const repoEdgeSocket = new URL(
	"../../../.tools/edge/admin.sock",
	import.meta.url,
).pathname;

/** The defaults suit development; docker-compose.yml sets its own. */
export const workerConfigSchema = commonSchema
	.extend(databaseSchema.shape)
	.extend(previewSchema.shape)
	.extend({
		/** Uploaded ZIP archives (shared with the API). */
		UPLOADS_DIR: z.string().default(dataDir("uploads")),
		/** Scratch space for sources and image archives during a build. */
		WORKSPACE_DIR: z.string().default(dataDir("workspaces")),
		/** Build logs, kept after the build (read by the API). */
		LOGS_DIR: z.string().default(dataDir("logs")),
		BUILDKIT_HOST: z.string().default("tcp://127.0.0.1:1234"),
		BUILDCTL_PATH: z.string().default(defaultBuildctl),
		/** Docker, through the socket proxy. */
		DOCKER_HOST: z.string().default("tcp://127.0.0.1:2375"),
		/**
		 * The worker's own container, when it runs in one: it joins each
		 * deployment's network to health-check the app. Unset: the worker
		 * runs on the host and reaches container addresses directly.
		 */
		WORKER_CONTAINER: z.string().optional(),
		/** The edge proxy's admin socket (see infrastructure/caddy). */
		EDGE_ADMIN_SOCKET: z.string().default(repoEdgeSocket),
		/** The edge proxy's container; it joins each routed app's network. */
		EDGE_CONTAINER: z.string().default("petri-dev-edge-1"),
		/**
		 * Comma-separated addresses/CIDRs whose X-Forwarded-* headers the
		 * edge proxy keeps: the NPM VM. Empty: trust none.
		 */
		EDGE_TRUSTED_PROXIES: z
			.string()
			.default("")
			.transform((value) =>
				value
					.split(",")
					.map((entry) => entry.trim())
					.filter(Boolean),
			),
	});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;
