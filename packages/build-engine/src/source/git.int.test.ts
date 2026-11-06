import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import {
	startGitServer,
	TEST_HOST,
	type TestGitServer,
} from "../../test/git-server.ts";
import { SourceError } from "./errors.ts";
import { fetchGitSource, type GitFetchOptions } from "./git.ts";

let server: TestGitServer;
const workspaces: string[] = [];

beforeAll(async () => {
	server = await startGitServer();
});
afterAll(async () => {
	await server.close();
});
afterEach(() => {
	for (const dir of workspaces.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function workspace() {
	const dir = mkdtempSync(join(tmpdir(), "petri-ws-"));
	workspaces.push(dir);
	return dir;
}

/** Options pointing at the local test server via repo.test → 127.0.0.1. */
function local(overrides: Partial<GitFetchOptions> = {}): GitFetchOptions {
	return {
		repository: server.url(),
		ref: "main",
		destination: workspace(),
		lookup: async () => ["127.0.0.1"],
		// The test server is on loopback, which the real policy blocks.
		isAllowedAddress: (address) => address === "127.0.0.1",
		allowedPorts: [server.port],
		extraConfig: [`http.sslCAInfo=${server.caFile}`],
		...overrides,
	};
}

async function failure(promise: Promise<unknown>): Promise<SourceError> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(SourceError);
	return error as SourceError;
}

describe("fetching", () => {
	test("checks out a branch and reports its commit", async () => {
		const options = local();
		const { commit } = await fetchGitSource(options);
		expect(commit).toBe(server.commits.second);
		expect(readFileSync(join(options.destination, "README.md"), "utf8")).toBe(
			"second\n",
		);
		expect(existsSync(join(options.destination, ".git"))).toBe(false);
	});

	test("checks out a branch with a slash", async () => {
		const { commit } = await fetchGitSource(local({ ref: "feature/new-ui" }));
		expect(commit).toBe(server.commits.feature);
	});

	test("checks out a tag", async () => {
		const options = local({ ref: "v1" });
		expect((await fetchGitSource(options)).commit).toBe(server.commits.first);
		expect(existsSync(join(options.destination, "Dockerfile"))).toBe(false);
	});

	test("checks out a specific commit", async () => {
		const { commit } = await fetchGitSource(
			local({ ref: server.commits.first }),
		);
		expect(commit).toBe(server.commits.first);
	});

	test("reports progress output", async () => {
		const lines: string[] = [];
		await fetchGitSource(local({ onOutput: (line) => lines.push(line) }));
		expect(lines.length).toBeGreaterThan(0);
	});

	test("reports unknown refs", async () => {
		const error = await failure(
			fetchGitSource(local({ ref: "no-such-branch" })),
		);
		expect(error.code).toBe("ref_not_found");
	});
});

describe("address checks", () => {
	test("resolves once and pins Git to that address", async () => {
		// repo.test exists in no real DNS: Git can only reach the server
		// through the pinned address. A rebinding DNS server would answer
		// differently the second time; there is no second time.
		const lookup = vi.fn(async () => ["127.0.0.1"]);
		await fetchGitSource(local({ lookup }));
		expect(lookup).toHaveBeenCalledTimes(1);
		expect(lookup).toHaveBeenCalledWith(TEST_HOST);
	});

	test("refuses hosts that resolve to a blocked address, without connecting", async () => {
		const before = server.requests.length;
		const error = await failure(
			fetchGitSource(local({ isAllowedAddress: () => false })),
		);
		expect(error.code).toBe("blocked_address");
		expect(server.requests.length).toBe(before);
	});

	test("refuses if any resolved address is blocked", async () => {
		const error = await failure(
			fetchGitSource(
				local({
					lookup: async () => ["127.0.0.1", "192.168.0.1"],
				}),
			),
		);
		expect(error.code).toBe("blocked_address");
	});

	test("the real policy blocks private and loopback hosts", async () => {
		for (const repository of [
			"https://127.0.0.1/repo.git",
			"https://[::1]/repo.git",
			"https://192.168.0.1/repo.git",
			"https://169.254.169.254/latest",
		]) {
			const error = await failure(
				fetchGitSource({ repository, ref: "main", destination: workspace() }),
			);
			expect(error.code, repository).toBe("blocked_address");
		}
		const error = await failure(
			fetchGitSource({
				repository: "https://internal.example/repo.git",
				ref: "main",
				destination: workspace(),
				lookup: async () => ["10.0.0.5"],
			}),
		);
		expect(error.code).toBe("blocked_address");
	});

	test("does not follow redirects", async () => {
		const before = server.requests.filter((path) =>
			path.startsWith("/demo.git"),
		).length;
		const error = await failure(
			fetchGitSource(local({ repository: server.url("/redirect.git") })),
		);
		expect(error.code).toBe("fetch_failed");
		expect(
			server.requests.filter((path) => path.startsWith("/demo.git")).length,
		).toBe(before);
	});
});

describe("URL rules", () => {
	test.each([
		["http://github.com/x/y", "HTTPS"],
		["https://user:token@github.com/x/y", "credentials"],
		["https://github.com:8443/x/y", "Port 8443"],
		["https://github.com/x/y?u=1", "query"],
		["file:///etc", "HTTPS"],
		["not a url", "not valid"],
	])("refuses %s", async (repository, message) => {
		const error = await failure(
			fetchGitSource({ repository, ref: "main", destination: workspace() }),
		);
		expect(error.code).toBe("invalid_url");
		expect(error.message).toContain(message);
	});

	test("refuses refs that look like options", async () => {
		const error = await failure(
			fetchGitSource(local({ ref: "--upload-pack=touch /tmp/x" })),
		);
		expect(error.code).toBe("invalid_url");
	});
});

describe("limits", () => {
	test("stops when the repository is too large", async () => {
		const error = await failure(fetchGitSource(local({ maxBytes: 1 })));
		expect(error.code).toBe("too_large");
	});

	test("stops after the timeout", async () => {
		const started = Date.now();
		const error = await failure(
			fetchGitSource(
				local({ repository: server.url("/slow.git"), timeoutMs: 1000 }),
			),
		);
		expect(error.code).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(5000);
	});

	test("can be cancelled", async () => {
		const controller = new AbortController();
		const pending = fetchGitSource(
			local({ repository: server.url("/slow.git"), signal: controller.signal }),
		);
		setTimeout(() => controller.abort(), 200);
		expect((await failure(pending)).code).toBe("cancelled");
	});
});

describe("a real public repository", () => {
	test("is fetched from GitHub at a pinned commit", {
		timeout: 60_000,
	}, async () => {
		const destination = workspace();
		const { commit } = await fetchGitSource({
			repository: "https://github.com/octocat/Hello-World",
			ref: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
			destination,
		});
		expect(commit).toBe("7fd1a60b01f91b314f59955a4e4d4e80d8edf11d");
		expect(existsSync(join(destination, "README"))).toBe(true);
	});
});
