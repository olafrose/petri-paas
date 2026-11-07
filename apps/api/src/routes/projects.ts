import {
	createProjectBody,
	errorResponse,
	idParams,
	type Project,
	project,
	projectList,
	updateProjectBody,
} from "@petri/contracts";
import {
	type Database,
	deployments,
	isConstraintViolation,
	projects,
} from "@petri/database";
import { and, desc, eq, ne } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ApiError } from "../errors.ts";
import { slugify } from "../slug.ts";

type ProjectRow = typeof projects.$inferSelect;

/** Maps a database row to the API shape, so no column leaks by accident. */
function toProject(row: ProjectRow): Project {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		description: row.description,
		notes: row.notes,
		visibility: row.visibility,
		featuredDeploymentId: row.featuredDeploymentId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

const notFound = () => new ApiError(404, "not_found", "Project not found");

export const projectRoutes: FastifyPluginAsyncZod<{ db: Database }> = async (
	app,
	{ db },
) => {
	const tags = ["projects"];

	app.post(
		"/projects",
		{
			config: { access: { scope: "deploy:create" } },
			schema: {
				tags,
				summary: "Create a project",
				body: createProjectBody,
				response: { 201: project, 400: errorResponse, 409: errorResponse },
			},
		},
		async (request, reply) => {
			const { slug: requestedSlug, ...values } = request.body;
			const slug = requestedSlug ?? slugify(values.name);
			if (slug === "") {
				throw new ApiError(400, "validation_failed", "Invalid request body", [
					{
						path: "slug",
						message: "Cannot derive a slug from this name; provide one",
					},
				]);
			}

			try {
				const [row] = await db
					.insert(projects)
					.values({ ...values, slug })
					.returning();
				if (!row) throw new Error("insert returned no row");
				return reply
					.status(201)
					.header("location", `/api/v1/projects/${row.id}`)
					.send(toProject(row));
			} catch (error) {
				if (isConstraintViolation(error, "projects_slug_unique")) {
					throw new ApiError(
						409,
						"conflict",
						`A project with slug "${slug}" already exists`,
					);
				}
				throw error;
			}
		},
	);

	app.get(
		"/projects",
		{
			config: { access: { scope: "deploy:read" } },
			schema: {
				tags,
				summary: "List projects, newest first",
				response: { 200: projectList },
			},
		},
		async () => {
			const rows = await db
				.select()
				.from(projects)
				.orderBy(desc(projects.createdAt), desc(projects.id));
			return { items: rows.map(toProject) };
		},
	);

	app.get(
		"/projects/:id",
		{
			config: { access: { scope: "deploy:read" } },
			schema: {
				tags,
				summary: "Get a project",
				params: idParams,
				response: { 200: project, 404: errorResponse },
			},
		},
		async (request) => {
			const [row] = await db
				.select()
				.from(projects)
				.where(eq(projects.id, request.params.id));
			if (!row) throw notFound();
			return toProject(row);
		},
	);

	app.patch(
		"/projects/:id",
		{
			config: { access: { scope: "deploy:update" } },
			schema: {
				tags,
				summary: "Update a project",
				params: idParams,
				body: updateProjectBody,
				response: { 200: project, 400: errorResponse, 404: errorResponse },
			},
		},
		async (request) => {
			const { id } = request.params;
			const changes = request.body;

			const row = await db.transaction(async (tx) => {
				const [existing] = await tx
					.select({ id: projects.id })
					.from(projects)
					.where(eq(projects.id, id))
					.for("update");
				if (!existing) throw notFound();

				if (changes.featuredDeploymentId) {
					const [deployment] = await tx
						.select({ id: deployments.id })
						.from(deployments)
						.where(
							and(
								eq(deployments.id, changes.featuredDeploymentId),
								eq(deployments.projectId, id),
							),
						);
					if (!deployment) {
						throw new ApiError(
							400,
							"validation_failed",
							"Invalid request body",
							[
								{
									path: "featuredDeploymentId",
									message: "Not a deployment of this project",
								},
							],
						);
					}
				}

				if (Object.keys(changes).length === 0) {
					const [current] = await tx
						.select()
						.from(projects)
						.where(eq(projects.id, id));
					return current;
				}
				const [updated] = await tx
					.update(projects)
					.set(changes)
					.where(eq(projects.id, id))
					.returning();
				return updated;
			});

			if (!row) throw notFound();
			return toProject(row);
		},
	);

	app.delete(
		"/projects/:id",
		{
			config: { access: { scope: "deploy:delete" } },
			schema: {
				tags,
				summary: "Delete a project and its deployments' history",
				description:
					"Only once all its deployments are deleted: deleting a project removes their records, and with them petri.'s only reference to anything still running.",
				params: idParams,
				response: { 204: z.null(), 404: errorResponse, 409: errorResponse },
			},
		},
		async (request, reply) => {
			const { id } = request.params;
			await db.transaction(async (tx) => {
				// Locked: a deployment created meanwhile waits, then fails.
				const [existing] = await tx
					.select({ id: projects.id })
					.from(projects)
					.where(eq(projects.id, id))
					.for("update");
				if (!existing) throw notFound();

				const [remaining] = await tx
					.select({ id: deployments.id })
					.from(deployments)
					.where(
						and(
							eq(deployments.projectId, id),
							ne(deployments.status, "deleted"),
						),
					)
					.limit(1);
				if (remaining) {
					throw new ApiError(
						409,
						"conflict",
						"Delete the project's deployments first",
					);
				}
				await tx.delete(projects).where(eq(projects.id, id));
			});
			return reply.status(204).send(null);
		},
	);
};
