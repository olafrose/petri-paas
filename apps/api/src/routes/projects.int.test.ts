import type { ErrorResponse, Project, ProjectList } from "@petri/contracts";
import { deployments } from "@petri/database";
import { describe, expect, test } from "vitest";
import { useTestApp } from "../../test/app.ts";

const ctx = useTestApp();

async function createProject(body: Record<string, unknown>) {
	const response = await ctx.app.inject({
		method: "POST",
		url: "/api/v1/projects",
		payload: body,
	});
	return { response, project: response.json<Project>() };
}

async function createDeployment(projectId: string, subdomain: string) {
	const [row] = await ctx.db
		.insert(deployments)
		.values({
			projectId,
			name: "main",
			subdomain,
			source: { type: "git", repository: "https://example.com/r", ref: "main" },
			lifecycleMode: "permanent",
		})
		.returning();
	if (!row) throw new Error("insert returned no row");
	return row;
}

describe("POST /projects", () => {
	test("creates a project and derives the slug", async () => {
		const { response, project } = await createProject({
			name: "Dashboard Concept",
			description: "A new dashboard",
		});
		expect(response.statusCode).toBe(201);
		expect(response.headers.location).toBe(`/api/v1/projects/${project.id}`);
		expect(project).toMatchObject({
			name: "Dashboard Concept",
			slug: "dashboard-concept",
			description: "A new dashboard",
			notes: "",
			visibility: "public",
			featuredDeploymentId: null,
		});
		expect(Date.parse(project.createdAt)).not.toBeNaN();
	});

	test("accepts an explicit slug", async () => {
		const { project } = await createProject({ name: "Demo", slug: "demo-v2" });
		expect(project.slug).toBe("demo-v2");
	});

	test("rejects a duplicate slug with 409", async () => {
		await createProject({ name: "Demo" });
		const { response } = await createProject({ name: "Demo" });
		expect(response.statusCode).toBe(409);
		expect(response.json<ErrorResponse>().error.code).toBe("conflict");
	});

	test("rejects invalid input with field details", async () => {
		const { response } = await createProject({ name: "", slug: "Bad Slug" });
		expect(response.statusCode).toBe(400);
		const { error } = response.json<ErrorResponse>();
		expect(error.code).toBe("validation_failed");
		expect(error.details?.map((detail) => detail.path).sort()).toEqual([
			"name",
			"slug",
		]);
	});

	test("rejects unknown fields", async () => {
		const { response } = await createProject({ name: "Demo", id: "x" });
		expect(response.statusCode).toBe(400);
	});

	test("asks for a slug when none can be derived", async () => {
		const { response } = await createProject({ name: "日本語" });
		expect(response.statusCode).toBe(400);
		expect(response.json<ErrorResponse>().error.details).toEqual([
			{ path: "slug", message: expect.any(String) },
		]);
	});

	test("rejects malformed JSON in the standard error shape", async () => {
		const response = await ctx.app.inject({
			method: "POST",
			url: "/api/v1/projects",
			headers: { "content-type": "application/json" },
			payload: "{not json",
		});
		expect(response.statusCode).toBe(400);
		expect(response.json<ErrorResponse>().error.code).toBe("bad_request");
	});
});

describe("GET /projects", () => {
	test("lists projects newest first", async () => {
		await createProject({ name: "First" });
		await createProject({ name: "Second" });
		const response = await ctx.app.inject({ url: "/api/v1/projects" });
		expect(response.statusCode).toBe(200);
		expect(
			response.json<ProjectList>().items.map((project) => project.slug),
		).toEqual(["second", "first"]);
	});
});

describe("GET /projects/:id", () => {
	test("returns the project", async () => {
		const { project } = await createProject({ name: "Demo" });
		const response = await ctx.app.inject({
			url: `/api/v1/projects/${project.id}`,
		});
		expect(response.json()).toEqual(project);
	});

	test("returns 404 for an unknown id", async () => {
		const response = await ctx.app.inject({
			url: "/api/v1/projects/0190a0e0-0000-7000-8000-000000000000",
		});
		expect(response.statusCode).toBe(404);
		expect(response.json<ErrorResponse>().error.code).toBe("not_found");
	});

	test("returns 400 for a malformed id", async () => {
		const response = await ctx.app.inject({ url: "/api/v1/projects/nope" });
		expect(response.statusCode).toBe(400);
	});
});

describe("PATCH /projects/:id", () => {
	test("updates fields and keeps the slug", async () => {
		const { project } = await createProject({ name: "Demo" });
		const response = await ctx.app.inject({
			method: "PATCH",
			url: `/api/v1/projects/${project.id}`,
			payload: {
				name: "Renamed",
				notes: "Works on mobile",
				visibility: "private",
			},
		});
		expect(response.statusCode).toBe(200);
		expect(response.json<Project>()).toMatchObject({
			name: "Renamed",
			slug: "demo",
			notes: "Works on mobile",
			visibility: "private",
		});
	});

	test("refuses to change the slug", async () => {
		const { project } = await createProject({ name: "Demo" });
		const response = await ctx.app.inject({
			method: "PATCH",
			url: `/api/v1/projects/${project.id}`,
			payload: { slug: "other" },
		});
		expect(response.statusCode).toBe(400);
	});

	test("an empty body returns the project unchanged", async () => {
		const { project } = await createProject({ name: "Demo" });
		const response = await ctx.app.inject({
			method: "PATCH",
			url: `/api/v1/projects/${project.id}`,
			payload: {},
		});
		expect(response.json()).toEqual(project);
	});

	test("sets and clears the featured deployment", async () => {
		const { project } = await createProject({ name: "Demo" });
		const deployment = await createDeployment(project.id, "demo");
		const url = `/api/v1/projects/${project.id}`;

		const set = await ctx.app.inject({
			method: "PATCH",
			url,
			payload: { featuredDeploymentId: deployment.id },
		});
		expect(set.json<Project>().featuredDeploymentId).toBe(deployment.id);

		const cleared = await ctx.app.inject({
			method: "PATCH",
			url,
			payload: { featuredDeploymentId: null },
		});
		expect(cleared.json<Project>().featuredDeploymentId).toBeNull();
	});

	test("rejects a featured deployment of another project", async () => {
		const { project } = await createProject({ name: "Demo" });
		const { project: other } = await createProject({ name: "Other" });
		const foreign = await createDeployment(other.id, "other");
		const response = await ctx.app.inject({
			method: "PATCH",
			url: `/api/v1/projects/${project.id}`,
			payload: { featuredDeploymentId: foreign.id },
		});
		expect(response.statusCode).toBe(400);
		expect(response.json<ErrorResponse>().error.details?.[0]?.path).toBe(
			"featuredDeploymentId",
		);
	});

	test("returns 404 for an unknown id", async () => {
		const response = await ctx.app.inject({
			method: "PATCH",
			url: "/api/v1/projects/0190a0e0-0000-7000-8000-000000000000",
			payload: { name: "x" },
		});
		expect(response.statusCode).toBe(404);
	});
});

describe("DELETE /projects/:id", () => {
	test("deletes the project", async () => {
		const { project } = await createProject({ name: "Demo" });
		const url = `/api/v1/projects/${project.id}`;
		const response = await ctx.app.inject({ method: "DELETE", url });
		expect(response.statusCode).toBe(204);
		expect(response.body).toBe("");
		expect((await ctx.app.inject({ url })).statusCode).toBe(404);
	});

	test("returns 404 for an unknown id", async () => {
		const response = await ctx.app.inject({
			method: "DELETE",
			url: "/api/v1/projects/0190a0e0-0000-7000-8000-000000000000",
		});
		expect(response.statusCode).toBe(404);
	});
});
