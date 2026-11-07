import { request } from "node:http";

export class CaddyAdminError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "CaddyAdminError";
		this.status = status;
	}
}

/**
 * Caddy's admin API over its Unix socket. The API has no authentication;
 * the socket's file permissions are the only access control.
 */
export class CaddyAdminClient {
	readonly #socketPath: string;

	constructor(socketPath: string) {
		this.#socketPath = socketPath;
	}

	/**
	 * Sends a request and returns the parsed JSON body (or null). Statuses
	 * in `accept` are returned instead of thrown, e.g. 404 for an unknown
	 * `@id`.
	 */
	call<T = unknown>(
		method: string,
		path: string,
		{ json, accept = [] }: { json?: unknown; accept?: readonly number[] } = {},
	): Promise<{ status: number; body: T }> {
		const payload = json === undefined ? undefined : JSON.stringify(json);
		return new Promise((resolve, reject) => {
			const req = request(
				{
					socketPath: this.#socketPath,
					method,
					path,
					// No Origin header: Caddy refuses admin requests that have one.
					headers: {
						host: "localhost",
						...(payload !== undefined && {
							"content-type": "application/json",
						}),
					},
				},
				(response) => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => chunks.push(chunk));
					response.on("error", reject);
					response.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8");
						const status = response.statusCode ?? 0;
						if ((status < 200 || status >= 300) && !accept.includes(status)) {
							reject(new CaddyAdminError(status, errorMessage(text, status)));
							return;
						}
						resolve({ status, body: (text ? JSON.parse(text) : null) as T });
					});
				},
			);
			req.on("error", (error) =>
				reject(
					new CaddyAdminError(
						0,
						`The edge proxy is not reachable: ${error.message}`,
					),
				),
			);
			req.end(payload);
		});
	}
}

function errorMessage(text: string, status: number): string {
	let message = text;
	try {
		message = (JSON.parse(text) as { error?: string }).error ?? text;
	} catch {}
	return `Caddy admin API error ${status}: ${message.trim().slice(0, 300)}`;
}
