import { z } from "zod";

/**
 * What an API key may do. Project and deployment routes share these
 * scopes: managing projects is part of deploying.
 */
export const scope = z.enum([
	"deploy:read",
	"deploy:create",
	"deploy:update",
	"deploy:delete",
]);

export type Scope = z.infer<typeof scope>;

export const apiKey = z
	.object({
		id: z.uuid(),
		name: z.string(),
		prefix: z
			.string()
			.meta({ description: "Start of the key, to tell keys apart" }),
		scopes: z.array(scope),
		createdAt: z.iso.datetime(),
		lastUsedAt: z.iso.datetime().nullable(),
		expiresAt: z.iso.datetime().nullable(),
		revokedAt: z.iso.datetime().nullable(),
	})
	.meta({ id: "ApiKey" });

export type ApiKey = z.infer<typeof apiKey>;

export const createApiKeyBody = z
	.object({
		name: z.string().trim().min(1).max(100),
		scopes: z
			.array(scope)
			.min(1)
			.refine((scopes) => new Set(scopes).size === scopes.length, {
				message: "Scopes must not repeat",
			}),
		expiresInDays: z
			.number()
			.int()
			.min(1)
			.max(3650)
			.optional()
			.meta({ description: "Omit for a key that does not expire" }),
	})
	.strict()
	.meta({ id: "CreateApiKey" });

export type CreateApiKeyBody = z.infer<typeof createApiKeyBody>;

export const createdApiKey = z
	.object({
		apiKey,
		key: z.string().meta({
			description:
				"The secret key. Shown only once; send it as `Authorization: Bearer <key>`.",
		}),
	})
	.meta({ id: "CreatedApiKey" });

export type CreatedApiKey = z.infer<typeof createdApiKey>;

export const apiKeyList = z
	.object({ items: z.array(apiKey) })
	.meta({ id: "ApiKeyList" });

export type ApiKeyList = z.infer<typeof apiKeyList>;
