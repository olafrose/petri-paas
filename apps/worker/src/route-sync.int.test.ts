import { randomUUID } from "node:crypto";
import {
	builds,
	type DeploymentStatus,
	deployments,
	projects,
} from "@petri/database";
import { useTestDatabase } from "@petri/database/testing";
import { DockerClient, DockerRuntime, networkName } from "@petri/runtime";
import { eq } from "drizzle-orm";
import { pino } from "pino";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { testEdge, viaEdge } from "../test/edge.ts";
import type { EdgeRouting } from "./edge-routing.ts";
import { withDeploymentLock } from "./handlers/deployment-lock.ts";
import { syncRoutes } from "./route-sync.ts";

const db = useTestDatabase();
const dockerHost = process.env.DOCKER_PROXY_HOST ?? "tcp://127.0.0.1:2375";
const runtime = new DockerRuntime(dockerHost);
const docker = new DockerClient(dockerHost);
const edge = testEdge(runtime);
const log = pino({ level: "silent" });
const created: string[] = [];

beforeAll(async () => {
	const pull = await docker.stream("POST", "/images/create", {
		query: { fromImage: "busybox", tag: "1.37" },
	});
	for await (const _ of pull);
}, 120_000);

afterEach(async () => {
	await edge.proxy.configure({});
	for (const id of created.splice(0)) {
		await edge.unpublish(id);
		await runtime.removeContainer(id);
		await runtime.removeNetwork(id);
	}
});

/**
 * A deployment in this status whose app runs, as a finished deployment
 * job leaves it (without building anything).
 */
async function deployment(status: DeploymentStatus) {
	const [project] = await db
		.insert(projects)
		.values({ name: "Demo", slug: `demo-${randomUUID().slice(0, 8)}` })
		.returning();
	const [row] = await db
		.insert(deployments)
		.values({
			projectId: project?.id as string,
			name: "main",
			subdomain: `d-${randomUUID().slice(0, 8)}`,
			source: { type: "git", repository: "https://example.com/r", ref: "main" },
			lifecycleMode: "permanent",
			status,
		})
		.returning();
	const id = row?.id as string;
	const subdomain = row?.subdomain as string;
	await db
		.insert(builds)
		.values({ deploymentId: id, status: "succeeded", port: 8080 });
	created.push(id);

	const network = await runtime.ensureNetwork(id);
	await docker.call("POST", "/containers/create", {
		query: { name: `petri-${id}` },
		json: {
			Image: "busybox:1.37",
			Cmd: [
				"sh",
				"-c",
				`mkdir /www && echo app-${subdomain} > /www/index.html && exec httpd -f -p 8080 -h /www`,
			],
			HostConfig: { NetworkMode: network },
		},
	});
	await docker.call("POST", `/containers/petri-${id}/start`);
	return { id, subdomain, answer: `app-${subdomain}\n` };
}

const sync = (routing: EdgeRouting = edge) => syncRoutes(db, routing, log);

describe("after Caddy restarted", () => {
	test("ready deployments get their routes back", async () => {
		const app = await deployment("ready");
		await edge.publish(app, 8080);
		await edge.proxy.configure({}); // what a restart leaves
		expect((await viaEdge(app.subdomain)).status).toBe(404);

		expect(await sync()).toEqual({
			added: [app.id],
			removed: [],
			reloaded: false,
		});
		expect(await viaEdge(app.subdomain)).toEqual({
			status: 200,
			body: app.answer,
		});
	});

	test("the trusted proxies come back too", async () => {
		const trusting = testEdge(runtime, ["192.0.2.10"]);
		const app = await deployment("ready");
		await edge.proxy.configure({});

		expect(await sync(trusting)).toMatchObject({
			added: [app.id],
			reloaded: true,
		});
		expect(await trusting.proxy.trustedProxies()).toEqual(["192.0.2.10"]);
		expect((await viaEdge(app.subdomain)).body).toBe(app.answer);
		// Nothing left to do.
		expect(await sync(trusting)).toEqual({
			added: [],
			removed: [],
			reloaded: false,
		});
	});

	test("the edge proxy rejoins networks it lost", async () => {
		const app = await deployment("ready");
		await edge.publish(app, 8080);
		// As when the edge proxy's container is recreated.
		await runtime.disconnect(networkName(app.id), edge.settings.edgeContainer);
		expect((await viaEdge(app.subdomain)).status).toBe(502);

		await sync();
		expect((await viaEdge(app.subdomain)).body).toBe(app.answer);
	});
});

describe("routes that shouldn't be there", () => {
	test.each(["stopped", "failed", "deleting"] as const)(
		"are removed for a %s deployment",
		async (status) => {
			const app = await deployment(status);
			await edge.publish(app, 8080);

			expect((await sync()).removed).toEqual([app.id]);
			expect((await viaEdge(app.subdomain)).status).toBe(404);
			expect(await edge.networks()).not.toContain(networkName(app.id));
		},
	);

	test("are removed for a deployment that no longer exists", async () => {
		const id = randomUUID();
		await edge.proxy.setRoute({
			deploymentId: id,
			hostname: "gone.app.localhost",
			upstream: { host: `petri-${id}`, port: 8080 },
		});
		expect((await sync()).removed).toEqual([id]);
		expect(await edge.proxy.listRoutes()).toEqual([]);
	});

	test("are replaced when they point elsewhere", async () => {
		const app = await deployment("ready");
		await edge.publish(app, 9999);
		expect((await sync()).added).toEqual([app.id]);
		expect((await viaEdge(app.subdomain)).body).toBe(app.answer);
	});
});

test.each(["deploying", "health_check"] as const)(
	"a route set during %s is left to the job setting it",
	async (status) => {
		const app = await deployment(status);
		await edge.publish(app, 8080);
		expect(await sync()).toEqual({ added: [], removed: [], reloaded: false });
		expect((await viaEdge(app.subdomain)).body).toBe(app.answer);
	},
);

test("a deployment stopped during a sync is not routed again", async () => {
	const app = await deployment("ready");
	// A stop job holds the deployment while it takes the app off.
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const stopping = withDeploymentLock(db, app.id, async (tx) => {
		await held;
		await tx
			.update(deployments)
			.set({ status: "stopped" })
			.where(eq(deployments.id, app.id));
	});
	const syncing = sync();
	await new Promise((resolve) => setTimeout(resolve, 500));
	release();
	await stopping;

	expect((await syncing).added).toEqual([]);
	expect((await viaEdge(app.subdomain)).status).toBe(404);
});
