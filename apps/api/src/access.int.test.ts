import type { ApiKeyList, ErrorResponse, Project } from "@petri/contracts";
import { apiKeys } from "@petri/database";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { publicUrl, useTestApp } from "../test/app.ts";

const ctx = useTestApp();
const SOME_ID = "0190a0e0-0000-7000-8000-000000000000";

/** Turns a route pattern into a concrete URL. */
const concrete = (url: string) =>
	url.replace(/:[a-zA-Z]+/g, SOME_ID).replace("*", "anything");

describe("route protection", () => {
	test("only the expected routes are public", () => {
		const publicRoutes = ctx.app.routeAccess
			.filter((route) => route.access === "public")
			.map((route) => route.url);
		for (const url of publicRoutes) {
			expect(
				url === "/api/v1/health" ||
					url === "/api/v1/gallery" ||
					url === "/api/v1/gallery/:slug" ||
					// Only for experiments the gallery shows (project-images.ts).
					url === "/api/v1/gallery/:slug/image" ||
					url === "/api/v1/auth/*" ||
					url.startsWith("/api/v1/docs"),
				`unexpected public route ${url}`,
			).toBe(true);
		}
	});

	test("every other route rejects anonymous requests", async () => {
		const protectedRoutes = ctx.app.routeAccess.filter(
			(route) => route.access !== "public",
		);
		expect(protectedRoutes.length).toBeGreaterThan(5);

		for (const route of protectedRoutes) {
			const response = await ctx.anonymous({
				method: route.method as "GET",
				url: concrete(route.url),
				...(route.method !== "GET" &&
					route.method !== "HEAD" &&
					route.method !== "DELETE" && { payload: {} }),
			});
			expect(
				response.statusCode,
				`${route.method} ${route.url} answered ${response.statusCode}`,
			).toBe(401);
		}
	});

	test("an invalid session cookie is rejected", async () => {
		const response = await ctx.anonymous({
			url: "/api/v1/projects",
			headers: { cookie: "better-auth.session_token=forged" },
		});
		expect(response.statusCode).toBe(401);
		expect(response.json<ErrorResponse>().error.code).toBe("unauthorized");
	});
});

describe("owner sessions", () => {
	test("can use every route", async () => {
		expect((await ctx.inject({ url: "/api/v1/projects" })).statusCode).toBe(
			200,
		);
		expect((await ctx.inject({ url: "/api/v1/api-keys" })).statusCode).toBe(
			200,
		);
	});

	test("changes must come from the admin panel's origin", async () => {
		const cookie = await ctx.ownerCookie();
		const payload = { name: "Demo" };
		const url = "/api/v1/projects";

		for (const origin of [undefined, "https://evil.example.com"]) {
			const response = await ctx.anonymous({
				method: "POST",
				url,
				payload,
				headers: { cookie, ...(origin && { origin }) },
			});
			expect(response.statusCode).toBe(403);
		}

		const sameOrigin = await ctx.anonymous({
			method: "POST",
			url,
			payload,
			headers: { cookie, origin: publicUrl },
		});
		expect(sameOrigin.statusCode).toBe(201);
	});

	test("signing out ends the session", async () => {
		const cookie = await ctx.ownerCookie();
		const signOut = await ctx.anonymous({
			method: "POST",
			url: "/api/v1/auth/sign-out",
			headers: { cookie, origin: publicUrl },
		});
		expect(signOut.statusCode).toBe(200);

		const after = await ctx.anonymous({
			url: "/api/v1/projects",
			headers: { cookie },
		});
		expect(after.statusCode).toBe(401);
	});
});

describe("API keys", () => {
	test("are shown once and stored only as a hash", async () => {
		const { apiKey, key } = await ctx.createKey(["deploy:read"]);
		expect(key).toMatch(/^petri_[A-Za-z0-9_-]{43}$/);
		expect(key.startsWith(apiKey.prefix)).toBe(true);

		const list = await ctx.inject({ url: "/api/v1/api-keys" });
		expect(list.body).not.toContain(key);
		const [row] = await ctx.db
			.select()
			.from(apiKeys)
			.where(eq(apiKeys.id, apiKey.id));
		expect(row?.keyHash).not.toContain(key.slice(6));
	});

	test("are limited to their scopes", async () => {
		const { key } = await ctx.createKey(["deploy:read"]);

		const read = await ctx.withKey(key, { url: "/api/v1/projects" });
		expect(read.statusCode).toBe(200);

		const create = await ctx.withKey(key, {
			method: "POST",
			url: "/api/v1/projects",
			payload: { name: "Demo" },
		});
		expect(create.statusCode).toBe(403);
		expect(create.json<ErrorResponse>().error.message).toContain(
			"deploy:create",
		);
	});

	test("with the right scope can create projects", async () => {
		const { key } = await ctx.createKey(["deploy:create"]);
		const response = await ctx.withKey(key, {
			method: "POST",
			url: "/api/v1/projects",
			payload: { name: "From an assistant" },
		});
		expect(response.statusCode).toBe(201);
		expect(response.json<Project>().slug).toBe("from-an-assistant");
	});

	test("cannot manage API keys", async () => {
		const { key } = await ctx.createKey([
			"deploy:read",
			"deploy:create",
			"deploy:update",
			"deploy:delete",
		]);
		const list = await ctx.withKey(key, { url: "/api/v1/api-keys" });
		expect(list.statusCode).toBe(403);
		const create = await ctx.withKey(key, {
			method: "POST",
			url: "/api/v1/api-keys",
			payload: { name: "escalation", scopes: ["deploy:read"] },
		});
		expect(create.statusCode).toBe(403);
	});

	test("stop working once revoked", async () => {
		const { apiKey, key } = await ctx.createKey(["deploy:read"]);
		const revoke = await ctx.inject({
			method: "DELETE",
			url: `/api/v1/api-keys/${apiKey.id}`,
		});
		expect(revoke.statusCode).toBe(200);
		expect(revoke.json().revokedAt).not.toBeNull();

		const response = await ctx.withKey(key, { url: "/api/v1/projects" });
		expect(response.statusCode).toBe(401);
	});

	test("revoking twice is harmless; unknown keys are 404", async () => {
		const { apiKey } = await ctx.createKey(["deploy:read"]);
		const url = `/api/v1/api-keys/${apiKey.id}`;
		const first = await ctx.inject({ method: "DELETE", url });
		const second = await ctx.inject({ method: "DELETE", url });
		expect(second.statusCode).toBe(200);
		expect(second.json().revokedAt).toBe(first.json().revokedAt);

		const unknown = await ctx.inject({
			method: "DELETE",
			url: `/api/v1/api-keys/${SOME_ID}`,
		});
		expect(unknown.statusCode).toBe(404);
	});

	test("stop working once expired", async () => {
		const { apiKey, key } = await ctx.createKey(["deploy:read"], {
			expiresInDays: 1,
		});
		expect(
			(await ctx.withKey(key, { url: "/api/v1/projects" })).statusCode,
		).toBe(200);

		await ctx.db
			.update(apiKeys)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(apiKeys.id, apiKey.id));
		expect(
			(await ctx.withKey(key, { url: "/api/v1/projects" })).statusCode,
		).toBe(401);
	});

	test("record when they were last used", async () => {
		const { apiKey, key } = await ctx.createKey(["deploy:read"]);
		expect(apiKey.lastUsedAt).toBeNull();
		await ctx.withKey(key, { url: "/api/v1/projects" });

		const list = await ctx.inject({ url: "/api/v1/api-keys" });
		const listed = list
			.json<ApiKeyList>()
			.items.find((item) => item.id === apiKey.id);
		expect(listed?.lastUsedAt).not.toBeNull();
	});

	test("malformed or unknown keys are rejected, even with a valid cookie", async () => {
		const cookie = await ctx.ownerCookie();
		for (const authorization of [
			"Bearer petri_unknown",
			"Bearer not-a-petri-key",
			"Basic dXNlcjpwYXNz",
			"Bearer",
		]) {
			const response = await ctx.anonymous({
				url: "/api/v1/projects",
				headers: { authorization, cookie },
			});
			expect(response.statusCode, authorization).toBe(401);
		}
	});

	test("creation is validated", async () => {
		for (const payload of [
			{ name: "no scopes", scopes: [] },
			{ name: "duplicate", scopes: ["deploy:read", "deploy:read"] },
			{ name: "unknown", scopes: ["admin"] },
			{ name: "", scopes: ["deploy:read"] },
		]) {
			const response = await ctx.inject({
				method: "POST",
				url: "/api/v1/api-keys",
				payload,
			});
			expect(response.statusCode, JSON.stringify(payload)).toBe(400);
		}
	});
});
