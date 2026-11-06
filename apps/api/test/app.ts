import type { CreatedApiKey, Scope } from "@petri/contracts";
import { useTestDatabase } from "@petri/database/testing";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { buildApp } from "../src/app.ts";
import { createAuth } from "../src/auth/auth.ts";
import { setOwner } from "../src/auth/owner.ts";

export const publicUrl = "http://localhost:3000";
export const owner = {
	email: "owner@example.com",
	name: "Owner",
	password: "correct horse battery",
};

/**
 * A ready API instance on the test database. Call once per test file.
 *
 * `inject` sends requests as the signed-in owner; the owner is created
 * and signed in on first use in each test, since the database is reset
 * between tests.
 */
export function useTestApp() {
	const db = useTestDatabase();
	const auth = createAuth({
		db,
		publicUrl,
		secret: "test-secret-that-is-at-least-32-characters-long",
	});
	let app: Awaited<ReturnType<typeof buildApp>>;
	let cookie: string | undefined;

	beforeAll(async () => {
		app = await buildApp({ db, auth, publicUrl });
		await app.ready();
	});

	beforeEach(() => {
		cookie = undefined;
	});

	afterAll(async () => {
		await app.close();
	});

	async function ownerCookie(): Promise<string> {
		if (cookie) return cookie;
		await setOwner(auth, owner);
		const response = await app.inject({
			method: "POST",
			url: "/api/v1/auth/sign-in/email",
			headers: { origin: publicUrl },
			payload: { email: owner.email, password: owner.password },
		});
		const setCookie = response.headers["set-cookie"];
		const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
		if (response.statusCode !== 200 || !first) {
			throw new Error(`owner sign-in failed: ${response.body}`);
		}
		cookie = first.split(";")[0];
		return cookie as string;
	}

	return {
		db,
		auth,
		get app() {
			return app;
		},
		ownerCookie,

		/** A request as the signed-in owner. */
		async inject(options: InjectOptions): Promise<LightMyRequestResponse> {
			return app.inject({
				...options,
				headers: {
					origin: publicUrl,
					...options.headers,
					cookie: await ownerCookie(),
				},
			});
		},

		/** A request without any credentials. */
		anonymous(options: InjectOptions) {
			return app.inject(options);
		},

		/** A request authenticated with the given API key. */
		withKey(key: string, options: InjectOptions) {
			return app.inject({
				...options,
				headers: { ...options.headers, authorization: `Bearer ${key}` },
			});
		},

		/** Creates an API key through the API, as the owner. */
		async createKey(scopes: Scope[], extra: { expiresInDays?: number } = {}) {
			const response = await this.inject({
				method: "POST",
				url: "/api/v1/api-keys",
				payload: { name: "test key", scopes, ...extra },
			});
			if (response.statusCode !== 201) {
				throw new Error(`creating key failed: ${response.body}`);
			}
			return response.json<CreatedApiKey>();
		},
	};
}
