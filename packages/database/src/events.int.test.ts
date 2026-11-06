import { sql } from "drizzle-orm";
import { afterEach, describe, expect, inject, test, vi } from "vitest";
import { useTestDatabase } from "../test/helpers.ts";
import { EventListener, type PetriEvent, publishEvent } from "./events.ts";
import { withTransaction } from "./transaction.ts";

const db = useTestDatabase();
const listeners: EventListener[] = [];

async function listen(options = {}) {
	const listener = new EventListener(inject("databaseUrl"), {
		reconnectDelayMs: 100,
		...options,
	});
	await listener.start();
	listeners.push(listener);
	const received: PetriEvent[] = [];
	listener.subscribe((event) => received.push(event));
	return { listener, received };
}

afterEach(async () => {
	await Promise.all(listeners.splice(0).map((listener) => listener.stop()));
});

const waitFor = (check: () => void) =>
	vi.waitFor(check, { timeout: 5000, interval: 20 });

describe("events", () => {
	test("are delivered to subscribers", async () => {
		const { received } = await listen();
		await publishEvent(db, { type: "test.hello", value: 42 });
		await waitFor(() =>
			expect(received).toEqual([{ type: "test.hello", value: 42 }]),
		);
	});

	test("in a transaction are delivered only after commit", async () => {
		const { received } = await listen();

		await expect(
			withTransaction(db, async (tx) => {
				await publishEvent(tx, { type: "test.rolled-back" });
				throw new Error("abort");
			}),
		).rejects.toThrow("abort");

		await withTransaction(db, async (tx) => {
			await publishEvent(tx, { type: "test.committed" });
			// Not visible while the transaction is open.
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(received).toEqual([]);
		});

		await waitFor(() => expect(received).toEqual([{ type: "test.committed" }]));
	});

	test("unsubscribed handlers stop receiving", async () => {
		const { listener } = await listen();
		const handler = vi.fn();
		const unsubscribe = listener.subscribe(handler);
		unsubscribe();
		await publishEvent(db, { type: "test.ignored" });
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(handler).not.toHaveBeenCalled();
	});

	test("a throwing subscriber does not affect others", async () => {
		const errors: Error[] = [];
		const { listener, received } = await listen({
			onError: (error: Error) => errors.push(error),
		});
		listener.subscribe(() => {
			throw new Error("subscriber bug");
		});
		await publishEvent(db, { type: "test.robust" });
		await waitFor(() => expect(received).toHaveLength(1));
		expect(errors.map((error) => error.message)).toContain("subscriber bug");
	});

	test("the listener reconnects when its connection is killed", async () => {
		const errors: Error[] = [];
		const { received } = await listen({
			onError: (error: Error) => errors.push(error),
		});
		await db.execute(sql`
			select pg_terminate_backend(pid) from pg_stat_activity
			where application_name = 'petri-events' and datname = current_database()
		`);

		await waitFor(async () => {
			await publishEvent(db, { type: "test.after-reconnect" });
			expect(received).toContainEqual({ type: "test.after-reconnect" });
		});
		expect(errors.length).toBeGreaterThan(0);
	});

	test("oversized events are refused", async () => {
		await expect(
			publishEvent(db, { type: "test.big", blob: "x".repeat(10_000) }),
		).rejects.toThrow(/too large/);
	});
});
