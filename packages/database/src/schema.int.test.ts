import { asc, eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { expectConstraintViolation, useTestDatabase } from "../test/helpers.ts";
import { migrateDatabase } from "./client.ts";
import {
	apiKeys,
	builds,
	deploymentEvents,
	deployments,
	projects,
} from "./schema.ts";

const db = useTestDatabase();

async function createProject(slug = "dashboard-concept") {
	const [project] = await db
		.insert(projects)
		.values({ name: "Dashboard Concept", slug })
		.returning();
	if (!project) throw new Error("insert returned no row");
	return project;
}

async function createDeployment(
	projectId: string,
	values: Partial<typeof deployments.$inferInsert> = {},
) {
	const [deployment] = await db
		.insert(deployments)
		.values({
			projectId,
			name: "main",
			subdomain: "dashboard",
			source: {
				type: "git",
				repository: "https://github.com/example/dashboard",
				ref: "main",
			},
			lifecycleMode: "permanent",
			...values,
		})
		.returning();
	if (!deployment) throw new Error("insert returned no row");
	return deployment;
}

describe("migrations", () => {
	test("can be applied again without changes", async () => {
		await expect(migrateDatabase(db)).resolves.toBeUndefined();
	});
});

describe("projects", () => {
	test("get an id, defaults and timestamps", async () => {
		const project = await createProject();
		expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(project).toMatchObject({
			description: "",
			notes: "",
			visibility: "public",
			featuredDeploymentId: null,
		});
		expect(project.createdAt).toBeInstanceOf(Date);
	});

	test("ids are time-ordered (UUIDv7)", async () => {
		const first = await createProject("first");
		const second = await createProject("second");
		expect(first.id < second.id).toBe(true);
	});

	test("are numbered in creation order, and numbers aren't reused", async () => {
		const first = await createProject("first");
		const second = await createProject("second");
		expect([first.number, second.number]).toEqual([1, 2]);

		await db.delete(projects).where(eq(projects.id, second.id));
		const third = await createProject("third");
		expect(third.number).toBe(3);
	});

	test("numbers can't be chosen or changed", async () => {
		const project = await createProject();
		await expect(
			db.execute(
				sql`insert into projects (number, name, slug) values (42, 'x', 'x')`,
			),
		).rejects.toThrow();
		await expect(
			db.execute(sql`update projects set number = 42 where id = ${project.id}`),
		).rejects.toThrow();
	});

	test("updatedAt changes on update", async () => {
		const project = await createProject();
		const [updated] = await db
			.update(projects)
			.set({ notes: "tried a new layout" })
			.where(eq(projects.id, project.id))
			.returning();
		expect(updated?.updatedAt.getTime()).toBeGreaterThan(
			project.updatedAt.getTime(),
		);
	});

	test("slugs are unique", async () => {
		await createProject("taken");
		await expectConstraintViolation(
			db.insert(projects).values({ name: "Other", slug: "taken" }),
			"projects_slug_unique",
		);
	});

	test.each(["Has Caps", "-leading", "trailing-", "under_score", ""])(
		"slug %j is rejected",
		async (slug) => {
			await expectConstraintViolation(
				db.insert(projects).values({ name: "Bad", slug }),
				"projects_slug_format",
			);
		},
	);
});

describe("deployments", () => {
	test("start queued and store their source", async () => {
		const project = await createProject();
		const deployment = await createDeployment(project.id);
		expect(deployment.status).toBe("queued");
		expect(deployment.source).toEqual({
			type: "git",
			repository: "https://github.com/example/dashboard",
			ref: "main",
		});
	});

	test("subdomains are unique across projects", async () => {
		const a = await createProject("a");
		const b = await createProject("b");
		await createDeployment(a.id, { subdomain: "demo" });
		await expectConstraintViolation(
			createDeployment(b.id, { subdomain: "demo" }),
			"deployments_subdomain_unique",
		);
	});

	test("subdomains must be DNS labels", async () => {
		const project = await createProject();
		await expectConstraintViolation(
			createDeployment(project.id, { subdomain: "demo.app" }),
			"deployments_subdomain_format",
		);
	});

	test("ports must be in range", async () => {
		const project = await createProject();
		await expectConstraintViolation(
			createDeployment(project.id, { internalPort: 70000 }),
			"deployments_internal_port_range",
		);
	});

	test("temporary deployments need an expiry", async () => {
		const project = await createProject();
		await expectConstraintViolation(
			createDeployment(project.id, { lifecycleMode: "temporary" }),
			"deployments_expiry_matches_lifecycle",
		);
		const expiring = await createDeployment(project.id, {
			lifecycleMode: "temporary",
			expiresAt: new Date(Date.now() + 48 * 3600_000),
		});
		expect(expiring.lifecycleMode).toBe("temporary");
	});

	test("permanent deployments cannot expire", async () => {
		const project = await createProject();
		await expectConstraintViolation(
			createDeployment(project.id, { expiresAt: new Date() }),
			"deployments_expiry_matches_lifecycle",
		);
	});

	test("deleting the featured deployment clears the reference", async () => {
		const project = await createProject();
		const deployment = await createDeployment(project.id);
		await db
			.update(projects)
			.set({ featuredDeploymentId: deployment.id })
			.where(eq(projects.id, project.id));

		await db.delete(deployments).where(eq(deployments.id, deployment.id));

		const [after] = await db
			.select()
			.from(projects)
			.where(eq(projects.id, project.id));
		expect(after?.featuredDeploymentId).toBeNull();
	});

	test("deleting a project removes its deployments, builds and events", async () => {
		const project = await createProject();
		const deployment = await createDeployment(project.id);
		await db.insert(builds).values({ deploymentId: deployment.id });
		await db.insert(deploymentEvents).values({
			deploymentId: deployment.id,
			type: "status",
			message: "Queued",
		});

		await db.delete(projects).where(eq(projects.id, project.id));

		expect(await db.select().from(deployments)).toEqual([]);
		expect(await db.select().from(builds)).toEqual([]);
		expect(await db.select().from(deploymentEvents)).toEqual([]);
	});
});

describe("deployment events", () => {
	test("keep insertion order", async () => {
		const project = await createProject();
		const deployment = await createDeployment(project.id);
		const messages = ["Queued", "Cloning", "Building", "Ready"];
		for (const message of messages) {
			await db.insert(deploymentEvents).values({
				deploymentId: deployment.id,
				type: "status",
				message,
			});
		}

		const events = await db
			.select()
			.from(deploymentEvents)
			.where(eq(deploymentEvents.deploymentId, deployment.id))
			.orderBy(asc(deploymentEvents.id));
		expect(events.map((event) => event.message)).toEqual(messages);
	});
});

describe("api keys", () => {
	const key = {
		name: "coding assistant",
		prefix: "petri_ab",
		keyHash: "0".repeat(64),
	};

	test("need at least one scope", async () => {
		await expectConstraintViolation(
			db.insert(apiKeys).values({ ...key, scopes: [] }),
			"api_keys_has_scopes",
		);
	});

	test("hashes are unique", async () => {
		await db.insert(apiKeys).values({ ...key, scopes: ["deploy:read"] });
		await expectConstraintViolation(
			db.insert(apiKeys).values({ ...key, scopes: ["deploy:read"] }),
			"api_keys_keyHash_unique",
		);
	});
});
