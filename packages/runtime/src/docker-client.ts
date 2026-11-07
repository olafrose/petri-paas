import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Readable } from "node:stream";

/** Docker Engine API version used for all requests. */
export const DOCKER_API_VERSION = "v1.47";

export class DockerApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "DockerApiError";
		this.status = status;
	}
}

type Endpoint = { socketPath: string } | { host: string; port: number };

/**
 * Parses a Docker address: `unix:///var/run/docker.sock` or
 * `tcp://docker-proxy:2375` (plain HTTP: only for a local socket proxy on
 * a private network).
 */
export function parseDockerHost(value: string): Endpoint {
	if (value.startsWith("unix://")) return { socketPath: value.slice(7) };
	const url = new URL(value.replace(/^tcp:/, "http:"));
	return { host: url.hostname, port: Number(url.port || 2375) };
}

export interface RequestOptions {
	query?: Record<string, string | number | boolean | object>;
	json?: unknown;
	/** A raw request body, e.g. an image archive. */
	stream?: Readable;
	contentType?: string;
	/** Statuses that are not errors besides 2xx (e.g. 304, 404). */
	accept?: readonly number[];
}

/** A minimal Docker Engine API client over HTTP or a Unix socket. */
export class DockerClient {
	readonly #endpoint: Endpoint;

	constructor(dockerHost: string) {
		this.#endpoint = parseDockerHost(dockerHost);
	}

	/** Sends a request and returns the parsed JSON body (or null). */
	async call<T = unknown>(
		method: string,
		path: string,
		options: RequestOptions = {},
	): Promise<{ status: number; body: T }> {
		const response = await this.#send(method, path, options);
		const text = await readAll(response);
		const status = response.statusCode ?? 0;
		const ok =
			(status >= 200 && status < 300) || options.accept?.includes(status);
		if (!ok) throw new DockerApiError(status, errorMessage(text, status));
		return { status, body: (text ? safeJson(text) : null) as T };
	}

	/** Sends a request and returns the raw response stream. */
	async stream(
		method: string,
		path: string,
		options: RequestOptions = {},
	): Promise<IncomingMessage> {
		const response = await this.#send(method, path, options);
		const status = response.statusCode ?? 0;
		if (status < 200 || status >= 300) {
			throw new DockerApiError(
				status,
				errorMessage(await readAll(response), status),
			);
		}
		return response;
	}

	#send(
		method: string,
		path: string,
		options: RequestOptions,
	): Promise<IncomingMessage> {
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(options.query ?? {})) {
			query.set(
				key,
				typeof value === "object" ? JSON.stringify(value) : String(value),
			);
		}
		const search = query.size > 0 ? `?${query}` : "";
		const body =
			options.json === undefined ? undefined : JSON.stringify(options.json);
		const headers: Record<string, string> = {};
		if (body !== undefined) headers["content-type"] = "application/json";
		if (options.stream)
			headers["content-type"] =
				options.contentType ?? "application/octet-stream";

		return new Promise((resolve, reject) => {
			const req = httpRequest(
				{
					...this.#endpoint,
					method,
					path: `/${DOCKER_API_VERSION}${path}${search}`,
					headers,
				},
				resolve,
			);
			req.on("error", (error) =>
				reject(
					new DockerApiError(0, `Docker is not reachable: ${error.message}`),
				),
			);
			if (options.stream) {
				options.stream.on("error", (error) => req.destroy(error));
				options.stream.pipe(req);
			} else {
				req.end(body);
			}
		});
	}
}

function readAll(response: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		response.on("data", (chunk: Buffer) => chunks.push(chunk));
		response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		response.on("error", reject);
	});
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function errorMessage(text: string, status: number): string {
	const parsed = safeJson(text) as { message?: string } | string;
	const message =
		typeof parsed === "object" && parsed?.message ? parsed.message : text;
	return `Docker API error ${status}: ${String(message).trim().slice(0, 300)}`;
}
