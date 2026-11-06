import type { Transaction } from "@petri/database";
import { PgBoss, type QueueOptions } from "pg-boss";
import { type JobData, type JobName, jobs } from "./definitions.ts";

export interface JobQueueOptions {
	connectionString: string;
	/** Maximum connections pg-boss may open. */
	maxConnections?: number;
	onError?: (error: Error) => void;
	/** Overrides for tests: faster supervision and expiry. */
	tuning?: {
		/** How often expired jobs are looked for (both default to 60). */
		superviseIntervalSeconds?: number;
		monitorIntervalSeconds?: number;
		queues?: Partial<Record<JobName, QueueOptions>>;
	};
}

export interface SendOptions {
	/** Send as part of this transaction: the job exists only if it commits. */
	transaction?: Transaction;
	/** At most one queued job per key (e.g. one build per deployment). */
	singletonKey?: string;
}

export interface WorkOptions {
	/** Jobs of this type processed at the same time by this worker. */
	concurrency?: number;
	pollingIntervalSeconds?: number;
}

export type JobHandler<Name extends JobName> = (job: {
	id: string;
	data: JobData<Name>;
	retryCount: number;
	signal: AbortSignal;
}) => Promise<void>;

/**
 * Background jobs on PostgreSQL (pg-boss). The API sends jobs; the worker
 * processes them. Jobs survive restarts of either.
 */
export class JobQueue {
	readonly #boss: PgBoss;

	private constructor(boss: PgBoss) {
		this.#boss = boss;
	}

	/** Connects, prepares pg-boss's schema and all queues. */
	static async start(options: JobQueueOptions): Promise<JobQueue> {
		const boss = new PgBoss({
			connectionString: options.connectionString,
			schema: "pgboss",
			max: options.maxConnections ?? 5,
			application_name: "petri-jobs",
			...(options.tuning?.superviseIntervalSeconds && {
				superviseIntervalSeconds: options.tuning.superviseIntervalSeconds,
			}),
			...(options.tuning?.monitorIntervalSeconds && {
				monitorIntervalSeconds: options.tuning.monitorIntervalSeconds,
			}),
		});
		boss.on("error", options.onError ?? (() => {}));
		await boss.start();
		for (const [name, definition] of Object.entries(jobs)) {
			await ensureQueue(boss, name, {
				...definition.queue,
				...options.tuning?.queues?.[name as JobName],
			});
		}
		return new JobQueue(boss);
	}

	async send<Name extends JobName>(
		name: Name,
		data: JobData<Name>,
		options: SendOptions = {},
	): Promise<string> {
		const payload = jobs[name].data.parse(data);
		const client = options.transaction?.$client;
		const id = await this.#boss.send(name, payload, {
			...(options.singletonKey && { singletonKey: options.singletonKey }),
			...(client && {
				db: { executeSql: (text, values) => client.query(text, values) },
			}),
		});
		if (!id) {
			throw new Error(
				`Job "${name}" was not queued (a job with the same singleton key exists)`,
			);
		}
		return id;
	}

	/**
	 * Processes jobs of one type. A handler that throws fails the attempt;
	 * pg-boss retries it according to the queue's settings.
	 */
	async work<Name extends JobName>(
		name: Name,
		handler: JobHandler<Name>,
		options: WorkOptions = {},
	): Promise<void> {
		await this.#boss.work<JobData<Name>>(
			name,
			{
				localConcurrency: options.concurrency ?? 1,
				pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2,
			},
			async ([job]) => {
				if (!job) return;
				await handler({
					id: job.id,
					data: jobs[name].data.parse(job.data) as JobData<Name>,
					retryCount: job.retryCount,
					signal: job.signal,
				});
			},
		);
	}

	async getState(name: JobName, id: string) {
		return (await this.#boss.getJobById(name, id))?.state ?? null;
	}

	/**
	 * Stops processing. Graceful by default: running jobs may finish
	 * within `timeoutMs`; anything unfinished is retried later.
	 */
	async stop({ graceful = true, timeoutMs = 30_000 } = {}): Promise<void> {
		await this.#boss.stop({ graceful, timeout: timeoutMs, close: true });
	}

	/** Escape hatch for tests and tooling. */
	get boss(): PgBoss {
		return this.#boss;
	}
}

async function ensureQueue(boss: PgBoss, name: string, options: QueueOptions) {
	if (await boss.getQueue(name)) {
		await boss.updateQueue(name, options);
	} else {
		await boss.createQueue(name, options);
	}
}
