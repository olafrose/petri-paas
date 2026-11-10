import { tmpdir } from "node:os";
import { join } from "node:path";
import { commonSchema, databaseSchema, previewSchema } from "@petri/config";
import { z } from "zod";

const OIDC_VARIABLES = [
	"OIDC_ISSUER",
	"OIDC_CLIENT_ID",
	"OIDC_CLIENT_SECRET",
] as const;

export const apiConfigSchema = commonSchema
	.extend(databaseSchema.shape)
	.extend(previewSchema.shape)
	.extend({
		/** Defaults to loopback; set to 0.0.0.0 inside a container. */
		API_HOST: z.string().default("127.0.0.1"),
		API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
		/** Public URL of the admin panel; used for cookies and redirects. */
		PUBLIC_URL: z.url({ protocol: /^https?$/ }),
		/** Signs session cookies. Generate with `openssl rand -base64 32`. */
		AUTH_SECRET: z.string().min(32, "Must be at least 32 characters"),
		/**
		 * Comma-separated addresses/CIDRs of reverse proxies whose
		 * X-Forwarded-For is trusted. Empty: trust none.
		 */
		TRUST_PROXY: z
			.string()
			.default("")
			.transform((value) =>
				value
					.split(",")
					.map((entry) => entry.trim())
					.filter(Boolean),
			),
		/**
		 * Where uploaded ZIP archives are kept (shared with the worker).
		 * The default suits development only: it may be cleared on reboot.
		 */
		UPLOADS_DIR: z.string().default(join(tmpdir(), "petri-uploads")),
		/** Build logs written by the worker (shared, read-only here). */
		LOGS_DIR: z.string().default(join(tmpdir(), "petri-logs")),
		/** The commit the image was built from; set in the image by CI. */
		PETRI_COMMIT: z.string().min(1).optional(),
		OIDC_ISSUER: z.url().optional(),
		OIDC_CLIENT_ID: z.string().min(1).optional(),
		OIDC_CLIENT_SECRET: z.string().min(1).optional(),
	})
	.superRefine((config, ctx) => {
		const set = OIDC_VARIABLES.filter((name) => config[name] !== undefined);
		if (set.length === 0 || set.length === OIDC_VARIABLES.length) return;
		for (const name of OIDC_VARIABLES) {
			if (config[name] === undefined) {
				ctx.addIssue({
					code: "custom",
					path: [name],
					message: "Required when any OIDC_* variable is set",
				});
			}
		}
	});

export type ApiConfig = z.infer<typeof apiConfigSchema>;

export function oidcOptions(config: ApiConfig) {
	const { OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET } = config;
	return OIDC_ISSUER && OIDC_CLIENT_ID && OIDC_CLIENT_SECRET
		? {
				issuer: OIDC_ISSUER,
				clientId: OIDC_CLIENT_ID,
				clientSecret: OIDC_CLIENT_SECRET,
			}
		: undefined;
}
