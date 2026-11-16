import type { ErrorResponse } from "@petri/contracts";
import { describe, expect, test } from "vitest";
import { previewBaseUrl, publicUrl, useTestApp } from "../../test/app.ts";
import { GUIDE_ENDPOINTS } from "../guide.ts";

const ctx = useTestApp();

async function guide() {
	const response = await ctx.anonymous({ url: "/api/v1/guide" });
	expect(response.statusCode).toBe(200);
	return response;
}

/** A route pattern as a regular expression for concrete paths. */
const pattern = (url: string) =>
	new RegExp(`^${url.replace(/:[a-zA-Z]+/g, "[^/]+")}$`);

describe("GET /guide", () => {
	test("is public Markdown with this instance's addresses", async () => {
		const response = await guide();
		expect(response.headers["content-type"]).toBe(
			"text/markdown; charset=utf-8",
		);
		expect(response.body).toMatch(/^# petri\. — a guide for coding assistants/);
		expect(response.body).toContain(`${publicUrl}/api/v1/access-requests`);
		expect(response.body).toContain(`.${new URL(previewBaseUrl).host}`);
	});

	test("names only endpoints that exist, with the access it claims", () => {
		for (const endpoint of GUIDE_ENDPOINTS) {
			const route = ctx.app.routeAccess.find(
				(r) => r.method === endpoint.method && r.url === endpoint.path,
			);
			expect(route, `${endpoint.method} ${endpoint.path}`).toBeDefined();
			expect(route?.access, `${endpoint.method} ${endpoint.path}`).toEqual(
				endpoint.access,
			);
		}
	});

	test("every API address in the text exists", async () => {
		const { body } = await guide();
		const prefix = `${publicUrl}/api/v1`;
		const paths = [
			...body.matchAll(/https?:\/\/[^\s'"`)]+\/api\/v1[^\s'"`)?]*/g),
		].map(([url]) =>
			url
				.slice(prefix.length - "/api/v1".length)
				.replace(/<[a-z]+>/g, "x")
				.replace(/[.,]$/, ""),
		);
		expect(paths.length).toBeGreaterThan(5);
		for (const path of paths) {
			const known = ctx.app.routeAccess.some((route) =>
				pattern(route.url).test(path),
			);
			expect(known, path).toBe(true);
		}
	});
});

test("a request without a key is pointed to the guide", async () => {
	const response = await ctx.anonymous({ url: "/api/v1/projects" });
	expect(response.statusCode).toBe(401);
	expect(response.json<ErrorResponse>().error.help).toBe(
		`${publicUrl}/api/v1/guide`,
	);
	const badKey = await ctx.anonymous({
		url: "/api/v1/projects",
		headers: { authorization: "Bearer nonsense" },
	});
	expect(badKey.json<ErrorResponse>().error.help).toBe(
		`${publicUrl}/api/v1/guide`,
	);
});
