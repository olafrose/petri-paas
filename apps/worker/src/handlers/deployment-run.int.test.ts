import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildZip,
	startGitServer,
	type TestGitServer,
} from "@petri/build-engine/testing";
import {
	builds,
	type DeploymentSource,
	deploymentEvents,
	deployments,
	projects,
} from "@petri/database";
import { useTestDatabase } from "@petri/database/testing";
import { updateStatus } from "@petri/deployment-core";
import { DockerRuntime } from "@petri/runtime";
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
	type DeploymentRunSettings,
	deploymentRunHandler,
} from "./deployment-run.ts";

const db = useTestDatabase();
const runtime = new DockerRuntime(
	process.env.DOCKER_PROXY_HOST ?? "tcp://127.0.0.1:2375",
);
const localBuildctl = new URL(
	"../../../../.tools/bin/buildctl",
	import.meta.url,
).pathname;
const base = mkdtempSync(join(tmpdir(), "petri-job-"));
/** Everything a test deployed, removed after each test. */
const deployed: { deploymentId: string; buildId: string }[] = [];

const httpd = (port: number) =>
	`CMD ["sh", "-c", "echo app starting; exec httpd -f -p ${port} -h /www"]`;
const web = (port: number, expose: number | null = port) =>
	[
		"FROM busybox:1.37",
		"RUN mkdir /www && echo hello-from-petri > /www/index.html",
		...(expose ? [`EXPOSE ${expose}`] : []),
		httpd(port),
	].join("\n");

let server: TestGitServer;
let settings: DeploymentRunSettings;

beforeAll(async () => {
	server = await startGitServer({
		web: { Dockerfile: web(8080) },
		crash: {
			Dockerfile:
				'FROM busybox:1.37\nEXPOSE 8080\nCMD ["sh", "-c", "echo boom; exit 7"]\n',
		},
		"wrong-port": { Dockerfile: web(9090, 8080) },
		broken: { Dockerfile: "FROM busybox:1.37\nRUN echo breaking && exit 3\n" },
		"no-port": { Dockerfile: web(8080, null) },
		"long-build": {
			Dockerfile: `FROM busybox:1.37\nRUN echo ${randomUUID()} && sleep 30\n`,
		},
		nested: { "site/Dockerfile": web(8080) },
	});
	settings = {
		workspaceDir: join(base, "workspaces"),
		logsDir: join(base, "logs"),
		uploadsDir: join(base, "uploads"),
		buildkitHost: process.env.BUILDKIT_HOST ?? "tcp://127.0.0.1:1234",
		buildctlPath:
			process.env.BUILDCTL_PATH ??
			(existsSync(localBuildctl) ? localBuildctl : "buildctl"),
		health: { timeoutMs: 6000, intervalMs: 300 },
		git: {
			lookup: async () => ["127.0.0.1"],
			isAllowedAddress: (address) => address === "127.0.0.1",
			allowedPorts: [server.port],
			extraConfig: [`http.sslCAInfo=${server.caFile}`],
		},
	};
});

afterEach(async () => {
	for (const { deploymentId, buildId } of deployed.splice(0)) {
		await edge.unpublish(deploymentId);
		await runtime.removeContainer(deploymentId);
		await runtime.removeNetwork(deploymentId);
		// Once the container is gone, its image isn't used any more.
		await runtime.removeImage(imageName(deploymentId, buildId));
	}
});

afterAll(async () => {
	await server.close();
	rmSync(base, { recursive: true, force: true });
});

const edge = testEdge(runtime);
const handler = () =>
	deploymentRunHandler({
		db,
		runtime,
		edge,
		log: pino({ level: "silent" }),
		settings,
	});

async function deploy(
	source: DeploymentSource,
	{
		port = null,
		retryCount = 0,
	}: { port?: number | null; retryCount?: number } = {},
) {
	const [project] = await db
		.insert(projects)
		.values({ name: "Demo", slug: `demo-${randomUUID().slice(0, 8)}` })
		.returning();
	const [deployment] = await db
		.insert(deployments)
		.values({
			projectId: project?.id as string,
			name: "main",
			subdomain: `d-${randomUUID().slice(0, 8)}`,
			source,
			internalPort: port,
			lifecycleMode: "permanent",
		})
		.returning();
	const [build] = await db
		.insert(builds)
		.values({ deploymentId: deployment?.id as string })
		.returning();
	const deploymentId = deployment?.id as string;
	deployed.push({ deploymentId, buildId: build?.id as string });
	const job = {
		id: randomUUID(),
		data: { deploymentId, buildId: build?.id as string },
		retryCount,
		signal: new AbortController().signal,
	};
	return {
		deploymentId,
		buildId: build?.id as string,
		run: () => handler()(job),
	};
}

const git = (
	repo: string,
	extra: Partial<DeploymentSource> = {},
): DeploymentSource =>
	({
		type: "git",
		repository: server.url(`/${repo}.git`),
		ref: "main",
		...extra,
	}) as DeploymentSource;

async function stateOf(deploymentId: string, buildId: string) {
	const [deployment] = await db
		.select()
		.from(deployments)
		.where(eq(deployments.id, deploymentId));
	const [build] = await db.select().from(builds).where(eq(builds.id, buildId));
	const history = await db
		.select()
		.from(deploymentEvents)
		.where(eq(deploymentEvents.deploymentId, deploymentId))
		.orderBy(asc(deploymentEvents.id));
	return {
		deployment,
		build,
		statuses: history.map((event) => (event.data as { to: string }).to),
		lastMessage: history.at(-1)?.message,
		log:
			build?.logPath && existsSync(build.logPath)
				? readFileSync(build.logPath, "utf8")
				: "",
	};
}

describe("successful deployments", { timeout: 120_000 }, () => {
	test("a Git repository goes from queued to ready and answers", async () => {
		const { deploymentId, buildId, run } = await deploy(git("web"));
		await run();
		const state = await stateOf(deploymentId, buildId);

		expect(state.statuses).toEqual([
			"cloning",
			"building",
			"deploying",
			"health_check",
			"ready",
		]);
		expect(state.deployment?.status).toBe("ready");
		expect(state.deployment?.containerId).toBeTruthy();
		const subdomain = state.deployment?.subdomain as string;
		expect(state.lastMessage).toBe(
			`Ready at http://${subdomain}.app.localhost:8088/`,
		);
		expect(state.deployment?.routeId).toBe(`petri-route-${deploymentId}`);
		expect(state.build?.port).toBe(8080);
		expect(await viaEdge(subdomain)).toEqual({
			status: 200,
			body: "hello-from-petri\n",
		});
		expect(state.build).toMatchObject({
			status: "succeeded",
			provider: "dockerfile",
		});
		expect(state.build?.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(state.log).toContain("Ready");

		const container = await runtime.inspect(deploymentId);
		const address = container?.addresses[`petri-${deploymentId}`];
		const response = await fetch(`http://${address}:8080/`);
		expect(await response.text()).toBe("hello-from-petri\n");
	});

	test("a ZIP upload is extracted, built and run", async () => {
		const uploadId = randomUUID();
		const { mkdirSync } = await import("node:fs");
		mkdirSync(settings.uploadsDir, { recursive: true });
		writeFileSync(
			join(settings.uploadsDir, `${uploadId}.zip`),
			buildZip([
				{ name: "site-main/", mode: 0o040755 },
				{ name: "site-main/Dockerfile", data: web(8080) },
			]),
		);
		const { deploymentId, buildId, run } = await deploy({
			type: "zip",
			uploadId,
		});
		await run();
		expect((await stateOf(deploymentId, buildId)).deployment?.status).toBe(
			"ready",
		);
	});

	test("builds from a subdirectory", async () => {
		const { deploymentId, buildId, run } = await deploy(
			git("nested", { directory: "site" }),
		);
		await run();
		expect((await stateOf(deploymentId, buildId)).deployment?.status).toBe(
			"ready",
		);
	});
});

describe("failures end as failed with a clear reason", {
	timeout: 120_000,
}, () => {
	test("a failing build keeps its log and starts nothing", async () => {
		const { deploymentId, buildId, run } = await deploy(git("broken"));
		await run();
		const state = await stateOf(deploymentId, buildId);
		expect(state.statuses).toEqual(["cloning", "building", "failed"]);
		expect(state.lastMessage).toContain("exit code: 3");
		expect(state.build).toMatchObject({ status: "failed" });
		expect(state.log).toContain("breaking");
		expect(await runtime.inspect(deploymentId)).toBeNull();
	});

	test("an unknown branch", async () => {
		const { deploymentId, buildId, run } = await deploy(
			git("web", { ref: "nope" } as never),
		);
		await run();
		const state = await stateOf(deploymentId, buildId);
		expect(state.statuses).toEqual(["cloning", "failed"]);
		expect(state.lastMessage).toBe("Branch, tag or commit not found");
	});

	test("an app that crashes on start; its output is kept", async () => {
		const { deploymentId, buildId, run } = await deploy(git("crash"));
		await run();
		const state = await stateOf(deploymentId, buildId);
		expect(state.statuses.at(-1)).toBe("failed");
		expect(state.lastMessage).toBe("The app stopped with exit code 7");
		expect(state.log).toContain("boom");
		expect(await runtime.inspect(deploymentId)).toBeNull();
		expect((await viaEdge(state.deployment?.subdomain as string)).status).toBe(
			404,
		);
	});

	test("an app listening on another port", async () => {
		const { deploymentId, buildId, run } = await deploy(git("wrong-port"));
		await run();
		const state = await stateOf(deploymentId, buildId);
		expect(state.statuses).toEqual([
			"cloning",
			"building",
			"deploying",
			"health_check",
			"failed",
		]);
		expect(state.lastMessage).toContain("did not answer");
		expect(state.lastMessage).toContain("nothing is listening");
	});

	test("no port configured and none exposed", async () => {
		const { deploymentId, buildId, run } = await deploy(git("no-port"));
		await run();
		const state = await stateOf(deploymentId, buildId);
		expect(state.lastMessage).toContain("No port known");
	});

	test("a configured port wins over EXPOSE", async () => {
		const { deploymentId, buildId, run } = await deploy(git("wrong-port"), {
			port: 9090,
		});
		await run();
		expect((await stateOf(deploymentId, buildId)).deployment?.status).toBe(
			"ready",
		);
	});
});

describe("interruptions", { timeout: 120_000 }, () => {
	test("deleting during the build stops the job and cleans up", async () => {
		const { deploymentId, buildId, run } = await deploy(git("long-build"));
		const running = run();
		await vi.waitFor(
			async () =>
				expect((await stateOf(deploymentId, buildId)).deployment?.status).toBe(
					"building",
				),
			{ timeout: 30_000, interval: 200 },
		);
		const deletedAt = Date.now();
		await updateStatus(db, deploymentId, "deleting", { message: "Deleting" });
		// The job notices within seconds and cancels the 30-second build.
		await running;
		expect(Date.now() - deletedAt).toBeLessThan(10_000);
		const state = await stateOf(deploymentId, buildId);
		expect(state.deployment?.status).toBe("deleting");
		expect(state.build?.status).toBe("cancelled");
		expect(await runtime.inspect(deploymentId)).toBeNull();
	});

	test("a retry after a worker crash records it and starts over", async () => {
		const { deploymentId, buildId, run } = await deploy(git("web"), {
			retryCount: 1,
		});
		// The crashed attempt had got as far as building.
		for (const to of ["cloning", "building"] as const) {
			await updateStatus(db, deploymentId, to, { message: to });
		}
		await run();
		const state = await stateOf(deploymentId, buildId);
		expect(state.statuses).toEqual([
			"cloning",
			"building",
			"failed",
			"queued",
			"cloning",
			"building",
			"deploying",
			"health_check",
			"ready",
		]);
	});

	test("a deployment that is no longer queued is left alone", async () => {
		const { deploymentId, buildId, run } = await deploy(git("web"));
		await updateStatus(db, deploymentId, "deleting", { message: "Deleting" });
		await run();
		expect((await stateOf(deploymentId, buildId)).statuses).toEqual([
			"deleting",
		]);
	});
});
