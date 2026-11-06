import type { Scope } from "@petri/contracts";
import { apiKeys, type Database } from "@petri/database";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { hashApiKey, looksLikeApiKey } from "./api-key-tokens.ts";
import type { Auth } from "./auth/auth.ts";
import { toWebHeaders } from "./auth/bridge.ts";
import { ApiError } from "./errors.ts";

/**
 * Who may call a route:
 * - "public": anyone
 * - "owner": the signed-in owner only (not API keys)
 * - { scope }: the signed-in owner, or an API key with that scope
 *
 * Routes without a rule are treated as "owner".
 */
export type Access = "public" | "owner" | { scope: Scope };

export type Principal =
	| { type: "owner"; userId: string }
	| { type: "apiKey"; apiKeyId: string; scopes: readonly Scope[] };

export interface RouteAccess {
	method: string;
	url: string;
	access: Access;
}

declare module "fastify" {
	interface FastifyContextConfig {
		access?: Access;
	}
	interface FastifyRequest {
		principal: Principal | null;
	}
	interface FastifyInstance {
		/** Every route with its access rule; used by tests and audits. */
		routeAccess: RouteAccess[];
	}
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Routes registered by plugins we don't control. */
const PUBLIC_PREFIXES = ["/api/v1/docs"];

const unauthorized = () =>
	new ApiError(401, "unauthorized", "Sign in or provide an API key");

/**
 * Authenticates every request and enforces each route's `access` rule.
 * Register before any routes.
 */
export function registerAccessControl(
	app: FastifyInstance,
	{ db, auth, publicUrl }: { db: Database; auth: Auth; publicUrl: string },
) {
	const publicOrigin = new URL(publicUrl).origin;
	app.decorateRequest("principal", null);
	app.decorate("routeAccess", []);

	app.addHook("onRoute", (route) => {
		if (!route.config?.access) {
			const isPublicPlugin = PUBLIC_PREFIXES.some((prefix) =>
				route.url.startsWith(prefix),
			);
			route.config = {
				...route.config,
				access: isPublicPlugin ? "public" : "owner",
			};
		}
		const access = route.config.access as Access;
		for (const method of [route.method].flat()) {
			app.routeAccess.push({ method, url: route.url, access });
		}
	});

	app.addHook("onRequest", async (request) => {
		// Unmatched routes (404) have no config.
		const access = request.routeOptions.config.access ?? "public";
		if (access === "public") return;

		const principal = await authenticate(request, db, auth);
		if (!principal) throw unauthorized();
		request.principal = principal;

		if (principal.type === "owner") {
			// Session cookies are sent by browsers automatically, so changes
			// made with one must come from the admin panel itself.
			if (
				!SAFE_METHODS.has(request.method) &&
				request.headers.origin !== publicOrigin
			) {
				throw new ApiError(403, "forbidden", "Cross-origin request rejected");
			}
			return;
		}
		if (access === "owner") {
			throw new ApiError(
				403,
				"forbidden",
				"This action requires signing in; API keys cannot perform it",
			);
		}
		if (!principal.scopes.includes(access.scope)) {
			throw new ApiError(
				403,
				"forbidden",
				`This API key lacks the "${access.scope}" scope`,
			);
		}
	});
}

async function authenticate(
	request: FastifyRequest,
	db: Database,
	auth: Auth,
): Promise<Principal | null> {
	const authorization = request.headers.authorization;
	if (authorization !== undefined) {
		// An Authorization header must hold a valid key; never fall back to
		// the session cookie.
		const [kind, token] = authorization.split(" ");
		if (kind?.toLowerCase() !== "bearer" || !token || !looksLikeApiKey(token)) {
			throw unauthorized();
		}
		return authenticateApiKey(db, token);
	}

	const session = await auth.api.getSession({ headers: toWebHeaders(request) });
	return session ? { type: "owner", userId: session.user.id } : null;
}

async function authenticateApiKey(
	db: Database,
	token: string,
): Promise<Principal | null> {
	const now = new Date();
	const [key] = await db
		.update(apiKeys)
		.set({ lastUsedAt: now })
		.where(
			and(
				eq(apiKeys.keyHash, hashApiKey(token)),
				isNull(apiKeys.revokedAt),
				or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
			),
		)
		.returning({ id: apiKeys.id, scopes: apiKeys.scopes });
	if (!key) return null;
	return { type: "apiKey", apiKeyId: key.id, scopes: key.scopes as Scope[] };
}
