import "server-only";
import { headers } from "next/headers";

/**
 * This installation's public address, e.g. https://petri.example.com, for
 * absolute links such as link-preview images. PUBLIC_URL when set (the
 * production Compose file passes it); otherwise the request's own host,
 * as in development.
 */
export async function publicOrigin(): Promise<string> {
	if (process.env.PUBLIC_URL) return new URL(process.env.PUBLIC_URL).origin;
	const request = await headers();
	const host = request.get("x-forwarded-host") ?? request.get("host");
	const proto = request.get("x-forwarded-proto") ?? "http";
	return `${proto}://${host ?? "localhost:3000"}`;
}
