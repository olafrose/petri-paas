import type { Gallery } from "@petri/contracts";
import { deployments, projects } from "@petri/database";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { useTestApp } from "../../test/app.ts";

const ctx = useTestApp();

async function addProject(
	slug: string,
	{
		visibility = "public",
		status = "ready",
		featured = true,
	}: {
		visibility?: "public" | "private";
		status?: "ready" | "stopped";
		featured?: boolean;
	} = {},
) {
	const [project] = await ctx.db
		.insert(projects)
		.values({
			name: slug,
			slug,
			visibility,
			notes: "private lab notes",
		})
		.returning();
	if (!project) throw new Error("no project");
	const [deployment] = await ctx.db
		.insert(deployments)
		.values({
			projectId: project.id,
			name: "main",
			subdomain: slug,
			source: {
				type: "git",
				repository: "https://example.com/secret",
				ref: "main",
			},
			lifecycleMode: "permanent",
			status,
		})
		.returning();
	if (!deployment) throw new Error("no deployment");
	if (featured) {
		await ctx.db
			.update(projects)
			.set({ featuredDeploymentId: deployment.id })
			.where(eq(projects.id, project.id));
	}
}

test("is public and lists only public projects with a ready featured deployment", async () => {
	await addProject("shown");
	await addProject("private-one", { visibility: "private" });
	await addProject("stopped-one", { status: "stopped" });
	await addProject("not-featured", { featured: false });

	const response = await ctx.anonymous({ url: "/api/v1/gallery" });
	expect(response.statusCode).toBe(200);
	const { items } = response.json<Gallery>();
	expect(items.map((item) => item.slug)).toEqual(["shown"]);
	expect(items[0]?.deployment).toEqual({
		name: "main",
		status: "ready",
		url: "https://shown.app.example.com/",
	});
});

test("never exposes notes, sources or ids", async () => {
	await addProject("shown");
	const response = await ctx.anonymous({ url: "/api/v1/gallery" });
	expect(response.body).not.toContain("private lab notes");
	expect(response.body).not.toContain("example.com/secret");
	expect(response.body).not.toMatch(/"id"/);
});

test("is empty when nothing is on display", async () => {
	const response = await ctx.anonymous({ url: "/api/v1/gallery" });
	expect(response.json()).toEqual({ items: [] });
});
