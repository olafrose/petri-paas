import type {
	Deployment,
	DeploymentEventList,
	DeploymentList,
	ErrorResponse,
	ProjectList,
} from "@petri/contracts";
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { useTestApp } from "../../test/app.ts";

const ctx = useTestApp();

const minimal = {
	project: "demo",
	source: {
		type: "git",
		repository: "https://github.com/example/demo",
		ref: "main",
	},
};

function create(body: Record<string, unknown>) {
	return ctx.inject({
		method: "POST",
		url: "/api/v1/deployments",
		payload: body,
	});
}

async function jobsFor(deploymentId?: string) {
	const result = await ctx.db.execute<{ data: unknown; state: string }>(sql`
		select data, state from pgboss.job
		where name = 'deployment.run'
		${deploymentId ? sql`and data->>'deploymentId' = ${deploymentId}` : sql``}
	`);
	return result.rows;
}

describe("POST /deployments", () => {
	test("queues a deployment, its build and its job", async () => {
		const response = await create(minimal);
		expect(response.statusCode).toBe(201);
		const deployment = response.json<Deployment>();

		expect(response.headers.location).toBe(
			`/api/v1/deployments/${deployment.id}`,
		);
		expect(deployment).toMatchObject({
			name: "main",
			subdomain: "demo-main",
			status: "queued",
			source: minimal.source,
			build: { strategy: "auto", port: null, args: {} },
			lifecycleMode: "temporary",
			latestBuild: { status: "queued", errorMessage: null },
			actions: ["delete"],
		});
		const hours =
			(Date.parse(deployment.expiresAt as string) - Date.now()) / 3_600_000;
		expect(hours).toBeGreaterThan(47.9);
		expect(hours).toBeLessThanOrEqual(48);

		expect(await jobsFor(deployment.id)).toEqual([
			{
				state: "created",
				data: {
					deploymentId: deployment.id,
					buildId: deployment.latestBuild?.id,
				},
			},
		]);

		const events = await ctx.inject({
			url: `/api/v1/deployments/${deployment.id}/events`,
		});
		expect(events.json<DeploymentEventList>().items).toMatchObject([
			{ type: "status", message: "Deployment queued" },
		]);
	});

	test("creates the project if needed and reuses it afterwards", async () => {
		await create(minimal);
		await create({ ...minimal, source: { ...minimal.source, ref: "dev" } });
		const projects = await ctx.inject({ url: "/api/v1/projects" });
		expect(projects.json<ProjectList>().items.map((p) => p.slug)).toEqual([
			"demo",
		]);
	});

	test("names the deployment after the ref and derives the subdomain", async () => {
		const response = await create({
			...minimal,
			source: { ...minimal.source, ref: "feature/New_UI" },
		});
		expect(response.json<Deployment>()).toMatchObject({
			name: "feature/New_UI",
			subdomain: "demo-feature-new-ui",
		});
	});

	test("adds a suffix when the generated subdomain is taken", async () => {
		const first = (await create(minimal)).json<Deployment>();
		const second = (await create(minimal)).json<Deployment>();
		expect(first.subdomain).toBe("demo-main");
		expect(second.subdomain).toMatch(/^demo-main-[0-9a-f]{6}$/);
	});

	test("an explicit subdomain that is taken is a conflict, with no job queued", async () => {
		await create({ ...minimal, subdomain: "showcase" });
		const before = (await jobsFor()).length;

		const response = await create({ ...minimal, subdomain: "showcase" });
		expect(response.statusCode).toBe(409);
		expect(response.json<ErrorResponse>().error.code).toBe("conflict");
		expect(await jobsFor()).toHaveLength(before);
	});

	test("permanent deployments do not expire", async () => {
		const response = await create({
			...minimal,
			lifecycle: { mode: "permanent" },
		});
		expect(response.json<Deployment>()).toMatchObject({
			lifecycleMode: "permanent",
			expiresAt: null,
		});
	});

	test("stores build settings", async () => {
		const response = await create({
			...minimal,
			source: { ...minimal.source, directory: "apps/site" },
			build: {
				strategy: "dockerfile",
				port: 8080,
				args: { NODE_ENV: "production" },
			},
		});
		expect(response.json<Deployment>()).toMatchObject({
			source: { directory: "apps/site" },
			build: {
				strategy: "dockerfile",
				port: 8080,
				args: { NODE_ENV: "production" },
			},
		});
	});

	test.each([
		[
			"plain http",
			{ source: { ...minimal.source, repository: "http://github.com/x/y" } },
		],
		[
			"ssh URL",
			{ source: { ...minimal.source, repository: "git@github.com:x/y.git" } },
		],
		[
			"ref with spaces",
			{ source: { ...minimal.source, ref: "main; rm -rf /" } },
		],
		[
			"leading-dash ref",
			{ source: { ...minimal.source, ref: "--upload-pack=x" } },
		],
		[
			"directory escaping",
			{ source: { ...minimal.source, directory: "../etc" } },
		],
		[
			"absolute directory",
			{ source: { ...minimal.source, directory: "/etc" } },
		],
		["too long TTL", { lifecycle: { mode: "temporary", ttlHours: 10_000 } }],
		["TTL on permanent", { lifecycle: { mode: "permanent", ttlHours: 5 } }],
		["bad port", { build: { port: 70_000 } }],
		["bad build arg name", { build: { args: { "BAD NAME": "x" } } }],
		["bad project slug", { project: "Not A Slug" }],
		["unknown field", { privileged: true }],
	])("rejects %s", async (_label, override) => {
		const before = (await jobsFor()).length;
		const response = await create({ ...minimal, ...override });
		expect(response.statusCode).toBe(400);
		expect(await jobsFor()).toHaveLength(before);
	});

	test("a request that fails after queuing leaves nothing behind", async () => {
		// Make the transaction's last step fail, after the job was sent.
		await ctx.db.execute(sql`
			create function fail_history() returns trigger language plpgsql as
			$$ begin raise exception 'simulated failure'; end $$;
			create trigger fail_history before insert on deployment_events
			for each row execute function fail_history();
		`);
		try {
			const before = (await jobsFor()).length;
			const response = await create(minimal);
			expect(response.statusCode).toBe(500);
			expect(await jobsFor()).toHaveLength(before);
			const list = await ctx.inject({ url: "/api/v1/deployments" });
			expect(list.json<DeploymentList>().items).toEqual([]);
		} finally {
			await ctx.db.execute(sql`
				drop trigger fail_history on deployment_events;
				drop function fail_history();
			`);
		}
	});
});

describe("reading deployments", () => {
	test("lists newest first, filtered by project and status", async () => {
		const a = (await create(minimal)).json<Deployment>();
		const b = (
			await create({ ...minimal, project: "other" })
		).json<Deployment>();

		const all = await ctx.inject({ url: "/api/v1/deployments" });
		expect(all.json<DeploymentList>().items.map((d) => d.id)).toEqual([
			b.id,
			a.id,
		]);

		const byProject = await ctx.inject({
			url: `/api/v1/deployments?projectId=${a.projectId}`,
		});
		expect(byProject.json<DeploymentList>().items.map((d) => d.id)).toEqual([
			a.id,
		]);

		const ready = await ctx.inject({ url: "/api/v1/deployments?status=ready" });
		expect(ready.json<DeploymentList>().items).toEqual([]);
	});

	test("returns one deployment, or 404", async () => {
		const created = (await create(minimal)).json<Deployment>();
		const found = await ctx.inject({
			url: `/api/v1/deployments/${created.id}`,
		});
		expect(found.json()).toEqual(created);

		const missing = await ctx.inject({
			url: "/api/v1/deployments/0190a0e0-0000-7000-8000-000000000000",
		});
		expect(missing.statusCode).toBe(404);
	});

	test("events can be paged with ?after", async () => {
		const created = (await create(minimal)).json<Deployment>();
		const url = `/api/v1/deployments/${created.id}/events`;
		const [first] = (await ctx.inject({ url })).json<DeploymentEventList>()
			.items;
		const after = await ctx.inject({ url: `${url}?after=${first?.id}` });
		expect(after.json<DeploymentEventList>().items).toEqual([]);
	});
});

describe("API keys", () => {
	test("need deploy:create to deploy and deploy:read to look", async () => {
		const reader = await ctx.createKey(["deploy:read"]);
		const denied = await ctx.withKey(reader.key, {
			method: "POST",
			url: "/api/v1/deployments",
			payload: minimal,
		});
		expect(denied.statusCode).toBe(403);

		const deployer = await ctx.createKey(["deploy:create"]);
		const created = await ctx.withKey(deployer.key, {
			method: "POST",
			url: "/api/v1/deployments",
			payload: minimal,
		});
		expect(created.statusCode).toBe(201);

		const listed = await ctx.withKey(reader.key, {
			url: "/api/v1/deployments",
		});
		expect(listed.json<DeploymentList>().items).toHaveLength(1);
	});
});
