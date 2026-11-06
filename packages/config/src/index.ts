import { z } from "zod";

/** Variables every petri. service reads. */
export const commonSchema = z.object({
	NODE_ENV: z
		.enum(["development", "test", "production"])
		.default("development"),
	LOG_LEVEL: z
		.enum(["fatal", "error", "warn", "info", "debug", "trace"])
		.default("info"),
});

/** Variables for services that connect to PostgreSQL. */
export const databaseSchema = z.object({
	DATABASE_URL: z
		.url({ protocol: /^postgres(ql)?$/ })
		.describe(
			"PostgreSQL connection string, e.g. postgres://user:pass@host:5432/db",
		),
});

export class ConfigError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(
			`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
		);
		this.name = "ConfigError";
		this.issues = issues;
	}
}

/**
 * Parses environment variables against a schema. Empty values count as
 * unset, so `NAME=` in a .env file or Compose's `${NAME:-}` fall back to
 * the default (or are reported as required).
 *
 * Error messages name the variable and the problem but never include its
 * value, because values may be secrets.
 */
export function loadConfig<Schema extends z.ZodObject>(
	schema: Schema,
	rawEnv: Record<string, string | undefined> = process.env,
): z.infer<Schema> {
	const env = Object.fromEntries(
		Object.entries(rawEnv).filter(([, value]) => value !== ""),
	);
	const result = schema.safeParse(env, { reportInput: false });
	if (result.success) {
		return result.data;
	}
	throw new ConfigError(
		result.error.issues.map((issue) => {
			const name = issue.path.join(".") || "(root)";
			return issue.code === "invalid_type" && env[name] === undefined
				? `${name}: required`
				: `${name}: ${issue.message}`;
		}),
	);
}

/**
 * Like `loadConfig`, but prints the problems and exits the process.
 * Meant for service entry points.
 */
export function loadConfigOrExit<Schema extends z.ZodObject>(
	schema: Schema,
	env: Record<string, string | undefined> = process.env,
): z.infer<Schema> {
	try {
		return loadConfig(schema, env);
	} catch (error) {
		if (error instanceof ConfigError) {
			console.error(error.message);
			process.exit(1);
		}
		throw error;
	}
}
