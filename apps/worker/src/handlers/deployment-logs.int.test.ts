import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImage } from "@petri/build-engine";
import { EventListener, type PetriEvent } from "@petri/database";
import { useTestDatabase } from "@petri/database/testing";
import {
	RUNTIME_LOGS_READY,
	runtimeLogsPath,
	runtimeLogsResult,
} from "@petri/jobs";
import { DockerRuntime } from "@petri/runtime";
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	inject,
	test,
	vi,
} from "vitest";
import { deploymentLogsHandler } from "./deployment-logs.ts";

const db = useTestDatabase();
const dockerHost = process.env.DOCKER_PROXY_HOST ?? "tcp://127.0.0.1:2375";
const buildkitHost = process.env.BUILDKIT_HOST ?? "tcp://127.0.0.1:1234";
const localBuildctl = new URL(
	"../../../../.tools/bin/buildctl",
	import.meta.url,
).pathname;
const runtime = new DockerRuntime(dockerHost);
const base = mkdtempSync(join(tmpdir(), "petri-logs-"));
const logsDir = join(base, "logs");
const image = `petri-test/logs:${randomUUID()}`;
const deploymentId = randomUUID();
const events = new EventListener(inject("databaseUrl"));
const received: PetriEvent[] = [];

const handler = deploymentLogsHandler({ db, runtime, settings: { logsDir } });
const run = (data: { deploymentId: string; lines: number }) => {
	const requestId = randomUUID();
	return handler({
		id: randomUUID(),
		data: { ...data, requestId },
		retryCount: 0,
		signal: new AbortController().signal,
	}).then(() => ({
		requestId,
		result: runtimeLogsResult.parse(
			JSON.parse(readFileSync(runtimeLogsPath(logsDir, requestId), "utf8")),
		),
	}));
};

beforeAll(async () => {
	const source = join(base, "app");
	mkdirSync(source);
	writeFileSync(
		join(source, "Dockerfile"),
		'FROM busybox:1.37\nCMD ["sh", "-c", "for i in 1 2 3 4 5; do echo line-$i; done; echo oops >&2; exec sleep 600"]\n',
	);
	await buildImage({
		sourceDir: source,
		imageName: image,
		outputFile: join(base, "app.tar"),
		buildkitHost,
		buildctlPath:
			process.env.BUILDCTL_PATH ??
			(existsSync(localBuildctl) ? localBuildctl : "buildctl"),
	});
	await runtime.loadImage(join(base, "app.tar"), image);
	const network = await runtime.ensureNetwork(deploymentId);
	await runtime.createContainer({
		deploymentId,
		buildId: randomUUID(),
		image,
		network,
	});
	await runtime.start(deploymentId);
	await events.start();
	events.subscribe((event) => received.push(event));
}, 180_000);

afterAll(async () => {
	await events.stop();
	await runtime.removeContainer(deploymentId);
	await runtime.removeNetwork(deploymentId);
	await runtime.removeImage(image);
	rmSync(base, { recursive: true, force: true });
});

describe("deployment.logs", () => {
	test("writes the app's last lines, with their times, and says so", async () => {
		await vi.waitFor(
			async () => expect(await runtime.logs(deploymentId)).toContain("oops"),
			{ timeout: 10_000 },
		);
		const { requestId, result } = await run({ deploymentId, lines: 6 });

		expect(result.container).toEqual({ status: "running", running: true });
		expect(result.truncated).toBe(false);
		const lines = result.text.trimEnd().split("\n");
		// stdout and stderr; their order within a moment isn't defined (two
		// pipes). Times to the second, in UTC.
		expect(lines.map((line) => line.slice(21)).sort()).toEqual([
			"line-1",
			"line-2",
			"line-3",
			"line-4",
			"line-5",
			"oops",
		]);
		for (const line of lines) {
			expect(line).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ \S+$/);
		}
		const { result: last } = await run({ deploymentId, lines: 2 });
		expect(last.text.trimEnd().split("\n")).toHaveLength(2);

		await vi.waitFor(() =>
			expect(received).toContainEqual({ type: RUNTIME_LOGS_READY, requestId }),
		);
	});

	test("answers that there is no container", async () => {
		const { result } = await run({ deploymentId: randomUUID(), lines: 10 });
		expect(result).toMatchObject({ container: null, text: "" });
	});

	test("removes answers nobody picked up", async () => {
		const old = runtimeLogsPath(logsDir, randomUUID());
		writeFileSync(old, "{}");
		const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
		utimesSync(old, tenMinutesAgo, tenMinutesAgo);

		const { requestId } = await run({ deploymentId, lines: 1 });
		expect(existsSync(old)).toBe(false);
		expect(existsSync(runtimeLogsPath(logsDir, requestId))).toBe(true);
	});
});
