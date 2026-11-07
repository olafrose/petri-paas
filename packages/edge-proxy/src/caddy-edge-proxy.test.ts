import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { edgeApps, edgeConfig, type PreviewRoute } from "./caddy-edge-proxy.ts";

const route: PreviewRoute = {
	deploymentId: "0190a0e0-0000-7000-8000-000000000000",
	hostname: "demo-main.app.example.com",
	upstream: { host: "petri-0190a0e0-0000-7000-8000-000000000000", port: 3000 },
};

const routesOf = (apps: ReturnType<typeof edgeApps>) =>
	apps.http.servers.previews.routes;

test("infrastructure/caddy/edge.json is the generated initial config", () => {
	const file = new URL(
		"../../../infrastructure/caddy/edge.json",
		import.meta.url,
	);
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(edgeConfig());
});

describe("edgeApps", () => {
	test("previews come before the catch-all 404", () => {
		const routes = routesOf(edgeApps({ routes: [route] }));
		expect(routes).toHaveLength(2);
		expect(routes[0]?.handle[0]).toMatchObject({
			handler: "subroute",
			routes: [
				{
					match: [{ host: ["demo-main.app.example.com"] }],
					handle: [
						{
							handler: "reverse_proxy",
							upstreams: [
								{ dial: "petri-0190a0e0-0000-7000-8000-000000000000:3000" },
							],
						},
					],
				},
			],
		});
		expect(routes[1]?.handle[0]).toMatchObject({
			handler: "static_response",
			status_code: 404,
		});
	});

	test("trusts forwarded headers only from the given proxies", () => {
		const server = (settings: Parameters<typeof edgeApps>[0]) =>
			edgeApps(settings).http.servers.previews;
		expect(server({})).not.toHaveProperty("trusted_proxies");
		expect(server({ trustedProxies: ["192.168.1.20"] })).toMatchObject({
			trusted_proxies: { source: "static", ranges: ["192.168.1.20"] },
		});
	});

	test.each([
		["an upper-case hostname", { hostname: "Demo.app.example.com" }],
		["a single-label hostname", { hostname: "localhost" }],
		["a hostname with a path", { hostname: "a.example.com/x" }],
		["a hostname with a port", { hostname: "a.example.com:80" }],
		["a label that is too long", { hostname: `${"a".repeat(64)}.example.com` }],
		["an odd deployment id", { deploymentId: "../admin" }],
		["an upstream with a scheme", { upstream: { host: "http://x", port: 80 } }],
		["port 0", { upstream: { host: "app", port: 0 } }],
		["a fractional port", { upstream: { host: "app", port: 80.5 } }],
	])("refuses %s", (_label, override) => {
		expect(() => edgeApps({ routes: [{ ...route, ...override }] })).toThrow();
	});
});
