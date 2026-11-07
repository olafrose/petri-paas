import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { waitForHealthy } from "./health-check.ts";

const servers: Server[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.close();
});

async function serve(status: number, port = 0): Promise<number> {
	const server = createServer((_request, response) => {
		response.statusCode = status;
		response.end("x");
	});
	servers.push(server);
	await new Promise<void>((resolve) =>
		server.listen(port, "127.0.0.1", resolve),
	);
	return (server.address() as AddressInfo).port;
}

const fast = { intervalMs: 50, requestTimeoutMs: 500 };

test.each([200, 302, 404])(
	"an answer with status %i is healthy",
	async (status) => {
		const port = await serve(status);
		expect(
			await waitForHealthy({ url: `http://127.0.0.1:${port}/`, ...fast }),
		).toMatchObject({ healthy: true, status, attempts: 1 });
	},
);

test("status 500 is not healthy", async () => {
	const port = await serve(500);
	const result = await waitForHealthy({
		url: `http://127.0.0.1:${port}/`,
		...fast,
		timeoutMs: 300,
	});
	expect(result).toMatchObject({ healthy: false });
	expect(!result.healthy && result.reason).toContain("status 500");
});

test("nothing listening is reported as such", async () => {
	const port = await serve(200);
	servers.pop()?.close();
	const result = await waitForHealthy({
		url: `http://127.0.0.1:${port}/`,
		...fast,
		timeoutMs: 300,
	});
	expect(!result.healthy && result.reason).toContain("nothing is listening");
});

test("an app that starts late becomes healthy", async () => {
	const port = await serve(200);
	servers.pop()?.close();
	setTimeout(() => void serve(200, port), 400);
	const result = await waitForHealthy({
		url: `http://127.0.0.1:${port}/`,
		...fast,
	});
	expect(result.healthy).toBe(true);
	expect(result.attempts).toBeGreaterThan(1);
});

test("a stopped app fails at once with its exit code", async () => {
	const port = await serve(200);
	servers.pop()?.close();
	const started = Date.now();
	const result = await waitForHealthy({
		url: `http://127.0.0.1:${port}/`,
		...fast,
		timeoutMs: 10_000,
		isRunning: async () => ({ running: false, exitCode: 7, oomKilled: false }),
	});
	expect(!result.healthy && result.reason).toBe(
		"The app stopped with exit code 7",
	);
	expect(Date.now() - started).toBeLessThan(2000);
});

test("running out of memory is named", async () => {
	const result = await waitForHealthy({
		url: "http://127.0.0.1:1/",
		...fast,
		isRunning: async () => ({ running: false, exitCode: 137, oomKilled: true }),
	});
	expect(!result.healthy && result.reason).toContain(
		"more memory than allowed",
	);
});
