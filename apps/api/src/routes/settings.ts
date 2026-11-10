import {
	DEFAULT_BUILD_TIMEOUT_MS,
	DEFAULT_GIT_LIMITS,
	DEFAULT_ZIP_LIMITS,
	type ZipLimits,
} from "@petri/build-engine";
import { type Settings, settings, TTL_HOURS } from "@petri/contracts";
// Only the worker's defaults: the API has no Docker access.
import { DEFAULT_HEALTH_TIMEOUT_MS, DEFAULT_LIMITS } from "@petri/runtime";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { DEFAULT_MAX_UPLOAD_BYTES } from "./uploads.ts";

const toSeconds = (ms: number) => Math.round(ms / 1000);

/** The installation's settings and limits, read-only. */
export const settingsRoutes: FastifyPluginAsyncZod<{
	publicUrl: string;
	previewBaseUrl: string;
	commit?: string | undefined;
	maxUploadBytes?: number | undefined;
	zipLimits?: ZipLimits | undefined;
}> = async (app, options) => {
	const body: Settings = {
		publicUrl: options.publicUrl,
		previewBaseUrl: options.previewBaseUrl,
		version: options.commit ?? "development",
		limits: {
			upload: {
				maxBytes: options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
				maxExtractedBytes: (options.zipLimits ?? DEFAULT_ZIP_LIMITS).maxBytes,
				maxFiles: (options.zipLimits ?? DEFAULT_ZIP_LIMITS).maxEntries,
			},
			git: {
				timeoutSeconds: toSeconds(DEFAULT_GIT_LIMITS.timeoutMs),
				maxBytes: DEFAULT_GIT_LIMITS.maxBytes,
			},
			build: { timeoutSeconds: toSeconds(DEFAULT_BUILD_TIMEOUT_MS) },
			container: {
				memoryBytes: DEFAULT_LIMITS.memoryBytes,
				cpus: DEFAULT_LIMITS.cpus,
				processes: DEFAULT_LIMITS.pids,
			},
			healthCheck: { timeoutSeconds: toSeconds(DEFAULT_HEALTH_TIMEOUT_MS) },
			temporaryTtlHours: { ...TTL_HOURS },
		},
	};

	app.get(
		"/settings",
		{
			config: { access: { scope: "deploy:read" } },
			schema: {
				tags: ["settings"],
				summary: "Settings and limits",
				description:
					"Read-only: settings are changed in the installation's `.env`. Useful to check limits before deploying.",
				response: { 200: settings },
			},
		},
		async () => body,
	);
};
