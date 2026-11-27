import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BuildError, chooseStrategy } from "./buildkit.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function context(files: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "petri-strategy-"));
	dirs.push(dir);
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

async function refusal(promise: Promise<unknown>): Promise<BuildError> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(BuildError);
	return error as BuildError;
}

describe("auto", () => {
	test("builds the Dockerfile if there is one", async () => {
		const dir = context({ Dockerfile: "FROM scratch\n", "package.json": "{}" });
		expect(await chooseStrategy(dir, "auto")).toEqual({
			provider: "dockerfile",
			reason: "Building the Dockerfile",
		});
	});

	test("uses buildpacks without one", async () => {
		const dir = context({ "package.json": "{}" });
		expect(await chooseStrategy(dir, "auto")).toEqual({
			provider: "buildpack",
			reason: "No Dockerfile: building with buildpacks (Paketo)",
		});
	});

	test("refuses a Dockerfile that is a link or a directory", async () => {
		const linked = context();
		symlinkSync("/etc/passwd", join(linked, "Dockerfile"));
		const directory = context();
		mkdirSync(join(directory, "Dockerfile"));
		for (const dir of [linked, directory]) {
			const error = await refusal(chooseStrategy(dir, "auto"));
			expect(error.code).toBe("no_dockerfile");
			expect(error.message).toContain("regular file");
		}
	});
});

describe("chosen", () => {
	test("dockerfile needs one", async () => {
		const error = await refusal(chooseStrategy(context(), "dockerfile"));
		expect(error.code).toBe("no_dockerfile");
		expect(error.message).toContain('build.strategy "auto"');
		expect(
			await chooseStrategy(context({ Dockerfile: "" }), "dockerfile"),
		).toMatchObject({ provider: "dockerfile" });
	});

	test("buildpacks ignores a Dockerfile", async () => {
		const dir = context({ Dockerfile: "FROM scratch\n" });
		expect(await chooseStrategy(dir, "buildpacks")).toEqual({
			provider: "buildpack",
			reason: "Building with buildpacks (build.strategy: buildpacks)",
		});
	});
});
