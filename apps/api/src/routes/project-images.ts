import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { errorResponse, idParams, project } from "@petri/contracts";
import {
	type Database,
	deployments,
	type ProjectImage,
	projects,
} from "@petri/database";
import { and, eq } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ApiError } from "../errors.ts";
import {
	IMAGE_CONTENT_TYPES,
	ImageError,
	imagePath,
	imageVersion,
	inspectImage,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_SIDE,
	MIN_IMAGE_SIDE,
} from "../image.ts";
import { toProject } from "./projects.ts";

const maxMb = MAX_IMAGE_BYTES / 1024 / 1024;
const tooLarge = () =>
	new ApiError(413, "too_large", `The image is larger than ${maxMb} MB`);
const notFound = () => new ApiError(404, "not_found", "Project not found");
const noImage = () =>
	new ApiError(404, "not_found", "This project has no image");

/** Preview images: upload, remove, and serve them. */
export const projectImageRoutes: FastifyPluginAsyncZod<{
	db: Database;
	uploadsDir: string;
}> = async (app, { db, uploadsDir }) => {
	await mkdir(dirname(imagePath(uploadsDir, "x")), {
		recursive: true,
		mode: 0o700,
	});

	// The body is the file itself, whatever type it declares: the content
	// decides. Only in this plugin.
	app.removeAllContentTypeParsers();
	app.addContentTypeParser(
		"*",
		{ parseAs: "buffer", bodyLimit: MAX_IMAGE_BYTES },
		(_request, body, done) => done(null, body),
	);

	app.put(
		"/projects/:id/image",
		{
			config: { access: { scope: "deploy:update" } },
			// Refused before reading the body, when its size is declared.
			onRequest: async (request) => {
				if (Number(request.headers["content-length"]) > MAX_IMAGE_BYTES) {
					throw tooLarge();
				}
			},
			schema: {
				tags: ["projects"],
				summary: "Set the project's preview image",
				description: [
					`The request body is the image file: PNG, JPEG or WebP, at most ${maxMb} MB, each side ${MIN_IMAGE_SIDE} to ${MAX_IMAGE_SIDE} pixels.`,
					"The type is taken from the file's content; the Content-Type header is ignored.",
					"",
					"`curl -X PUT --data-binary @preview.png -H 'Authorization: Bearer …' …/api/v1/projects/<id>/image`",
				].join("\n"),
				params: idParams,
				response: {
					200: project,
					400: errorResponse,
					404: errorResponse,
					413: errorResponse,
				},
			},
		},
		async (request) => {
			const { id } = request.params;
			const [existing] = await db
				.select({ id: projects.id })
				.from(projects)
				.where(eq(projects.id, id));
			if (!existing) throw notFound();

			const data = request.body;
			if (!Buffer.isBuffer(data) || data.length === 0) {
				throw new ApiError(
					400,
					"invalid_image",
					"Send the image file as the request body",
				);
			}
			let info: ReturnType<typeof inspectImage>;
			try {
				info = inspectImage(data);
			} catch (error) {
				if (error instanceof ImageError) {
					throw new ApiError(400, "invalid_image", error.message);
				}
				throw error;
			}

			// Replaced whole: a request for the old image never gets half a
			// new one.
			const path = imagePath(uploadsDir, id);
			await writeFile(`${path}.partial`, data, { mode: 0o600 });
			await rename(`${path}.partial`, path);
			const [row] = await db
				.update(projects)
				.set({ image: { ...info, updatedAt: new Date().toISOString() } })
				.where(eq(projects.id, id))
				.returning();
			if (!row) {
				// Deleted meanwhile.
				await rm(path, { force: true });
				throw notFound();
			}
			return toProject(row);
		},
	);

	app.delete(
		"/projects/:id/image",
		{
			config: { access: { scope: "deploy:update" } },
			schema: {
				tags: ["projects"],
				summary: "Remove the project's preview image",
				params: idParams,
				response: { 200: project, 404: errorResponse },
			},
		},
		async (request) => {
			const { id } = request.params;
			const [row] = await db
				.update(projects)
				.set({ image: null })
				.where(eq(projects.id, id))
				.returning();
			if (!row) throw notFound();
			await rm(imagePath(uploadsDir, id), { force: true });
			return toProject(row);
		},
	);

	app.get(
		"/projects/:id/image",
		{
			config: { access: { scope: "deploy:read" } },
			schema: {
				tags: ["projects"],
				summary: "The project's preview image",
				params: idParams,
				querystring: z.object({ v: z.string().optional() }),
				response: { 404: errorResponse },
			},
		},
		async (request, reply) => {
			const [row] = await db
				.select({ id: projects.id, image: projects.image })
				.from(projects)
				.where(eq(projects.id, request.params.id));
			if (!row) throw notFound();
			if (!row.image) throw noImage();
			return sendImage(reply, uploadsDir, row.id, row.image, "private");
		},
	);

	app.get(
		"/gallery/:slug/image",
		{
			config: { access: "public" },
			schema: {
				tags: ["gallery"],
				summary: "A gallery experiment's preview image",
				description: "Only for experiments the gallery shows.",
				security: [],
				params: z.object({ slug: z.string() }),
				querystring: z.object({ v: z.string().optional() }),
				response: { 404: errorResponse },
			},
		},
		async (request, reply) => {
			// The same conditions as the gallery itself (gallery.ts).
			const [row] = await db
				.select({ id: projects.id, image: projects.image })
				.from(projects)
				.innerJoin(
					deployments,
					eq(deployments.id, projects.featuredDeploymentId),
				)
				.where(
					and(
						eq(projects.slug, request.params.slug),
						eq(projects.visibility, "public"),
						eq(deployments.status, "ready"),
					),
				);
			if (!row?.image) {
				throw new ApiError(404, "not_found", "No image here");
			}
			return sendImage(reply, uploadsDir, row.id, row.image, "public");
		},
	);
};

/**
 * Sends a stored image with the type found on upload, never anything the
 * browser might run: nosniff, and a policy that allows nothing.
 */
async function sendImage(
	reply: FastifyReply,
	uploadsDir: string,
	projectId: string,
	image: ProjectImage,
	cache: "public" | "private",
) {
	const data = await readFile(imagePath(uploadsDir, projectId)).catch(
		() => null,
	);
	if (!data) throw noImage();
	const etag = `"${imageVersion(image)}"`;
	reply
		.header("content-type", IMAGE_CONTENT_TYPES[image.type])
		.header("x-content-type-options", "nosniff")
		.header("content-security-policy", "default-src 'none'; sandbox")
		.header("content-disposition", "inline")
		// Short: a hidden experiment's image shouldn't linger in caches.
		.header("cache-control", `${cache}, max-age=300`)
		.header("etag", etag);
	if (reply.request.headers["if-none-match"] === etag) {
		return reply.status(304).send();
	}
	return reply.send(data);
}
