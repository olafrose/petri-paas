import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import {
	containerName,
	DockerClient,
	DockerRuntime,
	networkName,
	nextContainerName,
} from "@petri/runtime";
import { asc, eq } from "drizzle-orm";
import { pino } from "pino";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	inject,
	test,
	vi,
} from "vitest";
import { testEdge, viaEdge } from "../../test/edge.ts";
import { imageName } from "./app-runtime.ts";
import {
	type DeploymentRunSettings,
	deploymentRunHandler,
} from "./deployment-run.ts";
import {
	newMemory,
	type ReconcileResult,
	reconcile,
	STUCK_AFTER_MS,
} from "./reconcile.ts";

/*
 * The reconciliation job against real Docker: a worker killed mid-build,
 * apps removed or stopped behind petri.'s back, and leftovers. Each test
 * ends with a run that finds nothing more to do: the database and Docker
 * agree again.
 */

const db = useTestDatabase();
const dockerHost = process.env.DOCKER_PROXY_HOST ?? "tcp://127.0.0.1:2375";
const runtime = new DockerRuntime(dockerHost);
const docker = new DockerClient(dockerHost);
const edge = testEdge(runtime);
const localBuildctl = new URL(
	"../../../../.tools/bin/buildctl",
	import.meta.url,
).pathname;
const base = mkdtempSync(join(tmpdir(), "petri-reconcile-"));
/** Every deployment a test created, and the build ids of its images. */
const created: { deploymentId: string; buildIds: string[] }[] = [];

const WEB = [
	"FROM busybox:1.37",
	"RUN mkdir /www && echo hello-from-petri > /www/index.html",
	"EXPOSE 8080",
	'CMD ["sh", "-c", "echo app starting; exec httpd -f -p 8080 -h /www"]',
].join("\n");
// Unique, so BuildKit can't take it from its cache.
const SLOW = () => `FROM busybox:1.37\nRUN echo ${randomUUID()} && sleep 60\n`;

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
	for (const { deploymentId, buildIds } of created.splice(0)) {
		await edge.unpublish(deploymentId);
		await runtime.removeContainer(deploymentId);
		await runtime.removeContainerNamed(nextContainerName(deploymentId));
		await runtime.removeNetwork(deploymentId);
		for (const buildId of buildIds) {
			await runtime.removeImage(imageName(deploymentId, buildId));
		}
	}
});

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

const deps = () => ({
	db,
	runtime,
	edge,
	log: pino({ level: "silent" }),
	settings,
});

/** Long enough after `now` that any build step counts as stuck. */
const later = () => new Date(Date.now() + STUCK_AFTER_MS + 60_000);

const NOTHING: ReconcileResult = {
	interrupted: [],
	interruptedBatches: [],
	crashed: [],
	down: [],
	removed: [],
	unknown: [],
	errors: [],
};

/** A run that finds nothing to do (about this test's cultures). */
async function expectAgreement(ids: string[], now = new Date()) {
	const result = await reconcile(deps(), newMemory(), now);
	expect({
		...result,
		unknown: result.unknown.filter((id) => ids.includes(id)),
	}).toEqual(NOTHING);
}

/** A deployment from a ZIP upload with one queued build. */
async function queued(dockerfile = WEB) {
	const uploadId = randomUUID();
	writeFileSync(
		join(settings.uploadsDir, `${uploadId}.zip`),
		buildZip([
			{ name: "app/", mode: 0o040755 },
			{ name: "app/Dockerfile", data: dockerfile },
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
	created.push({ deploymentId: ids.deploymentId, buildIds: [ids.buildId] });
	return { ...ids, subdomain: deployment?.subdomain as string };
}

/** A ready deployment, answering at its preview address. */
async function grown() {
	const app = await queued();
	await deploymentRunHandler(deps())({
		id: randomUUID(),
		data: { deploymentId: app.deploymentId, buildId: app.buildId },
		retryCount: 0,
		signal: new AbortController().signal,
	});
	expect(await rowOf(app.deploymentId)).toMatchObject({ status: "ready" });
	expect((await viaEdge(app.subdomain)).status).toBe(200);
	return { ...app, id: app.deploymentId };
}

async function rowOf(id: string) {
	const [row] = await db
		.select()
		.from(deployments)
		.where(eq(deployments.id, id));
	return row;
}

async function buildOf(id: string) {
	const [row] = await db.select().from(builds).where(eq(builds.id, id));
	return row;
}

async function history(id: string) {
	return db
		.select()
		.from(deploymentEvents)
		.where(eq(deploymentEvents.deploymentId, id))
		.orderBy(asc(deploymentEvents.id));
}

async function exists(path: string) {
	const { status } = await docker.call("GET", path, { accept: [404] });
	return status !== 404;
}

async function appExists(id: string, buildId: string) {
	return {
		container: (await runtime.inspect(id)) !== null,
		network: await exists(`/networks/${networkName(id)}`),
		image: await exists(`/images/${imageName(id, buildId)}/json`),
	};
}

/** Runs the build in a worker process of its own. */
function worker(app: { deploymentId: string; buildId: string }) {
	return spawn(
		process.execPath,
		[
			"--conditions=@petri/source",
			fileURLToPath(new URL("../../test/dying-worker.ts", import.meta.url)),
		],
		{
			env: {
				...process.env,
				DATABASE_URL: inject("databaseUrl"),
				DOCKER_PROXY_HOST: dockerHost,
				RUN_SETTINGS: JSON.stringify(settings),
				DEPLOYMENT_ID: app.deploymentId,
				BUILD_ID: app.buildId,
			},
			stdio: "inherit",
		},
	);
}

/** Kills the worker and everything it started, as when its container dies. */
async function kill(child: ChildProcess) {
	const exited = new Promise((resolve) => child.on("exit", resolve));
	for (const pid of [...descendants(child.pid as number), child.pid]) {
		try {
			process.kill(pid as number, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	await exited;
}

function descendants(pid: number): number[] {
	let children: number[] = [];
	try {
		children = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
			.split("\n")
			.filter(Boolean)
			.map(Number);
	} catch {
		// pgrep exits with 1 when there are none.
	}
	return children.flatMap((child) => [...descendants(child), child]);
}

describe("reconciliation", { timeout: 180_000 }, () => {
	test("a worker killed mid-build: the culture fails as interrupted", async () => {
		const app = await queued(SLOW());
		const child = worker(app);
		try {
			await vi.waitFor(
				async () =>
					expect((await rowOf(app.deploymentId))?.status).toBe("building"),
				{ timeout: 60_000, interval: 250 },
			);
			// Well into the build.
			await new Promise((resolve) => setTimeout(resolve, 2000));
		} finally {
			await kill(child);
		}
		expect((await rowOf(app.deploymentId))?.status).toBe("building");
		const workspace = join(settings.workspaceDir, app.buildId);
		expect(existsSync(workspace)).toBe(true);

		// Not before its job could have finished.
		const early = await reconcile(deps(), newMemory());
		expect(early.interrupted).toEqual([]);

		const result = await reconcile(deps(), newMemory(), later());
		expect(result.interrupted).toEqual([app.deploymentId]);
		expect(await rowOf(app.deploymentId)).toMatchObject({ status: "failed" });
		const [last] = (await history(app.deploymentId)).slice(-1);
		expect(last).toMatchObject({
			type: "status",
			message: expect.stringContaining(
				'Interrupted: the worker stopped during "building"',
			),
			data: expect.objectContaining({ from: "building", to: "failed" }),
		});
		expect(await buildOf(app.buildId)).toMatchObject({
			status: "failed",
			errorMessage: "Interrupted: the worker stopped",
		});
		expect(existsSync(workspace)).toBe(false);
		expect(await appExists(app.deploymentId, app.buildId)).toEqual({
			container: false,
			network: false,
			image: false,
		});

		await expectAgreement([app.deploymentId], later());
	});

	test("a new batch interrupted next to a ready culture: the ready one stays", async () => {
		const app = await grown();
		// What a worker that died growing a new batch leaves: a running
		// build and its app next to the ready one.
		const [batch] = await db
			.insert(builds)
			.values({
				deploymentId: app.id,
				status: "running",
				startedAt: new Date(),
			})
			.returning();
		const batchId = batch?.id as string;
		created.at(-1)?.buildIds.push(batchId);
		await runtime.createContainer({
			deploymentId: app.id,
			buildId: batchId,
			name: nextContainerName(app.id),
			image: imageName(app.id, app.buildId),
			network: networkName(app.id),
		});

		// While its job may still run, nothing happens to it.
		expect((await reconcile(deps(), newMemory())).interruptedBatches).toEqual(
			[],
		);
		expect(await runtime.inspectContainer(nextContainerName(app.id))).not.toBe(
			null,
		);

		const result = await reconcile(deps(), newMemory(), later());
		expect(result.interruptedBatches).toEqual([app.id]);
		expect(await runtime.inspectContainer(nextContainerName(app.id))).toBe(
			null,
		);
		expect(await buildOf(batchId)).toMatchObject({ status: "failed" });
		expect(await rowOf(app.id)).toMatchObject({ status: "ready" });
		expect((await viaEdge(app.subdomain)).status).toBe(200);
		const [last] = (await history(app.id)).slice(-1);
		expect(last).toMatchObject({
			type: "recovery",
			message: expect.stringContaining("New batch interrupted"),
		});

		await expectAgreement([app.id], later());
	});

	test("a ready culture whose container was removed behind petri.'s back fails", async () => {
		const app = await grown();
		await runtime.removeContainer(app.id);

		const result = await reconcile(deps(), newMemory());
		expect(result.crashed).toEqual([app.id]);
		expect(await rowOf(app.id)).toMatchObject({
			status: "failed",
			containerId: null,
			routeId: null,
		});
		const events = await history(app.id);
		expect(events.at(-2)).toMatchObject({
			type: "status",
			message: "The app's container is gone. Redeploy to grow it again",
		});
		// Its image, which nothing runs any more, went in the same run.
		expect(events.at(-1)).toMatchObject({
			type: "recovery",
			data: { removed: [imageName(app.id, app.buildId)] },
		});
		expect((await viaEdge(app.subdomain)).status).toBe(404);

		await expectAgreement([app.id]);
	});

	test("an app that stopped for good fails at the second run, with its output", async () => {
		const app = await grown();
		await runtime.stop(app.id, 1);
		const memory = newMemory();

		// Right after a host restart Docker may not have started it yet.
		const first = await reconcile(deps(), memory);
		expect(first.down).toEqual([app.id]);
		expect((await rowOf(app.id))?.status).toBe("ready");

		const second = await reconcile(deps(), memory);
		expect(second.crashed).toEqual([app.id]);
		expect(await rowOf(app.id)).toMatchObject({ status: "failed" });
		const [last] = (await history(app.id)).slice(-1);
		expect(last?.message).toMatch(/^The app stopped with exit code \d+$/);
		expect(last?.data).toMatchObject({
			output: expect.stringContaining("app starting"),
		});
		// Kept, stopped, for its logs; a redeploy replaces it.
		expect((await runtime.inspect(app.id))?.running).toBe(false);
		expect((await viaEdge(app.subdomain)).status).toBe(404);

		await expectAgreement([app.id]);
	});

	test("an app that is running again at the second run stays ready", async () => {
		const app = await grown();
		await runtime.stop(app.id, 1);
		const memory = newMemory();
		expect((await reconcile(deps(), memory)).down).toEqual([app.id]);

		await runtime.start(app.id);
		const second = await reconcile(deps(), memory);
		expect(second.crashed).toEqual([]);
		expect(memory.down.size).toBe(0);
		expect((await rowOf(app.id))?.status).toBe("ready");
	});

	test("leftovers of a deleted culture and of an old version are removed", async () => {
		const deleted = await grown();
		// Deleted, but its cleanup never happened.
		await updateStatus(db, deleted.id, "deleting", { message: "Deleting" });
		await updateStatus(db, deleted.id, "deleted", { message: "Deleted" });

		// An image of an earlier build of a ready culture, left when
		// removing old versions failed.
		const ready = await grown();
		const oldBuild = randomUUID();
		created.at(-1)?.buildIds.push(oldBuild);
		await docker.call(
			"POST",
			`/images/${encodeURIComponent(imageName(ready.id, ready.buildId))}/tag`,
			{ query: { repo: `petri/${ready.id}`, tag: oldBuild } },
		);

		// A network of a culture this database doesn't know (e.g. another
		// test run's): left alone.
		const stranger = randomUUID();
		created.push({ deploymentId: stranger, buildIds: [] });
		await runtime.ensureNetwork(stranger);

		const result = await reconcile(deps(), newMemory());
		expect(result.removed.sort()).toEqual(
			[
				containerName(deleted.id),
				networkName(deleted.id),
				imageName(deleted.id, deleted.buildId),
				imageName(ready.id, oldBuild),
			].sort(),
		);
		expect(result.unknown).toContain(stranger);
		expect(await appExists(deleted.id, deleted.buildId)).toEqual({
			container: false,
			network: false,
			image: false,
		});
		expect(await appExists(ready.id, ready.buildId)).toEqual({
			container: true,
			network: true,
			image: true,
		});
		expect(await exists(`/networks/${networkName(stranger)}`)).toBe(true);
		expect((await viaEdge(ready.subdomain)).status).toBe(200);
		const [last] = (await history(deleted.id)).slice(-1);
		expect(last).toMatchObject({
			type: "recovery",
			message: expect.stringContaining("Removed leftovers"),
		});

		await expectAgreement([deleted.id, ready.id]);
	});

	test("a culture in a build step only recently is left alone", async () => {
		const app = await queued();
		for (const to of ["cloning", "building"] as DeploymentStatus[]) {
			await updateStatus(db, app.deploymentId, to, { message: to });
		}
		const result = await reconcile(deps(), newMemory());
		expect(result.interrupted).toEqual([]);
		expect((await rowOf(app.deploymentId))?.status).toBe("building");
	});
});
