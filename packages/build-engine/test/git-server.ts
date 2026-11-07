import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Hostname of the test server. Not in real DNS: only reachable when pinned. */
export const TEST_HOST = "repo.test";

export interface TestGitServer {
	port: number;
	/** CA file to trust the server's self-signed certificate. */
	caFile: string;
	url(path?: string): string;
	commits: { first: string; second: string; feature: string };
	requests: string[];
	close(): Promise<void>;
}

/**
 * A local HTTPS Git server for tests, serving one repository through
 * `git http-backend`. Extra paths:
 * - /redirect.git/... answers with a redirect
 * - /slow.git/... never answers
 */
export async function startGitServer(
	/** More repositories to serve: name → files, one commit on main. */
	extraRepos: Record<string, Record<string, string>> = {},
): Promise<TestGitServer> {
	const root = mkdtempSync(join(tmpdir(), "petri-git-server-"));
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: root,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_AUTHOR_NAME: "Test",
				GIT_AUTHOR_EMAIL: "test@example.com",
				GIT_COMMITTER_NAME: "Test",
				GIT_COMMITTER_EMAIL: "test@example.com",
			},
		})
			.toString()
			.trim();

	// A repository with two commits on main, a tag and a feature branch.
	const work = join(root, "work");
	execFileSync("mkdir", ["-p", work]);
	git(work, "init", "--quiet", "--initial-branch=main");
	writeFileSync(join(work, "README.md"), "first\n");
	git(work, "add", ".");
	git(work, "commit", "--quiet", "-m", "first");
	const first = git(work, "rev-parse", "HEAD");
	git(work, "tag", "v1");
	writeFileSync(join(work, "README.md"), "second\n");
	writeFileSync(join(work, "Dockerfile"), "FROM scratch\n");
	git(work, "add", ".");
	git(work, "commit", "--quiet", "-m", "second");
	const second = git(work, "rev-parse", "HEAD");
	git(work, "switch", "--quiet", "-c", "feature/new-ui");
	writeFileSync(join(work, "feature.txt"), "feature\n");
	git(work, "add", ".");
	git(work, "commit", "--quiet", "-m", "feature");
	const feature = git(work, "rev-parse", "HEAD");

	for (const [name, files] of Object.entries(extraRepos)) {
		const dir = join(root, `work-${name}`);
		execFileSync("mkdir", ["-p", dir]);
		git(dir, "init", "--quiet", "--initial-branch=main");
		for (const [path, content] of Object.entries(files)) {
			execFileSync("mkdir", ["-p", join(dir, path, "..")]);
			writeFileSync(join(dir, path), content);
		}
		git(dir, "add", ".");
		git(dir, "commit", "--quiet", "-m", "app");
		git(root, "clone", "--quiet", "--bare", dir, join(root, `${name}.git`));
	}

	const bare = join(root, "demo.git");
	git(root, "clone", "--quiet", "--bare", work, bare);
	git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
	git(bare, "config", "http.uploadpack", "true");

	// Self-signed certificate for repo.test.
	const keyFile = join(root, "key.pem");
	const certFile = join(root, "cert.pem");
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:prime256v1",
			"-nodes",
			"-days",
			"1",
			"-subj",
			`/CN=${TEST_HOST}`,
			"-addext",
			`subjectAltName=DNS:${TEST_HOST}`,
			"-keyout",
			keyFile,
			"-out",
			certFile,
		],
		{ stdio: "ignore" },
	);

	const requests: string[] = [];
	const server: Server = createServer(
		{
			key: execFileSync("cat", [keyFile]),
			cert: execFileSync("cat", [certFile]),
		},
		(request, response) => {
			const url = new URL(request.url ?? "/", `https://${TEST_HOST}`);
			requests.push(url.pathname);

			if (url.pathname.startsWith("/redirect.git/")) {
				response.writeHead(302, {
					location: `https://${TEST_HOST}:${port}/demo.git/info/refs${url.search}`,
				});
				response.end();
				return;
			}
			if (url.pathname.startsWith("/slow.git/")) return; // never answers

			const backend = spawn("git", ["http-backend"], {
				env: {
					PATH: process.env.PATH,
					GIT_PROJECT_ROOT: root,
					GIT_HTTP_EXPORT_ALL: "1",
					PATH_INFO: url.pathname,
					QUERY_STRING: url.search.slice(1),
					REQUEST_METHOD: request.method ?? "GET",
					CONTENT_TYPE: request.headers["content-type"] ?? "",
					HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
					HTTP_GIT_PROTOCOL: (request.headers["git-protocol"] as string) ?? "",
					REMOTE_ADDR: "127.0.0.1",
				},
			});
			request.pipe(backend.stdin);

			// CGI output: headers, blank line, body.
			let buffer = Buffer.alloc(0);
			let headersSent = false;
			backend.stdout.on("data", (chunk: Buffer) => {
				if (headersSent) {
					response.write(chunk);
					return;
				}
				buffer = Buffer.concat([buffer, chunk]);
				const end = buffer.indexOf("\r\n\r\n");
				if (end === -1) return;
				let status = 200;
				for (const line of buffer.subarray(0, end).toString().split("\r\n")) {
					const [name, ...rest] = line.split(":");
					const value = rest.join(":").trim();
					if (name?.toLowerCase() === "status")
						status = Number.parseInt(value, 10);
					else if (name) response.setHeader(name, value);
				}
				response.writeHead(status);
				response.write(buffer.subarray(end + 4));
				headersSent = true;
			});
			backend.stdout.on("end", () => response.end());
		},
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;

	return {
		port,
		caFile: certFile,
		url: (path = "/demo.git") => `https://${TEST_HOST}:${port}${path}`,
		commits: { first, second, feature },
		requests,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		},
	};
}
