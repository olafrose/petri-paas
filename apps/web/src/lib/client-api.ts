import type { ErrorResponse } from "@petri/contracts";

/*
 * Changes from the browser go to the API through this app's /api/v1
 * forwarding: same origin, the session cookie, and the browser's Origin
 * header for the API's check.
 */

export type ApiResult<T> =
	| { ok: true; data: T }
	| { ok: false; message: string; fields: Record<string, string> };

/** Sends a request and turns the API's error format into a message. */
export async function apiSend<T>(
	method: "POST" | "PUT" | "PATCH" | "DELETE",
	path: `/api/v1/${string}`,
	body?: unknown,
): Promise<ApiResult<T>> {
	const init: RequestInit = { method };
	// Forms and files (e.g. an image, sent as it is) go unchanged.
	if (body instanceof FormData || body instanceof Blob) {
		init.body = body;
	} else if (body !== undefined) {
		init.body = JSON.stringify(body);
		init.headers = { "content-type": "application/json" };
	}
	let response: Response;
	try {
		response = await fetch(path, init);
	} catch {
		return { ok: false, message: "petri. can't be reached.", fields: {} };
	}
	const text = await response.text();
	const json = text ? safeJson(text) : null;
	if (response.ok) return { ok: true, data: json as T };

	const error = (json as ErrorResponse | null)?.error;
	const fields: Record<string, string> = {};
	for (const detail of error?.details ?? []) {
		fields[detail.path] = detail.message;
	}
	// The fields say what's wrong; the summary only points to them.
	if (error?.code === "validation_failed" && Object.keys(fields).length > 0) {
		return { ok: false, message: "Please check the marked fields.", fields };
	}
	return {
		ok: false,
		message:
			error?.message ??
			(response.status === 401
				? "Your session has ended; sign in again."
				: `The request failed (${response.status}).`),
		fields,
	};
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
