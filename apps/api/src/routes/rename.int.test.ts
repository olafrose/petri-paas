import type {
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
const GONE: DeploymentStatus[] = ["deleting", "deleted"];

/** A deployment in the given status, its build ended. */
async function deploymentIn(status: DeploymentStatus, subdomain?: string) {
	const response = await ctx.inject({
		method: "POST",
		url: "/api/v1/deployments",
		payload: {
			project: "demo",
			name: "first",
			...(subdomain && { subdomain }),
			source: {
				type: "git",
				repository: "https://github.com/example/demo",
				ref: "main",
			},
		},
	});
	const created = response.json<Deployment>();
	await ctx.db
		.update(deployments)
		.set({ status })
		.where(eq(deployments.id, created.id));
	await ctx.db
		.update(builds)
		.set({ status: "succeeded" })
		.where(eq(builds.deploymentId, created.id));
	return created;
}

const patch = (id: string, payload: object) => ({
	method: "PATCH" as const,
	url: `/api/v1/deployments/${id}`,
	payload,
});

async function events(id: string) {
	const response = await ctx.inject({
		url: `/api/v1/deployments/${id}/events`,
	});
	return response.json<DeploymentEventList>().items;
}

async function routeJobs(deploymentId: string) {
	const result = await ctx.db.execute<{ data: unknown }>(sql`
		select data from pgboss.job
		where name = 'deployment.route' and data->>'deploymentId' = ${deploymentId}
	`);
	return result.rows;
}

describe("PATCH /deployments/:id renames", () => {
	test("a new name, in the history", async () => {
		const created = await deploymentIn("ready");
		const response = await ctx.inject(
			patch(created.id, { name: "  Second try " }),
		);
		expect(response.statusCode).toBe(200);
		const body = response.json<Deployment>();
		expect(body).toMatchObject({
			name: "Second try",
			subdomain: created.subdomain,
			url: created.url,
			status: "ready",
		});
		expect((await events(created.id)).at(-1)).toMatchObject({
			type: "rename",
			message: 'Renamed from "first" to "Second try"',
			data: {
				from: "first",
				to: "Second try",
				requestedBy: { type: "owner" },
			},
		});
		// Its address stays: nothing to route.
		expect(await routeJobs(created.id)).toEqual([]);
	});

	test("a new subdomain moves the preview", async () => {
		const created = await deploymentIn("ready", "old-place");
		const response = await ctx.inject(
			patch(created.id, { subdomain: "new-place" }),
		);
		expect(response.statusCode).toBe(200);
		expect(response.json<Deployment>()).toMatchObject({
			name: "first",
			subdomain: "new-place",
			url: "https://new-place.app.example.com/",
		});
		expect((await events(created.id)).at(-1)).toMatchObject({
			type: "move",
			message:
				"Moved from https://old-place.app.example.com/ to https://new-place.app.example.com/",
			data: {
				from: "old-place",
				to: "new-place",
				url: "https://new-place.app.example.com/",
			},
		});
		expect(await routeJobs(created.id)).toEqual([
			{ data: { deploymentId: created.id } },
		]);

		// The old address is free for another culture.
		const other = await deploymentIn("ready", "old-place");
		expect(other.subdomain).toBe("old-place");
	});

	test("name, subdomain and lifecycle at once, one entry each", async () => {
		const created = await deploymentIn("stopped", "all-at-once");
		const before = (await events(created.id)).length;
		const response = await ctx.inject(
			patch(created.id, {
				name: "renamed",
				subdomain: "moved-too",
				lifecycle: { mode: "permanent" },
			}),
		);
		expect(response.statusCode).toBe(200);
		expect(response.json<Deployment>()).toMatchObject({
			name: "renamed",
			subdomain: "moved-too",
			lifecycleMode: "permanent",
			expiresAt: null,
		});
		const added = (await events(created.id)).slice(before);
		expect(added.map((event) => event.type)).toEqual([
			"rename",
			"move",
			"lifecycle",
		]);
	});

	test("the same name and subdomain change nothing", async () => {
		const created = await deploymentIn("ready", "same-place");
		const before = await events(created.id);
		const response = await ctx.inject(
			patch(created.id, { name: "first", subdomain: "same-place" }),
		);
		expect(response.statusCode).toBe(200);
		expect(await events(created.id)).toEqual(before);
		expect(await routeJobs(created.id)).toEqual([]);
	});

	test("a subdomain in use is 409, and nothing changes", async () => {
		await deploymentIn("ready", "taken");
		const created = await deploymentIn("ready", "mine");
		const before = await events(created.id);
		const response = await ctx.inject(
			patch(created.id, { name: "other", subdomain: "taken" }),
		);
		expect(response.statusCode).toBe(409);
		expect(response.json<ErrorResponse>().error.message).toBe(
			'The subdomain "taken" is already in use',
		);
		const [row] = await ctx.db
			.select()
			.from(deployments)
			.where(eq(deployments.id, created.id));
		expect(row).toMatchObject({ name: "first", subdomain: "mine" });
		expect(await events(created.id)).toEqual(before);
		expect(await routeJobs(created.id)).toEqual([]);
	});

	test("the same rules as when growing one", async () => {
		const created = await deploymentIn("ready");
		for (const payload of [
			{ name: "" },
			{ name: "   " },
			{ name: "x".repeat(101) },
			{ subdomain: "Upper" },
			{ subdomain: "-dash" },
			{ subdomain: "a.b" },
			{ subdomain: "x".repeat(64) },
			{ subdomain: "" },
			{ url: "https://elsewhere.example.com/" },
			{},
		]) {
			const response = await ctx.inject(patch(created.id, payload));
			expect(response.statusCode, JSON.stringify(payload)).toBe(400);
		}
	});

	test.each(deploymentStatus.enumValues)("from %s", async (status) => {
		const created = await deploymentIn(status);
		const response = await ctx.inject(
			patch(created.id, {
				name: "renamed",
				subdomain: `moved-${status.replace("_", "-")}`,
			}),
		);
		if (GONE.includes(status)) {
			expect(response.statusCode).toBe(409);
			expect(response.json<ErrorResponse>().error.message).toContain(
				`"${status}"`,
			);
			expect(await routeJobs(created.id)).toEqual([]);
		} else {
			// Expired too: only its lifecycle waits for a redeploy.
			expect(response.statusCode).toBe(200);
			expect(response.json<Deployment>().name).toBe("renamed");
		}
	});

	test("an expired one is renamed, but its lifecycle stays", async () => {
		const created = await deploymentIn("expired");
		const response = await ctx.inject(
			patch(created.id, { name: "renamed", lifecycle: { mode: "permanent" } }),
		);
		expect(response.statusCode).toBe(409);
		const [row] = await ctx.db
			.select({ name: deployments.name })
			.from(deployments)
			.where(eq(deployments.id, created.id));
		expect(row?.name).toBe("first");
	});

	test("a waiting request answers when it moves; the old tag is stale", async () => {
		const created = await deploymentIn("ready", "before-move");
		const url = `/api/v1/deployments/${created.id}`;
		const tag = (await ctx.inject({ url })).headers.etag as string;
		const waiting = ctx.inject({
			url: `${url}?wait=30`,
			headers: { "if-none-match": tag },
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		await ctx.inject(patch(created.id, { subdomain: "after-move" }));

		const answer = await waiting;
		expect(answer.statusCode).toBe(200);
		expect(answer.json<Deployment>().url).toBe(
			"https://after-move.app.example.com/",
		);
		expect(answer.headers.etag).not.toBe(tag);
		const again = await ctx.inject({ url, headers: { "if-none-match": tag } });
		expect(again.statusCode).toBe(200);

		// A new name, too.
		const moved = answer.headers.etag as string;
		await ctx.inject(patch(created.id, { name: "renamed" }));
		const renamed = await ctx.inject({
			url,
			headers: { "if-none-match": moved },
		});
		expect(renamed.statusCode).toBe(200);
	});

	test("an unknown deployment is 404", async () => {
		const response = await ctx.inject(patch(UNKNOWN_ID, { name: "x" }));
		expect(response.statusCode).toBe(404);
	});

	test("needs deploy:update", async () => {
		const created = await deploymentIn("ready");
		const reader = await ctx.createKey(["deploy:read", "deploy:create"]);
		const updater = await ctx.createKey(["deploy:update"]);
		const request = patch(created.id, { name: "by key" });
		expect((await ctx.withKey(reader.key, request)).statusCode).toBe(403);
		expect((await ctx.withKey(updater.key, request)).statusCode).toBe(200);
		expect((await events(created.id)).at(-1)).toMatchObject({
			data: { requestedBy: { type: "apiKey", apiKeyId: updater.apiKey.id } },
		});
	});
});
