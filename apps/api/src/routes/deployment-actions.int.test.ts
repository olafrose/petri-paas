import type {
	Deployment,
	DeploymentEventList,
	ErrorResponse,
} from "@petri/contracts";
import {
	type DeploymentStatus,
	deploymentStatus,
	deployments,
} from "@petri/database";
import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { useTestApp } from "../../test/app.ts";

const ctx = useTestApp();
const UNKNOWN_ID = "0190a0e0-0000-7000-8000-000000000000";

const ACTIONS = {
	stop: { method: "POST", path: "/stop", to: "stopped" },
	start: { method: "POST", path: "/start", to: "deploying" },
	delete: { method: "DELETE", path: "", to: "deleting" },
} as const;
type Action = keyof typeof ACTIONS;

/** Where each action is allowed from; refused from everything else. */
const ALLOWED_FROM: Record<Action, DeploymentStatus[]> = {
	stop: ["ready"],
	start: ["stopped"],
	delete: [
		"queued",
		"cloning",
		"building",
		"deploying",
		"health_check",
		"ready",
		"stopped",
		"failed",
		"expired",
	],
};

async function deploymentIn(status: DeploymentStatus) {
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
		},
	});
	const created = response.json<Deployment>();
	await ctx.db
		.update(deployments)
		.set({ status })
		.where(eq(deployments.id, created.id));
	return created.id;
}

const request = (action: Action, id: string) => ({
	method: ACTIONS[action].method,
	url: `/api/v1/deployments/${id}${ACTIONS[action].path}`,
});

async function jobsFor(deploymentId: string) {
	const result = await ctx.db.execute<{ name: string; data: unknown }>(sql`
		select name, data from pgboss.job
		where name <> 'deployment.run' and data->>'deploymentId' = ${deploymentId}
	`);
	return result.rows;
}

async function statusOf(id: string) {
	const [row] = await ctx.db
		.select({ status: deployments.status })
		.from(deployments)
		.where(eq(deployments.id, id));
	return row?.status;
}

async function lastEvent(id: string) {
	const response = await ctx.inject({
		url: `/api/v1/deployments/${id}/events`,
	});
	return response.json<DeploymentEventList>().items.at(-1);
}

describe.each(Object.keys(ACTIONS) as Action[])("%s", (action) => {
	test.each(deploymentStatus.enumValues)("from %s", async (status) => {
		const id = await deploymentIn(status);
		const response = await ctx.inject(request(action, id));

		if (ALLOWED_FROM[action].includes(status)) {
			expect(response.statusCode).toBe(202);
			expect(response.json<Deployment>().status).toBe(ACTIONS[action].to);
			expect(await statusOf(id)).toBe(ACTIONS[action].to);
			expect(await jobsFor(id)).toEqual([
				{ name: `deployment.${action}`, data: { deploymentId: id } },
			]);
		} else {
			expect(response.statusCode).toBe(409);
			expect(response.json<ErrorResponse>().error.message).toContain(
				`"${status}"`,
			);
			expect(await statusOf(id)).toBe(status);
			expect(await jobsFor(id)).toEqual([]);
		}
	});

	test("an unknown deployment is 404", async () => {
		const response = await ctx.inject(request(action, UNKNOWN_ID));
		expect(response.statusCode).toBe(404);
	});
});

describe("results", () => {
	test("the response offers the next actions", async () => {
		const id = await deploymentIn("ready");
		const stopped = await ctx.inject(request("stop", id));
		expect(stopped.json<Deployment>().actions).toEqual([
			"start",
			"redeploy",
			"delete",
		]);
		const deleting = await ctx.inject(request("delete", id));
		expect(deleting.json<Deployment>().actions).toEqual([]);
	});

	test("the history records the action and who asked", async () => {
		const id = await deploymentIn("ready");
		await ctx.inject(request("stop", id));
		expect(await lastEvent(id)).toMatchObject({
			type: "status",
			message: "Stopped",
			data: {
				from: "ready",
				to: "stopped",
				action: "stop",
				requestedBy: { type: "owner" },
			},
		});
	});
});

describe("API keys", () => {
	test("deploy:update stops and starts, deploy:delete deletes", async () => {
		const id = await deploymentIn("ready");
		const updater = await ctx.createKey(["deploy:update"]);
		const deleter = await ctx.createKey(["deploy:delete"]);

		expect(
			(await ctx.withKey(deleter.key, request("stop", id))).statusCode,
		).toBe(403);
		expect(
			(await ctx.withKey(updater.key, request("stop", id))).statusCode,
		).toBe(202);
		expect(await lastEvent(id)).toMatchObject({
			data: { requestedBy: { type: "apiKey", apiKeyId: updater.apiKey.id } },
		});
		expect(
			(await ctx.withKey(updater.key, request("start", id))).statusCode,
		).toBe(202);

		expect(
			(await ctx.withKey(updater.key, request("delete", id))).statusCode,
		).toBe(403);
		expect(
			(await ctx.withKey(deleter.key, request("delete", id))).statusCode,
		).toBe(202);
	});
});

describe("deleting a project", () => {
	test("waits until all its deployments are deleted", async () => {
		const id = await deploymentIn("ready");
		const [row] = await ctx.db
			.select({ projectId: deployments.projectId })
			.from(deployments)
			.where(eq(deployments.id, id));
		const url = `/api/v1/projects/${row?.projectId}`;

		const refused = await ctx.inject({ method: "DELETE", url });
		expect(refused.statusCode).toBe(409);
		expect(refused.json<ErrorResponse>().error.message).toBe(
			"Delete the project's deployments first",
		);

		// Still refused while the deletion is in progress.
		await ctx.inject(request("delete", id));
		expect((await ctx.inject({ method: "DELETE", url })).statusCode).toBe(409);

		await ctx.db
			.update(deployments)
			.set({ status: "deleted" })
			.where(eq(deployments.id, id));
		expect((await ctx.inject({ method: "DELETE", url })).statusCode).toBe(204);
		expect(await statusOf(id)).toBeUndefined();
	});
});
