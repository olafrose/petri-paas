import { type Database, publishEvent } from "@petri/database";
import type { JobHandler } from "@petri/jobs";

/** Answers a ping with a "system.pong" event, proving the worker is alive. */
export function pingHandler(db: Database): JobHandler<"system.ping"> {
	return async (job) => {
		await publishEvent(db, {
			type: "system.pong",
			jobId: job.id,
			requestedAt: job.data.requestedAt,
			answeredAt: new Date().toISOString(),
		});
	};
}
