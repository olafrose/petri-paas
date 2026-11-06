import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

// Tables used by Better Auth (apps/api/src/auth). Field names follow its
// data model; see the `schema` mapping passed to its Drizzle adapter.

const id = () => uuid().primaryKey().default(sql`uuidv7()`);

const createdAt = () =>
	timestamp({ withTimezone: true }).notNull().defaultNow();

const updatedAt = () =>
	timestamp({ withTimezone: true })
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date());

/** People who can sign in to the admin panel. In practice: the owner. */
export const users = pgTable("users", {
	id: id(),
	name: text().notNull(),
	email: text().notNull().unique(),
	emailVerified: boolean().notNull().default(false),
	image: text(),
	createdAt: createdAt(),
	updatedAt: updatedAt(),
});

export const sessions = pgTable(
	"sessions",
	{
		id: id(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		token: text().notNull().unique(),
		expiresAt: timestamp({ withTimezone: true }).notNull(),
		ipAddress: text(),
		userAgent: text(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [index().on(table.userId)],
);

/** Sign-in methods of a user: a password, or later an OIDC identity. */
export const accounts = pgTable(
	"accounts",
	{
		id: id(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		accountId: text().notNull(),
		providerId: text().notNull(),
		accessToken: text(),
		refreshToken: text(),
		idToken: text(),
		accessTokenExpiresAt: timestamp({ withTimezone: true }),
		refreshTokenExpiresAt: timestamp({ withTimezone: true }),
		scope: text(),
		/** Password hash, for the "credential" provider. */
		password: text(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [index().on(table.userId)],
);

/** Short-lived values such as OIDC state. */
export const verifications = pgTable(
	"verifications",
	{
		id: id(),
		identifier: text().notNull(),
		value: text().notNull(),
		expiresAt: timestamp({ withTimezone: true }).notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [index().on(table.identifier)],
);

/** Login rate-limit counters, kept in the database so restarts don't reset them. */
export const rateLimits = pgTable("rate_limits", {
	id: id(),
	key: text().notNull().unique(),
	count: integer().notNull(),
	lastRequest: bigint({ mode: "number" }).notNull(),
});
