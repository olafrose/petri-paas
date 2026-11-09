import type { Settings } from "@petri/contracts";
import { describe, expect, test } from "vitest";
import { previewBaseUrl, publicUrl, useTestApp } from "../../test/app.ts";

const ctx = useTestApp();

describe("GET /settings", () => {
	test("shows the URLs, version and the limits in force", async () => {
		const response = await ctx.inject({ url: "/api/v1/settings" });
		expect(response.statusCode).toBe(200);
		expect(response.json<Settings>()).toEqual({
			publicUrl,
			previewBaseUrl,
			version: "development",
			limits: {
				// The test app allows 1 MB uploads (test/app.ts).
				upload: {
					maxBytes: 1024 * 1024,
					maxExtractedBytes: 500 * 1024 * 1024,
					maxFiles: 20_000,
				},
				git: { timeoutSeconds: 120, maxBytes: 500 * 1024 * 1024 },
				build: { timeoutSeconds: 900 },
				container: { memoryBytes: 512 * 1024 * 1024, cpus: 1, processes: 256 },
				healthCheck: { timeoutSeconds: 60 },
				temporaryTtlHours: { default: 48, max: 720 },
			},
		});
	});

	test("is readable with a deploy:read key, not anonymously", async () => {
		const { key } = await ctx.createKey(["deploy:read"]);
		const withKey = await ctx.withKey(key, { url: "/api/v1/settings" });
		expect(withKey.statusCode).toBe(200);
		const anonymous = await ctx.anonymous({ url: "/api/v1/settings" });
		expect(anonymous.statusCode).toBe(401);
	});
});
