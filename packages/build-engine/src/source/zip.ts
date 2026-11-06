import { mkdir, open, rm } from "node:fs/promises";
import { dirname, posix, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { SourceError } from "./errors.ts";

export interface ZipLimits {
	/** Maximum number of entries (files and directories). */
	maxEntries: number;
	/** Maximum total size of all files once extracted. */
	maxBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
	maxEntries: 20_000,
	maxBytes: 500 * 1024 * 1024,
};

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const MAX_PATH_LENGTH = 1024;

interface CheckedEntry {
	entry: Entry;
	/** Normalized relative path, without a trailing slash. */
	path: string;
	isDirectory: boolean;
	executable: boolean;
}

/**
 * Checks an archive's directory without extracting it: entry names, types
 * and the declared sizes. Called when an archive is uploaded, so bad
 * archives are refused right away. `extractZip` checks again, against the
 * actual data.
 */
export async function inspectZip(
	archivePath: string,
	limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<{ entries: number; declaredBytes: number }> {
	const zip = await openZip(archivePath);
	try {
		let declaredBytes = 0;
		const entries = await checkEntries(zip, limits, (entry) => {
			declaredBytes += entry.entry.uncompressedSize;
			if (declaredBytes > limits.maxBytes) throw tooLarge(limits);
		});
		return { entries: entries.length, declaredBytes };
	} finally {
		zip.close();
	}
}

/**
 * Extracts an archive into an empty directory, refusing anything unsafe:
 * paths outside the directory, absolute paths, symlinks and other special
 * files, duplicates, encrypted entries, and more data than the limits
 * allow (counted from the actual decompressed bytes, so a "zip bomb"
 * that lies about its sizes is stopped too).
 *
 * If all entries share one top-level directory (as in GitHub's "Download
 * ZIP"), that directory is removed from the paths.
 */
export async function extractZip(
	archivePath: string,
	destination: string,
	limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<{ files: number; bytes: number }> {
	const zip = await openZip(archivePath);
	const root = resolve(destination);
	try {
		const entries = await checkEntries(zip, limits);
		const prefix = commonRoot(entries);

		let bytes = 0;
		let files = 0;
		for (const item of entries) {
			const path = prefix ? item.path.slice(prefix.length + 1) : item.path;
			if (!path) continue; // the stripped root directory itself
			const target = resolve(root, ...path.split("/"));
			const rel = relative(root, target);
			if (rel.startsWith("..") || rel.startsWith(sep) || rel === "") {
				throw unsafe(`"${item.path}" points outside the archive`);
			}

			if (item.isDirectory) {
				await mkdir(target, { recursive: true, mode: 0o755 });
				continue;
			}
			await mkdir(dirname(target), { recursive: true, mode: 0o755 });

			const counter = new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					bytes += chunk.length;
					if (bytes > limits.maxBytes) callback(tooLarge(limits));
					else callback(null, chunk);
				},
			});
			// "wx": never overwrite, and never write through an existing link.
			const file = await open(target, "wx", item.executable ? 0o755 : 0o644);
			try {
				await pipeline(
					await openEntry(zip, item.entry),
					counter,
					file.createWriteStream(),
				);
			} catch (error) {
				throw error instanceof SourceError
					? error
					: unsafe(
							`"${item.path}" could not be extracted: ${(error as Error).message}`,
						);
			}
			files++;
		}
		return { files, bytes };
	} catch (error) {
		// Leave nothing half-extracted behind.
		await rm(root, { recursive: true, force: true });
		await mkdir(root, { recursive: true });
		throw error;
	} finally {
		zip.close();
	}
}

async function checkEntries(
	zip: ZipFile,
	limits: ZipLimits,
	onEntry?: (entry: CheckedEntry) => void,
): Promise<CheckedEntry[]> {
	const seen = new Set<string>();
	const checked: CheckedEntry[] = [];
	if (zip.entryCount > limits.maxEntries) {
		throw unsafe(`The archive has more than ${limits.maxEntries} entries`);
	}
	for await (const entry of readEntries(zip)) {
		const item = checkEntry(entry);
		const key = item.path.toLowerCase();
		if (seen.has(key)) {
			throw unsafe(`"${item.path}" appears more than once in the archive`);
		}
		seen.add(key);
		onEntry?.(item);
		checked.push(item);
	}
	if (checked.length === 0) throw unsafe("The archive is empty");
	return checked;
}

function checkEntry(entry: Entry): CheckedEntry {
	const name = entry.fileName;
	if (name.length > MAX_PATH_LENGTH)
		throw unsafe("An entry's path is too long");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	if (/[\u0000-\u001f\\]/.test(name)) {
		throw unsafe(`"${printable(name)}" has an invalid character in its path`);
	}
	if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
		throw unsafe(`"${name}" is an absolute path`);
	}
	const isDirectory = name.endsWith("/");
	const path = posix.normalize(name).replace(/\/+$/, "");
	if (
		path === "" ||
		path === "." ||
		path.split("/").some((part) => part === ".." || part === ".")
	) {
		throw unsafe(`"${name}" points outside the archive`);
	}
	if (name.split("/").includes("..")) {
		throw unsafe(`"${name}" points outside the archive`);
	}
	if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
		throw unsafe(`"${name}" is encrypted`);
	}

	// Unix file type, if the archive was made on Unix (upper 16 bits).
	const madeOnUnix = entry.versionMadeBy >> 8 === 3;
	const mode = madeOnUnix ? entry.externalFileAttributes >>> 16 : 0;
	const type = mode & S_IFMT;
	if (type !== 0) {
		if (isDirectory ? type !== S_IFDIR : type !== S_IFREG) {
			throw unsafe(
				`"${name}" is a ${type === 0o120000 ? "symbolic link" : "special file"}; only files and directories are allowed`,
			);
		}
	}
	return { entry, path, isDirectory, executable: (mode & 0o111) !== 0 };
}

/** The single top-level directory shared by all entries, if any. */
function commonRoot(entries: CheckedEntry[]): string | null {
	const first = entries[0]?.path.split("/")[0];
	if (!first) return null;
	const allInside = entries.every((item) =>
		item.path === first ? item.isDirectory : item.path.startsWith(`${first}/`),
	);
	return allInside && entries.some((item) => item.path !== first)
		? first
		: null;
}

function openZip(path: string): Promise<ZipFile> {
	return new Promise((resolvePromise, reject) => {
		yauzl.open(
			path,
			{
				lazyEntries: true,
				autoClose: false,
				validateEntrySizes: true,
				strictFileNames: true,
				decodeStrings: true,
			},
			(error, zip) => {
				if (error || !zip) {
					reject(
						unsafe(
							`The file is not a valid ZIP archive: ${error?.message ?? "unknown error"}`,
						),
					);
				} else {
					resolvePromise(zip);
				}
			},
		);
	});
}

async function* readEntries(zip: ZipFile): AsyncGenerator<Entry> {
	while (true) {
		const entry = await new Promise<Entry | null>((resolvePromise, reject) => {
			const cleanup = () => {
				zip.off("entry", onEntry);
				zip.off("end", onEnd);
				zip.off("error", onError);
			};
			const onEntry = (value: Entry) => {
				cleanup();
				resolvePromise(value);
			};
			const onEnd = () => {
				cleanup();
				resolvePromise(null);
			};
			const onError = (error: Error) => {
				cleanup();
				reject(describeYauzlError(error));
			};
			zip.on("entry", onEntry);
			zip.on("end", onEnd);
			zip.on("error", onError);
			zip.readEntry();
		});
		if (!entry) return;
		yield entry;
	}
}

function openEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
	return new Promise((resolvePromise, reject) => {
		zip.openReadStream(entry, (error, stream) => {
			if (error || !stream)
				reject(unsafe(`"${entry.fileName}" could not be read`));
			else resolvePromise(stream);
		});
	});
}

/** yauzl's own checks, in the same words as ours. */
function describeYauzlError(error: Error): SourceError {
	const match =
		/^(invalid relative path|absolute path|invalid characters in fileName): (.*)$/.exec(
			error.message,
		);
	if (match) {
		const [, kind, name] = match;
		return unsafe(
			kind === "absolute path"
				? `"${name}" is an absolute path`
				: kind === "invalid relative path"
					? `"${name}" points outside the archive`
					: `"${name}" has an invalid character in its path`,
		);
	}
	return unsafe(`The archive is damaged: ${error.message}`);
}

function unsafe(message: string): SourceError {
	return new SourceError("invalid_archive", message);
}

function tooLarge(limits: ZipLimits): SourceError {
	return new SourceError(
		"too_large",
		`The archive extracts to more than ${Math.round(limits.maxBytes / 1024 / 1024)} MB`,
	);
}

function printable(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: replacing control characters is the point
	return value.replace(/[\u0000-\u001f]/g, "?");
}
