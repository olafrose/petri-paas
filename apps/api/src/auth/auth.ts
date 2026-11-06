import {
	accounts,
	type Database,
	rateLimits,
	sessions,
	users,
	verifications,
} from "@petri/database";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins/generic-oauth";

export interface AuthOptions {
	db: Database;
	/** Public URL of the admin panel, e.g. https://petri.example.com. */
	publicUrl: string;
	/** At least 32 random characters; signs session cookies. */
	secret: string;
	/** Optional OpenID Connect provider (Authentik, Authelia, ...). */
	oidc?: {
		issuer: string;
		clientId: string;
		clientSecret: string;
	};
}

/** Provider id of the optional OIDC login. */
export const OIDC_PROVIDER_ID = "oidc";

/**
 * Admin-panel authentication. There is exactly one user, the owner,
 * created with the `owner:set` command; nobody can sign up.
 */
export function createAuth({ db, publicUrl, secret, oidc }: AuthOptions) {
	return betterAuth({
		appName: "petri.",
		baseURL: publicUrl,
		basePath: "/api/v1/auth",
		secret,
		trustedOrigins: [publicUrl],
		telemetry: { enabled: false },
		database: drizzleAdapter(db, {
			provider: "pg",
			schema: {
				user: users,
				session: sessions,
				account: accounts,
				verification: verifications,
				rateLimit: rateLimits,
			},
		}),
		emailAndPassword: {
			enabled: true,
			disableSignUp: true,
			minPasswordLength: 12,
		},
		account: {
			// An OIDC login with the owner's verified email signs in as the
			// owner. Nobody else can get an account (sign-up is disabled).
			accountLinking: { enabled: true, trustedProviders: [OIDC_PROVIDER_ID] },
		},
		rateLimit: {
			enabled: true,
			storage: "database",
			customRules: {
				"/sign-in/email": { window: 60, max: 5 },
			},
		},
		advanced: {
			// Ids come from the database (uuidv7()).
			database: { generateId: false },
			useSecureCookies: publicUrl.startsWith("https://"),
			// Set by our Fastify bridge from the trusted client address.
			ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
		},
		plugins: oidc
			? [
					genericOAuth({
						config: [
							{
								providerId: OIDC_PROVIDER_ID,
								discoveryUrl: new URL(
									".well-known/openid-configuration",
									oidc.issuer.endsWith("/") ? oidc.issuer : `${oidc.issuer}/`,
								).toString(),
								clientId: oidc.clientId,
								clientSecret: oidc.clientSecret,
								scopes: ["openid", "email", "profile"],
								pkce: true,
								disableImplicitSignUp: true,
								disableSignUp: true,
							},
						],
					}),
				]
			: [],
	});
}

export type Auth = ReturnType<typeof createAuth>;
