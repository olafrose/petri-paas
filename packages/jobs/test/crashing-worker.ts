// Started as a child process by queue.int.test.ts: picks up one ping job,
// reports it, then hangs until the test kills the process with SIGKILL.
import { JobQueue } from "../src/queue.ts";

const queue = await JobQueue.start({
	connectionString: process.env.DATABASE_URL as string,
	tuning: { queues: { "system.ping": { expireInSeconds: 2 } } },
});
await queue.work(
	"system.ping",
	async (job) => {
		process.stdout.write(`started ${job.id}\n`);
		await new Promise(() => {});
	},
	{ pollingIntervalSeconds: 0.5 },
);
process.stdout.write("ready\n");
