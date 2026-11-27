import { createHash, randomBytes } from "node:crypto";
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
	getDeploymentQuery,
	idParams,
	listDeploymentsQuery,
	redeployBody,
	TTL_HOURS,
	type UpdateDeploymentBody,
	updateDeploymentBody,
} from "@petri/contracts";
import {
	builds,
	type Database,
	type DeploymentSource,
	type DeploymentStatus,
	deploymentEvents,
	deployments,
	type EventListener,
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
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Principal } from "../access.ts";
import { ApiError } from "../errors.ts";
import { slugify } from "../slug.ts";

type DeploymentRow = typeof deployments.$inferSelect;
type BuildRow = typeof builds.$inferSelect;

const HOUR_MS = 60 * 60 * 1000;
const MAX_LABEL = 63;
/**
 * A waiting request answers after this long at the latest, even if
 * asked to wait longer: reverse proxies such as NPM give up on an
 * upstream that is silent for a minute.
 */
const MAX_HOLD_MS = 55_000;
/** Catches changes that published no event (e.g. a build's status). */
const WAIT_POLL_MS = 2000;

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
		provider: build.provider,
		createdAt: build.createdAt.toISOString(),
		startedAt: build.startedAt?.toISOString() ?? null,
		finishedAt: build.finishedAt?.toISOString() ?? null,
		errorMessage: build.errorMessage,
	};
}

/**
 * The deployment's entity tag: it changes with the status or the latest
 * build (a new one, its status, the commit a Git build fetched, or what
 * builds it), what someone following a build waits for, and with its
 * name, address or lifetime: a 304 must not leave anyone with an old URL
 * or expiry. Weak, since other fields may change under the same tag.
 */
export function followTag(deployment: Deployment): string {
	const build = deployment.latestBuild;
	const state = JSON.stringify([
		deployment.status,
		build?.id,
		build?.status,
		build?.commit,
		build?.provider,
		deployment.name,
		deployment.url,
		deployment.lifecycleMode,
		deployment.expiresAt,
	]);
	const hash = createHash("sha256").update(state).digest("base64url");
	return `W/"${hash.slice(0, 16)}"`;
}

/** Sends the deployment with its tag, for a later `If-None-Match`. */
export function sendDeployment(
	reply: FastifyReply,
	status: number,
	deployment: Deployment,
) {
	return reply
		.status(status)
		.header("etag", followTag(deployment))
		.send(deployment);
}

/** Whether an `If-None-Match` header names the tag. */
function matchesTag(header: string | undefined, tag: string) {
	if (!header) return false;
	return header
		.split(",")
		.map((value) => value.trim())
		.some((value) => value === "*" || value === tag);
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

/** Gone, or on the way: nothing about them changes any more. */
const UNCHANGEABLE: readonly DeploymentStatus[] = ["deleting", "deleted"];

/** A history entry for one of the changes, published live too. */
interface ChangeEntry {
	type: "rename" | "move" | "lifecycle";
	message: string;
	data: Record<string, unknown>;
}

/**
 * Changes the deployment's name, subdomain or lifetime, each recorded in
 * its history. A new subdomain moves the preview: the worker routes a
 * ready deployment there (`deployment.route`), and the old address is
 * free for another deployment.
 */
export async function updateDeployment(
	{ db, jobs, previewBaseUrl }: DeploymentDeps,
	deploymentId: string,
	change: UpdateDeploymentBody,
	principal: Principal | null,
): Promise<Deployment> {
	try {
		const row = await withTransaction(db, async (tx) => {
			const [current] = await tx
				.select()
				.from(deployments)
				.where(eq(deployments.id, deploymentId))
				.for("update");
			if (!current) {
				throw new ApiError(404, "not_found", "Deployment not found");
			}
			if (UNCHANGEABLE.includes(current.status)) {
				throw new ApiError(
					409,
					"conflict",
					`A deployment that is "${current.status}" cannot be changed`,
				);
			}
			if (change.lifecycle && current.status === "expired") {
				throw new ApiError(
					409,
					"conflict",
					"This deployment has expired: redeploy it, then change its lifecycle",
				);
			}

			const by = requestedBy(principal);
			const updates: Partial<typeof deployments.$inferInsert> = {};
			const entries: ChangeEntry[] = [];
			if (change.name !== undefined && change.name !== current.name) {
				updates.name = change.name;
				entries.push({
					type: "rename",
					message: `Renamed from "${current.name}" to "${change.name}"`,
					data: { from: current.name, to: change.name, requestedBy: by },
				});
			}
			if (
				change.subdomain !== undefined &&
				change.subdomain !== current.subdomain
			) {
				updates.subdomain = change.subdomain;
				const from = previewUrl(previewBaseUrl, current.subdomain);
				const to = previewUrl(previewBaseUrl, change.subdomain);
				entries.push({
					type: "move",
					message: `Moved from ${from} to ${to}`,
					data: {
						from: current.subdomain,
						to: change.subdomain,
						url: to,
						requestedBy: by,
					},
				});
			}
			if (change.lifecycle) {
				entries.push(lifecycleChange(current, change.lifecycle, updates, by));
			}
			if (entries.length === 0) return current;

			const [updated] = await tx
				.update(deployments)
				.set(updates)
				.where(eq(deployments.id, deploymentId))
				.returning();
			if (!updated) throw new Error("update returned no row");

			for (const entry of entries) {
				const [event] = await tx
					.insert(deploymentEvents)
					.values({ deploymentId, ...entry })
					.returning({ id: deploymentEvents.id });
				if (!event) throw new Error("insert returned no row");
				await publishEvent(tx, {
					type: `deployment.${entry.type}`,
					deploymentId,
					eventId: event.id,
					message: entry.message,
				});
			}
			// Whatever the status: a build or start about to publish the
			// route reads the subdomain under the deployment's lock, and
			// the job, waiting for that lock, catches one that read it
			// just before this commits.
			if (updates.subdomain !== undefined) {
				await jobs.send(
					"deployment.route",
					{ deploymentId },
					{ transaction: tx },
				);
			}
			return updated;
		});
		const latest = await latestBuilds(db, [row.id]);
		return toDeployment(row, latest.get(row.id), previewBaseUrl);
	} catch (error) {
		if (isConstraintViolation(error, "deployments_subdomain_unique")) {
			throw new ApiError(
				409,
				"conflict",
				`The subdomain "${change.subdomain}" is already in use`,
			);
		}
		throw error;
	}
}

/**
 * A new expiry counted from now, or none (permanent): sets it in
 * `updates` and returns its history entry.
 */
function lifecycleChange(
	current: DeploymentRow,
	lifecycle: NonNullable<UpdateDeploymentBody["lifecycle"]>,
	updates: Partial<typeof deployments.$inferInsert>,
	by: ReturnType<typeof requestedBy>,
): ChangeEntry {
	const expiresAt =
		lifecycle.mode === "temporary"
			? new Date(Date.now() + lifecycle.ttlHours * HOUR_MS)
			: null;
	updates.lifecycleMode = lifecycle.mode;
	updates.expiresAt = expiresAt;

	const hours =
		lifecycle.mode === "temporary"
			? `${lifecycle.ttlHours} hour${lifecycle.ttlHours === 1 ? "" : "s"}`
			: "";
	const message =
		lifecycle.mode === "permanent"
			? "Kept: permanent, no expiry"
			: current.lifecycleMode === "permanent"
				? `Temporary again: expires in ${hours}`
				: `Extended: expires in ${hours}`;
	return {
		type: "lifecycle",
		message,
		data: {
			lifecycleMode: lifecycle.mode,
			expiresAt: expiresAt?.toISOString() ?? null,
			requestedBy: by,
		},
	};
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
		// Grown again after its time ran out: another default lifetime, or
		// it would expire again as soon as it is ready.
		const renewed =
			current.expiresAt && current.expiresAt.getTime() <= Date.now()
				? new Date(Date.now() + TTL_HOURS.default * HOUR_MS)
				: null;
		if (renewed) {
			await tx
				.update(deployments)
				.set({ expiresAt: renewed })
				.where(eq(deployments.id, deploymentId));
		}
		const data = {
			action: "redeploy",
			buildId: build.id,
			requestedBy: requestedBy(principal),
			...("ref" in change && change.ref && { ref: change.ref }),
			...(renewed && { expiresAt: renewed.toISOString() }),
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

export const deploymentRoutes: FastifyPluginAsyncZod<
	DeploymentDeps & {
		/** Live events from the worker, to wake waiting requests. */
		events: EventListener;
	}
> = async (app, { events, ...deps }) => {
	const { db, previewBaseUrl } = deps;
	const tags = ["deployments"];

	async function findDeployment(id: string) {
		const [row] = await db
			.select()
			.from(deployments)
			.where(eq(deployments.id, id));
		if (!row) throw new ApiError(404, "not_found", "Deployment not found");
		const latest = await latestBuilds(db, [row.id]);
		return toDeployment(row, latest.get(row.id), previewBaseUrl);
	}

	/**
	 * The deployment once its tag is none of `seen` (default: its tag
	 * now), or as it is when the time is up or the client goes away.
	 * Woken by the deployment's events; polls in case one published none.
	 */
	async function waitForChange(
		id: string,
		seen: string | undefined,
		ms: number,
		reply: FastifyReply,
	) {
		let woken = false;
		let wake = () => {
			woken = true;
		};
		// Subscribed before the first read, so no change falls in between.
		const unsubscribe = events.subscribe((event) => {
			if (event.deploymentId === id) wake();
		});
		let gone = false;
		const onClose = () => {
			gone = true;
			wake();
		};
		reply.raw.once("close", onClose);
		try {
			let current = await findDeployment(id);
			const baseline = seen ?? followTag(current);
			const deadline = Date.now() + ms;
			while (matchesTag(baseline, followTag(current))) {
				const left = deadline - Date.now();
				if (left <= 0 || gone) break;
				if (!woken) {
					await new Promise<void>((resolve) => {
						const timer = setTimeout(done, Math.min(WAIT_POLL_MS, left));
						function done() {
							clearTimeout(timer);
							resolve();
						}
						wake = done;
					});
				}
				woken = false;
				wake = () => {
					woken = true;
				};
				current = await findDeployment(id);
			}
			return current;
		} finally {
			unsubscribe();
			reply.raw.off("close", onClose);
		}
	}

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
			reply.header("location", `/api/v1/deployments/${created.id}`);
			return sendDeployment(reply, 201, created);
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
			if (request.query.project) {
				filters.push(
					inArray(
						deployments.projectId,
						db
							.select({ id: projects.id })
							.from(projects)
							.where(eq(projects.slug, request.query.project)),
					),
				);
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
				description: [
					"The `ETag` header changes with the status, the latest build (a new one, its status, its commit or its provider), the name or `url` (a rename), and the lifetime (`lifecycleMode`, `expiresAt`).",
					"",
					"`wait=<seconds>` (at most 60) follows a build without polling: the answer comes as soon as the tag differs from `If-None-Match` (send the `ETag` of the previous answer), or from the tag when the request arrived if there is none. If nothing changes in time, 304 with the same tag; ask again. The server answers after 55 seconds at the latest.",
					"",
					"Without `wait`, a matching `If-None-Match` answers 304 at once.",
				].join("\n"),
				params: idParams,
				querystring: getDeploymentQuery,
				response: {
					200: deployment,
					304: z.null().meta({ description: "Not changed" }),
					404: errorResponse,
				},
			},
		},
		async (request, reply) => {
			const { id } = request.params;
			const seen = request.headers["if-none-match"];
			const wait = request.query.wait ?? 0;
			const current =
				wait > 0
					? await waitForChange(
							id,
							seen,
							Math.min(wait * 1000, MAX_HOLD_MS),
							reply,
						)
					: await findDeployment(id);
			const tag = followTag(current);
			if (matchesTag(seen, tag)) {
				return reply.status(304).header("etag", tag).send(null);
			}
			return sendDeployment(reply, 200, current);
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

	app.patch(
		"/deployments/:id",
		{
			config: { access: { scope: "deploy:update" } },
			schema: {
				tags,
				summary: "Change a deployment's name, subdomain or lifecycle",
				description: [
					"Send any of the fields; each change goes into the history.",
					"",
					"`name` and `subdomain` follow the same rules as when creating one; a subdomain in use is 409. A new subdomain moves the preview: a `ready` deployment answers there within seconds and no longer at the old address, which is free for another deployment.",
					"",
					"`lifecycle` extends a temporary deployment (`ttlHours` from now, at most 720), makes it permanent, or temporary again. Not for `expired` deployments: redeploy first, which gives it another 48 hours.",
					"",
					"Not for deployments that are `deleting` or `deleted`: 409.",
				].join("\n"),
				params: idParams,
				body: updateDeploymentBody,
				response: {
					200: deployment,
					400: errorResponse,
					404: errorResponse,
					409: errorResponse,
				},
			},
		},
		async (request, reply) => {
			const result = await updateDeployment(
				deps,
				request.params.id,
				request.body,
				request.principal,
			);
			return sendDeployment(reply, 200, result);
		},
	);

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
						"A `ready` deployment stays `ready` and keeps answering while the new version builds; `latestBuild` follows the new build, and the deployment switches to it once it passes its health check. If it fails, the old version keeps running. From `stopped`, `failed` or `expired`, the deployment goes through `queued` as on its first build. A temporary deployment past its time gets another 48 hours.",
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
			return sendDeployment(reply, 202, result);
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
			return sendDeployment(reply, 202, result);
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
			return sendDeployment(reply, 202, result);
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
			return sendDeployment(reply, 202, result);
		},
	);
};
