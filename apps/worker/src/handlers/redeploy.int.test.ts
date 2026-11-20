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
import { DockerRuntime, nextContainerName } from "@petri/runtime";
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
import { syncRoutes } from "../route-sync.ts";
import { imageName } from "./app-runtime.ts";
import {
	type DeploymentRunSettings,
	deploymentRunHandler,
} from "./deployment-run.ts";

/*
 * Redeploys (deployment.run for a deployment built before): a ready one
 * keeps answering while its new version builds; others go through
 * `queued`. The API's part (a new build row, the status) is done here
 * the way the API does it.
 */

const db = useTestDatabase();
const runtime = new DockerRuntime(
	process.env.DOCKER_PROXY_HOST ?? "tcp://127.0.0.1:2375",
);
const edge = testEdge(runtime);
const localBuildctl = new URL(
	"../../../../.tools/bin/buildctl",
	import.meta.url,
).pathname;
const base = mkdtempSync(join(tmpdir(), "petri-redeploy-"));
const log = pino({ level: "silent" });
/** Every deployment a test grew, removed after each test. */
const grown: string[] = [];

/** A web app answering `body`; `slow` makes its build take a while. */
const site = (
	body: string,
	{ port = 8080, slow = false }: { port?: number; slow?: boolean } = {},
) =>
	[
		"FROM busybox:1.37",
		`RUN mkdir /www && echo ${body} > /www/index.html`,
		...(slow ? [`RUN echo ${randomUUID()} && sleep 6`] : []),
		`EXPOSE ${port}`,
		`CMD ["sh", "-c", "echo app starting; exec httpd -f -p ${port} -h /www"]`,
	].join("\n");

const REPOS = [
	"pushed",
	"broken",
	"crash",
	"port",
	"stop",
	"expired",
	"stopped",
];

let server: TestGitServer;
let settings: DeploymentRunSettings;

beforeAll(async () => {
	server = await startGitServer(
		Object.fromEntries(REPOS.map((repo) => [repo, { Dockerfile: site("v1") }])),
	);
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
	mkdirSync(settings.uploadsDir, { recursive: true });
});

afterEach(async () => {
	for (const deploymentId of grown.splice(0)) {
		await edge.unpublish(deploymentId);
		await runtime.removeContainer(deploymentId);
		await runtime.removeContainerNamed(nextContainerName(deploymentId));
		await runtime.removeNetwork(deploymentId);
		const rows = await db
			.select({ id: builds.id })
			.from(builds)
			.where(eq(builds.deploymentId, deploymentId));
		for (const build of rows) {
			await runtime.removeImage(imageName(deploymentId, build.id));
		}
	}
});

afterAll(async () => {
	await server.close();
	rmSync(base, { recursive: true, force: true });
});

const handler = () =>
	deploymentRunHandler({ db, runtime, edge, log, settings });

const jobFor = (deploymentId: string, buildId: string) => ({
	id: randomUUID(),
	data: { deploymentId, buildId },
	retryCount: 0,
	signal: new AbortController().signal,
});

const git = (repo: string): DeploymentSource => ({
	type: "git",
	repository: server.url(`/${repo}.git`),
	ref: "main",
});

/** A deployment grown from `source` and ready. */
async function grow(source: DeploymentSource) {
	const [project] = await db
		.insert(projects)
		.values({ name: "Demo", slug: `demo-${randomUUID().slice(0, 8)}` })
		.returning();
	const [deployment] = await db
		.insert(deployments)
		.values({
			projectId: project?.id as string,
			name: "main",
			subdomain: `r-${randomUUID().slice(0, 8)}`,
			source,
			lifecycleMode: "permanent",
		})
		.returning();
	const id = deployment?.id as string;
	grown.push(id);
	const [build] = await db
		.insert(builds)
		.values({ deploymentId: id, source })
		.returning();
	await handler()(jobFor(id, build?.id as string));
	const state = await stateOf(id);
	expect(state.deployment?.status).toBe("ready");
	return {
		id,
		firstBuildId: build?.id as string,
		subdomain: deployment?.subdomain as string,
	};
}

/** What the API does for a redeploy; `run` is the job. */
async function redeploy(deploymentId: string, source?: DeploymentSource) {
	const [deployment] = await db
		.select()
		.from(deployments)
		.where(eq(deployments.id, deploymentId));
	const [build] = await db
		.insert(builds)
		.values({ deploymentId, source: source ?? deployment?.source })
		.returning();
	if (deployment?.status !== "ready") {
		await updateStatus(db, deploymentId, "queued", {
			message: "Redeploy requested",
		});
	}
	const buildId = build?.id as string;
	return { buildId, run: () => handler()(jobFor(deploymentId, buildId)) };
}

async function stateOf(deploymentId: string, buildId?: string) {
	const [deployment] = await db
		.select()
		.from(deployments)
		.where(eq(deployments.id, deploymentId));
	const [build] = buildId
		? await db.select().from(builds).where(eq(builds.id, buildId))
		: [];
	const history = await db
		.select()
		.from(deploymentEvents)
		.where(eq(deploymentEvents.deploymentId, deploymentId))
		.orderBy(asc(deploymentEvents.id));
	return {
		deployment,
		build,
		statuses: history
			.filter((event) => event.type === "status")
			.map((event) => (event.data as { to: string }).to),
		steps: history
			.filter((event) => event.type === "build")
			.map((event) => event.message),
		log:
			build?.logPath && existsSync(build.logPath)
				? readFileSync(build.logPath, "utf8")
				: "",
	};
}

const imageExists = (name: string) =>
	runtime.exposedPorts(name).then(
		() => true,
		() => false,
	);

const FIRST_GROWTH = [
	"cloning",
	"building",
	"deploying",
	"health_check",
	"ready",
];

describe("a ready culture keeps answering", { timeout: 120_000 }, () => {
	test("a pushed change shows up at the same address", async () => {
		const app = await grow(git("pushed"));
		expect(await viaEdge(app.subdomain)).toEqual({ status: 200, body: "v1\n" });

		const commit = server.push("pushed", {
			Dockerfile: site("v2", { slow: true }),
		});
		const { buildId, run } = await redeploy(app.id);
		const running = run();
		await vi.waitFor(
			async () =>
				expect((await stateOf(app.id)).steps).toContain(
					"New batch: building image",
				),
			{ timeout: 30_000, interval: 200 },
		);
		// While the new batch builds, the old one answers.
		expect((await stateOf(app.id)).deployment?.status).toBe("ready");
		expect(await viaEdge(app.subdomain)).toEqual({ status: 200, body: "v1\n" });
		await running;

		expect(await viaEdge(app.subdomain)).toEqual({ status: 200, body: "v2\n" });
		const state = await stateOf(app.id, buildId);
		// No status changed: the steps are in the history.
		expect(state.statuses).toEqual(FIRST_GROWTH);
		expect(state.steps).toEqual([
			"Growing a new batch; the current one keeps answering",
			"New batch: fetching source",
			"New batch: building image",
			"New batch: starting the app",
			"New batch: waiting for the app to answer on port 8080",
			`Ready at http://${app.subdomain}.app.localhost:8088/ with the new batch`,
		]);
		expect(state.build).toMatchObject({
			status: "succeeded",
			commit,
			port: 8080,
		});

		// The new app has the culture's name, restarts, and the old one,
		// its image and the temporary name are gone.
		const container = await runtime.inspect(app.id);
		expect(container).toMatchObject({
			buildId,
			running: true,
			restartPolicy: "unless-stopped",
		});
		expect(state.deployment?.containerId).toBe(container?.id);
		expect(
			await runtime.inspectContainer(nextContainerName(app.id)),
		).toBeNull();
		expect(await imageExists(imageName(app.id, app.firstBuildId))).toBe(false);
		expect(await imageExists(imageName(app.id, buildId))).toBe(true);

		// The route sync agrees with what the switch did.
		const sync = await syncRoutes(db, edge, log);
		expect(sync.added).not.toContain(app.id);
		expect(sync.removed).not.toContain(app.id);
	});

	test("a failing build leaves the old version running", async () => {
		const app = await grow(git("broken"));
		server.push("broken", {
			Dockerfile: "FROM busybox:1.37\nRUN echo breaking && exit 3\n",
		});
		const { buildId, run } = await redeploy(app.id);
		await run();

		const state = await stateOf(app.id, buildId);
		expect(state.deployment?.status).toBe("ready");
		expect(state.statuses).toEqual(FIRST_GROWTH);
		expect(state.build?.status).toBe("failed");
		expect(state.build?.errorMessage).toBeTruthy();
		expect(state.steps.at(-1)).toBe(
			`New batch failed: ${state.build?.errorMessage}. The current one keeps answering`,
		);
		expect(state.log).toContain("breaking");
		expect(await viaEdge(app.subdomain)).toEqual({ status: 200, body: "v1\n" });
		expect((await runtime.inspect(app.id))?.buildId).toBe(app.firstBuildId);
		expect(await imageExists(imageName(app.id, app.firstBuildId))).toBe(true);
	});

	test("a new app that fails its health check is removed", async () => {
		const app = await grow(git("crash"));
		server.push("crash", {
			Dockerfile:
				'FROM busybox:1.37\nEXPOSE 8080\nCMD ["sh", "-c", "echo boom; exit 7"]\n',
		});
		const { buildId, run } = await redeploy(app.id);
		await run();

		const state = await stateOf(app.id, buildId);
		expect(state.deployment?.status).toBe("ready");
		expect(state.build?.errorMessage).toContain("exit code 7");
		expect(state.log).toContain("boom");
		expect(
			await runtime.inspectContainer(nextContainerName(app.id)),
		).toBeNull();
		expect(await imageExists(imageName(app.id, buildId))).toBe(false);
		expect(await viaEdge(app.subdomain)).toEqual({ status: 200, body: "v1\n" });
	});

	test("the new version may listen on another port", async () => {
		const app = await grow(git("port"));
		server.push("port", { Dockerfile: site("v2", { port: 9090 }) });
		const { buildId, run } = await redeploy(app.id);
		await run();

		expect((await stateOf(app.id, buildId)).build?.port).toBe(9090);
		expect(await viaEdge(app.subdomain)).toEqual({ status: 200, body: "v2\n" });
		const sync = await syncRoutes(db, edge, log);
		expect(sync.added).not.toContain(app.id);
	});

	test("stopping the culture cancels its new batch", async () => {
		const app = await grow(git("stop"));
		server.push("stop", { Dockerfile: site("v2", { slow: true }) });
		const { buildId, run } = await redeploy(app.id);
		const running = run();
		await vi.waitFor(
			async () =>
				expect((await stateOf(app.id)).steps).toContain(
					"New batch: building image",
				),
			{ timeout: 30_000, interval: 200 },
		);
		await updateStatus(db, app.id, "stopped", { message: "Stopped" });
		await running;

		const state = await stateOf(app.id, buildId);
		expect(state.deployment?.status).toBe("stopped");
		expect(state.build?.status).toBe("cancelled");
		expect(state.steps.at(-1)).toBe(
			"New batch cancelled: the culture is now stopped",
		);
		expect(
			await runtime.inspectContainer(nextContainerName(app.id)),
		).toBeNull();
		expect((await runtime.inspect(app.id))?.buildId).toBe(app.firstBuildId);
	});
});

describe("a culture that isn't running", { timeout: 120_000 }, () => {
	test("an expired one grows again, through queued", async () => {
		const app = await grow(git("expired"));
		// As the cleanup job leaves it: no route, app, network or image.
		await updateStatus(db, app.id, "expired", { message: "Expired" });
		await edge.unpublish(app.id);
		await runtime.removeContainer(app.id);
		await runtime.removeNetwork(app.id);
		await runtime.removeImage(imageName(app.id, app.firstBuildId));

		server.push("expired", { Dockerfile: site("v2") });
		const { buildId, run } = await redeploy(app.id);
		await run();

		const state = await stateOf(app.id, buildId);
		expect(state.statuses).toEqual([
			...FIRST_GROWTH,
			"expired",
			"queued",
			...FIRST_GROWTH,
		]);
		expect(state.steps).toEqual([]);
		expect(await viaEdge(app.subdomain)).toEqual({ status: 200, body: "v2\n" });
	});

	test("a stopped one is replaced by the new version", async () => {
		const app = await grow(git("stopped"));
		await updateStatus(db, app.id, "stopped", { message: "Stopped" });
		await edge.unpublish(app.id);
		await runtime.stop(app.id, 1);

		server.push("stopped", { Dockerfile: site("v2") });
		const { buildId, run } = await redeploy(app.id);
		await run();

		expect((await stateOf(app.id)).deployment?.status).toBe("ready");
		expect((await runtime.inspect(app.id))?.buildId).toBe(buildId);
		expect(await imageExists(imageName(app.id, app.firstBuildId))).toBe(false);
		expect(await viaEdge(app.subdomain)).toEqual({ status: 200, body: "v2\n" });
	});
});

describe("a new ZIP archive", { timeout: 120_000 }, () => {
	const upload = (dockerfile: string) => {
		const uploadId = randomUUID();
		writeFileSync(
			join(settings.uploadsDir, `${uploadId}.zip`),
			buildZip([{ name: "Dockerfile", data: dockerfile }]),
		);
		return {
			source: { type: "zip", uploadId } as DeploymentSource,
			stored: () => existsSync(join(settings.uploadsDir, `${uploadId}.zip`)),
		};
	};

	test("replaces the old one once live; a failing one is removed", async () => {
		const first = upload(site("v1"));
		const app = await grow(first.source);

		const broken = upload("FROM busybox:1.37\nRUN exit 3\n");
		await (await redeploy(app.id, broken.source)).run();
		expect(broken.stored()).toBe(false);
		expect(first.stored()).toBe(true);
		expect((await stateOf(app.id)).deployment?.source).toEqual(first.source);

		const second = upload(site("v2"));
		await (await redeploy(app.id, second.source)).run();
		expect(await viaEdge(app.subdomain)).toEqual({ status: 200, body: "v2\n" });
		expect((await stateOf(app.id)).deployment?.source).toEqual(second.source);
		expect(second.stored()).toBe(true);
		expect(first.stored()).toBe(false);
	});
});
