import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { useTestDatabase } from "@petri/database/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Auth, createAuth } from "./auth.ts";
import { setOwner } from "./owner.ts";

const db = useTestDatabase();
const publicUrl = "http://localhost:3000";
const secret = "test-secret-that-is-at-least-32-characters-long";
const owner = {
	email: "owner@example.com",
	name: "Owner",
	password: "correct horse battery",
};

let clientAddress = 0;

/** Calls a Better Auth endpoint the way the Fastify bridge does. */
function call(auth: Auth, path: string, body?: unknown, cookie?: string) {
	const headers = new Headers({
		origin: publicUrl,
		// A distinct address per test keeps rate-limit counters separate.
		"x-forwarded-for": `10.0.0.${clientAddress}`,
	});
	if (body !== undefined) headers.set("content-type", "application/json");
	if (cookie) headers.set("cookie", cookie);
	return auth.handler(
		new Request(`${publicUrl}/api/v1/auth${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers,
			...(body !== undefined && { body: JSON.stringify(body) }),
		}),
	);
}

function signIn(auth: Auth, password = owner.password) {
	return call(auth, "/sign-in/email", { email: owner.email, password });
}

function sessionCookie(response: Response) {
	const cookie = response.headers
		.getSetCookie()
		.find((value) => value.startsWith("better-auth.session_token="));
	if (!cookie) throw new Error("no session cookie");
	return cookie;
}

describe("password login", () => {
	const auth = createAuth({ db, publicUrl, secret });

	beforeAll(() => {
		clientAddress++;
	});

	test("the owner can sign in and gets a session cookie", async () => {
		expect(await setOwner(auth, owner)).toBe("created");

		const response = await signIn(auth);
		expect(response.status).toBe(200);
		const cookie = sessionCookie(response);
		expect(cookie).toMatch(/HttpOnly/i);
		expect(cookie).toMatch(/SameSite=Lax/i);

		const session = await auth.api.getSession({
			headers: new Headers({ cookie: cookie.split(";")[0] ?? "" }),
		});
		expect(session?.user.email).toBe(owner.email);
	});

	test("a wrong password is rejected", async () => {
		await setOwner(auth, owner);
		expect((await signIn(auth, "wrong password!!")).status).toBe(401);
	});

	test("nobody can sign up", async () => {
		const response = await call(auth, "/sign-up/email", {
			email: "intruder@example.com",
			name: "Intruder",
			password: "a long enough password",
		});
		expect(response.ok).toBe(false);
	});

	test("setting a new password ends existing sessions", async () => {
		await setOwner(auth, owner);
		const cookie = sessionCookie(await signIn(auth)).split(";")[0] ?? "";

		expect(
			await setOwner(auth, { ...owner, password: "another long password" }),
		).toBe("updated");

		expect(
			await auth.api.getSession({ headers: new Headers({ cookie }) }),
		).toBeNull();
		expect((await signIn(auth)).status).toBe(401);
		expect((await signIn(auth, "another long password")).status).toBe(200);
	});

	test("only one owner can exist", async () => {
		await setOwner(auth, owner);
		await expect(
			setOwner(auth, { ...owner, email: "someone@example.com" }),
		).rejects.toThrow(/single owner/);
	});

	test("short passwords are refused", async () => {
		await expect(
			setOwner(auth, { ...owner, password: "short" }),
		).rejects.toThrow(/at least 12/);
	});
});

describe("rate limiting", () => {
	test("blocks sign-in after 5 attempts per minute from one address", async () => {
		const auth = createAuth({ db, publicUrl, secret });
		await setOwner(auth, owner);
		clientAddress++;

		const statuses: number[] = [];
		for (let attempt = 0; attempt < 6; attempt++) {
			statuses.push((await signIn(auth, "wrong password!!")).status);
		}
		expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);

		// Even the right password is refused until the window passes.
		expect((await signIn(auth)).status).toBe(429);
	});
});

describe("OIDC", () => {
	let issuer: Server;
	let issuerUrl: string;

	beforeAll(async () => {
		// A minimal identity provider: only the discovery document.
		issuer = createServer((request, response) => {
			if (request.url === "/.well-known/openid-configuration") {
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						issuer: issuerUrl,
						authorization_endpoint: `${issuerUrl}/authorize`,
						token_endpoint: `${issuerUrl}/token`,
						userinfo_endpoint: `${issuerUrl}/userinfo`,
						jwks_uri: `${issuerUrl}/jwks`,
					}),
				);
				return;
			}
			response.statusCode = 404;
			response.end();
		});
		await new Promise<void>((resolve) =>
			issuer.listen(0, "127.0.0.1", resolve),
		);
		issuerUrl = `http://127.0.0.1:${(issuer.address() as AddressInfo).port}`;
	});

	afterAll(() => {
		issuer.close();
	});

	test("redirects to the configured provider with PKCE", async () => {
		const auth = createAuth({
			db,
			publicUrl,
			secret,
			oidc: { issuer: issuerUrl, clientId: "petri", clientSecret: "s3cret" },
		});
		clientAddress++;

		// Generic OAuth providers are served by the social sign-in endpoint.
		const response = await call(auth, "/sign-in/social", {
			provider: "oidc",
			callbackURL: "/admin",
		});
		expect(response.status).toBe(200);
		const { url } = (await response.json()) as { url: string };
		const redirect = new URL(url);
		expect(`${redirect.origin}${redirect.pathname}`).toBe(
			`${issuerUrl}/authorize`,
		);
		expect(redirect.searchParams.get("client_id")).toBe("petri");
		expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
		expect(redirect.searchParams.get("redirect_uri")).toBe(
			`${publicUrl}/api/v1/auth/callback/oidc`,
		);
	});
});
