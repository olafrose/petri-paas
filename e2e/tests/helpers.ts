import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { buildZip } from "../../packages/build-engine/test/zip-writer.ts";

/** Created by scripts/e2e.sh before the tests run. */
export const owner = {
	email: process.env.E2E_OWNER_EMAIL ?? "owner@example.com",
	password: process.env.E2E_OWNER_PASSWORD ?? "end-to-end-password",
};

export async function signIn(page: Page) {
	await page.goto("/login?next=/admin");
	await page.getByLabel("Email").fill(owner.email);
	await page.getByLabel("Password").fill(owner.password);
	await page.getByRole("button", { name: "Sign in" }).click();
	// The path itself: the login page's own URL (?next=/admin) ends the same.
	await expect(page).toHaveURL((url) => url.pathname === "/admin");
}

/** A ZIP archive of the fixture e2e/fixtures/<name>, for an upload field. */
export function fixtureZip(name: string) {
	const dir = new URL(`../fixtures/${name}/`, import.meta.url).pathname;
	const entries = readdirSync(dir).map((file) => ({
		name: `${name}/${file}`,
		data: readFileSync(join(dir, file)),
	}));
	return {
		name: `${name}.zip`,
		mimeType: "application/zip",
		buffer: buildZip([{ name: `${name}/`, mode: 0o040755 }, ...entries]),
	};
}

/** The status stamp next to a deployment page's title. */
export const statusStamp = (page: Page) => page.locator("h1 + span");

/** A name no earlier run used, for projects and subdomains. */
export const unique = (prefix: string) =>
	`${prefix}-${Date.now().toString(36)}`;
