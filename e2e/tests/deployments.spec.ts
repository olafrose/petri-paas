import { expect, test } from "@playwright/test";
import { fixtureZip, statusStamp, unique } from "./helpers.ts";

test("the API's validation shows next to the field", async ({ page }) => {
	await page.goto("/admin/deploy");
	await page.getByLabel("Repository").fill("http://plain-http.example.com/app");
	await page.getByLabel("Project").fill(unique("e2e"));
	await page.getByRole("button", { name: "Deploy" }).click();

	await expect(page.getByText("Please check the marked fields.")).toBeVisible();
	const repository = page.getByLabel("Repository");
	await expect(repository).toHaveAttribute("aria-invalid", "true");
	await expect(repository).toHaveAccessibleDescription("Invalid URL");
	await expect(page).toHaveURL(/\/admin\/deploy$/);
});

test("deploy a ZIP, open it, stop, start and delete it", async ({
	page,
	context,
}) => {
	const project = unique("e2e");
	await page.goto("/admin/deploy");
	await page.getByRole("button", { name: "ZIP upload" }).click();
	await page.getByLabel("ZIP archive").setInputFiles(fixtureZip("hello"));
	await page.getByLabel("Project").fill(project);
	await page.getByLabel("Name").fill("first");
	await page.getByRole("button", { name: "Deploy" }).click();

	// The deployment page follows the build live, without reloading.
	await expect(page).toHaveURL(/\/admin\/deployments\/[0-9a-f-]+$/);
	await expect(statusStamp(page)).toHaveText("ready", { timeout: 90_000 });
	await expect(page.getByText(/^Ready at http/)).toBeVisible();
	await expect(page.locator("pre").last()).toContainText(
		"[petri] Building image",
	);

	// The app's own output, fetched through the worker.
	const output = page.locator("section", { hasText: "App output" });
	await expect(output.locator("pre")).toContainText(
		/\d\d:\d\d:\d\dZ hello app started/,
	);
	await expect(output.getByText(/app running/)).toBeVisible();
	await output.getByRole("button", { name: "Refresh" }).click();
	await expect(output.locator("pre")).toContainText("hello app started");

	// The preview answers through the edge proxy.
	const url = await page.locator("dd a[target=_blank]").getAttribute("href");
	expect(url).toContain(`${project}-first.`);
	const preview = await context.newPage();
	await preview.goto(url as string);
	await expect(preview.getByRole("heading")).toHaveText(
		"Hello from an end-to-end test",
	);
	await preview.close();

	// Featured on its experiment's page, it appears in the public gallery.
	await page
		.getByRole("link", { name: new RegExp(`EXP-\\d+ ${project}`) })
		.click();
	await page.getByRole("link", { name: "Edit" }).click();
	await page.getByLabel("Description").fill("Says hello.");
	await page
		.getByLabel("Featured deployment")
		.selectOption({ label: "first (ready)" });
	await page.getByRole("button", { name: "Save" }).click();
	await expect(page.getByText("In the gallery, with “first”.")).toBeVisible();
	const gallery = await context.newPage();
	await gallery.goto("/");
	await expect(gallery.getByText("Says hello.")).toBeVisible();
	await gallery.close();

	// Listed on the overview, with a link to open it.
	await page.goto("/admin");
	const entry = page.locator("li", { hasText: project }).first();
	await expect(entry.getByText("ready")).toBeVisible();
	await expect(entry.getByRole("link", { name: "Open ↗" })).toBeVisible();
	await entry.getByRole("link", { name: "first" }).click();

	await page.getByRole("button", { name: "Stop" }).click();
	await expect(statusStamp(page)).toHaveText("stopped", { timeout: 30_000 });
	// The status changes when stopping is asked for; the app itself stops
	// a moment later. The output is a snapshot: refresh until it shows.
	await expect(async () => {
		await output.getByRole("button", { name: "Refresh" }).click();
		await expect(output.getByText(/app exited/)).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });
	await expect(output.locator("pre")).toContainText("hello app started");

	await page.getByRole("button", { name: "Start" }).click();
	await expect(statusStamp(page)).toHaveText("ready", { timeout: 60_000 });

	page.once("dialog", (dialog) => dialog.accept());
	await page.getByRole("button", { name: "Delete" }).click();
	await expect(statusStamp(page)).toHaveText("deleted", { timeout: 60_000 });
	await expect(page.getByRole("button", { name: "Start" })).toHaveCount(0);
	await expect(
		output.getByText("The app was removed with the deployment."),
	).toBeVisible();

	// With its deployment gone, the experiment can be deleted too.
	await page
		.getByRole("link", { name: new RegExp(`EXP-\\d+ ${project}`) })
		.click();
	await expect(
		page.getByText("1 deleted deployment (history kept)"),
	).toBeVisible();
	page.once("dialog", (dialog) => dialog.accept());
	await page.getByRole("button", { name: "Delete experiment" }).click();
	await expect(page).toHaveURL((url) => url.pathname === "/admin");
	await expect(page.getByText(project)).toHaveCount(0);
});

test("an experiment with deployments can't be deleted yet", async ({
	page,
}) => {
	const project = unique("e2e-keep");
	await page.goto("/admin/deploy");
	await page.getByRole("button", { name: "ZIP upload" }).click();
	await page.getByLabel("ZIP archive").setInputFiles(fixtureZip("hello"));
	await page.getByLabel("Project").fill(project);
	await page.getByRole("button", { name: "Deploy" }).click();
	await expect(page).toHaveURL(/\/admin\/deployments\/[0-9a-f-]+$/);

	await page
		.getByRole("link", { name: new RegExp(`EXP-\\d+ ${project}`) })
		.click();
	const remove = page.getByRole("button", { name: "Delete experiment" });
	await expect(remove).toBeDisabled();
	await expect(remove).toHaveAccessibleDescription(
		/^Delete its deployment first/,
	);
});
