import { existsSync, readFileSync } from "node:fs";
import type {
	Deployment,
	ErrorResponse,
	Gallery,
	Project,
} from "@petri/contracts";
import type { DeploymentStatus } from "@petri/database";
import { updateStatus } from "@petri/deployment-core";
import { describe, expect, test } from "vitest";
import { useTestApp } from "../../test/app.ts";
import { imagePath } from "../image.ts";

const ctx = useTestApp();

const fixture = (name: string) =>
	readFileSync(new URL(`../../test/fixtures/images/${name}`, import.meta.url));
const png = fixture("photo.png");

async function createProject(slug = "demo") {
	const response = await ctx.inject({
		method: "POST",
		url: "/api/v1/projects",
		payload: { name: "Demo", slug },
	});
	return response.json<Project>();
}

const upload = (
	id: string,
	data: Buffer | string,
	contentType = "application/octet-stream",
) =>
	ctx.inject({
		method: "PUT",
		url: `/api/v1/projects/${id}/image`,
		headers: { "content-type": contentType },
		payload: data,
	});

/** A project the gallery shows: public, with a ready featured deployment. */
async function galleryProject(slug: string) {
	const project = await createProject(slug);
	const created = await ctx.inject({
		method: "POST",
		url: "/api/v1/deployments",
		payload: {
			project: slug,
			source: {
				type: "git",
				repository: "https://github.com/x/y",
				ref: "main",
			},
		},
	});
	const deployment = created.json<Deployment>();
	const steps: DeploymentStatus[] = [
		"cloning",
		"building",
		"deploying",
		"health_check",
		"ready",
	];
	for (const status of steps) {
		await updateStatus(ctx.db, deployment.id, status, { message: status });
	}
	await ctx.inject({
		method: "PATCH",
		url: `/api/v1/projects/${project.id}`,
		payload: { featuredDeploymentId: deployment.id },
	});
	return project;
}

describe("PUT /projects/:id/image", () => {
	test("stores the image; its type comes from the content, not the header", async () => {
		const project = await createProject();
		const response = await upload(project.id, png, "text/html");
		expect(response.statusCode).toBe(200);
		const { image } = response.json<Project>();
		expect(image).toMatchObject({ width: 40, height: 30 });
		expect(image?.url).toMatch(
			new RegExp(`^/api/v1/projects/${project.id}/image\\?v=\\d+$`),
		);

		const served = await ctx.inject({ url: image?.url as string });
		expect(served.statusCode).toBe(200);
		expect(served.headers["content-type"]).toBe("image/png");
		expect(served.headers["x-content-type-options"]).toBe("nosniff");
		expect(served.headers["content-security-policy"]).toBe(
			"default-src 'none'; sandbox",
		);
		expect(served.headers["cache-control"]).toBe("private, max-age=300");
		expect(served.rawPayload.equals(png)).toBe(true);

		const again = await ctx.inject({
			url: image?.url as string,
			headers: { "if-none-match": served.headers.etag as string },
		});
		expect(again.statusCode).toBe(304);
	});

	test.each([
		["photo.jpg", "image/jpeg"],
		["lossy.webp", "image/webp"],
	])("serves %s as %s", async (name, type) => {
		const project = await createProject();
		const { image } = (await upload(project.id, fixture(name))).json<Project>();
		const served = await ctx.inject({ url: image?.url as string });
		expect(served.headers["content-type"]).toBe(type);
	});

	test("a new image replaces the old one, under a new URL", async () => {
		const project = await createProject();
		const first = (await upload(project.id, png)).json<Project>().image;
		await new Promise((resolve) => setTimeout(resolve, 5));
		const second = (
			await upload(project.id, fixture("photo.jpg"))
		).json<Project>().image;
		expect(second?.url).not.toBe(first?.url);
		const served = await ctx.inject({ url: second?.url as string });
		expect(served.headers["content-type"]).toBe("image/jpeg");
	});

	test.each([
		[
			"HTML declared as PNG",
			"<html><script>alert(1)</script></html>",
			"image/png",
		],
		["SVG", '<svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml"],
		["JSON", '{"not":"an image"}', "application/json"],
	])("refuses %s", async (_name, body, type) => {
		const project = await createProject();
		const response = await upload(project.id, body, type);
		expect(response.statusCode).toBe(400);
		expect(response.json<ErrorResponse>().error).toEqual({
			code: "invalid_image",
			message: "Not a PNG, JPEG or WebP image",
		});
		expect(existsSync(imagePath(ctx.uploadsDir, project.id))).toBe(false);
	});

	test("refuses an empty body and images over 2 MB", async () => {
		const project = await createProject();
		const empty = await upload(project.id, Buffer.alloc(0));
		expect(empty.json<ErrorResponse>().error.code).toBe("invalid_image");

		// A real PNG header, padded past the limit.
		const large = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]);
		const response = await upload(project.id, large);
		expect(response.statusCode).toBe(413);
		expect(response.json<ErrorResponse>().error).toEqual({
			code: "too_large",
			message: "The image is larger than 2 MB",
		});
	});

	test("needs deploy:update, and an existing project", async () => {
		const project = await createProject();
		const { key } = await ctx.createKey(["deploy:read"]);
		const readOnly = await ctx.withKey(key, {
			method: "PUT",
			url: `/api/v1/projects/${project.id}/image`,
			headers: { "content-type": "image/png" },
			payload: png,
		});
		expect(readOnly.statusCode).toBe(403);
		const anonymous = await ctx.anonymous({
			url: `/api/v1/projects/${project.id}/image`,
		});
		expect(anonymous.statusCode).toBe(401);
		const missing = await upload("01900000-0000-7000-8000-000000000000", png);
		expect(missing.statusCode).toBe(404);
	});
});

describe("DELETE /projects/:id/image", () => {
	test("removes the image and its file", async () => {
		const project = await createProject();
		const { image } = (await upload(project.id, png)).json<Project>();
		const response = await ctx.inject({
			method: "DELETE",
			url: `/api/v1/projects/${project.id}/image`,
		});
		expect(response.json<Project>().image).toBeNull();
		expect(existsSync(imagePath(ctx.uploadsDir, project.id))).toBe(false);
		const served = await ctx.inject({ url: image?.url as string });
		expect(served.statusCode).toBe(404);
	});

	test("deleting the project removes its image", async () => {
		const project = await createProject();
		await upload(project.id, png);
		await ctx.inject({
			method: "DELETE",
			url: `/api/v1/projects/${project.id}`,
		});
		expect(existsSync(imagePath(ctx.uploadsDir, project.id))).toBe(false);
	});
});

describe("GET /gallery/:slug/image", () => {
	test("serves the image of a project the gallery shows, publicly", async () => {
		const project = await galleryProject("shown");
		await upload(project.id, png);

		const gallery = await ctx.anonymous({ url: "/api/v1/gallery" });
		const [item] = gallery.json<Gallery>().items;
		expect(item?.image).toMatchObject({ width: 40, height: 30 });
		expect(item?.image?.url).toMatch(
			/^\/api\/v1\/gallery\/shown\/image\?v=\d+$/,
		);

		const served = await ctx.anonymous({ url: item?.image?.url as string });
		expect(served.statusCode).toBe(200);
		expect(served.headers["content-type"]).toBe("image/png");
		expect(served.headers["cache-control"]).toBe("public, max-age=300");
		expect(served.headers["x-content-type-options"]).toBe("nosniff");
	});

	test("refuses projects the gallery doesn't show", async () => {
		// No featured deployment.
		const plain = await createProject("plain");
		await upload(plain.id, png);
		expect(
			(await ctx.anonymous({ url: "/api/v1/gallery/plain/image" })).statusCode,
		).toBe(404);

		// Private.
		const hidden = await galleryProject("hidden");
		await upload(hidden.id, png);
		expect(
			(await ctx.anonymous({ url: "/api/v1/gallery/hidden/image" })).statusCode,
		).toBe(200);
		await ctx.inject({
			method: "PATCH",
			url: `/api/v1/projects/${hidden.id}`,
			payload: { visibility: "private" },
		});
		expect(
			(await ctx.anonymous({ url: "/api/v1/gallery/hidden/image" })).statusCode,
		).toBe(404);

		// Shown, but without an image.
		await galleryProject("bare");
		expect(
			(await ctx.anonymous({ url: "/api/v1/gallery/bare/image" })).statusCode,
		).toBe(404);
	});
});
