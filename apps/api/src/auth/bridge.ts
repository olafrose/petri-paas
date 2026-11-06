import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Converts a Fastify request into a Fetch API `Request` for Better Auth.
 *
 * `x-forwarded-for` is always replaced with Fastify's view of the client
 * address (which honours the trusted-proxy setting), so clients cannot
 * spoof the address used for rate limiting.
 */
export function toWebRequest(
	request: FastifyRequest,
	baseUrl: string,
): Request {
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		if (value === undefined || name === "x-forwarded-for") continue;
		for (const item of Array.isArray(value) ? value : [value]) {
			headers.append(name, item);
		}
	}
	headers.set("x-forwarded-for", request.ip);

	const hasBody = request.body !== undefined && request.body !== null;
	return new Request(new URL(request.url, baseUrl), {
		method: request.method,
		headers,
		...(hasBody && {
			body:
				typeof request.body === "string"
					? request.body
					: JSON.stringify(request.body),
		}),
	});
}

/** Copies a Fetch API `Response` onto a Fastify reply. */
export async function sendWebResponse(reply: FastifyReply, response: Response) {
	reply.status(response.status);
	for (const [name, value] of response.headers) {
		if (name === "set-cookie") continue;
		reply.header(name, value);
	}
	const cookies = response.headers.getSetCookie();
	if (cookies.length > 0) reply.header("set-cookie", cookies);
	return reply.send(response.body ? await response.text() : null);
}

/** Request headers as a Fetch API `Headers`, for `auth.api` calls. */
export function toWebHeaders(request: FastifyRequest): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		if (value === undefined) continue;
		for (const item of Array.isArray(value) ? value : [value]) {
			headers.append(name, item);
		}
	}
	return headers;
}
