import { randomUUID } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	type DeploymentEvent,
	errorResponse,
	idParams,
} from "@petri/contracts";
import {
	builds,
	type Database,
	deploymentEvents,
	deployments,
	type EventListener,
} from "@petri/database";
import {
	type JobQueue,
	RUNTIME_LOGS_READY,
	type RuntimeLogsResult,
	runtimeLogsPath,
	runtimeLogsResult,
} from "@petri/jobs";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ApiError } from "../errors.ts";

const KEEPALIVE_MS = 15_000;
/** Catches events whose notification was missed (listener reconnecting). */
const SAFETY_POLL_MS = 5000;
const MAX_LOG_CHUNK = 1024 * 1024;
/** How long to wait for the worker's answer with an app's output. */
const RUNTIME_LOGS_TIMEOUT_MS = 15_000;
/** How often to look for the answer, in case its event got lost. */
const RUNTIME_LOGS_POLL_MS = 1000;

/** Statuses in which a deployment has no container: no need to ask. */
const NO_CONTAINER: Record<string, string> = {
	queued: "The app hasn't been built yet.",
	cloning: "The app hasn't been built yet.",
	building: "The app is still being built; its build log shows the progress.",
	deleting: "The app is being removed.",
	deleted: "The app was removed with the deployment.",
};

const notFound = () => new ApiError(404, "not_found", "Deployment not found");

export interface LiveOptions {
	db: Database;
	events: EventListener;
	/** Where the worker writes build logs (shared volume). */
	logsDir: string;
	/** Asks the worker for an app's output. */
	jobs: JobQueue;
	keepaliveMs?: number;
	safetyPollMs?: number;
	runtimeLogsTimeoutMs?: number;
}

/** Server-Sent Events for a deployment's history, and its build log. */
export const deploymentLiveRoutes: FastifyPluginAsyncZod<LiveOptions> = async (
	app,
	{
		db,
		events,
		logsDir,
		jobs,
		keepaliveMs = KEEPALIVE_MS,
		safetyPollMs = SAFETY_POLL_MS,
		runtimeLogsTimeoutMs = RUNTIME_LOGS_TIMEOUT_MS,
	},
) => {
	/**
	 * Asks the worker for the app's last lines and waits for its answer:
	 * the event, or the file appearing if the event got lost.
	 */
	async function askWorker(
		deploymentId: string,
		lines: number,
	): Promise<RuntimeLogsResult | null> {
		const requestId = randomUUID();
		const path = runtimeLogsPath(logsDir, requestId);
		const read = () =>
			readFile(path, "utf8").then(
				(text) => runtimeLogsResult.parse(JSON.parse(text)),
				() => null,
			);

		let wake = () => {};
		// Subscribed before sending, so the answer can't come first.
		const unsubscribe = events.subscribe((event) => {
			if (event.type === RUNTIME_LOGS_READY && event.requestId === requestId)
				wake();
		});
		try {
			await jobs.send("deployment.logs", { deploymentId, requestId, lines });
			const deadline = Date.now() + runtimeLogsTimeoutMs;
			while (Date.now() < deadline) {
				const result = await read();
				if (result) return result;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(
						resolve,
						Math.min(RUNTIME_LOGS_POLL_MS, deadline - Date.now()),
					);
					wake = () => {
						clearTimeout(timer);
						resolve();
					};
				});
			}
			return await read();
		} finally {
			unsubscribe();
		}
	}

	const tags = ["deployments"];

	app.get(
		"/deployments/:id/events/stream",
		{
			config: { access: { scope: "deploy:read" } },
			schema: {
				tags,
				summary: "Follow a deployment live (Server-Sent Events)",
				description: [
					"Sends the stored history first, then new entries as they happen,",
					"each exactly once and in order. Every message has an `id`; reconnecting",
					"with `Last-Event-ID` (as browsers do) or `?after=<id>` resumes after it.",
					"Message type `deployment-event`, data: a DeploymentEvent.",
				].join(" "),
				params: idParams,
				querystring: z.object({
					after: z.coerce.number().int().min(0).optional(),
				}),
				response: { 404: errorResponse },
			},
		},
		async (request, reply) => {
			const { id } = request.params;
			const [exists] = await db
				.select({ id: deployments.id })
				.from(deployments)
				.where(eq(deployments.id, id));
			if (!exists) throw notFound();

			const header = Number.parseInt(
				String(request.headers["last-event-id"] ?? ""),
				10,
			);
			let lastId = Number.isFinite(header)
				? header
				: (request.query.after ?? 0);

			reply.hijack();
			const out = reply.raw;
			out.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				// Ask reverse proxies (nginx/NPM) not to buffer the stream.
				"x-accel-buffering": "no",
			});
			out.write(": connected\n\n");

			let closed = false;
			// Sends are chained, so concurrent triggers can't reorder or repeat.
			let sending = Promise.resolve();
			const sendNew = () => {
				sending = sending
					.then(async () => {
						if (closed) return;
						const rows = await db
							.select()
							.from(deploymentEvents)
							.where(
								and(
									eq(deploymentEvents.deploymentId, id),
									gt(deploymentEvents.id, lastId),
								),
							)
							.orderBy(asc(deploymentEvents.id))
							.limit(500);
						for (const row of rows) {
							if (closed) return;
							const event: DeploymentEvent = {
								id: row.id,
								type: row.type,
								message: row.message,
								data: row.data,
								createdAt: row.createdAt.toISOString(),
							};
							out.write(
								`id: ${row.id}\nevent: deployment-event\ndata: ${JSON.stringify(event)}\n\n`,
							);
							lastId = row.id;
						}
						// More than one page waiting: keep going.
						if (rows.length === 500) sendNew();
					})
					.catch((error: unknown) => {
						request.log.warn({ err: error }, "event stream: query failed");
					});
			};

			// Subscribe before the first read, so nothing falls in between.
			const unsubscribe = events.subscribe((event) => {
				if (event.deploymentId === id) sendNew();
			});
			sendNew();
			const keepalive = setInterval(
				() => out.write(": keepalive\n\n"),
				keepaliveMs,
			);
			const safety = setInterval(sendNew, safetyPollMs);

			request.raw.on("close", () => {
				closed = true;
				unsubscribe();
				clearInterval(keepalive);
				clearInterval(safety);
			});
		},
	);

	app.get(
		"/deployments/:id/logs",
		{
			config: { access: { scope: "deploy:read" } },
			schema: {
				tags,
				summary: "A build's log, or the app's output",
				description: [
					"Plain text.",
					"",
					"`source=build` (default): the build's log. Pass `offset` (from the `x-log-offset` header of the previous response) to get only what was added since, e.g. to follow a running build.",
					"",
					"`source=runtime`: the app's last `lines` lines of output (stdout and stderr), each starting with its time in UTC; at most 1 MB. The `x-container-status` header says whether the app is running. A deployment without a container (not built yet, failed, deleted) answers 409 with code `no_container`.",
				].join("\n"),
				params: idParams,
				querystring: z.object({
					source: z.enum(["build", "runtime"]).default("build"),
					build: z
						.uuid()
						.optional()
						.meta({ description: "Build log: defaults to the latest build" }),
					offset: z.coerce
						.number()
						.int()
						.min(0)
						.default(0)
						.meta({ description: "Build log: where to continue" }),
					lines: z.coerce
						.number()
						.int()
						.min(1)
						.max(1000)
						.default(200)
						.meta({ description: "App output: how many of the last lines" }),
				}),
				response: {
					200: z.string().meta({ description: "Log text (text/plain)" }),
					404: errorResponse,
					409: errorResponse,
					503: errorResponse,
				},
			},
		},
		async (request, reply) => {
			const { id } = request.params;
			const [exists] = await db
				.select({ id: deployments.id, status: deployments.status })
				.from(deployments)
				.where(eq(deployments.id, id));
			if (!exists) throw notFound();

			if (request.query.source === "runtime") {
				const known = NO_CONTAINER[exists.status];
				if (known) throw new ApiError(409, "no_container", known);
				const result = await askWorker(id, request.query.lines);
				if (!result) {
					throw new ApiError(
						503,
						"worker_unavailable",
						"The worker didn't answer in time. Is it running?",
					);
				}
				if (!result.container) {
					throw new ApiError(
						409,
						"no_container",
						exists.status === "failed"
							? "The app isn't there anymore: it was removed when the deployment failed. Its last output is in the build log."
							: "The app has no container right now.",
					);
				}
				return reply
					.serializer((payload) => String(payload))
					.header("content-type", "text/plain; charset=utf-8")
					.header("x-container-status", result.container.status)
					.header("x-log-truncated", String(result.truncated))
					.send(result.text);
			}

			const [build] = await db
				.select({ id: builds.id })
				.from(builds)
				.where(
					and(
						eq(builds.deploymentId, id),
						request.query.build
							? eq(builds.id, request.query.build)
							: undefined,
					),
				)
				.orderBy(desc(builds.createdAt), desc(builds.id))
				.limit(1);
			if (!build) throw new ApiError(404, "not_found", "Build not found");

			// The path comes from the build id, never from stored data.
			const path = join(logsDir, `${build.id}.log`);
			const size = await stat(path).then(
				(info) => info.size,
				() => 0,
			);
			const offset = Math.min(request.query.offset, size);
			const length = Math.min(size - offset, MAX_LOG_CHUNK);
			let text = "";
			if (length > 0) {
				const file = await open(path, "r");
				try {
					const buffer = Buffer.alloc(length);
					await file.read(buffer, 0, length, offset);
					text = buffer.toString("utf8");
				} finally {
					await file.close();
				}
			}
			return (
				reply
					// Plain text, not JSON-encoded.
					.serializer((payload) => String(payload))
					.header("content-type", "text/plain; charset=utf-8")
					.header("x-log-offset", String(offset + length))
					.header("x-build-id", build.id)
					.send(text)
			);
		},
	);
};
