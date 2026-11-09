import { expect, test } from "@playwright/test";
import { owner, signIn } from "./helpers.ts";

test("the admin area needs a session", async ({ page }) => {
	await page.goto("/admin");
	await expect(page).toHaveURL(/\/login\?next=%2Fadmin|\/login\?next=\/admin/);
	await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("a wrong password is refused", async ({ page }) => {
	await page.goto("/login");
	await page.getByLabel("Email").fill(owner.email);
	await page.getByLabel("Password").fill("not-the-password");
	await page.getByRole("button", { name: "Sign in" }).click();
	await expect(page.getByText("Email or password is incorrect.")).toBeVisible();
	await expect(page).toHaveURL(/\/login/);
});

test("signing in and out", async ({ page }) => {
	await signIn(page);
	await expect(
		page.getByRole("heading", { name: "Experiments" }),
	).toBeVisible();
	await expect(page.getByText(owner.email)).toBeVisible();

	await page.getByRole("button", { name: "Sign out" }).click();
	await expect(page).toHaveURL(/\/$/);
	await page.goto("/admin");
	await expect(page).toHaveURL(/\/login/);
});
