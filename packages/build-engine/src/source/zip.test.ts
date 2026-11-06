import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildZip, type TestZipEntry } from "../../test/zip-writer.ts";
import { SourceError } from "./errors.ts";
import { extractZip, inspectZip, type ZipLimits } from "./zip.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function setup(entries: TestZipEntry[] | Buffer) {
	const base = mkdtempSync(join(tmpdir(), "petri-zip-"));
	dirs.push(base);
	const archive = join(base, "upload.zip");
	writeFileSync(
		archive,
		Buffer.isBuffer(entries) ? entries : buildZip(entries),
	);
	const destination = join(base, "out");
	mkdirSync(destination);
	return { base, archive, destination };
}

async function refused(promise: Promise<unknown>) {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(SourceError);
	return error as SourceError;
}

describe("valid archives", () => {
	test("extract files and directories", async () => {
		const { archive, destination } = setup([
			{ name: "Dockerfile", data: "FROM scratch\n" },
			{ name: "src/", mode: 0o040755 },
			{ name: "src/app.js", data: "console.log(1)\n", deflate: true },
			{ name: "start.sh", data: "#!/bin/sh\n", mode: 0o100755 },
		]);
		expect(await inspectZip(archive)).toMatchObject({ entries: 4 });
		expect(await extractZip(archive, destination)).toMatchObject({ files: 3 });
		expect(readFileSync(join(destination, "src/app.js"), "utf8")).toBe(
			"console.log(1)\n",
		);
		expect(statSync(join(destination, "start.sh")).mode & 0o777).toBe(0o755);
		expect(statSync(join(destination, "Dockerfile")).mode & 0o777).toBe(0o644);
	});

	test("a single top-level directory is removed (GitHub's Download ZIP)", async () => {
		const { archive, destination } = setup([
			{ name: "demo-main/", mode: 0o040755 },
			{ name: "demo-main/Dockerfile", data: "FROM scratch\n" },
			{ name: "demo-main/src/app.js", data: "x" },
		]);
		await extractZip(archive, destination);
		expect(readdirSync(destination).sort()).toEqual(["Dockerfile", "src"]);
	});

	test("several top-level entries are kept as they are", async () => {
		const { archive, destination } = setup([
			{ name: "app/index.js", data: "x" },
			{ name: "Dockerfile", data: "FROM scratch\n" },
		]);
		await extractZip(archive, destination);
		expect(readdirSync(destination).sort()).toEqual(["Dockerfile", "app"]);
	});
});

describe("unsafe archives are refused when inspected and when extracted", () => {
	test.each<[string, TestZipEntry[], RegExp]>([
		["parent directory", [{ name: "../evil.sh", data: "x" }], /outside/],
		[
			"nested parent directory",
			[{ name: "a/../../evil.sh", data: "x" }],
			/outside/,
		],
		[
			"absolute path",
			[{ name: "/etc/cron.d/evil", data: "x" }],
			/absolute|invalid/,
		],
		["drive letter", [{ name: "C:/evil", data: "x" }], /absolute/],
		["backslash path", [{ name: "..\\evil", data: "x" }], /invalid/],
		["control character", [{ name: "a\nb", data: "x" }], /invalid/],
		[
			"symbolic link",
			[{ name: "link", data: "/etc/passwd", mode: 0o120777 }],
			/symbolic link/,
		],
		["named pipe", [{ name: "fifo", mode: 0o010644 }], /special file/],
		[
			"duplicate entry",
			[
				{ name: "a.txt", data: "1" },
				{ name: "a.txt", data: "2" },
			],
			/more than once/,
		],
		[
			"case-only duplicate",
			[
				{ name: "README", data: "1" },
				{ name: "readme", data: "2" },
			],
			/more than once/,
		],
		[
			"encrypted entry",
			[{ name: "a.txt", data: "x", encrypted: true }],
			/encrypted/,
		],
		["empty archive", [], /empty/],
	])("%s", async (_label, entries, message) => {
		const { base, archive, destination } = setup(entries);
		const inspected = await refused(inspectZip(archive));
		expect(inspected.message).toMatch(message);
		const extracted = await refused(extractZip(archive, destination));
		expect(extracted.message).toMatch(message);
		expect(readdirSync(destination)).toEqual([]);
		expect(existsSync(join(base, "evil.sh"))).toBe(false);
	});

	test("a file that is not a ZIP archive", async () => {
		const { archive } = setup(Buffer.from("definitely not a zip"));
		expect((await refused(inspectZip(archive))).code).toBe("invalid_archive");
	});
});

describe("size limits", () => {
	const limits: ZipLimits = { maxEntries: 10, maxBytes: 1024 * 1024 };
	const megabytes = (n: number) => Buffer.alloc(n * 1024 * 1024);

	test("too many entries", async () => {
		const entries = Array.from({ length: 11 }, (_, i) => ({
			name: `f${i}`,
			data: "x",
		}));
		const { archive } = setup(entries);
		expect((await refused(inspectZip(archive, limits))).message).toMatch(
			/more than 10 entries/,
		);
	});

	test("declared sizes over the limit are refused on inspection", async () => {
		const { archive } = setup([
			{ name: "big", data: megabytes(2), deflate: true },
		]);
		expect((await refused(inspectZip(archive, limits))).code).toBe("too_large");
	});

	test("a zip bomb that lies about its size is stopped while extracting", async () => {
		// 2 MB of zeros compress to a few KB; the archive claims 10 bytes.
		const { archive, destination } = setup([
			{ name: "bomb", data: megabytes(2), deflate: true, declaredSize: 10 },
		]);
		await inspectZip(archive, limits); // the declared sizes look harmless
		await refused(extractZip(archive, destination, limits));
		expect(readdirSync(destination)).toEqual([]);
	});

	test("the total across files counts, not each file", async () => {
		const { archive, destination } = setup([
			{ name: "a", data: Buffer.alloc(600 * 1024), deflate: true },
			{ name: "b", data: Buffer.alloc(600 * 1024), deflate: true },
		]);
		expect((await refused(extractZip(archive, destination, limits))).code).toBe(
			"too_large",
		);
	});
});
