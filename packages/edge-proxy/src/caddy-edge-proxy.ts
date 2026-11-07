import { CaddyAdminClient, CaddyAdminError } from "./caddy-admin.ts";

/** Port the edge proxy listens on inside its container. */
export const EDGE_PORT = 8080;

/** Where Caddy's admin socket is, inside the edge proxy's container. */
export const ADMIN_SOCKET = "/run/petri-edge/admin.sock";

const SERVER = "previews";
/** The subroute holding one route per preview; see `edgeApps`. */
const PREVIEWS_ID = "petri-previews";
const ROUTE_PREFIX = "petri-route-";

const HOSTNAME =
	/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const UPSTREAM_HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;
const DEPLOYMENT_ID = /^[a-z0-9-]{1,64}$/;

/** Traffic for `hostname` goes to the app at `upstream`. */
export interface PreviewRoute {
	deploymentId: string;
	/** Full hostname, e.g. demo-main.app.example.com. Lower case. */
	hostname: string;
	/** The app's container, as the edge proxy reaches it. */
	upstream: { host: string; port: number };
}

export interface EdgeSettings {
	/**
	 * Proxies whose X-Forwarded-* headers are kept (the NPM VM), as
	 * addresses or CIDRs. Others' headers are replaced.
	 */
	trustedProxies?: string[];
	routes?: PreviewRoute[];
}

/**
 * Caddy's `apps` configuration. Previews are routes in one subroute, in
 * front of a catch-all 404: unknown hostnames never fall through to an
 * app, and new routes never end up behind the catch-all.
 */
export function edgeApps({ trustedProxies = [], routes = [] }: EdgeSettings) {
	return {
		http: {
			servers: {
				[SERVER]: {
					listen: [`:${EDGE_PORT}`],
					// TLS ends at NPM.
					automatic_https: { disable: true },
					...(trustedProxies.length > 0 && {
						trusted_proxies: { source: "static", ranges: trustedProxies },
					}),
					routes: [
						{
							handle: [
								{
									handler: "subroute",
									"@id": PREVIEWS_ID,
									routes: routes.map(routeConfig),
								},
							],
						},
						{
							handle: [
								{
									handler: "static_response",
									status_code: 404,
									body: "No preview at this address.\n",
								},
							],
						},
					],
				},
			},
		},
	};
}

/** The complete initial configuration (infrastructure/caddy/edge.json). */
export function edgeConfig(settings: EdgeSettings = {}) {
	return {
		admin: {
			listen: `unix/${ADMIN_SOCKET}`,
			// Routes come from the database, not from a saved copy.
			config: { persist: false },
		},
		apps: edgeApps(settings),
	};
}

const routeId = (deploymentId: string) => `${ROUTE_PREFIX}${deploymentId}`;

interface CaddyRoute {
	"@id": string;
	match: [{ host: [string] }];
	handle: [{ handler: "reverse_proxy"; upstreams: [{ dial: string }] }];
	terminal: true;
}

function routeConfig(route: PreviewRoute): CaddyRoute {
	validate(route);
	return {
		"@id": routeId(route.deploymentId),
		match: [{ host: [route.hostname] }],
		handle: [
			{
				handler: "reverse_proxy",
				upstreams: [{ dial: `${route.upstream.host}:${route.upstream.port}` }],
			},
		],
		terminal: true,
	};
}

function validate(route: PreviewRoute) {
	const { deploymentId, hostname, upstream } = route;
	if (!DEPLOYMENT_ID.test(deploymentId)) {
		throw new Error(`Invalid deployment id for a route: ${deploymentId}`);
	}
	if (!HOSTNAME.test(hostname)) {
		throw new Error(`Invalid preview hostname: ${hostname}`);
	}
	if (
		!UPSTREAM_HOST.test(upstream.host) ||
		!Number.isInteger(upstream.port) ||
		upstream.port < 1 ||
		upstream.port > 65535
	) {
		throw new Error(`Invalid upstream: ${upstream.host}:${upstream.port}`);
	}
}

function parseRoute(route: Partial<CaddyRoute>): PreviewRoute | null {
	const id = route["@id"];
	const hostname = route.match?.[0]?.host?.[0];
	const dial = route.handle?.[0]?.upstreams?.[0]?.dial;
	if (!id?.startsWith(ROUTE_PREFIX) || !hostname || !dial) return null;
	const separator = dial.lastIndexOf(":");
	return {
		deploymentId: id.slice(ROUTE_PREFIX.length),
		hostname,
		upstream: {
			host: dial.slice(0, separator),
			port: Number(dial.slice(separator + 1)),
		},
	};
}

/**
 * Routes preview hostnames to app containers through Caddy's admin API.
 * Every operation is safe to repeat. Caddy keeps routes only in memory:
 * after a restart it has none until `configure` loads them again.
 */
export class CaddyEdgeProxy {
	readonly #admin: CaddyAdminClient;

	/** `adminSocket`: the admin socket's path as seen from here. */
	constructor(adminSocket: string) {
		this.#admin = new CaddyAdminClient(adminSocket);
	}

	/**
	 * Replaces the whole preview configuration: these routes and no
	 * others. Caddy applies it at once or not at all.
	 */
	async configure(settings: EdgeSettings): Promise<void> {
		await this.#admin.call("PATCH", "/config/apps", {
			json: edgeApps(settings),
		});
	}

	/** Creates the deployment's route, or replaces the existing one. */
	async setRoute(route: PreviewRoute): Promise<void> {
		const config = routeConfig(route);
		const path = `/id/${routeId(route.deploymentId)}`;
		const replaced = await this.#admin.call("PATCH", path, {
			json: config,
			accept: [404],
		});
		if (replaced.status !== 404) return;
		const added = await this.#admin.call<{ error?: string } | null>(
			"POST",
			`/id/${PREVIEWS_ID}/routes`,
			{ json: config, accept: [400] },
		);
		if (added.status !== 400) return;
		if (!added.body?.error?.includes("duplicate ID")) {
			throw new CaddyAdminError(
				400,
				`Caddy admin API error 400: ${added.body?.error ?? "bad request"}`,
			);
		}
		// Created concurrently: replace that one.
		await this.#admin.call("PATCH", path, { json: config });
	}

	async removeRoute(deploymentId: string): Promise<void> {
		await this.#admin.call("DELETE", `/id/${routeId(deploymentId)}`, {
			accept: [404],
		});
	}

	async listRoutes(): Promise<PreviewRoute[]> {
		const { body } = await this.#admin.call<Partial<CaddyRoute>[] | null>(
			"GET",
			`/id/${PREVIEWS_ID}/routes`,
		);
		return (body ?? []).map(parseRoute).filter((route) => route !== null);
	}
}
