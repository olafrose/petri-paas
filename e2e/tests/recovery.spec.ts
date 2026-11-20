import { expect, type Page, test } from "@playwright/test";
import { fixtureZip, statusStamp, unique } from "./helpers.ts";

/*
 * After a host restart, Docker starts the apps again (their restart
 * policy) and the worker's route sync gives the edge proxy back its
 * routes. A real reboot can't be part of a test run: here the app exits
 * by itself and the edge proxy's container is restarted, through the
 * same Docker socket proxy the worker uses. The routes of a dev worker
 * running alongside come back with its own next sync.
 */

const docker = process.env.DOCKER_PROXY_URL ?? "http://127.0.0.1:2375";
const edgeContainer = process.env.EDGE_CONTAINER ?? "petri-dev-edge-1";

/** The preview's heading, or null while it doesn't answer. */
async function previewHeading(page: Page, url: string) {
	const response = await page.goto(url).catch(() => null);
	if (!response?.ok()) return null;
	return page.getByRole("heading").textContent();
}

test("after a restart, the app and its route come back", async ({
	page,
	context,
}) => {
	test.setTimeout(240_000);
	await page.goto("/admin/cultures/new");
	await page.getByRole("button", { name: "ZIP upload" }).click();
	await page.getByLabel("ZIP archive").setInputFiles(fixtureZip("restarts"));
	await page.getByLabel("Experiment").fill(unique("e2e"));
	await page.getByLabel("Name").fill("restarts");
	await page.getByRole("button", { name: "Grow culture" }).click();
	await expect(statusStamp(page)).toHaveText("ready", { timeout: 90_000 });
	const url = (await page
		.locator("dd a[target=_blank]")
		.getAttribute("href")) as string;
	const preview = await context.newPage();

	// The app exited and Docker started it again: its output says so twice.
	const output = page.locator("section", { hasText: "App output" });
	await expect(async () => {
		await output.getByRole("button", { name: "Refresh" }).click();
		const text = (await output.locator("pre").textContent()) ?? "";
		expect(text.match(/restarts app started/g)).toHaveLength(2);
	}).toPass({ timeout: 90_000, intervals: [2000] });
	await expect
		.poll(() => previewHeading(preview, url), { timeout: 30_000 })
		.toBe("Hello again");

	// The edge proxy forgets its routes when it restarts.
	const restarted = await fetch(
		`${docker}/v1.47/containers/${edgeContainer}/restart?t=1`,
		{ method: "POST" },
	);
	expect(restarted.status).toBe(204);
	await expect
		.poll(() => previewHeading(preview, url), {
			timeout: 90_000,
			intervals: [2000],
		})
		.toBe("Hello again");

	await page.reload();
	await expect(statusStamp(page)).toHaveText("ready");
	await preview.close();

	// Delete it, as the other tests do.
	page.once("dialog", (dialog) => dialog.accept());
	await page.getByRole("button", { name: "Delete" }).click();
	await expect(statusStamp(page)).toHaveText("deleted", { timeout: 60_000 });
});
