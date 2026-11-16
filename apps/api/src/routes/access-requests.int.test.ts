import type {
	AccessRequestList,
	AccessTokenResponse,
	ApiKeyList,
	CreatedAccessRequest,
	ErrorResponse,
} from "@petri/contracts";
import { accessRequests } from "@petri/database";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { publicUrl, useTestApp } from "../../test/app.ts";

const ctx = useTestApp();

async function requestAccess(
	payload: object = {
		name: "Claude Code on laptop",
		scopes: ["deploy:read", "deploy:create"],
		reason: "To preview the dashboard concept",
	},
	remoteAddress = "127.0.0.1",
) {
	return ctx.anonymous({
		method: "POST",
		url: "/api/v1/access-requests",
		payload,
		remoteAddress,
		headers: { "user-agent": "test-agent/1.0" },
	});
}

async function created() {
	const response = await requestAccess();
	expect(response.statusCode).toBe(201);
	return response.json<CreatedAccessRequest>();
}

/** Polls as an assistant that waited the interval. */
async function poll(pollToken: string) {
	await ctx.db.update(accessRequests).set({ lastPolledAt: null });
	return ctx.anonymous({
		method: "POST",
		url: "/api/v1/access-requests/token",
		payload: { pollToken },
	});
}

async function openRequests() {
	const response = await ctx.inject({ url: "/api/v1/access-requests" });
	expect(response.statusCode).toBe(200);
	return response.json<AccessRequestList>().items;
}

async function decide(id: string, action: "grant" | "deny", payload = {}) {
	return ctx.inject({
		method: "POST",
		url: `/api/v1/access-requests/${id}/${action}`,
		payload,
	});
}

describe("asking for access", () => {
	test("answers with a code, the review link and a poll token", async () => {
		const answer = await created();
		expect(answer.userCode).toMatch(
			/^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/,
		);
		expect(answer.reviewUrl).toBe(
			`${publicUrl}/admin/access-requests?code=${answer.userCode}`,
		);
		expect(answer.pollToken.length).toBeGreaterThan(40);
		expect(answer.interval).toBe(5);
		const minutes = (Date.parse(answer.expiresAt) - Date.now()) / 60_000;
		expect(minutes).toBeGreaterThan(14);
		expect(minutes).toBeLessThanOrEqual(15);
	});

	test("the owner sees the request, but not the poll token", async () => {
		const answer = await created();
		const [request] = await openRequests();
		expect(request).toMatchObject({
			name: "Claude Code on laptop",
			reason: "To preview the dashboard concept",
			scopes: ["deploy:read", "deploy:create"],
			userCode: answer.userCode,
			address: "127.0.0.1",
			userAgent: "test-agent/1.0",
		});
		expect(JSON.stringify(request)).not.toContain(answer.pollToken);
	});

	test("validates the request", async () => {
		const response = await requestAccess({ name: "", scopes: ["root"] });
		expect(response.statusCode).toBe(400);
		expect(response.json<ErrorResponse>().error.code).toBe("validation_failed");
	});

	test("limits requests per address", async () => {
		for (let i = 0; i < 5; i++) {
			expect((await requestAccess()).statusCode).toBe(201);
		}
		const sixth = await requestAccess();
		expect(sixth.statusCode).toBe(429);
		expect(sixth.json<ErrorResponse>().error.code).toBe("rate_limited");
		// Others can still ask.
		expect((await requestAccess(undefined, "10.0.0.9")).statusCode).toBe(201);
	});

	test("limits the open requests", async () => {
		for (let i = 0; i < 10; i++) {
			const response = await requestAccess(undefined, `10.0.0.${i}`);
			expect(response.statusCode).toBe(201);
		}
		const eleventh = await requestAccess(undefined, "10.0.1.1");
		expect(eleventh.statusCode).toBe(429);
		expect(eleventh.json<ErrorResponse>().error.code).toBe("too_many_open");
	});
});

describe("collecting the key", () => {
	test("pending until granted, then the key, exactly once", async () => {
		const answer = await created();
		expect((await poll(answer.pollToken)).json<AccessTokenResponse>()).toEqual({
			status: "pending",
		});

		const [request] = await openRequests();
		const grant = await decide(request?.id as string, "grant", {
			scopes: ["deploy:read"],
			expiresInDays: 30,
		});
		expect(grant.statusCode).toBe(204);
		expect(await openRequests()).toEqual([]);

		const collected = await poll(answer.pollToken);
		expect(collected.statusCode).toBe(200);
		const body = collected.json<AccessTokenResponse>();
		if (body.status !== "granted") throw new Error(collected.body);
		expect(body.apiKey).toMatchObject({
			name: "Claude Code on laptop",
			scopes: ["deploy:read"],
			accessRequestId: request?.id,
		});
		const days =
			(Date.parse(body.apiKey.expiresAt as string) - Date.now()) / 86_400_000;
		expect(Math.round(days)).toBe(30);

		// The key works, within the granted scopes.
		expect(
			(await ctx.withKey(body.key, { url: "/api/v1/projects" })).statusCode,
		).toBe(200);
		const create = await ctx.withKey(body.key, {
			method: "POST",
			url: "/api/v1/projects",
			payload: { name: "Nope", slug: "nope" },
		});
		expect(create.statusCode).toBe(403);

		// Listed with the other keys, with its origin.
		const keys = await ctx.inject({ url: "/api/v1/api-keys" });
		expect(keys.json<ApiKeyList>().items[0]?.accessRequestId).toBe(request?.id);

		const again = await poll(answer.pollToken);
		expect(again.statusCode).toBe(410);
		expect(again.json<ErrorResponse>().error.code).toBe("already_collected");
	});

	test("granting all requested scopes by default", async () => {
		const answer = await created();
		const [request] = await openRequests();
		await decide(request?.id as string, "grant");
		const body = (await poll(answer.pollToken)).json<AccessTokenResponse>();
		expect(body.status === "granted" && body.apiKey.scopes).toEqual([
			"deploy:read",
			"deploy:create",
		]);
		expect(body.status === "granted" && body.apiKey.expiresAt).toBeNull();
	});

	test("scopes can be narrowed, not widened", async () => {
		await created();
		const [request] = await openRequests();
		const response = await decide(request?.id as string, "grant", {
			scopes: ["deploy:read", "deploy:delete"],
		});
		expect(response.statusCode).toBe(400);
		expect(response.json<ErrorResponse>().error.details?.[0]?.path).toBe(
			"scopes",
		);
	});

	test("a denied request never yields a key", async () => {
		const answer = await created();
		const [request] = await openRequests();
		expect((await decide(request?.id as string, "deny")).statusCode).toBe(204);
		expect((await poll(answer.pollToken)).json<AccessTokenResponse>()).toEqual({
			status: "denied",
		});
		// Decided requests can't be decided again.
		expect((await decide(request?.id as string, "grant")).statusCode).toBe(409);
	});

	test("an expired request never yields a key", async () => {
		const answer = await created();
		const [request] = await openRequests();
		await ctx.db
			.update(accessRequests)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(accessRequests.id, request?.id as string));
		expect((await poll(answer.pollToken)).json<AccessTokenResponse>()).toEqual({
			status: "expired",
		});
		expect(await openRequests()).toEqual([]);
		expect((await decide(request?.id as string, "grant")).statusCode).toBe(409);
	});

	test("a grant not collected in time expires", async () => {
		const answer = await created();
		const [request] = await openRequests();
		await decide(request?.id as string, "grant");
		await ctx.db
			.update(accessRequests)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(accessRequests.id, request?.id as string));
		expect((await poll(answer.pollToken)).json<AccessTokenResponse>()).toEqual({
			status: "expired",
		});
	});

	test("polling too fast answers slow_down", async () => {
		const answer = await created();
		const url = "/api/v1/access-requests/token";
		const payload = { pollToken: answer.pollToken };
		const first = await ctx.anonymous({ method: "POST", url, payload });
		expect(first.statusCode).toBe(200);
		const second = await ctx.anonymous({ method: "POST", url, payload });
		expect(second.statusCode).toBe(429);
		expect(second.json<ErrorResponse>().error.code).toBe("slow_down");
	});

	test("an unknown poll token is refused", async () => {
		const response = await poll("not-a-real-token");
		expect(response.statusCode).toBe(404);
	});
});

describe("deciding", () => {
	test("is for the owner only, not for API keys", async () => {
		await created();
		const [request] = await openRequests();
		const { key } = await ctx.createKey([
			"deploy:read",
			"deploy:create",
			"deploy:update",
			"deploy:delete",
		]);
		for (const url of [
			"/api/v1/access-requests",
			`/api/v1/access-requests/${request?.id}/grant`,
			`/api/v1/access-requests/${request?.id}/deny`,
		]) {
			const method = url.endsWith("requests") ? "GET" : "POST";
			const response = await ctx.withKey(key, {
				method,
				url,
				...(method === "POST" && { payload: {} }),
			});
			expect(response.statusCode, url).toBe(403);
		}
	});

	test("an unknown request is a 404", async () => {
		const response = await decide(
			"0190a0e0-0000-7000-8000-000000000000",
			"deny",
		);
		expect(response.statusCode).toBe(404);
	});
});
