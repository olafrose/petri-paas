import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
	ConfigError,
	commonSchema,
	databaseSchema,
	loadConfig,
} from "./index.ts";

const schema = commonSchema.extend(databaseSchema.shape);

describe("loadConfig", () => {
	test("applies defaults", () => {
		const config = loadConfig(schema, {
			DATABASE_URL: "postgres://u:p@localhost:5432/petri",
		});
		expect(config).toEqual({
			NODE_ENV: "development",
			LOG_LEVEL: "info",
			DATABASE_URL: "postgres://u:p@localhost:5432/petri",
		});
	});

	test("accepts the postgresql:// scheme", () => {
		expect(
			loadConfig(databaseSchema, {
				DATABASE_URL: "postgresql://localhost/petri",
			}),
		).toEqual({
			DATABASE_URL: "postgresql://localhost/petri",
		});
	});

	test("reports missing variables as required", () => {
		expect(() => loadConfig(schema, {})).toThrow(ConfigError);
		try {
			loadConfig(schema, {});
		} catch (error) {
			expect((error as ConfigError).issues).toEqual(["DATABASE_URL: required"]);
		}
	});

	test("treats empty values as unset", () => {
		expect(
			loadConfig(schema, {
				DATABASE_URL: "postgres://localhost/petri",
				LOG_LEVEL: "",
			}).LOG_LEVEL,
		).toBe("info");
		expect(() => loadConfig(schema, { DATABASE_URL: "" })).toThrow(
			/DATABASE_URL: required/,
		);
	});

	test("rejects non-PostgreSQL URLs", () => {
		expect(() =>
			loadConfig(databaseSchema, { DATABASE_URL: "mysql://localhost/petri" }),
		).toThrow(/DATABASE_URL/);
	});

	test("rejects unknown enum values", () => {
		expect(() => loadConfig(commonSchema, { NODE_ENV: "staging" })).toThrow(
			/NODE_ENV/,
		);
	});

	test("never includes the value in the error", () => {
		const secret = "not-a-url-but-a-s3cret";
		try {
			loadConfig(
				z.object({ DATABASE_URL: databaseSchema.shape.DATABASE_URL }),
				{
					DATABASE_URL: secret,
				},
			);
			expect.unreachable();
		} catch (error) {
			expect((error as Error).message).toContain("DATABASE_URL");
			expect((error as Error).message).not.toContain(secret);
		}
	});
});
