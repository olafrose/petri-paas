import "server-only";
import type { z } from "zod";

/** Where the web server reaches the API. */
const API_URL = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

export class ApiRequestError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "ApiRequestError";
		this.status = status;
	}
}

/**
 * Calls the API from the server and validates the response with the
 * shared schema from @petri/contracts, so the types are checked at runtime
 * too. Pass `cookie` to act as the signed-in user.
 */
export async function apiGet<Schema extends z.ZodType>(
	path: `/api/v1/${string}`,
	schema: Schema,
	{ cookie }: { cookie?: string } = {},
): Promise<z.infer<Schema>> {
	const response = await fetch(`${API_URL}${path}`, {
		headers: cookie ? { cookie } : {},
		cache: "no-store",
	});
	if (!response.ok) {
		throw new ApiRequestError(
			response.status,
			`GET ${path} failed with ${response.status}`,
		);
	}
	return schema.parse(await response.json());
}
