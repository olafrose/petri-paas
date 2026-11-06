import {
	type DeploymentStatus,
	deploymentEvents,
	deployments,
	EventListener,
	type PetriEvent,
	projects,
	withTransaction,
} from "@petri/database";
import { useTestDatabase } from "@petri/database/testing";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, inject, test, vi } from "vitest";
import {
	changeStatus,
	DeploymentNotFoundError,
	InvalidTransitionError,
	updateStatus,
} from "./status-change.ts";

const db = useTestDatabase();
const listeners: EventListener[] = [];

afterEach(async () => {
	await Promise.all(listeners.splice(0).map((listener) => listener.stop()));
});

async function createDeployment(status: DeploymentStatus = "queued") {
	const [project] = await db
		.insert(projects)
		.values({ name: "Demo", slug: "demo" })
		.returning();
	const [deployment] = await db
		.insert(deployments)
		.values({
			projectId: project?.id as string,
			name: "main",
			subdomain: "demo",
			source: { type: "git", repository: "https://example.com/r", ref: "main" },
			lifecycleMode: "permanent",
			status,
		})
		.returning();
	return deployment as typeof deployments.$inferSelect;
}

async function statusOf(id: string) {
	const [row] = await db
		.select({ status: deployments.status })
		.from(deployments)
		.where(eq(deployments.id, id));
	return row?.status;
}

async function historyOf(id: string) {
	return db
		.select()
		.from(deploymentEvents)
		.where(eq(deploymentEvents.deploymentId, id))
		.orderBy(asc(deploymentEvents.id));
}

describe("changeStatus", () => {
	test("updates the status, records history and publishes an event", async () => {
		const listener = new EventListener(inject("databaseUrl"));
		await listener.start();
		listeners.push(listener);
		const received: PetriEvent[] = [];
		listener.subscribe((event) => received.push(event));

		const deployment = await createDeployment();
		const event = await updateStatus(db, deployment.id, "cloning", {
			message: "Fetching source",
			data: { commit: "abc123" },
		});

		expect(await statusOf(deployment.id)).toBe("cloning");
		const [entry] = await historyOf(deployment.id);
		expect(entry).toMatchObject({
			type: "status",
			message: "Fetching source",
			data: { from: "queued", to: "cloning", commit: "abc123" },
		});
		expect(event).toMatchObject({
			type: "deployment.status",
			deploymentId: deployment.id,
			projectId: deployment.projectId,
			eventId: entry?.id,
			from: "queued",
			to: "cloning",
		});
		await vi.waitFor(() => expect(received).toEqual([event]));
	});

	test("applies column updates together with the status", async () => {
		const deployment = await createDeployment("deploying");
		await updateStatus(db, deployment.id, "health_check", {
			message: "Container started",
			updates: { containerId: "c0ffee" },
		});
		const [row] = await db
			.select()
			.from(deployments)
			.where(eq(deployments.id, deployment.id));
		expect(row).toMatchObject({
			status: "health_check",
			containerId: "c0ffee",
		});
	});

	test("refuses transitions outside the table and changes nothing", async () => {
		const deployment = await createDeployment();
		await expect(
			updateStatus(db, deployment.id, "ready", { message: "skip ahead" }),
		).rejects.toThrow(InvalidTransitionError);
		expect(await statusOf(deployment.id)).toBe("queued");
		expect(await historyOf(deployment.id)).toEqual([]);
	});

	test("refuses when the deployment is not in an expected status", async () => {
		const deployment = await createDeployment("building");
		await updateStatus(db, deployment.id, "deleting", { message: "Deleting" });

		// The worker, unaware of the deletion, tries to continue.
		await expect(
			updateStatus(db, deployment.id, "deploying", {
				message: "Build finished",
				expectedFrom: ["building"],
			}),
		).rejects.toThrow(InvalidTransitionError);
		expect(await statusOf(deployment.id)).toBe("deleting");
	});

	test("reports unknown deployments", async () => {
		await expect(
			updateStatus(db, "0190a0e0-0000-7000-8000-000000000000", "cloning", {
				message: "x",
			}),
		).rejects.toThrow(DeploymentNotFoundError);
	});

	test("is undone with the surrounding transaction", async () => {
		const deployment = await createDeployment();
		await expect(
			withTransaction(db, async (tx) => {
				await changeStatus(tx, deployment.id, "cloning", {
					message: "Fetching",
				});
				throw new Error("later step failed");
			}),
		).rejects.toThrow("later step failed");
		expect(await statusOf(deployment.id)).toBe("queued");
		expect(await historyOf(deployment.id)).toEqual([]);
	});

	test("a change waits for a concurrent one and then sees its result", async () => {
		const deployment = await createDeployment("ready");

		// Transaction A stops the deployment and stays open.
		let applied!: () => void;
		let release!: () => void;
		const appliedA = new Promise<void>((resolve) => {
			applied = resolve;
		});
		const holdA = new Promise<void>((resolve) => {
			release = resolve;
		});
		const a = withTransaction(db, async (tx) => {
			await changeStatus(tx, deployment.id, "stopped", { message: "Stop A" });
			applied();
			await holdA;
		});
		await appliedA;

		// B tries the same while A is uncommitted. Without the row lock it
		// would read the stale "ready" and also succeed.
		const b = updateStatus(db, deployment.id, "stopped", { message: "Stop B" });
		const bOutcome = b.then(
			() => "succeeded",
			(error: unknown) => error,
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		release();
		await a;

		expect(await bOutcome).toBeInstanceOf(InvalidTransitionError);
		expect(await historyOf(deployment.id)).toHaveLength(1);
	});
});
