import {
	type ApiKey,
	apiKey,
	apiKeyList,
	createApiKeyBody,
	createdApiKey,
	errorResponse,
	idParams,
	type Scope,
} from "@petri/contracts";
import { apiKeys, type Database } from "@petri/database";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { generateApiKey } from "../api-key-tokens.ts";
import { ApiError } from "../errors.ts";

type ApiKeyRow = typeof apiKeys.$inferSelect;

export function toApiKey(row: ApiKeyRow): ApiKey {
	return {
		id: row.id,
		name: row.name,
		prefix: row.prefix,
		scopes: row.scopes as Scope[],
		createdAt: row.createdAt.toISOString(),
		lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
		expiresAt: row.expiresAt?.toISOString() ?? null,
		revokedAt: row.revokedAt?.toISOString() ?? null,
		accessRequestId: row.accessRequestId,
	};
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * API key management. Owner only: keys cannot manage keys, but each may
 * look at itself.
 */
export const apiKeyRoutes: FastifyPluginAsyncZod<{ db: Database }> = async (
	app,
	{ db },
) => {
	const tags = ["api-keys"];
	const config = { access: "owner" } as const;

	app.post(
		"/api-keys",
		{
			config,
			schema: {
				tags,
				summary: "Create an API key",
				body: createApiKeyBody,
				response: { 201: createdApiKey, 400: errorResponse },
			},
		},
		async (request, reply) => {
			const { name, scopes, expiresInDays } = request.body;
			const { key, prefix, hash } = generateApiKey();
			const [row] = await db
				.insert(apiKeys)
				.values({
					name,
					scopes,
					prefix,
					keyHash: hash,
					expiresAt: expiresInDays
						? new Date(Date.now() + expiresInDays * DAY_MS)
						: null,
				})
				.returning();
			if (!row) throw new Error("insert returned no row");
			return reply.status(201).send({ apiKey: toApiKey(row), key });
		},
	);

	app.get(
		"/api-keys",
		{
			config,
			schema: {
				tags,
				summary: "List API keys, newest first",
				response: { 200: apiKeyList },
			},
		},
		async () => {
			const rows = await db
				.select()
				.from(apiKeys)
				.orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
			return { items: rows.map(toApiKey) };
		},
	);

	app.get(
		"/api-keys/current",
		{
			config: { access: "apiKey" },
			schema: {
				tags,
				summary: "The API key making this request",
				description:
					"Its name, scopes and expiry, so a coding assistant can check what it may do before trying. Any key may ask; a signed-in owner gets 403.",
				response: { 200: apiKey },
			},
		},
		async (request) => {
			const principal = request.principal;
			if (principal?.type !== "apiKey") throw new Error("not an API key");
			const [row] = await db
				.select()
				.from(apiKeys)
				.where(eq(apiKeys.id, principal.apiKeyId));
			if (!row) throw new Error(`API key ${principal.apiKeyId} vanished`);
			return toApiKey(row);
		},
	);

	app.delete(
		"/api-keys/:id",
		{
			config,
			schema: {
				tags,
				summary: "Revoke an API key",
				description: "Revoked keys stay listed. Revoking twice is harmless.",
				params: idParams,
				response: { 200: apiKey, 404: errorResponse },
			},
		},
		async (request) => {
			const { id } = request.params;
			const [revoked] = await db
				.update(apiKeys)
				.set({ revokedAt: new Date() })
				.where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
				.returning();
			if (revoked) return toApiKey(revoked);

			const [existing] = await db
				.select()
				.from(apiKeys)
				.where(eq(apiKeys.id, id));
			if (!existing) throw new ApiError(404, "not_found", "API key not found");
			return toApiKey(existing);
		},
	);
};
