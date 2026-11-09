import { spawn } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPublicAddress } from "./address-policy.ts";
import { diskUsage } from "./disk-usage.ts";
import { SourceError } from "./errors.ts";

export type LookupFn = (hostname: string) => Promise<string[]>;

export interface GitFetchOptions {
	/** HTTPS URL of the repository. */
	repository: string;
	/** Branch, tag or full commit SHA. */
	ref: string;
	/** Existing, empty directory to check the source out into. */
	destination: string;
	timeoutMs?: number;
	/** Maximum size of the fetched repository on disk. */
	maxBytes?: number;
	signal?: AbortSignal;
	/** Receives Git's progress output, line by line. */
	onOutput?: (line: string) => void;

	// For tests only: a local HTTPS Git server on 127.0.0.1.
	lookup?: LookupFn;
	isAllowedAddress?: (address: string) => boolean;
	allowedPorts?: readonly number[];
	extraConfig?: readonly string[];
}

export interface GitFetchResult {
	/** The commit that was checked out. */
	commit: string;
}

/** How long a fetch may take, and how large the repository may get. */
export const DEFAULT_GIT_LIMITS = {
	timeoutMs: 2 * 60 * 1000,
	maxBytes: 500 * 1024 * 1024,
};
const SIZE_CHECK_INTERVAL_MS = 500;

const defaultLookup: LookupFn = async (hostname) =>
	(await dnsLookup(hostname, { all: true, verbatim: true })).map(
		(entry) => entry.address,
	);

/**
 * Fetches one ref of a public Git repository over HTTPS, shallowly, and
 * checks it out. The `.git` directory is removed afterwards; only the
 * source files remain.
 *
 * The host is resolved once and every address must be public. Git is then
 * pinned to that address, so a second, different DNS answer (DNS
 * rebinding) can't redirect it into the local network. Redirects,
 * credential prompts, hooks, submodules and non-HTTPS transports are off.
 */
export async function fetchGitSource(
	options: GitFetchOptions,
): Promise<GitFetchResult> {
	const url = parseRepositoryUrl(
		options.repository,
		options.allowedPorts ?? [443],
	);
	if (options.ref.startsWith("-")) {
		throw new SourceError("invalid_url", "Invalid branch, tag or commit");
	}
	const address = await resolvePublicAddress(
		url.hostname,
		options.lookup ?? defaultLookup,
		options.isAllowedAddress ?? isPublicAddress,
	);
	const port = url.port || "443";
	const pinned = `${url.hostname}:${port}:${isIP(address) === 6 ? `[${address}]` : address}`;

	// An empty home and no system config: nothing from the worker's own
	// environment (credentials, proxies, hooks) influences the fetch.
	const home = await mkdtemp(join(tmpdir(), "petri-git-home-"));
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: home,
		LANG: "C",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "/bin/false",
		SSH_ASKPASS: "/bin/false",
	};
	const config = [
		"protocol.allow=never",
		"protocol.https.allow=always",
		"http.followRedirects=false",
		`http.curloptResolve=${pinned}`,
		"credential.helper=",
		"core.hooksPath=/dev/null",
		"core.askPass=/bin/false",
		"submodule.recurse=false",
		"fetch.recurseSubmodules=false",
		"transfer.fsckObjects=true",
		"advice.detachedHead=false",
		...(options.extraConfig ?? []),
	].flatMap((entry) => ["-c", entry]);

	const timeout = AbortSignal.timeout(
		options.timeoutMs ?? DEFAULT_GIT_LIMITS.timeoutMs,
	);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeout])
		: timeout;
	const maxBytes = options.maxBytes ?? DEFAULT_GIT_LIMITS.maxBytes;
	const run = (args: string[], watchSize = false) =>
		runGit(args, {
			cwd: options.destination,
			env,
			config,
			signal,
			timeout,
			onOutput: options.onOutput,
			...(watchSize && {
				watch: { path: options.destination, maxBytes },
			}),
		});
	// The watchdog samples periodically; this catches anything that grew
	// past the limit between samples, or during checkout.
	const checkSize = async () => {
		if ((await diskUsage(options.destination)) > maxBytes) {
			throw new SourceError(
				"too_large",
				`The repository is larger than ${formatBytes(maxBytes)}`,
			);
		}
	};

	try {
		await run(["init", "--quiet", "--template=", "."]);
		await run(
			[
				"fetch",
				"--depth=1",
				"--no-tags",
				"--progress",
				"--",
				url.href,
				options.ref,
			],
			true,
		);
		await checkSize();
		await run(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
		await checkSize();
		const commit = (await run(["rev-parse", "HEAD"])).trim();
		await rm(join(options.destination, ".git"), {
			recursive: true,
			force: true,
		});
		return { commit };
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

function parseRepositoryUrl(
	value: string,
	allowedPorts: readonly number[],
): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new SourceError("invalid_url", "The repository URL is not valid");
	}
	if (url.protocol !== "https:") {
		throw new SourceError(
			"invalid_url",
			"Only HTTPS repository URLs are supported",
		);
	}
	if (url.username || url.password) {
		throw new SourceError(
			"invalid_url",
			"Repository URLs must not contain credentials",
		);
	}
	if (url.search || url.hash) {
		throw new SourceError(
			"invalid_url",
			"Repository URLs must not have a query",
		);
	}
	const port = Number(url.port || 443);
	if (!allowedPorts.includes(port)) {
		throw new SourceError("invalid_url", `Port ${port} is not allowed`);
	}
	return url;
}

async function resolvePublicAddress(
	hostname: string,
	lookup: LookupFn,
	isAllowed: (address: string) => boolean,
): Promise<string> {
	// URL keeps IPv6 literals in brackets.
	const literal = hostname.replace(/^\[(.*)\]$/, "$1");
	let addresses: string[];
	if (isIP(literal)) {
		addresses = [literal];
	} else {
		try {
			addresses = await lookup(hostname);
		} catch {
			throw new SourceError("dns_failed", `Could not resolve ${hostname}`);
		}
	}
	if (addresses.length === 0) {
		throw new SourceError("dns_failed", `Could not resolve ${hostname}`);
	}
	// All addresses must be public: otherwise which one is used would be
	// up to chance.
	if (!addresses.every(isAllowed)) {
		throw new SourceError(
			"blocked_address",
			`${hostname} points to a private or reserved address; only public repositories can be fetched`,
		);
	}
	return addresses[0] as string;
}

interface RunOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	config: string[];
	signal: AbortSignal;
	timeout: AbortSignal;
	onOutput?: ((line: string) => void) | undefined;
	watch?: { path: string; maxBytes: number };
}

function runGit(args: string[], options: RunOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		if (options.signal.aborted) {
			reject(abortError(options));
			return;
		}
		const child = spawn("git", [...options.config, ...args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			// Own process group, so the transport helpers die with it.
			detached: true,
		});
		let stdout = "";
		let stderrTail = "";
		let failure: SourceError | null = null;

		const kill = (reason: SourceError) => {
			failure ??= reason;
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				// already gone
			}
		};

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stderrTail = (stderrTail + text).slice(-4000);
			for (const line of text.split(/[\r\n]+/)) {
				if (line.trim()) options.onOutput?.(line.trim());
			}
		});

		const onAbort = () => kill(abortError(options));
		options.signal.addEventListener("abort", onAbort, { once: true });

		let checking = false;
		const sizeTimer = options.watch
			? setInterval(async () => {
					if (checking || !options.watch) return;
					checking = true;
					const size = await diskUsage(options.watch.path);
					checking = false;
					if (size > options.watch.maxBytes) {
						kill(
							new SourceError(
								"too_large",
								`The repository is larger than ${formatBytes(options.watch.maxBytes)}`,
							),
						);
					}
				}, SIZE_CHECK_INTERVAL_MS)
			: undefined;

		child.on("error", (error) => {
			kill(
				new SourceError("fetch_failed", `Could not run git: ${error.message}`),
			);
		});
		child.on("close", (code) => {
			options.signal.removeEventListener("abort", onAbort);
			if (sizeTimer) clearInterval(sizeTimer);
			if (failure) reject(failure);
			else if (code === 0) resolve(stdout);
			else reject(classifyGitError(stderrTail));
		});
	});
}

function abortError(options: RunOptions): SourceError {
	return options.timeout.aborted
		? new SourceError("timeout", "Fetching the repository took too long")
		: new SourceError("cancelled", "Fetching the repository was cancelled");
}

function classifyGitError(stderr: string): SourceError {
	const detail = lastMeaningfulLine(stderr);
	if (
		/couldn't find remote ref|not our ref|unadvertised object/i.test(stderr)
	) {
		return new SourceError("ref_not_found", "Branch, tag or commit not found");
	}
	if (/redirect/i.test(stderr)) {
		return new SourceError(
			"fetch_failed",
			"The repository URL redirects elsewhere; use the final URL",
		);
	}
	if (/repository .* not found|returned error: 40[134]/i.test(stderr)) {
		return new SourceError(
			"fetch_failed",
			"Repository not found or not public",
		);
	}
	return new SourceError(
		"fetch_failed",
		detail ? `Fetching failed: ${detail}` : "Fetching failed",
	);
}

function lastMeaningfulLine(text: string): string {
	const lines = text
		.split(/[\r\n]+/)
		.map((line) => line.trim())
		.filter(
			(line) =>
				line &&
				!/^(remote: )?(Enumerating|Counting|Compressing|Receiving|Resolving)/.test(
					line,
				),
		);
	return (lines.at(-1) ?? "").replace(/^(fatal|error): /, "").slice(0, 300);
}

function formatBytes(bytes: number): string {
	return bytes >= 1024 * 1024
		? `${Math.round(bytes / 1024 / 1024)} MB`
		: `${bytes} bytes`;
}
