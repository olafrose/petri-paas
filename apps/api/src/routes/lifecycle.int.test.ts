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
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { useTestApp } from "../../test/app.ts";

const ctx = useTestApp();
const UNKNOWN_ID = "0190a0e0-0000-7000-8000-000000000000";
const HOUR_MS = 60 * 60 * 1000;
const FIXED: DeploymentStatus[] = ["expired", "deleting", "deleted"];

/** A temporary deployment (48 hours) in the given status, its build ended. */
async function deploymentIn(status: DeploymentStatus, lifecycle?: object) {
	const response = await ctx.inject({
		method: "POST",
		url: "/api/v1/deployments",
		payload: {
			project: "demo",
			source: {
				type: "git",
				repository: "https://github.com/example/demo",
				ref: "main",
			},
			...(lifecycle && { lifecycle }),
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

const patch = (id: string, lifecycle: unknown) => ({
	method: "PATCH" as const,
	url: `/api/v1/deployments/${id}`,
	payload: { lifecycle },
});

async function lastEvent(id: string) {
	const response = await ctx.inject({
		url: `/api/v1/deployments/${id}/events`,
	});
	return response.json<DeploymentEventList>().items.at(-1);
}

/** Close to `hours` from now (the request took a moment). */
function expectHoursFromNow(iso: string | null, hours: number) {
	expect(iso).not.toBeNull();
	const ms = Date.parse(iso as string) - Date.now();
	expect(Math.abs(ms - hours * HOUR_MS)).toBeLessThan(60_000);
}

describe("PATCH /deployments/:id", () => {
	test("extends a temporary deployment, counted from now", async () => {
		const created = await deploymentIn("ready");
		const response = await ctx.inject(
			patch(created.id, { mode: "temporary", ttlHours: 720 }),
		);
		expect(response.statusCode).toBe(200);
		const body = response.json<Deployment>();
		expect(body.lifecycleMode).toBe("temporary");
		expectHoursFromNow(body.expiresAt, 720);
		expect(body.status).toBe("ready");
		expect(await lastEvent(created.id)).toMatchObject({
			type: "lifecycle",
			message: "Extended: expires in 720 hours",
			data: {
				lifecycleMode: "temporary",
				expiresAt: body.expiresAt,
				requestedBy: { type: "owner" },
			},
		});
	});

	test("ttlHours defaults to 48", async () => {
		const created = await deploymentIn("stopped");
		const body = (
			await ctx.inject(patch(created.id, { mode: "temporary" }))
		).json<Deployment>();
		expectHoursFromNow(body.expiresAt, 48);
	});

	test("makes it permanent, and temporary again", async () => {
		const created = await deploymentIn("ready");
		const kept = (
			await ctx.inject(patch(created.id, { mode: "permanent" }))
		).json<Deployment>();
		expect(kept).toMatchObject({ lifecycleMode: "permanent", expiresAt: null });
		expect((await lastEvent(created.id))?.message).toBe(
			"Kept: permanent, no expiry",
		);

		const again = (
			await ctx.inject(patch(created.id, { mode: "temporary", ttlHours: 1 }))
		).json<Deployment>();
		expect(again.lifecycleMode).toBe("temporary");
		expectHoursFromNow(again.expiresAt, 1);
		expect((await lastEvent(created.id))?.message).toBe(
			"Temporary again: expires in 1 hour",
		);
	});

	test.each(deploymentStatus.enumValues)("from %s", async (status) => {
		const created = await deploymentIn(status);
		const response = await ctx.inject(patch(created.id, { mode: "permanent" }));
		if (FIXED.includes(status)) {
			expect(response.statusCode).toBe(409);
			expect(response.json<ErrorResponse>().error.message).toContain(
				status === "expired" ? "redeploy" : `"${status}"`,
			);
			const [row] = await ctx.db
				.select({ mode: deployments.lifecycleMode })
				.from(deployments)
				.where(eq(deployments.id, created.id));
			expect(row?.mode).toBe("temporary");
		} else {
			expect(response.statusCode).toBe(200);
		}
	});

	test("checks the lifecycle", async () => {
		const created = await deploymentIn("ready");
		for (const lifecycle of [
			{ mode: "temporary", ttlHours: 721 },
			{ mode: "temporary", ttlHours: 0 },
			{ mode: "forever" },
			{ mode: "permanent", ttlHours: 5 },
		]) {
			const response = await ctx.inject(patch(created.id, lifecycle));
			expect(response.statusCode).toBe(400);
		}
		const missing = await ctx.inject({
			method: "PATCH",
			url: `/api/v1/deployments/${created.id}`,
			payload: {},
		});
		expect(missing.statusCode).toBe(400);
	});

	test("an unknown deployment is 404", async () => {
		const response = await ctx.inject(patch(UNKNOWN_ID, { mode: "permanent" }));
		expect(response.statusCode).toBe(404);
	});

	test("needs deploy:update", async () => {
		const created = await deploymentIn("ready");
		const reader = await ctx.createKey(["deploy:read", "deploy:create"]);
		const updater = await ctx.createKey(["deploy:update"]);
		const request = patch(created.id, { mode: "temporary", ttlHours: 5 });
		expect((await ctx.withKey(reader.key, request)).statusCode).toBe(403);
		expect((await ctx.withKey(updater.key, request)).statusCode).toBe(200);
		expect(await lastEvent(created.id)).toMatchObject({
			data: { requestedBy: { type: "apiKey", apiKeyId: updater.apiKey.id } },
		});
	});
});

describe("redeploy after the time ran out", () => {
	test("an expired deployment gets another 48 hours", async () => {
		const created = await deploymentIn("expired", {
			mode: "temporary",
			ttlHours: 1,
		});
		await ctx.db
			.update(deployments)
			.set({ expiresAt: new Date(Date.now() - HOUR_MS) })
			.where(eq(deployments.id, created.id));

		const response = await ctx.inject({
			method: "POST",
			url: `/api/v1/deployments/${created.id}/redeploy`,
		});
		expect(response.statusCode).toBe(202);
		const body = response.json<Deployment>();
		expect(body.status).toBe("queued");
		expectHoursFromNow(body.expiresAt, 48);
		expect((await lastEvent(created.id))?.data).toMatchObject({
			action: "redeploy",
			expiresAt: body.expiresAt,
		});
	});

	test("one with time left keeps its expiry", async () => {
		const created = await deploymentIn("failed", {
			mode: "temporary",
			ttlHours: 3,
		});
		const body = (
			await ctx.inject({
				method: "POST",
				url: `/api/v1/deployments/${created.id}/redeploy`,
			})
		).json<Deployment>();
		expect(body.expiresAt).toBe(created.expiresAt);
	});
});
