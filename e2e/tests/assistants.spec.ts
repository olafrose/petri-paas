import { expect, test } from "@playwright/test";
import type {
	ApiKey,
	CreatedApiKey,
	Deployment,
	DeploymentList,
} from "../../packages/contracts/src/index.ts";
import { fixtureZip, unique } from "./helpers.ts";

test("an assistant checks its key and follows a build, one request per change", async ({
	page,
	playwright,
	baseURL,
}) => {
	test.setTimeout(180_000);
	// A key from the owner, as the guide's section 1 ends.
	const created = await page.request.post("/api/v1/api-keys", {
		headers: { origin: baseURL as string },
		data: {
			name: unique("follower"),
			scopes: ["deploy:read", "deploy:create", "deploy:delete"],
		},
	});
	const { key } = (await created.json()) as CreatedApiKey;
	const assistant = await playwright.request.newContext({
		baseURL: baseURL as string,
		extraHTTPHeaders: { authorization: `Bearer ${key}` },
	});

	// One request says what the key may do.
	const current = await assistant.get("/api/v1/api-keys/current");
	expect(current.status()).toBe(200);
	expect(((await current.json()) as ApiKey).scopes).toEqual([
		"deploy:read",
		"deploy:create",
		"deploy:delete",
	]);

	const project = unique("follow");
	const grown = await assistant.post("/api/v1/deployments/upload", {
		multipart: {
			settings: JSON.stringify({ project, name: "first" }),
			archive: fixtureZip("hello"),
		},
	});
	expect(grown.status()).toBe(201);
	let culture = (await grown.json()) as Deployment;
	let tag = grown.headers().etag as string;
	expect(tag).toBeTruthy();

	// Every answer is a change: no 304, no answer like the one before.
	const seen = [`${culture.status}/${culture.latestBuild?.status}`];
	while (culture.status !== "ready" && culture.status !== "failed") {
		const answer = await assistant.get(
			`/api/v1/deployments/${culture.id}?wait=60`,
			{ headers: { "if-none-match": tag } },
		);
		expect(answer.status(), seen.join(" → ")).toBe(200);
		expect(answer.headers().etag).not.toBe(tag);
		tag = answer.headers().etag as string;
		culture = (await answer.json()) as Deployment;
		seen.push(`${culture.status}/${culture.latestBuild?.status}`);
		expect(seen.length, seen.join(" → ")).toBeLessThan(15);
	}
	expect(culture.status, seen.join(" → ")).toBe("ready");

	// The experiment's cultures, by its slug.
	const listed = await assistant.get(`/api/v1/deployments?project=${project}`);
	expect(
		((await listed.json()) as DeploymentList).items.map((d) => d.id),
	).toEqual([culture.id]);

	// Waiting longer than the web app's default proxy timeout (30 s) works,
	// once nothing changes anymore (the build is marked done after ready).
	const url = `/api/v1/deployments/${culture.id}`;
	await expect
		.poll(async () => {
			const answer = await assistant.get(url);
			tag = answer.headers().etag as string;
			return ((await answer.json()) as Deployment).latestBuild?.status;
		})
		.toBe("succeeded");
	const quiet = await assistant.get(`${url}?wait=35`, {
		headers: { "if-none-match": tag },
	});
	expect(quiet.status()).toBe(304);

	await assistant.delete(`/api/v1/deployments/${culture.id}`);
	await assistant.dispose();
});
