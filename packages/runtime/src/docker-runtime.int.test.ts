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
import { buildImage } from "@petri/build-engine";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import { DockerApiError, DockerClient } from "./docker-client.ts";
import {
	createBody,
	DockerRuntime,
	KEPT_CAPABILITIES,
} from "./docker-runtime.ts";

// Both started by `pnpm dev:infra` (and in CI).
const dockerHost = process.env.DOCKER_PROXY_HOST ?? "tcp://127.0.0.1:2375";
const buildkitHost = process.env.BUILDKIT_HOST ?? "tcp://127.0.0.1:1234";
const localBuildctl = new URL("../../../.tools/bin/buildctl", import.meta.url)
	.pathname;
const buildctlPath =
	process.env.BUILDCTL_PATH ??
	(existsSync(localBuildctl) ? localBuildctl : "buildctl");

const runtime = new DockerRuntime(dockerHost);
const docker = new DockerClient(dockerHost);
const workDir = mkdtempSync(join(tmpdir(), "petri-runtime-"));
const created: string[] = [];
const images: Record<"web" | "crash", { name: string; archive: string }> = {
	web: {
		name: `petri-test/web:${randomUUID()}`,
		archive: join(workDir, "web.tar"),
	},
	crash: {
		name: `petri-test/crash:${randomUUID()}`,
		archive: join(workDir, "crash.tar"),
	},
};

async function build(kind: keyof typeof images, dockerfile: string) {
	const source = join(workDir, kind);
	rmSync(source, { recursive: true, force: true });
	mkdirSync(source);
	writeFileSync(join(source, "Dockerfile"), dockerfile);
	await buildImage({
		sourceDir: source,
		imageName: images[kind].name,
		outputFile: images[kind].archive,
		buildkitHost,
		buildctlPath,
	});
}

beforeAll(async () => {
	await build(
		"web",
		[
			"FROM busybox:1.37",
			"RUN mkdir /www && echo hello-from-petri > /www/index.html",
			'CMD ["sh", "-c", "echo started; exec httpd -f -p 8080 -h /www"]',
		].join("\n"),
	);
	await build(
		"crash",
		'FROM busybox:1.37\nCMD ["sh", "-c", "echo crashing; exit 7"]\n',
	);
}, 180_000);

afterEach(async () => {
	for (const id of created.splice(0)) {
		await runtime.removeContainer(id);
		await runtime.removeNetwork(id);
	}
});

afterAll(async () => {
	await runtime.removeImage(images.web.name);
	await runtime.removeImage(images.crash.name);
	rmSync(workDir, { recursive: true, force: true });
});

/** A fresh deployment id, cleaned up after the test. */
function deployment() {
	const id = randomUUID();
	created.push(id);
	return id;
}

async function runWeb(deploymentId: string, buildId = "build-1") {
	await runtime.loadImage(images.web.archive, images.web.name);
	const network = await runtime.ensureNetwork(deploymentId);
	const containerId = await runtime.createContainer({
		deploymentId,
		buildId,
		image: images.web.name,
		network,
	});
	await runtime.start(deploymentId);
	return { network, containerId };
}

describe("images and networks", { timeout: 60_000 }, () => {
	test("loads an image archive from BuildKit", async () => {
		const id = await runtime.loadImage(images.web.archive, images.web.name);
		expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	test("a deployment's network is created once", async () => {
		const id = deployment();
		const first = await runtime.ensureNetwork(id);
		const second = await runtime.ensureNetwork(id);
		expect(second).toBe(first);
	});
});

describe("containers", { timeout: 60_000 }, () => {
	test("run with the fixed security settings and limits", async () => {
		const id = deployment();
		const { network } = await runWeb(id);
		const { body } = await docker.call<{
			HostConfig: Record<string, unknown>;
			Config: { Labels: Record<string, string> };
		}>("GET", `/containers/petri-${id}/json`);

		expect(body.HostConfig).toMatchObject({
			Memory: 512 * 1024 * 1024,
			MemorySwap: 512 * 1024 * 1024,
			NanoCpus: 1e9,
			PidsLimit: 256,
			CapDrop: ["ALL"],
			Privileged: false,
			PublishAllPorts: false,
			Init: true,
			NetworkMode: network,
		});
		expect([...(body.HostConfig.CapAdd as string[])].sort()).toEqual(
			[...KEPT_CAPABILITIES].sort(),
		);
		expect(body.HostConfig.SecurityOpt).toContain("no-new-privileges:true");
		expect(body.HostConfig.PortBindings ?? {}).toEqual({});
		expect(body.HostConfig.Binds ?? []).toEqual([]);
		expect(body.Config.Labels).toMatchObject({
			"dev.petri.managed": "true",
			"dev.petri.deployment": id,
			"dev.petri.build": "build-1",
		});
	});

	test("are reachable on their network and answer", async () => {
		const id = deployment();
		const { network } = await runWeb(id);
		const state = await runtime.inspect(id);
		expect(state?.running).toBe(true);
		const address = state?.addresses[network];
		expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

		// From the host, the bridge network is reachable (Linux).
		await vi.waitFor(
			async () => {
				const response = await fetch(`http://${address}:8080/`);
				expect(await response.text()).toBe("hello-from-petri\n");
			},
			{ timeout: 10_000, interval: 250 },
		);
		expect(await runtime.logs(id)).toContain("started");
	});

	test("creating again for the same build reuses the container", async () => {
		const id = deployment();
		const { network, containerId } = await runWeb(id);
		const again = await runtime.createContainer({
			deploymentId: id,
			buildId: "build-1",
			image: images.web.name,
			network,
		});
		expect(again).toBe(containerId);
	});

	test("a new build replaces the old container", async () => {
		const id = deployment();
		const { network, containerId } = await runWeb(id);
		const replaced = await runtime.createContainer({
			deploymentId: id,
			buildId: "build-2",
			image: images.web.name,
			network,
		});
		expect(replaced).not.toBe(containerId);
		expect((await runtime.inspect(id))?.buildId).toBe("build-2");
	});

	test("restart automatically only once enabled", async () => {
		const id = deployment();
		await runWeb(id);
		const policy = async () => (await runtime.inspect(id))?.restartPolicy;
		expect(await policy()).toBe("no");
		await runtime.enableRestarts(id);
		expect(await policy()).toBe("unless-stopped");
		await runtime.disableRestarts(id);
		expect(await policy()).toBe("no");
	});

	test("stop, start and remove", async () => {
		const id = deployment();
		await runWeb(id);
		await runtime.stop(id, 2);
		expect((await runtime.inspect(id))?.running).toBe(false);
		await runtime.stop(id, 2); // already stopped: fine
		await runtime.start(id);
		expect((await runtime.inspect(id))?.running).toBe(true);
		await runtime.removeContainer(id);
		expect(await runtime.inspect(id)).toBeNull();
		await runtime.removeContainer(id); // already gone: fine
	});

	test("joining and leaving another network, each twice", async () => {
		const id = deployment();
		await runWeb(id);
		const other = deployment();
		const network = await runtime.ensureNetwork(other);
		const container = `petri-${id}`;

		await runtime.connect(network, container);
		await runtime.connect(network, container); // already connected: fine
		expect(await runtime.networksOf(container)).toEqual(
			expect.arrayContaining([`petri-${id}`, network]),
		);
		await runtime.disconnect(network, container);
		await runtime.disconnect(network, container); // not connected: fine
		expect(await runtime.networksOf(container)).toEqual([`petri-${id}`]);
	});

	test("a crashing app is reported with its exit code", async () => {
		const id = deployment();
		await runtime.loadImage(images.crash.archive, images.crash.name);
		const network = await runtime.ensureNetwork(id);
		await runtime.createContainer({
			deploymentId: id,
			buildId: "b",
			image: images.crash.name,
			network,
		});
		await runtime.start(id);
		await vi.waitFor(
			async () => {
				const state = await runtime.inspect(id);
				expect(state?.exitCode).toBe(7);
			},
			{ timeout: 10_000, interval: 100 },
		);
		expect(await runtime.logs(id)).toContain("crashing");
	});
});

describe("the socket proxy", () => {
	test("blocks running commands in apps, volumes, builds and system information", async () => {
		const id = deployment();
		await runWeb(id);
		// Creating an exec session falls under the containers API, but it
		// can't be started or inspected, so no command ever runs.
		const { body } = await docker.call<{ Id: string }>(
			"POST",
			`/containers/petri-${id}/exec`,
			{ json: { Cmd: ["id"], AttachStdout: true } },
		);
		for (const [method, path] of [
			["POST", `/exec/${body.Id}/start`],
			["GET", `/exec/${body.Id}/json`],
			["GET", "/volumes"],
			["GET", "/info"],
			["POST", "/build"],
			["POST", "/swarm/init"],
		] as const) {
			const error = await docker.call(method, path, { json: {} }).then(
				() => null,
				(caught: unknown) => caught,
			);
			expect(error, `${method} ${path}`).toBeInstanceOf(DockerApiError);
			expect((error as DockerApiError).status, `${method} ${path}`).toBe(403);
		}
	}, 60_000);
});

test("callers cannot loosen the security settings", () => {
	const body = createBody({
		deploymentId: "d",
		buildId: "b",
		image: "x",
		network: "n",
		// Not part of ContainerSpec; a sloppy or malicious caller.
		...({ HostConfig: { Privileged: true }, privileged: true } as object),
	});
	expect(body.HostConfig.Privileged).toBe(false);
	expect(body.HostConfig.CapDrop).toEqual(["ALL"]);
	expect(body.HostConfig.Binds).toEqual([]);
});
