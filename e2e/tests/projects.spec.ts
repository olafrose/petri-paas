import { expect, test } from "@playwright/test";
import { unique } from "./helpers.ts";

test("create, describe, annotate and delete an experiment", async ({
	page,
}) => {
	const slug = unique("e2e-notes");
	await page.goto("/admin");
	await page.getByRole("link", { name: "New experiment" }).click();
	await page.getByLabel("Name").fill("Notebook test");
	await page.getByLabel("Slug").fill(slug);
	await page.getByLabel("Description").fill("Checks the experiment pages.");
	await page.getByRole("button", { name: "Create experiment" }).click();

	await expect(page).toHaveURL(/\/admin\/projects\/[0-9a-f-]+$/);
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		"Notebook test",
	);
	const number = await page.getByText(/^EXP-\d{3,}$/).textContent();
	await expect(page.getByText("Checks the experiment pages.")).toBeVisible();
	await expect(
		page.getByText("Not in the gallery yet: choose a featured deployment"),
	).toBeVisible();

	// Notes in Markdown; HTML in them is shown as text, never run.
	await page.getByRole("link", { name: "Edit" }).click();
	await page.getByLabel("Name").fill("Notebook test, renamed");
	await page.getByText("Private: not in the gallery").click();
	await page
		.getByLabel("Notes")
		.fill(
			"## Findings\n\n- [x] **pages** work\n\n<script>window.injected = 1</script>",
		);
	await page.getByRole("button", { name: "Save" }).click();

	await expect(page).toHaveURL(/\/admin\/projects\/[0-9a-f-]+$/);
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		"Notebook test, renamed",
	);
	await expect(page.getByRole("heading", { name: "Findings" })).toBeVisible();
	await expect(page.getByRole("checkbox")).toBeChecked();
	await expect(
		page.getByText("<script>window.injected = 1</script>"),
	).toBeVisible();
	expect(await page.evaluate(() => "injected" in globalThis)).toBe(false);
	await expect(
		page.getByText("Private: not shown in the gallery."),
	).toBeVisible();

	// Same number after the edit, and on the overview.
	await expect(page.getByText(number as string, { exact: true })).toBeVisible();
	await page.goto("/admin");
	const entry = page.locator("li", { hasText: "Notebook test, renamed" });
	await expect(entry.getByText(number as string)).toBeVisible();
	await expect(entry.getByText("private")).toBeVisible();

	await entry.getByRole("link", { name: "Notebook test, renamed" }).click();
	page.once("dialog", (dialog) => dialog.accept());
	await page.getByRole("button", { name: "Delete experiment" }).click();
	await expect(page).toHaveURL((url) => url.pathname === "/admin");
	await expect(page.getByText("Notebook test, renamed")).toHaveCount(0);
});

test("the API's validation shows next to the field", async ({ page }) => {
	await page.goto("/admin/projects/new");
	await page.getByLabel("Name").fill("Bad slug");
	await page.getByLabel("Slug").fill("Not A Slug");
	await page.getByRole("button", { name: "Create experiment" }).click();

	await expect(page.getByText("Please check the marked fields.")).toBeVisible();
	await expect(page.getByLabel("Slug")).toHaveAttribute("aria-invalid", "true");
	await expect(page).toHaveURL(/\/admin\/projects\/new$/);
});
