import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

export type BuildErrorCode =
	| "invalid_directory"
	| "no_dockerfile"
	| "build_failed"
	| "buildkit_unavailable"
	| "timeout"
	| "cancelled";

/** A build failed. `message` is safe to show the owner. */
export class BuildError extends Error {
	readonly code: BuildErrorCode;

	constructor(code: BuildErrorCode, message: string) {
		super(message);
		this.name = "BuildError";
		this.code = code;
	}
}

export interface BuildImageOptions {
	/** The fetched or extracted source. */
	sourceDir: string;
	/** Subdirectory of the source to build, if not the root. */
	directory?: string | undefined;
	/** Name for the image, e.g. "petri/<deployment>:<build>". */
	imageName: string;
	/** Where to write the image (Docker image archive). */
	outputFile: string;
	buildArgs?: Record<string, string>;
	/** BuildKit daemon address, e.g. tcp://buildkitd:1234. */
	buildkitHost: string;
	buildctlPath?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** The build log is written here, capped at `maxLogBytes`. */
	logFile?: string;
	maxLogBytes?: number;
	/** Receives the build output, line by line. */
	onLog?: (line: string) => void;
}

export interface BuildImageResult {
	provider: "dockerfile";
	imageName: string;
	outputFile: string;
}

/** How long a build may take. */
export const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Builds a Dockerfile with BuildKit and writes the image to a file. The
 * daemon runs rootless, in its own container; this only drives it with
 * `buildctl`.
 */
export async function buildImage(
	options: BuildImageOptions,
): Promise<BuildImageResult> {
	const context = await resolveContext(options.sourceDir, options.directory);
	await requireDockerfile(context);

	const args = [
		"--addr",
		options.buildkitHost,
		"build",
		"--frontend",
		"dockerfile.v0",
		"--local",
		`context=${context}`,
		"--local",
		`dockerfile=${context}`,
		"--opt",
		"filename=Dockerfile",
		"--progress",
		"plain",
		"--output",
		`type=docker,name=${options.imageName},dest=${options.outputFile}`,
	];
	for (const [key, value] of Object.entries(options.buildArgs ?? {})) {
		args.push("--opt", `build-arg:${key}=${value}`);
	}

	const home = await mkdtemp(join(tmpdir(), "petri-buildctl-home-"));
	const log = options.logFile
		? new CappedLog(
				options.logFile,
				options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES,
			)
		: null;
	try {
		await runBuildctl(options.buildctlPath ?? "buildctl", args, {
			env: { PATH: process.env.PATH, HOME: home, LANG: "C" },
			timeoutMs: options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
			signal: options.signal,
			onLine: (line) => {
				log?.write(line);
				options.onLog?.(line);
			},
		});
		return {
			provider: "dockerfile",
			imageName: options.imageName,
			outputFile: options.outputFile,
		};
	} finally {
		await log?.close();
		await rm(home, { recursive: true, force: true });
	}
}

/** The build directory, guaranteed to be inside the source. */
async function resolveContext(
	sourceDir: string,
	directory: string | undefined,
): Promise<string> {
	const root = await realpath(sourceDir);
	if (!directory) return root;
	const invalid = () =>
		new BuildError(
			"invalid_directory",
			`The build directory "${directory}" does not exist in the source`,
		);
	let target: string;
	try {
		// realpath follows symlinks, so a link pointing outside is caught.
		target = await realpath(resolve(root, directory));
	} catch {
		throw invalid();
	}
	const rel = relative(root, target);
	if (rel.startsWith("..") || rel.startsWith(sep)) {
		throw new BuildError(
			"invalid_directory",
			`The build directory "${directory}" points outside the source`,
		);
	}
	if (!(await stat(target)).isDirectory()) throw invalid();
	return target;
}

async function requireDockerfile(context: string) {
	try {
		const info = await lstat(join(context, "Dockerfile"));
		if (info.isFile()) return;
		throw new BuildError(
			"no_dockerfile",
			"The Dockerfile must be a regular file, not a link or directory",
		);
	} catch (error) {
		if (error instanceof BuildError) throw error;
		throw new BuildError(
			"no_dockerfile",
			"No Dockerfile found. Add one to the build directory (automatic builds without a Dockerfile come later).",
		);
	}
}

function runBuildctl(
	command: string,
	args: string[],
	options: {
		env: NodeJS.ProcessEnv;
		timeoutMs: number;
		signal?: AbortSignal | undefined;
		onLine: (line: string) => void;
	},
): Promise<void> {
	const timeout = AbortSignal.timeout(options.timeoutMs);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeout])
		: timeout;

	return new Promise((resolvePromise, reject) => {
		if (signal.aborted) {
			reject(abortReason(timeout));
			return;
		}
		const child = spawn(command, args, {
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		let failure: BuildError | null = null;
		const tail: string[] = [];
		let pending = "";

		const onData = (chunk: Buffer) => {
			pending += chunk.toString();
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) emit(line);
		};
		const emit = (line: string) => {
			const trimmed = line.trimEnd();
			if (!trimmed) return;
			options.onLine(trimmed);
			tail.push(trimmed);
			if (tail.length > 40) tail.shift();
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);

		// Ending buildctl closes its session, which cancels the build.
		const onAbort = () => {
			failure ??= abortReason(timeout);
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				// already gone
			}
		};
		signal.addEventListener("abort", onAbort, { once: true });

		child.on("error", (error) => {
			failure ??= new BuildError(
				"buildkit_unavailable",
				`Could not run buildctl: ${error.message}`,
			);
		});
		child.on("close", (code) => {
			signal.removeEventListener("abort", onAbort);
			if (pending) emit(pending);
			if (failure) reject(failure);
			else if (code === 0) resolvePromise();
			else reject(classify(tail));
		});
	});
}

function abortReason(timeout: AbortSignal): BuildError {
	return timeout.aborted
		? new BuildError("timeout", "The build took too long and was stopped")
		: new BuildError("cancelled", "The build was cancelled");
}

function classify(tail: string[]): BuildError {
	const text = tail.join("\n");
	if (
		/connection refused|no such host|failed to dial|context deadline exceeded.*dial/i.test(
			text,
		)
	) {
		return new BuildError(
			"buildkit_unavailable",
			"The build service is not reachable",
		);
	}
	// BuildKit's summary, e.g. `process "/bin/sh -c npm ci" did not complete
	// successfully: exit code: 1`.
	const summary =
		[...tail].reverse().find((line) => /^(error|ERROR):/.test(line)) ??
		tail.at(-1) ??
		"unknown error";
	return new BuildError(
		"build_failed",
		`Build failed: ${summary.replace(/^(error|ERROR):\s*/, "").slice(0, 500)}`,
	);
}

/** A log file that stops growing at a size limit, with a note saying so. */
class CappedLog {
	readonly #stream: WriteStream;
	readonly #maxBytes: number;
	#written = 0;
	#capped = false;

	constructor(path: string, maxBytes: number) {
		this.#stream = createWriteStream(path, { flags: "a", mode: 0o640 });
		this.#maxBytes = maxBytes;
	}

	write(line: string) {
		if (this.#capped) return;
		const data = `${line}\n`;
		const size = Buffer.byteLength(data);
		if (this.#written + size > this.#maxBytes) {
			this.#stream.write("[log truncated: size limit reached]\n");
			this.#capped = true;
			return;
		}
		this.#written += size;
		this.#stream.write(data);
	}

	close(): Promise<void> {
		return new Promise((resolvePromise) => this.#stream.end(resolvePromise));
	}
}
