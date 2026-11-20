import { randomBytes } from "node:crypto";
import {
	type BuildSummary,
	buildList,
	type CreateDeploymentBody,
	createDeploymentBody,
	type Deployment,
	deployment,
	deploymentEventList,
	deploymentEventsQuery,
	deploymentList,
	errorResponse,
	idParams,
	listDeploymentsQuery,
	redeployBody,
} from "@petri/contracts";
import {
	builds,
	type Database,
	type DeploymentSource,
	deploymentEvents,
	deployments,
	isConstraintViolation,
	projects,
	publishEvent,
	type Transaction,
	withTransaction,
} from "@petri/database";
import {
	actionTarget,
	availableActions,
	canPerform,
	changeStatus,
	type DeploymentAction,
	previewUrl,
	recordBuildEvent,
} from "@petri/deployment-core";
import type { JobName, JobQueue } from "@petri/jobs";
import { and, asc, desc, eq, gt, inArray, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Principal } from "../access.ts";
import { ApiError } from "../errors.ts";
import { slugify } from "../slug.ts";

type DeploymentRow = typeof deployments.$inferSelect;
type BuildRow = typeof builds.$inferSelect;

const HOUR_MS = 60 * 60 * 1000;
const MAX_LABEL = 63;

/** What the deployment routes and functions work with. */
export interface DeploymentDeps {
	db: Database;
	jobs: JobQueue;
	/** Previews are served at <subdomain>.<this URL's host>. */
	previewBaseUrl: string;
}

function toDeployment(
	row: DeploymentRow,
	build: BuildRow | undefined,
	previewBaseUrl: string,
): Deployment {
	return {
		id: row.id,
		projectId: row.projectId,
		name: row.name,
		subdomain: row.subdomain,
		url: previewUrl(previewBaseUrl, row.subdomain),
		status: row.status,
		source: row.source,
		build: {
			strategy: row.buildOptions.strategy,
			port: row.internalPort,
			args: row.buildOptions.args,
		},
		lifecycleMode: row.lifecycleMode,
		expiresAt: row.expiresAt?.toISOString() ?? null,
		latestBuild: build ? toBuild(row, build) : null,
		// One build at a time: no redeploy while one is queued or running.
		actions: availableActions(row.status).filter(
			(action) =>
				action !== "redeploy" ||
				(build?.status !== "queued" && build?.status !== "running"),
		),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function toBuild(row: DeploymentRow, build: BuildRow): BuildSummary {
	// Builds from before redeploys built the deployment's own source.
	const source = build.source ?? row.source;
	return {
		id: build.id,
		status: build.status,
		ref: source.type === "git" ? source.ref : null,
		commit: build.commit,
		createdAt: build.createdAt.toISOString(),
		startedAt: build.startedAt?.toISOString() ?? null,
		finishedAt: build.finishedAt?.toISOString() ?? null,
		errorMessage: build.errorMessage,
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
	const find = () =>
		tx
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.slug, slug))
			.then(([row]) => row);
	// Looked up first: an insert that hits the conflict would still use up
	// an experiment number.
	const existing = await find();
	if (existing) return existing;
	await tx
		.insert(projects)
		.values({ name: slug, slug })
		.onConflictDoNothing({ target: projects.slug });
	const project = await find();
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

export interface NewDeployment {
	project: string;
	name: string;
	subdomain?: string | undefined;
	source: DeploymentSource;
	build: CreateDeploymentBody["build"];
	lifecycle: CreateDeploymentBody["lifecycle"];
}

/**
 * Creates a deployment with its first build and queues its job, all in one
 * transaction: no deployment without its job, and no job for a deployment
 * that wasn't saved.
 */
export async function createDeployment(
	{ db, jobs, previewBaseUrl }: DeploymentDeps,
	input: NewDeployment,
): Promise<Deployment> {
	const expiresAt =
		input.lifecycle.mode === "temporary"
			? new Date(Date.now() + input.lifecycle.ttlHours * HOUR_MS)
			: null;
	try {
		const { row, build } = await withTransaction(db, async (tx) => {
			const project = await ensureProject(tx, input.project);
			const subdomain =
				input.subdomain ??
				(await generateSubdomain(tx, input.project, input.name));

			const [row] = await tx
				.insert(deployments)
				.values({
					projectId: project.id,
					name: input.name,
					subdomain,
					source: input.source,
					buildOptions: {
						strategy: input.build.strategy,
						args: input.build.args,
					},
					internalPort: input.build.port ?? null,
					lifecycleMode: input.lifecycle.mode,
					expiresAt,
				})
				.returning();
			if (!row) throw new Error("insert returned no row");

			const [build] = await tx
				.insert(builds)
				.values({ deploymentId: row.id, source: input.source })
				.returning();
			if (!build) throw new Error("insert returned no row");

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
		return toDeployment(row, build, previewBaseUrl);
	} catch (error) {
		if (isConstraintViolation(error, "deployments_subdomain_unique")) {
			throw new ApiError(
				409,
				"conflict",
				`The subdomain "${input.subdomain}" is already in use`,
			);
		}
		throw error;
	}
}

/** The owner's actions handled here, with the job doing the work. */
type LifecycleAction = Exclude<DeploymentAction, "redeploy">;

const ACTIONS: Record<
	LifecycleAction,
	{ job: JobName; message: string; done: string }
> = {
	stop: { job: "deployment.stop", message: "Stopped", done: "stopped" },
	start: {
		job: "deployment.start",
		message: "Starting the app",
		done: "started",
	},
	delete: { job: "deployment.delete", message: "Deleting", done: "deleted" },
};

/**
 * Applies an action: the new status, its history entry and the job that
 * carries it out, in one transaction. Refused unless the deployment's
 * current status offers the action.
 */
async function performAction(
	{ db, jobs, previewBaseUrl }: DeploymentDeps,
	deploymentId: string,
	action: LifecycleAction,
	principal: Principal | null,
): Promise<Deployment> {
	const row = await withTransaction(db, async (tx) => {
		const [current] = await tx
			.select({ status: deployments.status })
			.from(deployments)
			.where(eq(deployments.id, deploymentId))
			.for("update");
		if (!current) throw new ApiError(404, "not_found", "Deployment not found");
		if (!canPerform(action, current.status)) {
			throw new ApiError(
				409,
				"conflict",
				`A deployment that is "${current.status}" cannot be ${ACTIONS[action].done}`,
			);
		}

		await changeStatus(tx, deploymentId, actionTarget(action), {
			message: ACTIONS[action].message,
			data: { action, requestedBy: requestedBy(principal) },
		});
		await jobs.send(ACTIONS[action].job, { deploymentId }, { transaction: tx });
		const [updated] = await tx
			.select()
			.from(deployments)
			.where(eq(deployments.id, deploymentId));
		return updated as DeploymentRow;
	});
	const latest = await latestBuilds(db, [row.id]);
	return toDeployment(row, latest.get(row.id), previewBaseUrl);
}

/** What a redeploy changes: the Git ref, or the archive (ZIP). */
export type RedeployChange =
	| { ref?: string | undefined }
	| { uploadId: string };

/**
 * Queues a new build of the deployment from its source, or from a new
 * ref or archive, which become its source once the build is live.
 *
 * A ready deployment stays ready: the new version is built next to it
 * (see the worker's deployment-run.ts). Any other goes through `queued`.
 * One build at a time.
 */
export async function redeployDeployment(
	{ db, jobs, previewBaseUrl }: DeploymentDeps,
	deploymentId: string,
	change: RedeployChange,
	principal: Principal | null,
): Promise<Deployment> {
	const { row, build } = await withTransaction(db, async (tx) => {
		const [current] = await tx
			.select()
			.from(deployments)
			.where(eq(deployments.id, deploymentId))
			.for("update");
		if (!current) throw new ApiError(404, "not_found", "Deployment not found");
		const source = redeploySource(current.source, change);
		if (!canPerform("redeploy", current.status)) {
			throw new ApiError(
				409,
				"conflict",
				`A deployment that is "${current.status}" cannot be redeployed`,
			);
		}
		const [running] = await tx
			.select({ id: builds.id })
			.from(builds)
			.where(
				and(
					eq(builds.deploymentId, deploymentId),
					inArray(builds.status, ["queued", "running"]),
				),
			);
		if (running) {
			throw new ApiError(
				409,
				"conflict",
				"A build of this deployment is already running; wait for it to end",
			);
		}

		const [build] = await tx
			.insert(builds)
			.values({ deploymentId, source })
			.returning();
		if (!build) throw new Error("insert returned no row");
		const data = {
			action: "redeploy",
			buildId: build.id,
			requestedBy: requestedBy(principal),
			...("ref" in change && change.ref && { ref: change.ref }),
		};
		if (current.status === "ready") {
			await recordBuildEvent(tx, deploymentId, {
				message: "Redeploy requested",
				data,
			});
		} else {
			await changeStatus(tx, deploymentId, "queued", {
				message: "Redeploy requested",
				data,
			});
		}
		await jobs.send(
			"deployment.run",
			{ deploymentId, buildId: build.id },
			{ transaction: tx, singletonKey: deploymentId },
		);
		const [row] = await tx
			.select()
			.from(deployments)
			.where(eq(deployments.id, deploymentId));
		return { row: row as DeploymentRow, build };
	});
	return toDeployment(row, build, previewBaseUrl);
}

/**
 * The source a redeploy builds. Checked before anything else, so a
 * request that can never work says so.
 */
export function redeploySource(
	source: DeploymentSource,
	change: RedeployChange,
): DeploymentSource {
	if ("uploadId" in change) {
		if (source.type !== "zip") {
			throw new ApiError(
				409,
				"conflict",
				"This deployment is built from Git: redeploy it instead of uploading an archive",
			);
		}
		return { ...source, uploadId: change.uploadId };
	}
	if (change.ref === undefined) return source;
	if (source.type !== "git") {
		throw new ApiError(
			409,
			"conflict",
			"This deployment is built from a ZIP archive, which has no ref: upload a new archive instead",
		);
	}
	return { ...source, ref: change.ref };
}

/** Who asked, for the history. */
function requestedBy(principal: Principal | null) {
	if (principal?.type === "apiKey") {
		return { type: "apiKey", apiKeyId: principal.apiKeyId };
	}
	return { type: "owner" };
}

export const deploymentRoutes: FastifyPluginAsyncZod<DeploymentDeps> = async (
	app,
	deps,
) => {
	const { db, previewBaseUrl } = deps;
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
			const created = await createDeployment(deps, {
				project: body.project,
				name: body.name ?? body.source.ref,
				subdomain: body.subdomain,
				source: {
					type: "git",
					repository: body.source.repository,
					ref: body.source.ref,
					...(body.source.directory && { directory: body.source.directory }),
				},
				build: body.build,
				lifecycle: body.lifecycle,
			});
			return reply
				.status(201)
				.header("location", `/api/v1/deployments/${created.id}`)
				.send(created);
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
				items: rows.map((row) =>
					toDeployment(row, latest.get(row.id), previewBaseUrl),
				),
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
			return toDeployment(row, latest.get(row.id), previewBaseUrl);
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

	app.get(
		"/deployments/:id/builds",
		{
			config: { access: { scope: "deploy:read" } },
			schema: {
				tags,
				summary: "A deployment's builds, newest first",
				params: idParams,
				response: { 200: buildList, 404: errorResponse },
			},
		},
		async (request) => {
			const [row] = await db
				.select()
				.from(deployments)
				.where(eq(deployments.id, request.params.id));
			if (!row) throw new ApiError(404, "not_found", "Deployment not found");
			const rows = await db
				.select()
				.from(builds)
				.where(eq(builds.deploymentId, row.id))
				.orderBy(desc(builds.createdAt), desc(builds.id));
			return { items: rows.map((build) => toBuild(row, build)) };
		},
	);

	const actionSchema = (summary: string, description: string) => ({
		tags,
		summary,
		description,
		params: idParams,
		response: { 202: deployment, 404: errorResponse, 409: errorResponse },
	});

	app.post(
		"/deployments/:id/redeploy",
		{
			config: { access: { scope: "deploy:update" } },
			schema: {
				...actionSchema(
					"Build a deployment again",
					[
						"Builds the deployment again from its source, as a new build in its history: Git fetches the ref again (a branch picks up new commits), or `ref` changes it. For a new ZIP archive, use the upload endpoint.",
						"",
						"A `ready` deployment stays `ready` and keeps answering while the new version builds; `latestBuild` follows the new build, and the deployment switches to it once it passes its health check. If it fails, the old version keeps running. From `stopped`, `failed` or `expired`, the deployment goes through `queued` as on its first build.",
						"",
						"One build at a time: 409 while one is queued or running.",
					].join("\n"),
				),
				// No body at all is fine too (Fastify reads it as null).
				body: redeployBody.nullish(),
			},
		},
		async (request, reply) => {
			const result = await redeployDeployment(
				deps,
				request.params.id,
				{ ref: request.body?.ref },
				request.principal,
			);
			return reply.status(202).send(result);
		},
	);

	app.post(
		"/deployments/:id/stop",
		{
			config: { access: { scope: "deploy:update" } },
			schema: actionSchema(
				"Stop a deployment",
				"Stops the app; its container and image are kept, so starting it again needs no rebuild. Only from `ready`.",
			),
		},
		async (request, reply) => {
			const result = await performAction(
				deps,
				request.params.id,
				"stop",
				request.principal,
			);
			return reply.status(202).send(result);
		},
	);

	app.post(
		"/deployments/:id/start",
		{
			config: { access: { scope: "deploy:update" } },
			schema: actionSchema(
				"Start a stopped deployment",
				"Starts the app again without a rebuild and health-checks it, as on its first start. Only from `stopped`. Follow progress with the events endpoint.",
			),
		},
		async (request, reply) => {
			const result = await performAction(
				deps,
				request.params.id,
				"start",
				request.principal,
			);
			return reply.status(202).send(result);
		},
	);

	app.delete(
		"/deployments/:id",
		{
			config: { access: { scope: "deploy:delete" } },
			schema: actionSchema(
				"Delete a deployment",
				"Removes the app's container, network and image, and a running build. The deployment stays listed with its history, as `deleted`.",
			),
		},
		async (request, reply) => {
			const result = await performAction(
				deps,
				request.params.id,
				"delete",
				request.principal,
			);
			return reply.status(202).send(result);
		},
	);
};
