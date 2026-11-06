import { EventListener, type PetriEvent } from "@petri/database";
import { useTestDatabase } from "@petri/database/testing";
import { expect, inject, test, vi } from "vitest";
import { pingHandler } from "./ping.ts";

const db = useTestDatabase();

test("ping answers with a pong event", async () => {
	const listener = new EventListener(inject("databaseUrl"));
	await listener.start();
	const received: PetriEvent[] = [];
	listener.subscribe((event) => received.push(event));

	try {
		const requestedAt = new Date().toISOString();
		await pingHandler(db)({
			id: "job-1",
			data: { requestedAt },
			retryCount: 0,
			signal: new AbortController().signal,
		});

		await vi.waitFor(() =>
			expect(received).toEqual([
				expect.objectContaining({
					type: "system.pong",
					jobId: "job-1",
					requestedAt,
				}),
			]),
		);
	} finally {
		await listener.stop();
	}
});
