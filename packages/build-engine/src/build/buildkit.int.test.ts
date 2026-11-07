import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BuildError, type BuildImageOptions, buildImage } from "./buildkit.ts";

// Started by `pnpm dev:infra`; the client comes from scripts/install-buildctl.sh.
const buildkitHost = process.env.BUILDKIT_HOST ?? "tcp://127.0.0.1:1234";
const localBuildctl = new URL(
	"../../../../.tools/bin/buildctl",
	import.meta.url,
).pathname;
const buildctlPath =
	process.env.BUILDCTL_PATH ??
	(existsSync(localBuildctl) ? localBuildctl : "buildctl");

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A source directory with the given files, plus an output directory. */
function project(files: Record<string, string>) {
	const base = mkdtempSync(join(tmpdir(), "petri-build-"));
	dirs.push(base);
	const source = join(base, "source");
	for (const [path, content] of Object.entries(files)) {
		const full = join(source, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	mkdirSync(source, { recursive: true });
	return { base, source };
}

function options(
	base: string,
	source: string,
	overrides: Partial<BuildImageOptions> = {},
): BuildImageOptions {
	return {
		sourceDir: source,
		imageName: "petri-test/app:1",
		outputFile: join(base, "image.tar"),
		logFile: join(base, "build.log"),
		buildkitHost,
		buildctlPath,
		...overrides,
	};
}

async function failure(promise: Promise<unknown>): Promise<BuildError> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(BuildError);
	return error as BuildError;
}

const BASE = "FROM busybox:1.37";

/** Makes a RUN step unique, so BuildKit can't answer it from its cache. */
const fresh = () => `echo ${Date.now()}-${Math.random()} > /dev/null &&`;

/** A line printed by a RUN step, as opposed to the step's header. */
const output = (text: string) => new RegExp(`^#\\d+ [\\d.]+ ${text}$`, "m");

describe("building", { timeout: 120_000 }, () => {
	test("builds a Dockerfile into an image archive with a log", async () => {
		const { base, source } = project({
			Dockerfile: `${BASE}\nCOPY index.html /www/\nCMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n`,
			"index.html": "<h1>hello</h1>\n",
		});
		const lines: string[] = [];
		const result = await buildImage(
			options(base, source, { onLog: (line) => lines.push(line) }),
		);
		expect(result).toMatchObject({
			provider: "dockerfile",
			imageName: "petri-test/app:1",
		});

		const manifest = JSON.parse(
			execFileSync("tar", [
				"-xOf",
				result.outputFile,
				"manifest.json",
			]).toString(),
		);
		expect(manifest[0].RepoTags).toEqual(["petri-test/app:1"]);
		expect(lines.some((line) => line.includes("COPY index.html"))).toBe(true);
		expect(readFileSync(join(base, "build.log"), "utf8")).toContain(
			"COPY index.html",
		);
	});

	test("passes build arguments", async () => {
		const { base, source } = project({
			Dockerfile: `${BASE}\nARG GREETING=none\nRUN ${fresh()} echo "greeting=$GREETING"\n`,
		});
		await buildImage(
			options(base, source, { buildArgs: { GREETING: "hello-petri" } }),
		);
		expect(readFileSync(join(base, "build.log"), "utf8")).toMatch(
			output("greeting=hello-petri"),
		);
	});

	test("builds from a subdirectory", async () => {
		const { base, source } = project({
			"apps/site/Dockerfile": `${BASE}\nCOPY page.txt /\n`,
			"apps/site/page.txt": "x",
		});
		await buildImage(options(base, source, { directory: "apps/site" }));
		expect(existsSync(join(base, "image.tar"))).toBe(true);
	});

	test("a failing step fails the build, with the reason and the log kept", async () => {
		const { base, source } = project({
			Dockerfile: `${BASE}\nRUN ${fresh()} echo "about to fail" && exit 3\n`,
		});
		const error = await failure(buildImage(options(base, source)));
		expect(error.code).toBe("build_failed");
		expect(error.message).toContain("exit code: 3");
		expect(readFileSync(join(base, "build.log"), "utf8")).toMatch(
			output("about to fail"),
		);
	});
});

describe("refused before building", () => {
	test("no Dockerfile", async () => {
		const { base, source } = project({ "index.html": "x" });
		expect((await failure(buildImage(options(base, source)))).code).toBe(
			"no_dockerfile",
		);
	});

	test("a Dockerfile that is a symbolic link", async () => {
		const { base, source } = project({ "real.txt": `${BASE}\n` });
		symlinkSync("/etc/passwd", join(source, "Dockerfile"));
		expect((await failure(buildImage(options(base, source)))).code).toBe(
			"no_dockerfile",
		);
	});

	test("a build directory that does not exist", async () => {
		const { base, source } = project({ Dockerfile: `${BASE}\n` });
		const error = await failure(
			buildImage(options(base, source, { directory: "nope" })),
		);
		expect(error.code).toBe("invalid_directory");
	});

	test("a build directory that links outside the source", async () => {
		const { base, source } = project({ Dockerfile: `${BASE}\n` });
		symlinkSync("/etc", join(source, "escape"));
		const error = await failure(
			buildImage(options(base, source, { directory: "escape" })),
		);
		expect(error.code).toBe("invalid_directory");
		expect(error.message).toContain("outside");
	});
});

describe("limits and failures", { timeout: 120_000 }, () => {
	test("stops a build that takes too long", async () => {
		const { base, source } = project({
			Dockerfile: `${BASE}\nRUN ${fresh()} sleep 120\n`,
		});
		const started = Date.now();
		const error = await failure(
			buildImage(options(base, source, { timeoutMs: 8000 })),
		);
		expect(error.code).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(20_000);
	});

	test("reports an unreachable build service", async () => {
		const { base, source } = project({ Dockerfile: `${BASE}\n` });
		const error = await failure(
			buildImage(
				options(base, source, {
					buildkitHost: "tcp://127.0.0.1:1",
					timeoutMs: 20_000,
				}),
			),
		);
		expect(error.code).toBe("buildkit_unavailable");
	});

	test("caps the log file", async () => {
		const { base, source } = project({
			Dockerfile: `${BASE}\nRUN ${fresh()} for i in $(seq 1 200); do echo "line $i"; done\n`,
		});
		const lines: string[] = [];
		await buildImage(
			options(base, source, {
				maxLogBytes: 500,
				onLog: (line) => lines.push(line),
			}),
		);
		const log = readFileSync(join(base, "build.log"), "utf8");
		expect(Buffer.byteLength(log)).toBeLessThan(600);
		expect(log).toContain("[log truncated");
		// Only the stored log is capped, not the live output.
		expect(lines.join("\n")).toMatch(output("line 200"));
	});
});
