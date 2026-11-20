import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildZip } from "@petri/build-engine/testing";
import type {
	BuildList,
	Deployment,
	DeploymentEventList,
	ErrorResponse,
} from "@petri/contracts";
import {
	builds,
	type DeploymentStatus,
	deploymentStatus,
	deployments,
} from "@petri/database";
import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { useTestApp } from "../../test/app.ts";

const ctx = useTestApp();
const UNKNOWN_ID = "0190a0e0-0000-7000-8000-000000000000";
const REDEPLOYABLE: DeploymentStatus[] = [
	"ready",
	"stopped",
	"failed",
	"expired",
];

const archive = () =>
	buildZip([
		{ name: "demo-main/", mode: 0o040755 },
		{ name: "demo-main/Dockerfile", data: "FROM nginx:alpine\n" },
	]);

async function form(fields: Record<string, string | Buffer>) {
	const data = new FormData();
	for (const [name, value] of Object.entries(fields)) {
		if (typeof value === "string") data.set(name, value);
		else data.set(name, new Blob([new Uint8Array(value)]), "app.zip");
	}
	const encoded = new Response(data);
	return {
		payload: Buffer.from(await encoded.arrayBuffer()),
		headers: { "content-type": encoded.headers.get("content-type") as string },
	};
}

/** A deployment in the given status whose first build has ended. */
async function deploymentIn(status: DeploymentStatus, from: "git" | "zip") {
	const response =
		from === "git"
			? await ctx.inject({
					method: "POST",
					url: "/api/v1/deployments",
					payload: {
						project: "demo",
						source: {
							type: "git",
							repository: "https://github.com/example/demo",
							ref: "main",
						},
					},
				})
			: await ctx.inject({
					method: "POST",
					url: "/api/v1/deployments/upload",
					...(await form({
						settings: JSON.stringify({ project: "demo" }),
						archive: archive(),
					})),
				});
	const created = response.json<Deployment>();
	await ctx.db
		.update(deployments)
		.set({ status })
		.where(eq(deployments.id, created.id));
	await ctx.db
		.update(builds)
		.set({ status: status === "failed" ? "failed" : "succeeded" })
		.where(eq(builds.deploymentId, created.id));
	return created;
}

const redeploy = (id: string, payload?: Record<string, unknown>) =>
	ctx.inject({
		method: "POST",
		url: `/api/v1/deployments/${id}/redeploy`,
		...(payload !== undefined && { payload }),
	});

const uploadNew = async (id: string, fields = { archive: archive() }) =>
	ctx.inject({
		method: "POST",
		url: `/api/v1/deployments/${id}/upload`,
		...(await form(fields)),
	});

async function buildsOf(id: string) {
	const response = await ctx.inject({
		url: `/api/v1/deployments/${id}/builds`,
	});
	return response.json<BuildList>().items;
}

async function runJobs(deploymentId: string) {
	const result = await ctx.db.execute<{ data: { buildId: string } }>(sql`
		select data from pgboss.job
		where name = 'deployment.run' and data->>'deploymentId' = ${deploymentId}
	`);
	return result.rows.map((row) => row.data.buildId);
}

async function lastEvent(id: string) {
	const response = await ctx.inject({
		url: `/api/v1/deployments/${id}/events`,
	});
	return response.json<DeploymentEventList>().items.at(-1);
}

async function rowOf(id: string) {
	const [row] = await ctx.db
		.select()
		.from(deployments)
		.where(eq(deployments.id, id));
	return row;
}

describe("POST /deployments/:id/redeploy", () => {
	test.each(deploymentStatus.enumValues)("from %s", async (status) => {
		const created = await deploymentIn(status, "git");
		const response = await redeploy(created.id);

		if (!REDEPLOYABLE.includes(status)) {
			expect(response.statusCode).toBe(409);
			expect(response.json<ErrorResponse>().error.message).toContain(
				`"${status}"`,
			);
			expect(await buildsOf(created.id)).toHaveLength(1);
			return;
		}
		expect(response.statusCode).toBe(202);
		const body = response.json<Deployment>();
		const [newest] = await buildsOf(created.id);
		expect(body.latestBuild).toMatchObject({
			id: newest?.id,
			status: "queued",
			ref: "main",
		});
		expect(await runJobs(created.id)).toContain(newest?.id);
		// A ready one keeps answering; the others start over.
		const expected = status === "ready" ? "ready" : "queued";
		expect(body.status).toBe(expected);
		expect((await rowOf(created.id))?.status).toBe(expected);
		expect(await lastEvent(created.id)).toMatchObject({
			type: status === "ready" ? "build" : "status",
			message: "Redeploy requested",
			data: {
				action: "redeploy",
				buildId: newest?.id,
				requestedBy: { type: "owner" },
			},
		});
	});

	test("one build at a time", async () => {
		const created = await deploymentIn("ready", "git");
		const first = await redeploy(created.id);
		expect(first.statusCode).toBe(202);
		expect(first.json<Deployment>().actions).toEqual(["stop", "delete"]);
		const again = await redeploy(created.id);
		expect(again.statusCode).toBe(409);
		expect(again.json<ErrorResponse>().error.message).toContain(
			"already running",
		);

		await ctx.db
			.update(builds)
			.set({ status: "running" })
			.where(eq(builds.deploymentId, created.id));
		expect((await redeploy(created.id)).statusCode).toBe(409);

		await ctx.db
			.update(builds)
			.set({ status: "failed" })
			.where(eq(builds.deploymentId, created.id));
		expect((await redeploy(created.id)).statusCode).toBe(202);
	});

	test("a new ref is built, and becomes the source only once live", async () => {
		const created = await deploymentIn("ready", "git");
		const response = await redeploy(created.id, { ref: "feature/x" });
		expect(response.statusCode).toBe(202);
		const body = response.json<Deployment>();
		expect(body.latestBuild?.ref).toBe("feature/x");
		expect(body.source).toMatchObject({ type: "git", ref: "main" });
		expect(await lastEvent(created.id)).toMatchObject({
			data: { ref: "feature/x" },
		});
		const [newest, first] = await buildsOf(created.id);
		expect(newest?.ref).toBe("feature/x");
		expect(first?.ref).toBe("main");
	});

	test("checks the ref", async () => {
		const created = await deploymentIn("ready", "git");
		const response = await redeploy(created.id, { ref: "bad ref" });
		expect(response.statusCode).toBe(400);
		expect((await redeploy(created.id, { other: 1 })).statusCode).toBe(400);
	});

	test("a ZIP culture has no ref to change", async () => {
		const created = await deploymentIn("ready", "zip");
		const response = await redeploy(created.id, { ref: "main" });
		expect(response.statusCode).toBe(409);
		expect(response.json<ErrorResponse>().error.message).toContain(
			"upload a new archive",
		);
		// Without one, it builds the same archive again.
		expect((await redeploy(created.id)).statusCode).toBe(202);
	});

	test("an unknown deployment is 404", async () => {
		expect((await redeploy(UNKNOWN_ID)).statusCode).toBe(404);
	});

	test("needs deploy:update", async () => {
		const created = await deploymentIn("ready", "git");
		const creator = await ctx.createKey(["deploy:create", "deploy:read"]);
		const updater = await ctx.createKey(["deploy:update"]);
		const url = `/api/v1/deployments/${created.id}/redeploy`;
		expect(
			(await ctx.withKey(creator.key, { method: "POST", url })).statusCode,
		).toBe(403);
		expect(
			(await ctx.withKey(updater.key, { method: "POST", url })).statusCode,
		).toBe(202);
		expect(await lastEvent(created.id)).toMatchObject({
			data: { requestedBy: { type: "apiKey", apiKeyId: updater.apiKey.id } },
		});
	});
});

describe("POST /deployments/:id/upload", () => {
	test("stores the new archive for a new build; the old one stays", async () => {
		const created = await deploymentIn("ready", "zip");
		const response = await uploadNew(created.id);
		expect(response.statusCode).toBe(202);
		const body = response.json<Deployment>();
		expect(body.status).toBe("ready");
		expect(body.latestBuild?.status).toBe("queued");

		const [newest] = await ctx.db
			.select({ source: builds.source })
			.from(builds)
			.where(eq(builds.id, body.latestBuild?.id as string));
		const oldSource = created.source as { uploadId: string };
		const newSource = newest?.source as { type: string; uploadId: string };
		expect(newSource.type).toBe("zip");
		expect(newSource.uploadId).not.toBe(oldSource.uploadId);
		expect(body.source).toEqual(created.source);
		for (const uploadId of [oldSource.uploadId, newSource.uploadId]) {
			expect(existsSync(join(ctx.uploadsDir, `${uploadId}.zip`))).toBe(true);
		}
	});

	test("from stopped, the culture goes through queued", async () => {
		const created = await deploymentIn("stopped", "zip");
		const response = await uploadNew(created.id);
		expect(response.json<Deployment>().status).toBe("queued");
	});

	test("refused for Git cultures, busy ones and unknown ids; nothing is kept", async () => {
		const before = readdirSync(ctx.uploadsDir);
		const git = await deploymentIn("ready", "git");
		const refused = await uploadNew(git.id);
		expect(refused.statusCode).toBe(409);
		expect(refused.json<ErrorResponse>().error.message).toContain(
			"built from Git",
		);

		const building = await deploymentIn("building", "zip");
		expect((await uploadNew(building.id)).statusCode).toBe(409);
		expect((await uploadNew(UNKNOWN_ID)).statusCode).toBe(404);

		const ready = await deploymentIn("ready", "zip");
		expect((await uploadNew(ready.id)).statusCode).toBe(202);
		const after = readdirSync(ctx.uploadsDir);
		// Only the two archives of the ZIP cultures above, and the new one.
		expect(after.length - before.length).toBe(3);
		// A second while the first is queued: refused, not stored.
		expect((await uploadNew(ready.id)).statusCode).toBe(409);
		expect(readdirSync(ctx.uploadsDir)).toHaveLength(after.length);
	});

	test("checks the archive and the fields", async () => {
		const created = await deploymentIn("ready", "zip");
		const notZip = await uploadNew(created.id, {
			archive: Buffer.from("not a zip"),
		});
		expect(notZip.statusCode).toBe(400);
		expect(notZip.json<ErrorResponse>().error.code).toBe("invalid_archive");
		const extra = await ctx.inject({
			method: "POST",
			url: `/api/v1/deployments/${created.id}/upload`,
			...(await form({ settings: "{}", archive: archive() })),
		});
		expect(extra.statusCode).toBe(400);
		expect(extra.json<ErrorResponse>().error.message).toBe(
			'Unexpected field "settings"',
		);
		expect(await buildsOf(created.id)).toHaveLength(1);
	});

	test("needs deploy:update", async () => {
		const created = await deploymentIn("ready", "zip");
		const creator = await ctx.createKey(["deploy:create", "deploy:read"]);
		const response = await ctx.withKey(creator.key, {
			method: "POST",
			url: `/api/v1/deployments/${created.id}/upload`,
			...(await form({ archive: archive() })),
		});
		expect(response.statusCode).toBe(403);
	});
});

describe("GET /deployments/:id/builds", () => {
	test("lists every build, newest first", async () => {
		const created = await deploymentIn("failed", "git");
		await redeploy(created.id, { ref: "v2" });
		const items = await buildsOf(created.id);
		expect(items.map((build) => [build.ref, build.status])).toEqual([
			["v2", "queued"],
			["main", "failed"],
		]);
	});

	test("an unknown deployment is 404", async () => {
		const response = await ctx.inject({
			url: `/api/v1/deployments/${UNKNOWN_ID}/builds`,
		});
		expect(response.statusCode).toBe(404);
	});
});
