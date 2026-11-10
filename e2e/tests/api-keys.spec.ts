import { expect, test } from "@playwright/test";
import { unique } from "./helpers.ts";

test("create an API key, use it, and revoke it", async ({
	page,
	context,
	playwright,
	baseURL,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const name = unique("assistant");
	await page.goto("/admin");
	await page.getByRole("link", { name: "API keys" }).click();
	await page.getByLabel("Name").fill(name);
	await page.getByLabel(/deploy:update/).uncheck();
	await page.getByLabel("Expires after (days)").fill("30");
	await page.getByRole("button", { name: "Create key" }).click();

	// Shown once, with a copy button and a curl line that uses it.
	const key = await page.getByLabel("Key", { exact: true }).inputValue();
	expect(key).toMatch(/^petri_/);
	await page.getByRole("button", { name: "Copy key" }).click();
	await expect(page.getByText("Copied.")).toBeVisible();
	expect(await page.evaluate("navigator.clipboard.readText()")).toBe(key);
	await expect(page.getByLabel("Try it", { exact: true })).toHaveValue(
		`curl -H "Authorization: Bearer ${key}" ${baseURL}/api/v1/projects`,
	);
	await page.getByRole("button", { name: "Done" }).click();
	await expect(page.getByLabel("Key", { exact: true })).toHaveCount(0);

	// Without the browser's session: only the key counts.
	const api = await playwright.request.newContext({
		baseURL: baseURL as string,
		extraHTTPHeaders: { authorization: `Bearer ${key}` },
	});
	expect((await api.get("/api/v1/projects")).status()).toBe(200);

	const entry = page.locator("li", { hasText: name });
	await expect(entry.getByText("deploy:read")).toBeVisible();
	await expect(entry.getByText("deploy:update")).toHaveCount(0);
	await page.reload();
	await expect(entry.getByText("never")).toHaveCount(0); // used, and expires

	page.once("dialog", (dialog) => dialog.accept());
	await entry.getByRole("button", { name: "Revoke" }).click();
	await expect(page.getByText("1 revoked or expired key")).toBeVisible();
	expect((await api.get("/api/v1/projects")).status()).toBe(401);
	await api.dispose();
});

test("the settings show the limits in force", async ({ page }) => {
	await page.goto("/admin/settings");
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	await expect(page.getByText("development build")).toBeVisible();
	await expect(
		page.getByText("100 MB compressed, 500 MB extracted, 20,000 files"),
	).toBeVisible();
	await expect(
		page.getByText("512 MB memory, 1 CPU core, 256 processes"),
	).toBeVisible();
});
