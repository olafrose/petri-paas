import { previewHostname } from "@petri/deployment-core";
import {
	type CaddyEdgeProxy,
	type PreviewRoute,
	routeId,
} from "@petri/edge-proxy";
import { containerName, type DockerRuntime, networkName } from "@petri/runtime";

export interface EdgeRoutingSettings {
	/** Previews are served at <subdomain>.<this URL's host>. */
	previewBaseUrl: string;
	/** The edge proxy's container, which joins each routed app's network. */
	edgeContainer: string;
	/** Proxies whose X-Forwarded-* the edge proxy keeps (the NPM VM). */
	trustedProxies: string[];
}

/** A deployment as routing needs it. */
export interface Routable {
	id: string;
	subdomain: string;
}

/**
 * Puts apps on their preview hostnames and takes them off again. Both
 * are safe to repeat.
 */
export class EdgeRouting {
	readonly proxy: CaddyEdgeProxy;
	readonly settings: EdgeRoutingSettings;
	readonly #runtime: DockerRuntime;

	constructor(
		proxy: CaddyEdgeProxy,
		runtime: DockerRuntime,
		settings: EdgeRoutingSettings,
	) {
		this.proxy = proxy;
		this.#runtime = runtime;
		this.settings = settings;
	}

	route(deployment: Routable, port: number): PreviewRoute {
		return {
			deploymentId: deployment.id,
			hostname: previewHostname(
				this.settings.previewBaseUrl,
				deployment.subdomain,
			),
			upstream: { host: containerName(deployment.id), port },
		};
	}

	/**
	 * Makes the app reachable at its preview hostname: the edge proxy
	 * joins its network, then the route is set. Returns the route's id,
	 * for the deployment's `routeId`.
	 */
	async publish(deployment: Routable, port: number): Promise<string> {
		await this.connect(deployment.id);
		await this.proxy.setRoute(this.route(deployment, port));
		return routeId(deployment.id);
	}

	/** Takes the app off its hostname and the edge proxy off its network. */
	async unpublish(deploymentId: string): Promise<void> {
		await this.proxy.removeRoute(deploymentId);
		await this.#runtime.disconnect(
			networkName(deploymentId),
			this.settings.edgeContainer,
		);
	}

	async connect(deploymentId: string): Promise<void> {
		await this.#runtime.connect(
			networkName(deploymentId),
			this.settings.edgeContainer,
		);
	}

	/** Networks the edge proxy is on. */
	networks(): Promise<string[]> {
		return this.#runtime.networksOf(this.settings.edgeContainer);
	}
}
