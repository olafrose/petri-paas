import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	check,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

// Columns are named in camelCase here and stored in snake_case
// (`casing: "snake_case"` in the client and in drizzle.config.ts).

/** A lower-case DNS label: used for project slugs and preview subdomains. */
const DNS_LABEL = "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$";

const id = () => uuid().primaryKey().default(sql`uuidv7()`);

const createdAt = () =>
	timestamp({ withTimezone: true }).notNull().defaultNow();

const updatedAt = () =>
	timestamp({ withTimezone: true })
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date());

export const visibility = pgEnum("visibility", ["public", "private"]);

export const deploymentStatus = pgEnum("deployment_status", [
	"queued",
	"cloning",
	"building",
	"deploying",
	"health_check",
	"ready",
	"failed",
	"stopped",
	"expired",
	"deleting",
	/** Resources removed; the row and its history remain. */
	"deleted",
]);

export type DeploymentStatus = (typeof deploymentStatus.enumValues)[number];

export const lifecycleMode = pgEnum("lifecycle_mode", [
	"temporary",
	"permanent",
]);

export const buildStatus = pgEnum("build_status", [
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
]);

export const buildProvider = pgEnum("build_provider", [
	"dockerfile",
	"buildpack",
]);

/** Where a deployment's source comes from. Stored as JSON. */
export type DeploymentSource =
	| {
			type: "git";
			repository: string;
			/** Branch, tag or commit as requested. */
			ref: string;
			/** Commit SHA the ref resolved to, once fetched. */
			commit?: string;
			/** Subdirectory to build from. */
			directory?: string;
	  }
	| {
			type: "zip";
			/** Reference to the stored upload, kept for redeploys. */
			uploadId: string;
			directory?: string;
	  };

/** How to build a deployment. Stored as JSON. */
export interface BuildOptions {
	/** "auto" uses the Dockerfile if present (buildpacks come later). */
	strategy: "auto" | "dockerfile";
	/** Build arguments. Visible in the image; never use them for secrets. */
	args: Record<string, string>;
}

export const projects = pgTable(
	"projects",
	{
		id: id(),
		name: text().notNull(),
		slug: text().notNull().unique(),
		description: text().notNull().default(""),
		notes: text().notNull().default(""),
		visibility: visibility().notNull().default("public"),
		/**
		 * The deployment the public gallery shows. Must belong to this
		 * project; the API enforces that.
		 */
		featuredDeploymentId: uuid().references((): AnyPgColumn => deployments.id, {
			onDelete: "set null",
		}),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		check(
			"projects_slug_format",
			sql`${table.slug} ~ ${sql.raw(`'${DNS_LABEL}'`)}`,
		),
	],
);

export const deployments = pgTable(
	"deployments",
	{
		id: id(),
		projectId: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		name: text().notNull(),
		subdomain: text().notNull().unique(),
		source: jsonb().$type<DeploymentSource>().notNull(),
		buildOptions: jsonb()
			.$type<BuildOptions>()
			.notNull()
			.default({ strategy: "auto", args: {} }),
		status: deploymentStatus().notNull().default("queued"),
		imageId: text(),
		containerId: text(),
		routeId: text(),
		/** Application HTTP port. Null means detect it from the image. */
		internalPort: integer(),
		lifecycleMode: lifecycleMode().notNull(),
		expiresAt: timestamp({ withTimezone: true }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		index().on(table.projectId),
		check(
			"deployments_subdomain_format",
			sql`${table.subdomain} ~ ${sql.raw(`'${DNS_LABEL}'`)}`,
		),
		check(
			"deployments_internal_port_range",
			sql`${table.internalPort} between 1 and 65535`,
		),
		// Temporary deployments expire; permanent ones never do.
		check(
			"deployments_expiry_matches_lifecycle",
			sql`(${table.lifecycleMode} = 'temporary') = (${table.expiresAt} is not null)`,
		),
	],
);

export const builds = pgTable(
	"builds",
	{
		id: id(),
		deploymentId: uuid()
			.notNull()
			.references(() => deployments.id, { onDelete: "cascade" }),
		status: buildStatus().notNull().default("queued"),
		/** Null until the build strategy has been detected. */
		provider: buildProvider(),
		/** Git commit that was built (Git sources only). */
		commit: text(),
		imageId: text(),
		/**
		 * Port the app answers on: the deployment's port, or the one the
		 * image declares. Routes to the app use it.
		 */
		port: integer(),
		/** Path of the stored build log. */
		logPath: text(),
		errorMessage: text(),
		startedAt: timestamp({ withTimezone: true }),
		finishedAt: timestamp({ withTimezone: true }),
		createdAt: createdAt(),
	},
	(table) => [index().on(table.deploymentId)],
);

export const deploymentEvents = pgTable(
	"deployment_events",
	{
		// Sequential, so events of one deployment have a stable order.
		id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		deploymentId: uuid()
			.notNull()
			.references(() => deployments.id, { onDelete: "cascade" }),
		type: text().notNull(),
		message: text().notNull(),
		data: jsonb().$type<Record<string, unknown>>(),
		createdAt: createdAt(),
	},
	(table) => [index().on(table.deploymentId, table.id)],
);

export const apiKeys = pgTable(
	"api_keys",
	{
		id: id(),
		name: text().notNull(),
		/** First characters of the key, shown so keys can be told apart. */
		prefix: text().notNull(),
		/** SHA-256 of the full key. The key itself is never stored. */
		keyHash: text().notNull().unique(),
		scopes: text().array().notNull(),
		lastUsedAt: timestamp({ withTimezone: true }),
		expiresAt: timestamp({ withTimezone: true }),
		revokedAt: timestamp({ withTimezone: true }),
		createdAt: createdAt(),
	},
	(table) => [
		check("api_keys_has_scopes", sql`cardinality(${table.scopes}) > 0`),
	],
);
