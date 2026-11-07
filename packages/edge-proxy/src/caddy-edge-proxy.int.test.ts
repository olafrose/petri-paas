import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { connect } from "node:net";
import { DockerClient } from "@petri/runtime";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import { CaddyEdgeProxy, type PreviewRoute } from "./caddy-edge-proxy.ts";

// The edge proxy from infrastructure/compose/dev.yml (CI starts its own).
const adminSocket =
	process.env.EDGE_ADMIN_SOCKET ??
	new URL("../../../.tools/edge/admin.sock", import.meta.url).pathname;
const edgeUrl = new URL(process.env.EDGE_URL ?? "http://127.0.0.1:8088");
const edgeContainer = process.env.EDGE_CONTAINER ?? "petri-dev-edge-1";
const docker = new DockerClient(
	process.env.DOCKER_PROXY_HOST ?? "tcp://127.0.0.1:2375",
);

const edge = new CaddyEdgeProxy(adminSocket);
const suffix = randomUUID().slice(0, 8);
const network = `petri-edge-test-${suffix}`;
const app = `petri-edge-test-${suffix}`;

/*
 * The app behind the routes: busybox httpd on two ports, telling them
 * apart, with a CGI script on 8080 that shows the forwarded headers.
 */
const cgi = [
	"#!/bin/sh",
	"printf 'Content-Type: text/plain\\r\\n\\r\\n'",
	'echo "xff=$HTTP_X_FORWARDED_FOR"',
].join("\n");
const appCommand = [
	"mkdir -p /www/cgi-bin /www2",
	"echo one > /www/index.html",
	"echo two > /www2/index.html",
	`echo ${Buffer.from(cgi).toString("base64")} | base64 -d > /www/cgi-bin/echo`,
	"chmod +x /www/cgi-bin/echo",
	"httpd -p 8081 -h /www2",
	"exec httpd -f -p 8080 -h /www",
].join(" && ");

const routeTo = (
	hostname: string,
	port = 8080,
	deploymentId = `test-${suffix}`,
): PreviewRoute => ({ deploymentId, hostname, upstream: { host: app, port } });

/** A request to the edge proxy's public port, for the given Host. */
function get(host: string, path = "/", headers: Record<string, string> = {}) {
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const req = request(
			{
				host: edgeUrl.hostname,
				port: edgeUrl.port,
				path,
				headers: { host, ...headers },
			},
			(response) => {
				let body = "";
				response.on("data", (chunk) => {
					body += chunk;
				});
				response.on("end", () =>
					resolve({ status: response.statusCode ?? 0, body }),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

beforeAll(async () => {
	const pull = await docker.stream("POST", "/images/create", {
		query: { fromImage: "busybox", tag: "1.37" },
	});
	for await (const _ of pull);
	await docker.call("POST", "/networks/create", { json: { Name: network } });
	await docker.call("POST", "/containers/create", {
		query: { name: app },
		json: {
			Image: "busybox:1.37",
			Cmd: ["sh", "-c", appCommand],
			HostConfig: { NetworkMode: network },
		},
	});
	await docker.call("POST", `/containers/${app}/start`);
	await docker.call("POST", `/networks/${network}/connect`, {
		json: { Container: edgeContainer },
	});
}, 120_000);

beforeEach(async () => {
	await edge.configure({});
});

afterAll(async () => {
	await edge.configure({});
	await docker.call("POST", `/networks/${network}/disconnect`, {
		json: { Container: edgeContainer, Force: true },
		accept: [404],
	});
	await docker.call("DELETE", `/containers/${app}`, {
		query: { force: true },
		accept: [404],
	});
	await docker.call("DELETE", `/networks/${network}`, { accept: [404] });
});

describe("routes", () => {
	test("an unknown hostname gets 404 from the edge proxy itself", async () => {
		expect(await get("nothing.app.localhost")).toEqual({
			status: 404,
			body: "No preview at this address.\n",
		});
	});

	test("a route sends its hostname to the app", async () => {
		await edge.setRoute(routeTo("demo.app.localhost"));
		expect(await get("demo.app.localhost")).toEqual({
			status: 200,
			body: "one\n",
		});
		// Browsers and NPM may send the port, or capitals.
		expect((await get("Demo.App.Localhost:8088")).body).toBe("one\n");
		expect((await get("other.app.localhost")).status).toBe(404);
	});

	test("setting a route again replaces it", async () => {
		await edge.setRoute(routeTo("demo.app.localhost"));
		await edge.setRoute(routeTo("renamed.app.localhost", 8081));
		expect(await edge.listRoutes()).toEqual([
			routeTo("renamed.app.localhost", 8081),
		]);
		expect((await get("renamed.app.localhost")).body).toBe("two\n");
		expect((await get("demo.app.localhost")).status).toBe(404);
	});

	test("concurrent sets of the same route leave one", async () => {
		await Promise.all([
			edge.setRoute(routeTo("demo.app.localhost")),
			edge.setRoute(routeTo("demo.app.localhost")),
			edge.setRoute(routeTo("demo.app.localhost")),
		]);
		expect(await edge.listRoutes()).toHaveLength(1);
	});

	test("removing a route, also when it is already gone", async () => {
		await edge.setRoute(routeTo("demo.app.localhost"));
		await edge.removeRoute(`test-${suffix}`);
		await edge.removeRoute(`test-${suffix}`);
		expect(await edge.listRoutes()).toEqual([]);
		expect((await get("demo.app.localhost")).status).toBe(404);
	});

	test("configure replaces all routes at once", async () => {
		await edge.setRoute(routeTo("old.app.localhost", 8080, "old"));
		const wanted = [
			routeTo("a.app.localhost", 8080, "a"),
			routeTo("b.app.localhost", 8081, "b"),
		];
		await edge.configure({ routes: wanted });
		expect(await edge.listRoutes()).toEqual(wanted);
		expect((await get("b.app.localhost")).body).toBe("two\n");
		expect((await get("old.app.localhost")).status).toBe(404);
	});
});

describe("forwarded headers", () => {
	const forged = { "x-forwarded-for": "203.0.113.9" };

	test("are replaced when the sender is not a trusted proxy", async () => {
		await edge.setRoute(routeTo("demo.app.localhost"));
		const { body } = await get("demo.app.localhost", "/cgi-bin/echo", forged);
		expect(body).toMatch(/^xff=[0-9a-f.:]+\n$/);
		expect(body).not.toContain("203.0.113.9");
	});

	test("are kept from a trusted proxy", async () => {
		await edge.configure({
			trustedProxies: ["0.0.0.0/0", "::/0"],
			routes: [routeTo("demo.app.localhost")],
		});
		const { body } = await get("demo.app.localhost", "/cgi-bin/echo", forged);
		expect(body).toMatch(/^xff=203\.0\.113\.9, /);
		expect(await edge.trustedProxies()).toEqual(["0.0.0.0/0", "::/0"]);
		await edge.configure({});
		expect(await edge.trustedProxies()).toEqual([]);
	});
});

describe("the admin API", () => {
	test("is not reachable from the apps' networks", async () => {
		const { body } = await docker.call<{
			NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
		}>("GET", `/containers/${edgeContainer}/json`);
		const address = body.NetworkSettings.Networks[network]?.IPAddress;
		expect(address).toBeTruthy();

		// Caddy's default admin port is closed...
		const refused = await new Promise<boolean>((resolve) => {
			const socket = connect({ host: address, port: 2019 });
			socket.setTimeout(3000);
			socket.on("connect", () => {
				socket.destroy();
				resolve(false);
			});
			socket.on("error", () => resolve(true));
			socket.on("timeout", () => {
				socket.destroy();
				resolve(true);
			});
		});
		expect(refused).toBe(true);
		// ...and admin paths on the preview port are just unknown previews.
		const config = await fetch(`http://${address}:8080/config/`);
		expect(config.status).toBe(404);
	});
});
