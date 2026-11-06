import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildZip, type TestZipEntry } from "@petri/build-engine/testing";
import type { Deployment, ErrorResponse } from "@petri/contracts";
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { useTestApp } from "../../test/app.ts";

const ctx = useTestApp();

const validArchive: TestZipEntry[] = [
	{ name: "demo-main/", mode: 0o040755 },
	{ name: "demo-main/Dockerfile", data: "FROM nginx:alpine\n" },
	{ name: "demo-main/index.html", data: "<h1>hi</h1>\n" },
];
const settings = { project: "demo" };

async function form(fields: {
	settings?: unknown;
	archive?: Buffer;
	extra?: Record<string, string>;
}) {
	const data = new FormData();
	if (fields.settings !== undefined) {
		data.set(
			"settings",
			typeof fields.settings === "string"
				? fields.settings
				: JSON.stringify(fields.settings),
		);
	}
	for (const [name, value] of Object.entries(fields.extra ?? {})) {
		data.set(name, value);
	}
	if (fields.archive) {
		data.set("archive", new Blob([new Uint8Array(fields.archive)]), "app.zip");
	}
	const encoded = new Response(data);
	return {
		payload: Buffer.from(await encoded.arrayBuffer()),
		headers: { "content-type": encoded.headers.get("content-type") as string },
	};
}

async function upload(fields: Parameters<typeof form>[0]) {
	return ctx.inject({
		method: "POST",
		url: "/api/v1/deployments/upload",
		...(await form(fields)),
	});
}

function storedUploads() {
	return readdirSync(ctx.uploadsDir);
}

async function queuedJobs() {
	const result = await ctx.db.execute(
		sql`select 1 from pgboss.job where name = 'deployment.run'`,
	);
	return result.rows.length;
}

describe("POST /deployments/upload", () => {
	test("stores the archive and queues the deployment", async () => {
		const jobsBefore = await queuedJobs();
		const response = await upload({
			settings: {
				...settings,
				name: "mockup v2",
				lifecycle: { mode: "permanent" },
			},
			archive: buildZip(validArchive),
		});
		expect(response.statusCode).toBe(201);
		const created = response.json<Deployment>();
		expect(created).toMatchObject({
			name: "mockup v2",
			subdomain: "demo-mockup-v2",
			status: "queued",
			lifecycleMode: "permanent",
			source: { type: "zip" },
		});
		const { uploadId } = created.source as { uploadId: string };
		expect(storedUploads()).toContain(`${uploadId}.zip`);
		expect(existsSync(join(ctx.uploadsDir, `${uploadId}.zip`))).toBe(true);
		expect(await queuedJobs()).toBe(jobsBefore + 1);
	});

	test('defaults the name to "upload"', async () => {
		const response = await upload({
			settings,
			archive: buildZip(validArchive),
		});
		expect(response.json<Deployment>().name).toBe("upload");
	});

	test.each<[string, TestZipEntry[]]>([
		["path traversal", [{ name: "../../etc/cron.d/x", data: "x" }]],
		["symbolic link", [{ name: "link", data: "/etc/shadow", mode: 0o120777 }]],
		["absolute path", [{ name: "/root/.ssh/authorized_keys", data: "x" }]],
	])(
		"refuses an archive with a %s and keeps nothing",
		async (_label, entries) => {
			const before = storedUploads();
			const jobsBefore = await queuedJobs();
			const response = await upload({ settings, archive: buildZip(entries) });
			expect(response.statusCode).toBe(400);
			expect(response.json<ErrorResponse>().error.code).toBe("invalid_archive");
			expect(storedUploads()).toEqual(before);
			expect(await queuedJobs()).toBe(jobsBefore);
		},
	);

	test("refuses files that are not ZIP archives", async () => {
		const response = await upload({
			settings,
			archive: Buffer.from("#!/bin/sh\necho hi\n"),
		});
		expect(response.statusCode).toBe(400);
		expect(response.json<ErrorResponse>().error.code).toBe("invalid_archive");
	});

	test("refuses archives over the upload limit (1 MB in tests)", async () => {
		const before = storedUploads();
		// Stored, not compressed, so the upload itself is over 1 MB.
		const big = buildZip([
			{ name: "big.bin", data: Buffer.alloc(2 * 1024 * 1024) },
		]);
		const response = await upload({ settings, archive: big });
		expect(response.statusCode).toBe(413);
		expect(response.json<ErrorResponse>().error.code).toBe("too_large");
		expect(storedUploads()).toEqual(before);
	});

	test.each<[string, Parameters<typeof form>[0], string]>([
		["missing archive", { settings }, "archive"],
		["missing settings", { archive: buildZip(validArchive) }, "settings"],
		[
			"settings that aren't JSON",
			{ settings: "{nope", archive: buildZip(validArchive) },
			"JSON",
		],
		[
			"an unexpected field",
			{ settings, archive: buildZip(validArchive), extra: { x: "1" } },
			"",
		],
	])("refuses %s", async (_label, fields, message) => {
		const response = await upload(fields);
		expect(response.statusCode).toBe(400);
		expect(response.json<ErrorResponse>().error.message).toContain(message);
	});

	test("validates settings with field paths", async () => {
		const response = await upload({
			settings: { project: "Bad Slug", directory: "../x" },
			archive: buildZip(validArchive),
		});
		expect(response.statusCode).toBe(400);
		const paths = response
			.json<ErrorResponse>()
			.error.details?.map((d) => d.path);
		expect(paths?.sort()).toEqual(["settings.directory", "settings.project"]);
	});

	test("a failure after storing the archive removes it again", async () => {
		await upload({
			settings: { ...settings, subdomain: "taken" },
			archive: buildZip(validArchive),
		});
		const before = storedUploads();
		const response = await upload({
			settings: { ...settings, subdomain: "taken" },
			archive: buildZip(validArchive),
		});
		expect(response.statusCode).toBe(409);
		expect(storedUploads()).toEqual(before);
	});

	test("needs the deploy:create scope", async () => {
		const reader = await ctx.createKey(["deploy:read"]);
		const response = await ctx.withKey(reader.key, {
			method: "POST",
			url: "/api/v1/deployments/upload",
			...(await form({ settings, archive: buildZip(validArchive) })),
		});
		expect(response.statusCode).toBe(403);
	});
});
