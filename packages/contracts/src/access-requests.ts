import { z } from "zod";
import { apiKey, scope } from "./api-keys.ts";

/**
 * Access requests: a coding assistant asks for an API key, the owner
 * grants or denies it in the admin panel, and the assistant collects the
 * key with its poll token. Modelled on the OAuth device authorization
 * grant (RFC 8628).
 */

const uniqueScopes = z
	.array(scope)
	.min(1)
	.refine((scopes) => new Set(scopes).size === scopes.length, {
		message: "Scopes must not repeat",
	});

export const createAccessRequestBody = z
	.object({
		name: z
			.string()
			.trim()
			.min(1)
			.max(100)
			.meta({
				description: "Who is asking, shown to the owner",
				examples: ["Claude Code on laptop"],
			}),
		scopes: uniqueScopes,
		reason: z
			.string()
			.trim()
			.max(500)
			.optional()
			.meta({ description: "Why access is needed, shown to the owner" }),
	})
	.strict()
	.meta({ id: "CreateAccessRequest" });

export type CreateAccessRequestBody = z.infer<typeof createAccessRequestBody>;

export const createdAccessRequest = z
	.object({
		userCode: z.string().meta({
			description:
				"Show this to your user: the owner checks it matches before granting",
			examples: ["WXYZ-BCDF"],
		}),
		reviewUrl: z.url().meta({
			description: "Where the owner reviews the request; show it to your user",
		}),
		pollToken: z.string().meta({
			description:
				"Secret: send it to POST /access-requests/token to collect the key. Don't show it.",
		}),
		expiresAt: z.iso.datetime(),
		interval: z.number().int().meta({
			description: "Seconds to wait between polls",
		}),
	})
	.meta({ id: "CreatedAccessRequest" });

export type CreatedAccessRequest = z.infer<typeof createdAccessRequest>;

export const accessTokenBody = z
	.object({ pollToken: z.string().min(1).max(200) })
	.strict()
	.meta({ id: "AccessTokenRequest" });

export const accessTokenResponse = z
	.discriminatedUnion("status", [
		z.object({ status: z.literal("pending") }),
		z.object({ status: z.literal("denied") }),
		z.object({ status: z.literal("expired") }),
		z.object({
			status: z.literal("granted"),
			apiKey,
			key: z.string().meta({
				description:
					"The API key, given out only once; send it as `Authorization: Bearer <key>`.",
			}),
		}),
	])
	.meta({ id: "AccessToken" });

export type AccessTokenResponse = z.infer<typeof accessTokenResponse>;

/** An open request, as the owner reviews it. */
export const accessRequest = z
	.object({
		id: z.uuid(),
		name: z.string(),
		reason: z.string().nullable(),
		scopes: z.array(scope),
		userCode: z.string(),
		address: z.string().meta({ description: "Where the request came from" }),
		userAgent: z.string().nullable(),
		createdAt: z.iso.datetime(),
		expiresAt: z.iso.datetime(),
	})
	.meta({ id: "AccessRequest" });

export type AccessRequest = z.infer<typeof accessRequest>;

export const accessRequestList = z
	.object({ items: z.array(accessRequest) })
	.meta({ id: "AccessRequestList" });

export type AccessRequestList = z.infer<typeof accessRequestList>;

export const grantAccessRequestBody = z
	.object({
		scopes: uniqueScopes.optional().meta({
			description: "Some of the requested scopes; omit to grant all",
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
	.meta({ id: "GrantAccessRequest" });

export type GrantAccessRequestBody = z.infer<typeof grantAccessRequestBody>;
