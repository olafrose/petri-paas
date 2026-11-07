import { open, stat } from "node:fs/promises";
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
import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ApiError } from "../errors.ts";

const KEEPALIVE_MS = 15_000;
/** Catches events whose notification was missed (listener reconnecting). */
const SAFETY_POLL_MS = 5000;
const MAX_LOG_CHUNK = 1024 * 1024;

const notFound = () => new ApiError(404, "not_found", "Deployment not found");

export interface LiveOptions {
	db: Database;
	events: EventListener;
	/** Where the worker writes build logs (shared volume). */
	logsDir: string;
	keepaliveMs?: number;
	safetyPollMs?: number;
}

/** Server-Sent Events for a deployment's history, and its build log. */
export const deploymentLiveRoutes: FastifyPluginAsyncZod<LiveOptions> = async (
	app,
	{
		db,
		events,
		logsDir,
		keepaliveMs = KEEPALIVE_MS,
		safetyPollMs = SAFETY_POLL_MS,
	},
) => {
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
				summary: "A build's log",
				description:
					"Plain text. Pass `offset` (from the `x-log-offset` header of the previous response) to get only what was added since, e.g. to follow a running build.",
				params: idParams,
				querystring: z.object({
					build: z
						.uuid()
						.optional()
						.meta({ description: "Defaults to the latest build" }),
					offset: z.coerce.number().int().min(0).default(0),
				}),
				response: {
					200: z.string().meta({ description: "Log text (text/plain)" }),
					404: errorResponse,
				},
			},
		},
		async (request, reply) => {
			const { id } = request.params;
			const [exists] = await db
				.select({ id: deployments.id })
				.from(deployments)
				.where(eq(deployments.id, id));
			if (!exists) throw notFound();

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
