import { request } from "node:http";
import { CaddyEdgeProxy } from "@petri/edge-proxy";
import type { DockerRuntime } from "@petri/runtime";
import { EdgeRouting } from "../src/edge-routing.ts";

// The edge proxy from infrastructure/compose/dev.yml (CI starts its own).
const adminSocket =
	process.env.EDGE_ADMIN_SOCKET ??
	new URL("../../../.tools/edge/admin.sock", import.meta.url).pathname;
const edgeUrl = new URL(process.env.EDGE_URL ?? "http://127.0.0.1:8088");

export const PREVIEW_BASE_URL = "http://app.localhost:8088";

export function testEdge(
	runtime: DockerRuntime,
	trustedProxies: string[] = [],
) {
	return new EdgeRouting(new CaddyEdgeProxy(adminSocket), runtime, {
		previewBaseUrl: PREVIEW_BASE_URL,
		edgeContainer: process.env.EDGE_CONTAINER ?? "petri-dev-edge-1",
		trustedProxies,
	});
}

/** A request to a preview through the edge proxy, as NPM would send it. */
export function viaEdge(subdomain: string) {
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const req = request(
			{
				host: edgeUrl.hostname,
				port: edgeUrl.port,
				// Fresh each time, as from NPM: route changes reload Caddy,
				// which closes idle connections.
				agent: false,
				path: "/",
				headers: { host: `${subdomain}.app.localhost` },
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
