import { randomBytes } from "node:crypto";
import {
	createDeploymentBody,
	type Deployment,
	deployment,
	deploymentEventList,
	deploymentEventsQuery,
	deploymentList,
	errorResponse,
	idParams,
	listDeploymentsQuery,
} from "@petri/contracts";
import {
	builds,
	type Database,
	deploymentEvents,
	deployments,
	isConstraintViolation,
	projects,
	publishEvent,
	type Transaction,
	withTransaction,
} from "@petri/database";
import { availableActions } from "@petri/deployment-core";
import type { JobQueue } from "@petri/jobs";
import { and, asc, desc, eq, gt, inArray, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { ApiError } from "../errors.ts";
import { slugify } from "../slug.ts";

type DeploymentRow = typeof deployments.$inferSelect;
type BuildRow = typeof builds.$inferSelect;

const HOUR_MS = 60 * 60 * 1000;
const MAX_LABEL = 63;

function toDeployment(
	row: DeploymentRow,
	build: BuildRow | undefined,
): Deployment {
	return {
		id: row.id,
		projectId: row.projectId,
		name: row.name,
		subdomain: row.subdomain,
		status: row.status,
		source: row.source,
		build: {
			strategy: row.buildOptions.strategy,
			port: row.internalPort,
			args: row.buildOptions.args,
		},
		lifecycleMode: row.lifecycleMode,
		expiresAt: row.expiresAt?.toISOString() ?? null,
		latestBuild: build
			? {
					id: build.id,
					status: build.status,
					startedAt: build.startedAt?.toISOString() ?? null,
					finishedAt: build.finishedAt?.toISOString() ?? null,
					errorMessage: build.errorMessage,
				}
			: null,
		actions: availableActions(row.status),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/** The most recent build of each given deployment. */
async function latestBuilds(db: Database, deploymentIds: string[]) {
	if (deploymentIds.length === 0) return new Map<string, BuildRow>();
	const rows = await db
		.selectDistinctOn([builds.deploymentId])
		.from(builds)
		.where(inArray(builds.deploymentId, deploymentIds))
		.orderBy(builds.deploymentId, desc(builds.createdAt), desc(builds.id));
	return new Map(rows.map((row) => [row.deploymentId, row]));
}

/** Finds the project by slug, creating it if needed. */
async function ensureProject(tx: Transaction, slug: string) {
	await tx
		.insert(projects)
		.values({ name: slug, slug })
		.onConflictDoNothing({ target: projects.slug });
	const [project] = await tx
		.select({ id: projects.id })
		.from(projects)
		.where(eq(projects.slug, slug));
	if (!project) throw new Error(`project ${slug} vanished`);
	return project;
}

/** "<project>-<name>", or with a random suffix if that is taken. */
async function generateSubdomain(
	tx: Transaction,
	project: string,
	name: string,
) {
	const base =
		slugify(`${project}-${name}`).slice(0, MAX_LABEL).replace(/-+$/, "") ||
		project;
	const candidates = [base];
	for (let i = 0; i < 5; i++) {
		const suffix = randomBytes(3).toString("hex");
		candidates.push(
			`${base.slice(0, MAX_LABEL - 7).replace(/-+$/, "")}-${suffix}`,
		);
	}
	for (const candidate of candidates) {
		const [taken] = await tx
			.select({ id: deployments.id })
			.from(deployments)
			.where(eq(deployments.subdomain, candidate));
		if (!taken) return candidate;
	}
	throw new Error("could not find a free subdomain");
}

export const deploymentRoutes: FastifyPluginAsyncZod<{
	db: Database;
	jobs: JobQueue;
}> = async (app, { db, jobs }) => {
	const tags = ["deployments"];

	app.post(
		"/deployments",
		{
			config: { access: { scope: "deploy:create" } },
			schema: {
				tags,
				summary: "Deploy from a Git repository",
				description:
					"Queues a build and returns immediately. Follow progress with the events endpoint.",
				body: createDeploymentBody,
				response: { 201: deployment, 400: errorResponse, 409: errorResponse },
			},
		},
		async (request, reply) => {
			const body = request.body;
			const name = body.name ?? body.source.ref;
			const expiresAt =
				body.lifecycle.mode === "temporary"
					? new Date(Date.now() + body.lifecycle.ttlHours * HOUR_MS)
					: null;

			try {
				const { row, build } = await withTransaction(db, async (tx) => {
					const project = await ensureProject(tx, body.project);
					const subdomain =
						body.subdomain ?? (await generateSubdomain(tx, body.project, name));

					const [row] = await tx
						.insert(deployments)
						.values({
							projectId: project.id,
							name,
							subdomain,
							source: {
								type: "git",
								repository: body.source.repository,
								ref: body.source.ref,
								...(body.source.directory && {
									directory: body.source.directory,
								}),
							},
							buildOptions: {
								strategy: body.build.strategy,
								args: body.build.args,
							},
							internalPort: body.build.port ?? null,
							lifecycleMode: body.lifecycle.mode,
							expiresAt,
						})
						.returning();
					if (!row) throw new Error("insert returned no row");

					const [build] = await tx
						.insert(builds)
						.values({ deploymentId: row.id })
						.returning();
					if (!build) throw new Error("insert returned no row");

					// Part of this transaction: no deployment without its job,
					// and no job for a deployment that wasn't saved.
					await jobs.send(
						"deployment.run",
						{ deploymentId: row.id, buildId: build.id },
						{ transaction: tx, singletonKey: row.id },
					);

					await tx.insert(deploymentEvents).values({
						deploymentId: row.id,
						type: "status",
						message: "Deployment queued",
						data: { to: "queued" },
					});
					await publishEvent(tx, {
						type: "deployment.created",
						deploymentId: row.id,
						projectId: project.id,
					});
					return { row, build };
				});

				return reply
					.status(201)
					.header("location", `/api/v1/deployments/${row.id}`)
					.send(toDeployment(row, build));
			} catch (error) {
				if (isConstraintViolation(error, "deployments_subdomain_unique")) {
					throw new ApiError(
						409,
						"conflict",
						`The subdomain "${body.subdomain}" is already in use`,
					);
				}
				throw error;
			}
		},
	);

	app.get(
		"/deployments",
		{
			config: { access: { scope: "deploy:read" } },
			schema: {
				tags,
				summary: "List deployments, newest first",
				querystring: listDeploymentsQuery,
				response: { 200: deploymentList },
			},
		},
		async (request) => {
			const filters: SQL[] = [];
			if (request.query.projectId) {
				filters.push(eq(deployments.projectId, request.query.projectId));
			}
			if (request.query.status) {
				filters.push(eq(deployments.status, request.query.status));
			}
			const rows = await db
				.select()
				.from(deployments)
				.where(and(...filters))
				.orderBy(desc(deployments.createdAt), desc(deployments.id));
			const latest = await latestBuilds(
				db,
				rows.map((row) => row.id),
			);
			return {
				items: rows.map((row) => toDeployment(row, latest.get(row.id))),
			};
		},
	);

	app.get(
		"/deployments/:id",
		{
			config: { access: { scope: "deploy:read" } },
			schema: {
				tags,
				summary: "Get a deployment",
				params: idParams,
				response: { 200: deployment, 404: errorResponse },
			},
		},
		async (request) => {
			const [row] = await db
				.select()
				.from(deployments)
				.where(eq(deployments.id, request.params.id));
			if (!row) throw new ApiError(404, "not_found", "Deployment not found");
			const latest = await latestBuilds(db, [row.id]);
			return toDeployment(row, latest.get(row.id));
		},
	);

	app.get(
		"/deployments/:id/events",
		{
			config: { access: { scope: "deploy:read" } },
			schema: {
				tags,
				summary: "A deployment's history, oldest first",
				params: idParams,
				querystring: deploymentEventsQuery,
				response: { 200: deploymentEventList, 404: errorResponse },
			},
		},
		async (request) => {
			const { id } = request.params;
			const [exists] = await db
				.select({ id: deployments.id })
				.from(deployments)
				.where(eq(deployments.id, id));
			if (!exists) throw new ApiError(404, "not_found", "Deployment not found");

			const rows = await db
				.select()
				.from(deploymentEvents)
				.where(
					and(
						eq(deploymentEvents.deploymentId, id),
						request.query.after !== undefined
							? gt(deploymentEvents.id, request.query.after)
							: undefined,
					),
				)
				.orderBy(asc(deploymentEvents.id))
				.limit(request.query.limit);
			return {
				items: rows.map((row) => ({
					id: row.id,
					type: row.type,
					message: row.message,
					data: row.data,
					createdAt: row.createdAt.toISOString(),
				})),
			};
		},
	);
};
