import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deployment, DeploymentEvent } from "@petri/contracts";
import {
	builds,
	type DeploymentStatus,
	deploymentEvents,
} from "@petri/database";
import { updateStatus } from "@petri/deployment-core";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { useTestApp } from "../../test/app.ts";

const ctx = useTestApp();
let baseUrl: string;

beforeAll(async () => {
	await ctx.app.listen({ port: 0, host: "127.0.0.1" });
	const address = ctx.app.server.address() as { port: number };
	baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	// useTestApp closes the app.
});

async function createDeployment(project = "demo") {
	const response = await ctx.inject({
		method: "POST",
		url: "/api/v1/deployments",
		payload: {
			project,
			source: {
				type: "git",
				repository: "https://github.com/example/demo",
				ref: "main",
			},
		},
	});
	return response.json<Deployment>();
}

/** Reads a Server-Sent Events stream, collecting deployment events. */
async function follow(
	deploymentId: string,
	headers: Record<string, string> = {},
	query = "",
) {
	const controller = new AbortController();
	const response = await fetch(
		`${baseUrl}/api/v1/deployments/${deploymentId}/events/stream${query}`,
		{
			headers: { cookie: await ctx.ownerCookie(), ...headers },
			signal: controller.signal,
		},
	);
	const received: DeploymentEvent[] = [];
	const ids: number[] = [];
	const reading = (async () => {
		if (!response.body) return;
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of response.body) {
				buffer += decoder.decode(chunk, { stream: true });
				let end = buffer.indexOf("\n\n");
				while (end !== -1) {
					const message = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const fields = Object.fromEntries(
						message
							.split("\n")
							.filter((line) => !line.startsWith(":") && line.includes(": "))
							.map((line) => [
								line.slice(0, line.indexOf(": ")),
								line.slice(line.indexOf(": ") + 2),
							]),
					);
					if (fields.event === "deployment-event") {
						received.push(JSON.parse(fields.data as string));
						ids.push(Number(fields.id));
					}
					end = buffer.indexOf("\n\n");
				}
			}
		} catch {
			// aborted
		}
	})();
	return {
		response,
		received,
		ids,
		close: async () => {
			controller.abort();
			await reading;
		},
	};
}

const statusesOf = (events: DeploymentEvent[]) =>
	events.map((event) => (event.data as { to: string }).to);

async function storedIds(deploymentId: string) {
	const rows = await ctx.db
		.select({ id: deploymentEvents.id })
		.from(deploymentEvents)
		.where(eq(deploymentEvents.deploymentId, deploymentId))
		.orderBy(asc(deploymentEvents.id));
	return rows.map((row) => row.id);
}

describe("GET /deployments/:id/events/stream", () => {
	test("sends the history, then new events as they happen", async () => {
		const deployment = await createDeployment();
		const stream = await follow(deployment.id);
		expect(stream.response.headers.get("content-type")).toContain(
			"text/event-stream",
		);
		expect(stream.response.headers.get("x-accel-buffering")).toBe("no");

		await vi.waitFor(() =>
			expect(statusesOf(stream.received)).toEqual(["queued"]),
		);
		await updateStatus(ctx.db, deployment.id, "cloning", {
			message: "Fetching source",
		});
		await updateStatus(ctx.db, deployment.id, "building", {
			message: "Building image",
		});
		await vi.waitFor(() =>
			expect(statusesOf(stream.received)).toEqual([
				"queued",
				"cloning",
				"building",
			]),
		);
		expect(stream.received.at(-1)?.message).toBe("Building image");
		await stream.close();
	});

	test("a client joining mid-deployment gets every event once, in order", async () => {
		const deployment = await createDeployment();
		const early = await follow(deployment.id);

		// 40 quick status changes; a second client connects halfway.
		const cycle: DeploymentStatus[] = [
			"deploying",
			"health_check",
			"ready",
			"stopped",
		];
		await updateStatus(ctx.db, deployment.id, "cloning", { message: "x" });
		await updateStatus(ctx.db, deployment.id, "building", { message: "x" });
		let late: Awaited<ReturnType<typeof follow>> | undefined;
		for (let round = 0; round < 10; round++) {
			for (const to of cycle) {
				await updateStatus(ctx.db, deployment.id, to, {
					message: `${to} ${round}`,
				});
			}
			if (round === 4) late = await follow(deployment.id);
		}

		const all = await storedIds(deployment.id);
		expect(all).toHaveLength(43);
		for (const client of [early, late]) {
			await vi.waitFor(() => expect(client?.ids).toEqual(all), {
				timeout: 10_000,
			});
			await client?.close();
		}
	});

	test("resumes after Last-Event-ID or ?after", async () => {
		const deployment = await createDeployment();
		await updateStatus(ctx.db, deployment.id, "cloning", { message: "x" });
		await updateStatus(ctx.db, deployment.id, "building", { message: "x" });
		const [first, second, third] = await storedIds(deployment.id);

		const viaHeader = await follow(deployment.id, {
			"last-event-id": String(first),
		});
		const viaQuery = await follow(deployment.id, {}, `?after=${second}`);
		await vi.waitFor(() => {
			expect(viaHeader.ids).toEqual([second, third]);
			expect(viaQuery.ids).toEqual([third]);
		});
		await viaHeader.close();
		await viaQuery.close();
	});

	test("does not mix in other deployments' events", async () => {
		const mine = await createDeployment("mine");
		const other = await createDeployment("other");
		const stream = await follow(mine.id);
		await vi.waitFor(() => expect(stream.ids).toHaveLength(1));
		await updateStatus(ctx.db, other.id, "cloning", { message: "other" });
		await updateStatus(ctx.db, mine.id, "cloning", { message: "mine" });
		await vi.waitFor(() =>
			expect(stream.received.map((e) => e.message)).toContain("mine"),
		);
		expect(stream.received.map((e) => e.message)).not.toContain("other");
		await stream.close();
	});

	test("needs access and an existing deployment", async () => {
		const deployment = await createDeployment();
		const anonymous = await fetch(
			`${baseUrl}/api/v1/deployments/${deployment.id}/events/stream`,
		);
		expect(anonymous.status).toBe(401);

		const missing = await fetch(
			`${baseUrl}/api/v1/deployments/0190a0e0-0000-7000-8000-000000000000/events/stream`,
			{ headers: { cookie: await ctx.ownerCookie() } },
		);
		expect(missing.status).toBe(404);

		const { key } = await ctx.createKey(["deploy:read"]);
		const withKey = await follow(deployment.id, {
			authorization: `Bearer ${key}`,
			cookie: "",
		});
		expect(withKey.response.status).toBe(200);
		await withKey.close();
	});
});

describe("GET /deployments/:id/logs", () => {
	async function buildOf(deploymentId: string) {
		const [build] = await ctx.db
			.select()
			.from(builds)
			.where(eq(builds.deploymentId, deploymentId));
		return build?.id as string;
	}

	test("returns the latest build's log, and only new text after an offset", async () => {
		const deployment = await createDeployment();
		const url = `/api/v1/deployments/${deployment.id}/logs`;

		const empty = await ctx.inject({ url });
		expect(empty.statusCode).toBe(200);
		expect(empty.body).toBe("");
		expect(empty.headers["x-log-offset"]).toBe("0");

		const logFile = join(ctx.logsDir, `${await buildOf(deployment.id)}.log`);
		writeFileSync(logFile, "#1 building\n");
		const first = await ctx.inject({ url });
		expect(first.body).toBe("#1 building\n");
		expect(first.headers["content-type"]).toContain("text/plain");

		appendFileSync(logFile, "#2 done\n");
		const next = await ctx.inject({
			url: `${url}?offset=${first.headers["x-log-offset"]}`,
		});
		expect(next.body).toBe("#2 done\n");
		expect(next.headers["x-build-id"]).toBe(await buildOf(deployment.id));
	});

	test("refuses builds of other deployments", async () => {
		const mine = await createDeployment("mine");
		const other = await createDeployment("other");
		const response = await ctx.inject({
			url: `/api/v1/deployments/${mine.id}/logs?build=${await buildOf(other.id)}`,
		});
		expect(response.statusCode).toBe(404);
	});
});
