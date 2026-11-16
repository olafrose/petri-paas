import { expect, test } from "@playwright/test";
import type {
	AccessTokenResponse,
	CreatedAccessRequest,
} from "../../packages/contracts/src/index.ts";
import { expectLabWords, unique } from "./helpers.ts";

test("an assistant asks for access, the owner grants it, the key works", async ({
	page,
	playwright,
	baseURL,
}) => {
	// The assistant has nothing but petri.'s address.
	const assistant = await playwright.request.newContext({
		baseURL: baseURL as string,
	});
	const name = unique("assistant");
	const asked = await assistant.post("/api/v1/access-requests", {
		data: {
			name,
			scopes: ["deploy:read", "deploy:create"],
			reason: "To try the access flow",
		},
	});
	expect(asked.status()).toBe(201);
	const { userCode, reviewUrl, pollToken } =
		(await asked.json()) as CreatedAccessRequest;

	// The owner follows the link the assistant shows.
	await page.goto(new URL(reviewUrl).pathname + new URL(reviewUrl).search);
	const entry = page.locator("li", { hasText: name });
	await expect(entry.getByText(userCode)).toBeVisible();
	await expect(entry.getByText("your code")).toBeVisible();
	await expect(entry.getByText("To try the access flow")).toBeVisible();
	await expectLabWords(page);
	await entry.getByLabel(/deploy:create/).uncheck();
	await entry.getByRole("button", { name: "Grant" }).click();
	await expect(entry).toHaveCount(0);

	// The assistant collects the key, once.
	const collected = await assistant.post("/api/v1/access-requests/token", {
		data: { pollToken },
	});
	const body = (await collected.json()) as AccessTokenResponse;
	if (body.status !== "granted") throw new Error(JSON.stringify(body));
	expect(body.apiKey.scopes).toEqual(["deploy:read"]);
	const headers = { authorization: `Bearer ${body.key}` };
	expect((await assistant.get("/api/v1/projects", { headers })).status()).toBe(
		200,
	);

	// Listed with the other keys, where it can be revoked.
	await page.getByRole("link", { name: "API keys" }).click();
	const key = page.locator("li", { hasText: name });
	await expect(key.getByText("via access request")).toBeVisible();
	await assistant.dispose();
});

test("a denied request yields no key", async ({
	page,
	playwright,
	baseURL,
}) => {
	const assistant = await playwright.request.newContext({
		baseURL: baseURL as string,
	});
	const name = unique("stranger");
	const asked = await assistant.post("/api/v1/access-requests", {
		data: { name, scopes: ["deploy:delete"] },
	});
	const { pollToken } = (await asked.json()) as CreatedAccessRequest;

	await page.goto("/admin/access-requests");
	const entry = page.locator("li", { hasText: name });
	page.once("dialog", (dialog) => dialog.accept());
	await entry.getByRole("button", { name: "Deny" }).click();
	await expect(entry).toHaveCount(0);

	const answer = await assistant.post("/api/v1/access-requests/token", {
		data: { pollToken },
	});
	expect(await answer.json()).toEqual({ status: "denied" });
	await assistant.dispose();
});

test("a code that matches no open request is pointed out", async ({ page }) => {
	await page.goto("/admin/access-requests?code=BCDF-GHJK");
	await expect(page.getByText(/No open request with the code/)).toBeVisible();
});
