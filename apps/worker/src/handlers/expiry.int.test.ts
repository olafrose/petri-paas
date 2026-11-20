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
import { DockerClient, DockerRuntime, networkName } from "@petri/runtime";
import { asc, eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { testEdge, viaEdge } from "../../test/edge.ts";
import { imageName } from "./app-runtime.ts";
import {
	type DeploymentRunSettings,
	deploymentRunHandler,
} from "./deployment-run.ts";
import { expireDeployments } from "./expiry.ts";

/*
 * The expiry job, with the time moved: deployments are grown for real,
 * then their expiry is put in the past (or the job is run in the
 * future).
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
const base = mkdtempSync(join(tmpdir(), "petri-expiry-"));
const created: { deploymentId: string; buildId: string }[] = [];
const HOUR_MS = 60 * 60 * 1000;

const WEB = [
	"FROM busybox:1.37",
	"RUN mkdir /www && echo hello-from-petri > /www/index.html",
	"EXPOSE 8080",
	'CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]',
].join("\n");

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

const deps = () => ({
	db,
	runtime,
	edge,
	log: pino({ level: "silent" }),
	settings,
});

/** A ready deployment from a ZIP upload, temporary for `ttlHours`. */
async function grown(lifecycle: "temporary" | "permanent" = "temporary") {
	const uploadId = randomUUID();
	const archive = join(settings.uploadsDir, `${uploadId}.zip`);
	writeFileSync(
		archive,
		buildZip([
			{ name: "app/", mode: 0o040755 },
			{ name: "app/Dockerfile", data: WEB },
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
			lifecycleMode: lifecycle,
			expiresAt:
				lifecycle === "temporary" ? new Date(Date.now() + 48 * HOUR_MS) : null,
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
	await deploymentRunHandler(deps())({
		id: randomUUID(),
		data: ids,
		retryCount: 0,
		signal: new AbortController().signal,
	});
	expect(await rowOf(ids.deploymentId)).toMatchObject({ status: "ready" });
	return {
		id: ids.deploymentId,
		buildId: ids.buildId,
		subdomain: deployment?.subdomain as string,
		archive,
	};
}

/** Its time ran out an hour ago. */
async function pastDue(id: string) {
	await db
		.update(deployments)
		.set({ expiresAt: new Date(Date.now() - HOUR_MS) })
		.where(eq(deployments.id, id));
}

async function rowOf(id: string) {
	const [row] = await db
		.select()
		.from(deployments)
		.where(eq(deployments.id, id));
	return row;
}

async function statuses(id: string) {
	const rows = await db
		.select()
		.from(deploymentEvents)
		.where(eq(deploymentEvents.deploymentId, id))
		.orderBy(asc(deploymentEvents.id));
	return rows
		.filter((row) => row.type === "status")
		.map((row) => (row.data as { to: DeploymentStatus }).to);
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

describe("expiry", { timeout: 120_000 }, () => {
	test("a ready culture past its time stops answering; its history stays", async () => {
		const app = await grown();
		expect((await viaEdge(app.subdomain)).status).toBe(200);
		await pastDue(app.id);

		const result = await expireDeployments(deps());
		expect(result).toEqual({
			expired: [app.id],
			removed: [app.id],
			failed: [],
		});
		expect((await viaEdge(app.subdomain)).status).toBe(404);
		expect(await appExists(app.id, app.buildId)).toEqual({
			container: false,
			network: false,
			image: false,
		});
		expect(await rowOf(app.id)).toMatchObject({
			status: "expired",
			containerId: null,
			imageId: null,
			routeId: null,
		});
		expect((await statuses(app.id)).slice(-2)).toEqual(["ready", "expired"]);
		// Kept for growing it again: the archive, the build and its log.
		expect(existsSync(app.archive)).toBe(true);
		const [build] = await db
			.select()
			.from(builds)
			.where(eq(builds.id, app.buildId));
		expect(build?.status).toBe("succeeded");
		expect(readFileSync(build?.logPath as string, "utf8")).toContain("Ready");

		// Nothing left to do on the next run.
		expect(await expireDeployments(deps())).toEqual({
			expired: [],
			removed: [],
			failed: [],
		});
	});

	test("stopped and failed cultures expire too", async () => {
		const stopped = await grown();
		await updateStatus(db, stopped.id, "stopped", { message: "Stopped" });
		await edge.unpublish(stopped.id);
		await runtime.stop(stopped.id, 1);
		const failed = await grown();
		await updateStatus(db, failed.id, "failed", { message: "Crashed" });
		await pastDue(stopped.id);
		await pastDue(failed.id);

		const result = await expireDeployments(deps());
		expect(result.expired.sort()).toEqual([stopped.id, failed.id].sort());
		for (const app of [stopped, failed]) {
			expect((await rowOf(app.id))?.status).toBe("expired");
			expect((await appExists(app.id, app.buildId)).container).toBe(false);
		}
	});

	test("extended, permanent and busy cultures keep running", async () => {
		const extended = await grown();
		const permanent = await grown("permanent");
		// Growing a new batch next to its ready version: waits for it.
		const growing = await grown();
		await pastDue(growing.id);
		await db.insert(builds).values({ deploymentId: growing.id });

		// Two days on: the 48 hours of `extended` haven't run out.
		const now = new Date(Date.now() + 47 * HOUR_MS);
		expect((await expireDeployments(deps(), now)).expired).toEqual([]);
		for (const app of [extended, permanent, growing]) {
			expect((await rowOf(app.id))?.status).toBe("ready");
			expect((await viaEdge(app.subdomain)).status).toBe(200);
		}

		// Once its time is up, as with any other.
		const later = new Date(Date.now() + 49 * HOUR_MS);
		expect((await expireDeployments(deps(), later)).expired).toEqual([
			extended.id,
		]);
		expect((await rowOf(permanent.id))?.status).toBe("ready");
	});

	test("a removal that failed is tried again on the next run", async () => {
		const app = await grown();
		await pastDue(app.id);
		const broken = {
			...deps(),
			runtime: new DockerRuntime("tcp://127.0.0.1:9"),
		};
		const first = await expireDeployments(broken);
		expect(first).toMatchObject({ expired: [app.id], failed: [app.id] });
		// Expired all the same: nothing routes it again.
		expect((await rowOf(app.id))?.status).toBe("expired");
		expect((await rowOf(app.id))?.containerId).not.toBeNull();

		const second = await expireDeployments(deps());
		expect(second).toEqual({ expired: [], removed: [app.id], failed: [] });
		expect((await viaEdge(app.subdomain)).status).toBe(404);
		expect(await appExists(app.id, app.buildId)).toEqual({
			container: false,
			network: false,
			image: false,
		});
	});
});
