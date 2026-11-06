import "server-only";
import { headers } from "next/headers";
import { z } from "zod";
import { apiGet } from "./api.ts";

const sessionResponse = z
	.object({
		user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
	})
	.nullable();

export type Session = NonNullable<z.infer<typeof sessionResponse>>;

/** The signed-in owner's session, or null. Checked with the API. */
export async function getSession(): Promise<Session | null> {
	const cookie = (await headers()).get("cookie") ?? undefined;
	if (!cookie) return null;
	return apiGet("/api/v1/auth/get-session", sessionResponse, { cookie });
}

/** The incoming request's cookies, to forward to the API. */
export async function requestCookie(): Promise<string | undefined> {
	return (await headers()).get("cookie") ?? undefined;
}
