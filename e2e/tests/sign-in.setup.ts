import { test as setup } from "@playwright/test";
import { ownerSession, signIn } from "./helpers.ts";

setup("sign in as the owner", async ({ page }) => {
	await signIn(page);
	await page.context().storageState({ path: ownerSession });
});
