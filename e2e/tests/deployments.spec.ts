import { expect, test } from "@playwright/test";
import {
	fixtureZip,
	imageFixture,
	loadedWidth,
	statusStamp,
	unique,
} from "./helpers.ts";

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
	browser,
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
	await page.getByLabel("Notes").fill("SECRET-NOTE: never public");
	await page
		.getByLabel("Featured deployment")
		.selectOption({ label: "first (ready)" });
	await page.getByRole("button", { name: "Save" }).click();
	await expect(page.getByText("In the gallery, with “first”.")).toBeVisible();
	await page.getByLabel("Upload image").setInputFiles(imageFixture);
	await expect(page.getByRole("img", { name: /^Preview of/ })).toBeVisible();

	// The card shows the image, served publicly: a signed-out visitor,
	// without JavaScript (the gallery is server-rendered).
	const visitor = await browser.newContext({
		storageState: { cookies: [], origins: [] },
		javaScriptEnabled: false,
	});
	const gallery = await visitor.newPage();
	await gallery.goto("/");
	const card = gallery.locator("li", { hasText: "Says hello." });
	await expect(card).toBeVisible();
	const image = card.locator("img");
	await expect(image).toHaveAttribute(
		"src",
		/^\/api\/v1\/gallery\/.+\/image\?v=\d+$/,
	);
	await expect.poll(() => image.evaluate(loadedWidth)).toBe(40);
	await expect(card.getByText("first", { exact: true })).toBeVisible();
	await expect(card.getByText("ready")).toBeVisible();

	// Try it opens the app.
	const [app] = await Promise.all([
		visitor.waitForEvent("page"),
		card.getByRole("link", { name: /^Try / }).click(),
	]);
	await expect(app.getByRole("heading")).toHaveText(
		"Hello from an end-to-end test",
	);
	await app.close();

	// Nothing private reaches the public pages: notes, ids, the source.
	// (The admin page open in `page` is the project's: its id ends the URL.)
	const projectId = new URL(page.url()).pathname.split("/").pop() as string;
	const listed = await gallery.content();
	expect(listed).not.toContain("SECRET-NOTE");
	expect(listed).not.toContain(projectId);
	expect(listed).not.toMatch(/uploadId|projectId|featuredDeploymentId/);

	// Its own page, for sharing: the link preview shows its image.
	await card.getByRole("link", { name: project, exact: true }).click();
	await expect(gallery).toHaveURL(new RegExp(`/experiments/${project}$`));
	await expect(gallery.getByRole("heading", { level: 1 })).toHaveText(project);
	const meta = (property: string) =>
		gallery.locator(`meta[property="${property}"]`).getAttribute("content");
	expect(await meta("og:title")).toBe(project);
	expect(await meta("og:description")).toBe("Says hello.");
	expect(await meta("og:image")).toMatch(
		new RegExp(
			`^http://localhost:\\d+/api/v1/gallery/${project}/image\\?v=\\d+$`,
		),
	);
	const html = await gallery.content();
	expect(html).not.toContain("SECRET-NOTE");
	expect(html).not.toContain(projectId);
	await visitor.close();

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
