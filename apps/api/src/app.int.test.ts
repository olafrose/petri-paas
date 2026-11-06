import type { ErrorResponse } from "@petri/contracts";
import { describe, expect, test } from "vitest";
import { useTestApp } from "../test/app.ts";

const ctx = useTestApp();

describe("system routes", () => {
	test("health reports ok when the database is reachable", async () => {
		const response = await ctx.app.inject({ url: "/api/v1/health" });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ status: "ok" });
	});

	test("unknown routes return the standard 404", async () => {
		const response = await ctx.app.inject({ url: "/api/v1/nope" });
		expect(response.statusCode).toBe(404);
		expect(response.json<ErrorResponse>().error.code).toBe("not_found");
	});

	test("the OpenAPI document describes the project routes", async () => {
		const response = await ctx.app.inject({ url: "/api/v1/docs/json" });
		expect(response.statusCode).toBe(200);
		const document = response.json();
		expect(document.openapi).toMatch(/^3\./);
		expect(Object.keys(document.paths)).toEqual(
			expect.arrayContaining([
				"/api/v1/health",
				"/api/v1/projects",
				"/api/v1/projects/{id}",
			]),
		);
		expect(Object.keys(document.components.schemas)).toEqual(
			expect.arrayContaining(["Project", "CreateProject", "Error"]),
		);
	});
});
