import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZip } from "@petri/build-engine/testing";
import {
	builds,
	type DeploymentStatus,
	deploymentEvents,
	deployments,
	projects,
} from "@petri/database";
import { useTestDatabase } from "@petri/database/testing";
import { updateStatus } from "@petri/deployment-core";
import { DockerClient, DockerRuntime } from "@petri/runtime";
import { asc, eq } from "drizzle-orm";
import { pino } from "pino";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import { testEdge, viaEdge } from "../../test/edge.ts";
import { imageName } from "./app-runtime.ts";
import {
	deploymentDeleteHandler,
	deploymentStartHandler,
	deploymentStopHandler,
} from "./deployment-actions.ts";
import { withDeploymentLock } from "./deployment-lock.ts";
import {
	type DeploymentRunSettings,
	deploymentRunHandler,
} from "./deployment-run.ts";

const db = useTestDatabase();
const dockerHost = process.env.DOCKER_PROXY_HOST ?? "tcp://127.0.0.1:2375";
const runtime = new DockerRuntime(dockerHost);
const docker = new DockerClient(dockerHost);
const localBuildctl = new URL(
	"../../../../.tools/bin/buildctl",
	import.meta.url,
).pathname;
const base = mkdtempSync(join(tmpdir(), "petri-actions-"));
const created: { deploymentId: string; buildId: string }[] = [];

const httpd = "exec httpd -f -p 8080 -h /www";
const dockerfile = (command: string) =>
	[
		"FROM busybox:1.37",
		"RUN mkdir /www && echo hello-from-petri > /www/index.html",
		"EXPOSE 8080",
		`CMD ["sh", "-c", ${JSON.stringify(command)}]`,
	].join("\n");
const WEB = dockerfile(httpd);
/** Serves on its first start; exits on every later one. */
const FIRST_START_ONLY = dockerfile(
	`if [ -f /tmp/started ]; then echo refusing-to-start-again; exit 5; fi; touch /tmp/started; ${httpd}`,
);
const LONG_BUILD = `FROM busybox:1.37\nRUN echo ${randomUUID()} && sleep 30\n`;

let settings: DeploymentRunSettings;

beforeAll(() => {
	settings = {
		workspaceDir: join(base, "workspaces"),
		logsDir: join(base, "logs"),
		uploadsDir: join(base, "uploads"),
		buildkitHost: process.env.BUILDKIT_HOST ?? "tcp://127.0.0.1:1234",
		buildctlPath:
			process.env.BUILDCTL_PATH ??
			(existsSync(localBuildctl) ? localBuildctl : "buildctl"),
		health: { timeoutMs: 6000, intervalMs: 300 },
	};
	mkdirSync(settings.uploadsDir, { recursive: true });
});

afterEach(async () => {
	for (const { deploymentId, buildId } of created.splice(0)) {
		await edge.unpublish(deploymentId);
		await runtime.removeContainer(deploymentId);
		await runtime.removeNetwork(deploymentId);
		await runtime.removeImage(imageName(deploymentId, buildId));
	}
});

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

const edge = testEdge(runtime);
const deps = () => ({
	db,
	runtime,
	edge,
	log: pino({ level: "silent" }),
	settings,
});
const job = (deploymentId: string) => ({
	id: randomUUID(),
	data: { deploymentId },
	retryCount: 0,
	signal: new AbortController().signal,
});

/** A deployment from a ZIP upload with this Dockerfile, not yet run. */
async function queued(dockerfileText: string) {
	const uploadId = randomUUID();
	const archive = join(settings.uploadsDir, `${uploadId}.zip`);
	writeFileSync(
		archive,
		buildZip([
			{ name: "app/", mode: 0o040755 },
			{ name: "app/Dockerfile", data: dockerfileText },
		]),
	);
	const [project] = await db
		.insert(projects)
		.values({ name: "Demo", slug: `demo-${randomUUID().slice(0, 8)}` })
		.returning();
	const [deployment] = await db
		.insert(deployments)
		.values({
			projectId: project?.id as string,
			name: "upload",
			subdomain: `d-${randomUUID().slice(0, 8)}`,
			source: { type: "zip", uploadId },
			lifecycleMode: "permanent",
		})
		.returning();
	const [build] = await db
		.insert(builds)
		.values({ deploymentId: deployment?.id as string })
		.returning();
	const ids = {
		deploymentId: deployment?.id as string,
		buildId: build?.id as string,
	};
	created.push(ids);
	const run = () =>
		deploymentRunHandler(deps())({
			...job(ids.deploymentId),
			data: ids,
		});
	return { ...ids, subdomain: deployment?.subdomain as string, archive, run };
}

/** A deployment whose app is up and healthy. */
async function ready(dockerfileText = WEB) {
	const deployment = await queued(dockerfileText);
	await deployment.run();
	expect(await statusOf(deployment.deploymentId)).toBe("ready");
	return deployment;
}

/** As the API does it: the new status first, then the job. */
const ACTIONS = {
	stop: { to: "stopped", handler: deploymentStopHandler },
	start: { to: "deploying", handler: deploymentStartHandler },
	delete: { to: "deleting", handler: deploymentDeleteHandler },
} as const;

async function request(action: keyof typeof ACTIONS, deploymentId: string) {
	await updateStatus(db, deploymentId, ACTIONS[action].to, { message: action });
}

function runJob(action: keyof typeof ACTIONS, deploymentId: string) {
	return ACTIONS[action].handler(deps())(job(deploymentId));
}

async function perform(action: keyof typeof ACTIONS, deploymentId: string) {
	await request(action, deploymentId);
	await runJob(action, deploymentId);
}

async function routeIdOf(deploymentId: string) {
	const [row] = await db
		.select({ routeId: deployments.routeId })
		.from(deployments)
		.where(eq(deployments.id, deploymentId));
	return row?.routeId;
}

async function statusOf(deploymentId: string) {
	const [row] = await db
		.select({ status: deployments.status })
		.from(deployments)
		.where(eq(deployments.id, deploymentId));
	return row?.status;
}

async function history(deploymentId: string) {
	const rows = await db
		.select()
		.from(deploymentEvents)
		.where(eq(deploymentEvents.deploymentId, deploymentId))
		.orderBy(asc(deploymentEvents.id));
	return rows.map((row) => ({
		to: (row.data as { to: DeploymentStatus }).to,
		message: row.message,
	}));
}

const buildLog = (buildId: string) =>
	readFileSync(join(settings.logsDir, `${buildId}.log`), "utf8");

async function answers(deploymentId: string) {
	const container = await runtime.inspect(deploymentId);
	const address = container?.addresses[`petri-${deploymentId}`];
	const response = await fetch(`http://${address}:8080/`);
	return response.text();
}

async function exists(path: string) {
	const { status } = await docker.call("GET", path, { accept: [404] });
	return status !== 404;
}

describe("stop and start", { timeout: 120_000 }, () => {
	test("stops the app and starts it again without a rebuild", async () => {
		const { deploymentId, buildId, subdomain } = await ready();
		const before = await runtime.inspect(deploymentId);
		expect((await viaEdge(subdomain)).status).toBe(200);

		await perform("stop", deploymentId);
		expect((await viaEdge(subdomain)).status).toBe(404);
		expect(await routeIdOf(deploymentId)).toBeNull();
		const stopped = await runtime.inspect(deploymentId);
		expect(stopped?.running).toBe(false);
		// Stays stopped across Docker restarts, but is kept.
		expect(stopped?.restartPolicy).toBe("unless-stopped");

		await perform("start", deploymentId);
		expect((await history(deploymentId)).map((e) => e.to).slice(-5)).toEqual([
			"ready",
			"stopped",
			"deploying",
			"health_check",
			"ready",
		]);
		const started = await runtime.inspect(deploymentId);
		expect(started?.id).toBe(before?.id);
		expect(started?.restartPolicy).toBe("unless-stopped");
		expect(await answers(deploymentId)).toBe("hello-from-petri\n");
		expect(buildLog(buildId)).toContain("[petri] Starting the app again");
		expect(await viaEdge(subdomain)).toEqual({
			status: 200,
			body: "hello-from-petri\n",
		});
		expect(await routeIdOf(deploymentId)).toBe(`petri-route-${deploymentId}`);
	});

	test("a start that fails says why and keeps the app's output", async () => {
		const { deploymentId, buildId, subdomain } = await ready(FIRST_START_ONLY);
		await perform("stop", deploymentId);
		await perform("start", deploymentId);

		const last = (await history(deploymentId)).at(-1);
		expect(last).toEqual({
			to: "failed",
			message: "The app stopped with exit code 5",
		});
		expect(buildLog(buildId)).toContain("refusing-to-start-again");
		// Kept for a look, but not restarting in a loop.
		const container = await runtime.inspect(deploymentId);
		expect(container?.running).toBe(false);
		expect(container?.restartPolicy).toBe("no");
		expect((await viaEdge(subdomain)).status).toBe(404);
	});

	test("a start without a container fails clearly", async () => {
		const { deploymentId } = await ready();
		await perform("stop", deploymentId);
		await runtime.removeContainer(deploymentId);
		await perform("start", deploymentId);
		expect((await history(deploymentId)).at(-1)).toEqual({
			to: "failed",
			message: "The app's container no longer exists; deploy it again",
		});
	});
});

describe("delete", { timeout: 120_000 }, () => {
	test("removes route, container, network, image and upload; keeps the history", async () => {
		const { deploymentId, buildId, archive, subdomain } = await ready();
		await perform("delete", deploymentId);
		expect((await viaEdge(subdomain)).status).toBe(404);

		expect(await statusOf(deploymentId)).toBe("deleted");
		expect((await history(deploymentId)).map((e) => e.to).slice(-2)).toEqual([
			"deleting",
			"deleted",
		]);
		expect(await runtime.inspect(deploymentId)).toBeNull();
		expect(await exists(`/networks/petri-${deploymentId}`)).toBe(false);
		expect(
			await exists(
				`/images/${encodeURIComponent(imageName(deploymentId, buildId))}/json`,
			),
		).toBe(false);
		expect(existsSync(archive)).toBe(false);
		expect(buildLog(buildId)).toContain("Ready");

		const [row] = await db
			.select()
			.from(deployments)
			.where(eq(deployments.id, deploymentId));
		expect(row).toMatchObject({
			containerId: null,
			imageId: null,
			routeId: null,
		});
	});

	test("a stopped deployment is deleted too", async () => {
		const { deploymentId } = await ready();
		await perform("stop", deploymentId);
		await perform("delete", deploymentId);
		expect(await statusOf(deploymentId)).toBe("deleted");
		expect(await runtime.inspect(deploymentId)).toBeNull();
	});

	test("during a build: the build stops and nothing is left", async () => {
		const { deploymentId, buildId, run } = await queued(LONG_BUILD);
		const running = run();
		await vi.waitFor(
			async () => expect(await statusOf(deploymentId)).toBe("building"),
			{ timeout: 30_000, interval: 200 },
		);
		await perform("delete", deploymentId);
		await running;

		expect(await statusOf(deploymentId)).toBe("deleted");
		const [build] = await db
			.select()
			.from(builds)
			.where(eq(builds.id, buildId));
		expect(build?.status).toBe("cancelled");
		expect(await runtime.inspect(deploymentId)).toBeNull();
		expect(await exists(`/networks/petri-${deploymentId}`)).toBe(false);
	});
});

describe("one action at a time", { timeout: 120_000 }, () => {
	test("a start waits while another action holds the deployment", async () => {
		const { deploymentId } = await ready();
		await perform("stop", deploymentId);

		// E.g. a stop job that checked the status and is about to stop the app.
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const holding = withDeploymentLock(db, deploymentId, () => held);
		await request("start", deploymentId);
		const starting = runJob("start", deploymentId);

		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(await statusOf(deploymentId)).toBe("deploying");
		expect((await runtime.inspect(deploymentId))?.running).toBe(false);

		release();
		await holding;
		await starting;
		expect(await statusOf(deploymentId)).toBe("ready");
	});
});

describe("jobs that arrive late do nothing", { timeout: 120_000 }, () => {
	test("a stop after the owner started the app again", async () => {
		const { deploymentId } = await ready();
		await request("stop", deploymentId);
		await perform("start", deploymentId);
		await runJob("stop", deploymentId);
		expect(await statusOf(deploymentId)).toBe("ready");
		expect((await runtime.inspect(deploymentId))?.running).toBe(true);
	});

	test("a start or delete for a deployment in another status", async () => {
		const { deploymentId } = await ready();
		await runJob("start", deploymentId);
		await runJob("delete", deploymentId);
		expect(await statusOf(deploymentId)).toBe("ready");
		expect(await answers(deploymentId)).toBe("hello-from-petri\n");
	});
});
