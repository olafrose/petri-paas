import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { projects, withTransaction } from "@petri/database";
import { useTestDatabase } from "@petri/database/testing";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, inject, test, vi } from "vitest";
import { JobQueue, type JobQueueOptions } from "./queue.ts";

const db = useTestDatabase();
const connectionString = inject("databaseUrl");
const started: JobQueue[] = [];

async function startQueue(tuning?: JobQueueOptions["tuning"]) {
	const queue = await JobQueue.start({
		connectionString,
		...(tuning && { tuning }),
	});
	started.push(queue);
	return queue;
}

afterEach(async () => {
	const [first, ...rest] = started.splice(0);
	await Promise.all(rest.map((queue) => queue.stop({ timeoutMs: 1000 })));
	// Jobs left waiting for a retry would be picked up by the next test.
	await first?.boss.deleteAllJobs();
	await first?.stop({ timeoutMs: 1000 });
});

const ping = () => ({ requestedAt: new Date().toISOString() });

describe("transactional send", () => {
	test("a committed transaction keeps the row and the job", async () => {
		const queue = await startQueue();
		const jobId = await withTransaction(db, async (tx) => {
			await tx.insert(projects).values({ name: "Demo", slug: "demo" });
			return queue.send("system.ping", ping(), { transaction: tx });
		});

		expect(await queue.getState("system.ping", jobId)).toBe("created");
		expect(
			await db.select().from(projects).where(eq(projects.slug, "demo")),
		).toHaveLength(1);
	});

	test("a rolled-back transaction leaves neither", async () => {
		const queue = await startQueue();
		let jobId: string | undefined;
		await expect(
			withTransaction(db, async (tx) => {
				await tx.insert(projects).values({ name: "Demo", slug: "demo" });
				jobId = await queue.send("system.ping", ping(), { transaction: tx });
				throw new Error("something failed after sending");
			}),
		).rejects.toThrow("something failed");

		expect(jobId).toBeDefined();
		expect(await queue.getState("system.ping", jobId as string)).toBeNull();
		expect(await db.select().from(projects)).toEqual([]);
	});

	test("rejects invalid payloads before sending", async () => {
		const queue = await startQueue();
		await expect(
			queue.send("system.ping", { requestedAt: "yesterday" }),
		).rejects.toThrow();
	});
});

describe("processing", () => {
	test("a worker completes queued jobs with validated data", async () => {
		const queue = await startQueue();
		const received: unknown[] = [];
		await queue.work(
			"system.ping",
			async (job) => {
				received.push(job.data);
			},
			{ pollingIntervalSeconds: 0.5 },
		);

		const data = ping();
		const id = await queue.send("system.ping", data);
		await vi.waitFor(
			async () =>
				expect(await queue.getState("system.ping", id)).toBe("completed"),
			{ timeout: 10_000, interval: 200 },
		);
		expect(received).toContainEqual(data);
	});

	test("a failing handler leaves the job to be retried", async () => {
		const queue = await startQueue();
		await queue.work(
			"system.ping",
			async () => {
				throw new Error("boom");
			},
			{ pollingIntervalSeconds: 0.5 },
		);
		const id = await queue.send("system.ping", ping());
		await vi.waitFor(
			async () => expect(await queue.getState("system.ping", id)).toBe("retry"),
			{ timeout: 10_000, interval: 200 },
		);
	});

	test("a graceful stop lets the running job finish", async () => {
		const queue = await startQueue();
		let finished = false;
		let begun!: () => void;
		const running = new Promise<void>((resolve) => {
			begun = resolve;
		});
		await queue.work(
			"system.ping",
			async () => {
				begun();
				await new Promise((resolve) => setTimeout(resolve, 1000));
				finished = true;
			},
			{ pollingIntervalSeconds: 0.5 },
		);
		const id = await queue.send("system.ping", ping());
		await running;

		await queue.stop({ timeoutMs: 10_000 });
		started.splice(started.indexOf(queue), 1);
		expect(finished).toBe(true);

		const observer = await startQueue();
		expect(await observer.getState("system.ping", id)).toBe("completed");
	});
});

describe("crash recovery", () => {
	test("a job running in a killed worker is retried by the next worker", {
		timeout: 60_000,
	}, async () => {
		const tuning = {
			superviseIntervalSeconds: 1,
			monitorIntervalSeconds: 1,
			queues: { "system.ping": { expireInSeconds: 2 } },
		};
		const queue = await startQueue(tuning);
		const id = await queue.send("system.ping", ping());

		// A separate worker process picks the job up, then dies mid-job.
		const child = spawn(
			process.execPath,
			[
				"--conditions=@petri/source",
				fileURLToPath(new URL("../test/crashing-worker.ts", import.meta.url)),
			],
			{
				env: { ...process.env, DATABASE_URL: connectionString },
				stdio: ["ignore", "pipe", "inherit"],
			},
		);
		await new Promise<void>((resolve, reject) => {
			child.on("exit", (code) =>
				reject(new Error(`worker exited early (${code})`)),
			);
			child.stdout.on("data", (chunk: Buffer) => {
				if (chunk.toString().includes(`started ${id}`)) resolve();
			});
		});
		expect(await queue.getState("system.ping", id)).toBe("active");
		child.removeAllListeners("exit");
		const exited = new Promise((resolve) => child.on("exit", resolve));
		child.kill("SIGKILL");
		await exited;

		// The replacement worker gets the job once it expires.
		const attempts: number[] = [];
		await queue.work(
			"system.ping",
			async (job) => {
				if (job.id === id) attempts.push(job.retryCount);
			},
			{ pollingIntervalSeconds: 0.5 },
		);
		await vi.waitFor(
			async () =>
				expect(await queue.getState("system.ping", id)).toBe("completed"),
			{ timeout: 30_000, interval: 500 },
		);
		expect(attempts).toEqual([1]);
	});
});
