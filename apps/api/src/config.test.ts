import { type ConfigError, loadConfig } from "@petri/config";
import { describe, expect, test } from "vitest";
import { apiConfigSchema, oidcOptions } from "./config.ts";

const base = {
	DATABASE_URL: "postgres://petri:petri@localhost:5432/petri",
	PUBLIC_URL: "http://localhost:3000",
	AUTH_SECRET: "x".repeat(32),
};
const oidc = {
	OIDC_ISSUER: "https://auth.example.com/application/o/petri/",
	OIDC_CLIENT_ID: "petri",
	OIDC_CLIENT_SECRET: "secret",
};

describe("apiConfigSchema", () => {
	test("works without OIDC", () => {
		const config = loadConfig(apiConfigSchema, base);
		expect(oidcOptions(config)).toBeUndefined();
		expect(config.TRUST_PROXY).toEqual([]);
	});

	test("enables OIDC when all variables are set", () => {
		const config = loadConfig(apiConfigSchema, { ...base, ...oidc });
		expect(oidcOptions(config)).toEqual({
			issuer: oidc.OIDC_ISSUER,
			clientId: "petri",
			clientSecret: "secret",
		});
	});

	test("names the missing variables when OIDC is partly configured", () => {
		try {
			loadConfig(apiConfigSchema, { ...base, OIDC_ISSUER: oidc.OIDC_ISSUER });
			expect.unreachable();
		} catch (error) {
			expect((error as ConfigError).issues).toEqual([
				"OIDC_CLIENT_ID: Required when any OIDC_* variable is set",
				"OIDC_CLIENT_SECRET: Required when any OIDC_* variable is set",
			]);
		}
	});

	test("empty OIDC variables (as passed by Docker Compose) mean no OIDC", () => {
		const config = loadConfig(apiConfigSchema, {
			...base,
			OIDC_ISSUER: "",
			OIDC_CLIENT_ID: "",
			OIDC_CLIENT_SECRET: "",
		});
		expect(oidcOptions(config)).toBeUndefined();
	});

	test("requires a long enough secret", () => {
		expect(() =>
			loadConfig(apiConfigSchema, { ...base, AUTH_SECRET: "short" }),
		).toThrow(/AUTH_SECRET/);
	});

	test("parses trusted proxies", () => {
		const config = loadConfig(apiConfigSchema, {
			...base,
			TRUST_PROXY: "192.168.1.10, 10.0.0.0/8",
		});
		expect(config.TRUST_PROXY).toEqual(["192.168.1.10", "10.0.0.0/8"]);
	});
});
