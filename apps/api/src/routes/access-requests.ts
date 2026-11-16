import {
	type AccessRequest,
	accessRequestList,
	accessTokenBody,
	accessTokenResponse,
	createAccessRequestBody,
	createdAccessRequest,
	errorResponse,
	grantAccessRequestBody,
	idParams,
	type Scope,
} from "@petri/contracts";
import {
	accessRequests,
	apiKeys,
	type Database,
	isConstraintViolation,
	withTransaction,
} from "@petri/database";
import { and, count, desc, eq, gt, lt, ne } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
	generateApiKey,
	generatePollToken,
	generateUserCode,
	hashApiKey,
} from "../api-key-tokens.ts";
import { ApiError } from "../errors.ts";
import { DAY_MS, toApiKey } from "./api-keys.ts";

type AccessRequestRow = typeof accessRequests.$inferSelect;

const MINUTE_MS = 60 * 1000;
/** How long a request waits for the owner, and a grant for collection. */
const LIFETIME_MS = 15 * MINUTE_MS;
/** Requests one address may make per window. */
const PER_ADDRESS = 5;
const ADDRESS_WINDOW_MS = 10 * MINUTE_MS;
/** Open requests at a time, so the owner's list can't be flooded. */
const MAX_OPEN = 10;
/** Expired requests are removed after this; collected ones are kept. */
const KEEP_EXPIRED_MS = DAY_MS;

function toAccessRequest(row: AccessRequestRow): AccessRequest {
	return {
		id: row.id,
		name: row.name,
		reason: row.reason,
		scopes: row.scopes as Scope[],
		userCode: row.userCode,
		address: row.address,
		userAgent: row.userAgent,
		createdAt: row.createdAt.toISOString(),
		expiresAt: row.expiresAt.toISOString(),
	};
}

const isOpen = (row: AccessRequestRow, now: Date) =>
	row.status === "pending" && row.expiresAt > now;

const notOpen = () =>
	new ApiError(409, "conflict", "This request is no longer open");

/**
 * Access requests: coding assistants ask for an API key, the owner grants
 * or denies it, and the assistant collects the key with its poll token.
 */
export const accessRequestRoutes: FastifyPluginAsyncZod<{
	db: Database;
	publicUrl: string;
	/** Minimum seconds between polls of one request. */
	pollIntervalSeconds?: number;
}> = async (app, { db, publicUrl, pollIntervalSeconds = 5 }) => {
	const tags = ["access-requests"];

	app.post(
		"/access-requests",
		{
			config: { access: "public" },
			schema: {
				tags,
				summary: "Ask the owner for an API key",
				description:
					"Show `userCode` and `reviewUrl` to your user, then poll POST /access-requests/token with `pollToken` every `interval` seconds until the owner decides.",
				security: [],
				body: createAccessRequestBody,
				response: { 201: createdAccessRequest, 429: errorResponse },
			},
		},
		async (request, reply) => {
			const now = new Date();
			const address = request.ip;
			await db
				.delete(accessRequests)
				.where(
					and(
						lt(
							accessRequests.expiresAt,
							new Date(now.getTime() - KEEP_EXPIRED_MS),
						),
						ne(accessRequests.status, "collected"),
					),
				);

			const [recent] = await db
				.select({ n: count() })
				.from(accessRequests)
				.where(
					and(
						eq(accessRequests.address, address),
						gt(
							accessRequests.createdAt,
							new Date(now.getTime() - ADDRESS_WINDOW_MS),
						),
					),
				);
			if ((recent?.n ?? 0) >= PER_ADDRESS) {
				throw new ApiError(
					429,
					"rate_limited",
					"Too many access requests from this address; try again in a few minutes",
				);
			}
			const [open] = await db
				.select({ n: count() })
				.from(accessRequests)
				.where(
					and(
						eq(accessRequests.status, "pending"),
						gt(accessRequests.expiresAt, now),
					),
				);
			if ((open?.n ?? 0) >= MAX_OPEN) {
				throw new ApiError(
					429,
					"too_many_open",
					"Too many access requests are waiting for the owner; try again later",
				);
			}

			const { name, scopes, reason } = request.body;
			const { token, hash } = generatePollToken();
			const expiresAt = new Date(now.getTime() + LIFETIME_MS);
			// A code collision is unlikely; try a fresh one a few times.
			for (let attempt = 0; ; attempt++) {
				const userCode = generateUserCode();
				try {
					await db.insert(accessRequests).values({
						name,
						reason: reason || null,
						scopes,
						userCode,
						pollTokenHash: hash,
						address,
						userAgent: request.headers["user-agent"] ?? null,
						expiresAt,
					});
				} catch (error) {
					if (
						attempt < 3 &&
						isConstraintViolation(error, "access_requests_userCode_unique")
					) {
						continue;
					}
					throw error;
				}
				const reviewUrl = new URL("/admin/access-requests", publicUrl);
				reviewUrl.searchParams.set("code", userCode);
				return reply.status(201).send({
					userCode,
					reviewUrl: reviewUrl.toString(),
					pollToken: token,
					expiresAt: expiresAt.toISOString(),
					interval: pollIntervalSeconds,
				});
			}
		},
	);

	app.post(
		"/access-requests/token",
		{
			config: { access: "public" },
			schema: {
				tags,
				summary: "Collect the API key, once granted",
				description:
					"Answers `pending` until the owner decides. Once granted, the answer holds the key, exactly once. Polling faster than `interval` answers 429 `slow_down`.",
				security: [],
				body: accessTokenBody,
				response: {
					200: accessTokenResponse,
					404: errorResponse,
					410: errorResponse,
					429: errorResponse,
				},
			},
		},
		async (request) => {
			const now = new Date();
			const [row] = await db
				.select()
				.from(accessRequests)
				.where(
					eq(accessRequests.pollTokenHash, hashApiKey(request.body.pollToken)),
				);
			if (!row) {
				throw new ApiError(404, "not_found", "Unknown poll token");
			}
			if (row.status === "collected") {
				throw new ApiError(
					410,
					"already_collected",
					"The key was already collected; ask for access again if it was lost",
				);
			}
			if (
				row.lastPolledAt &&
				now.getTime() - row.lastPolledAt.getTime() < pollIntervalSeconds * 1000
			) {
				throw new ApiError(
					429,
					"slow_down",
					`Poll at most every ${pollIntervalSeconds} seconds`,
				);
			}
			await db
				.update(accessRequests)
				.set({ lastPolledAt: now })
				.where(eq(accessRequests.id, row.id));

			if (row.status === "denied") return { status: "denied" as const };
			if (row.expiresAt <= now) return { status: "expired" as const };
			if (row.status === "pending") return { status: "pending" as const };

			// Granted: the key is created now, so it is never stored.
			return withTransaction(db, async (tx) => {
				const [collected] = await tx
					.update(accessRequests)
					.set({ status: "collected" })
					.where(
						and(
							eq(accessRequests.id, row.id),
							eq(accessRequests.status, "granted"),
						),
					)
					.returning();
				if (!collected) {
					throw new ApiError(
						410,
						"already_collected",
						"The key was already collected; ask for access again if it was lost",
					);
				}
				const { key, prefix, hash } = generateApiKey();
				const [created] = await tx
					.insert(apiKeys)
					.values({
						name: collected.name,
						scopes: collected.scopes,
						prefix,
						keyHash: hash,
						accessRequestId: collected.id,
						expiresAt: collected.keyExpiresInDays
							? new Date(now.getTime() + collected.keyExpiresInDays * DAY_MS)
							: null,
					})
					.returning();
				if (!created) throw new Error("insert returned no row");
				return { status: "granted" as const, apiKey: toApiKey(created), key };
			});
		},
	);

	// Owner only from here: keys cannot grant keys.
	const config = { access: "owner" } as const;

	app.get(
		"/access-requests",
		{
			config,
			schema: {
				tags,
				summary: "List open access requests, newest first",
				response: { 200: accessRequestList },
			},
		},
		async () => {
			const rows = await db
				.select()
				.from(accessRequests)
				.where(
					and(
						eq(accessRequests.status, "pending"),
						gt(accessRequests.expiresAt, new Date()),
					),
				)
				.orderBy(desc(accessRequests.createdAt), desc(accessRequests.id));
			return { items: rows.map(toAccessRequest) };
		},
	);

	app.post(
		"/access-requests/:id/grant",
		{
			config,
			schema: {
				tags,
				summary: "Grant an access request",
				description:
					"The requester then collects the key within 15 minutes. Scopes can be narrowed, not widened.",
				params: idParams,
				body: grantAccessRequestBody,
				response: {
					204: z.null(),
					400: errorResponse,
					404: errorResponse,
					409: errorResponse,
				},
			},
		},
		async (request, reply) => {
			const now = new Date();
			const row = await find(request.params.id);
			if (!isOpen(row, now)) throw notOpen();

			const requested = row.scopes as Scope[];
			const scopes = request.body.scopes ?? requested;
			const extra = scopes.filter((scope) => !requested.includes(scope));
			if (extra.length > 0) {
				throw new ApiError(400, "validation_failed", "Invalid request body", [
					{
						path: "scopes",
						message: `Not requested: ${extra.join(", ")}`,
					},
				]);
			}
			const [granted] = await db
				.update(accessRequests)
				.set({
					status: "granted",
					scopes,
					keyExpiresInDays: request.body.expiresInDays ?? null,
					decidedAt: now,
					expiresAt: new Date(now.getTime() + LIFETIME_MS),
				})
				.where(
					and(
						eq(accessRequests.id, row.id),
						eq(accessRequests.status, "pending"),
					),
				)
				.returning({ id: accessRequests.id });
			if (!granted) throw notOpen();
			return reply.status(204).send(null);
		},
	);

	app.post(
		"/access-requests/:id/deny",
		{
			config,
			schema: {
				tags,
				summary: "Deny an access request",
				params: idParams,
				response: { 204: z.null(), 404: errorResponse, 409: errorResponse },
			},
		},
		async (request, reply) => {
			const now = new Date();
			const row = await find(request.params.id);
			if (!isOpen(row, now)) throw notOpen();
			const [denied] = await db
				.update(accessRequests)
				.set({ status: "denied", decidedAt: now })
				.where(
					and(
						eq(accessRequests.id, row.id),
						eq(accessRequests.status, "pending"),
					),
				)
				.returning({ id: accessRequests.id });
			if (!denied) throw notOpen();
			return reply.status(204).send(null);
		},
	);

	async function find(id: string): Promise<AccessRequestRow> {
		const [row] = await db
			.select()
			.from(accessRequests)
			.where(eq(accessRequests.id, id));
		if (!row) throw new ApiError(404, "not_found", "Access request not found");
		return row;
	}
};
