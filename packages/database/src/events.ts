import { sql } from "drizzle-orm";
import pg from "pg";
import type { Database } from "./client.ts";
import type { Transaction } from "./transaction.ts";

/**
 * Live events from the worker to the API, over PostgreSQL LISTEN/NOTIFY.
 * Events sent inside a transaction are delivered only if it commits.
 *
 * Delivery is best effort: listeners that are disconnected miss events.
 * Anything that must not be lost belongs in a table (e.g.
 * deployment_events); events only say "something changed".
 */
export const EVENT_CHANNEL = "petri_events";

/** PostgreSQL rejects NOTIFY payloads of 8000 bytes or more. */
const MAX_PAYLOAD_BYTES = 7900;

export interface PetriEvent {
	type: string;
	[key: string]: unknown;
}

export async function publishEvent(
	db: Database | Transaction,
	event: PetriEvent,
): Promise<void> {
	const payload = JSON.stringify(event);
	if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
		throw new Error(
			`Event "${event.type}" is too large for NOTIFY (${Buffer.byteLength(payload)} bytes)`,
		);
	}
	await db.execute(sql`select pg_notify(${EVENT_CHANNEL}, ${payload})`);
}

type Subscriber = (event: PetriEvent) => void;

export interface EventListenerOptions {
	onError?: (error: Error) => void;
	/** Delay before reconnecting after the connection drops. */
	reconnectDelayMs?: number;
}

/**
 * Holds one dedicated connection that LISTENs for events and hands them
 * to subscribers. Reconnects automatically if the connection drops.
 */
export class EventListener {
	readonly #connectionString: string;
	readonly #subscribers = new Set<Subscriber>();
	readonly #onError: (error: Error) => void;
	readonly #reconnectDelayMs: number;
	#client: pg.Client | null = null;
	#stopped = false;
	#reconnectTimer: NodeJS.Timeout | null = null;

	constructor(connectionString: string, options: EventListenerOptions = {}) {
		this.#connectionString = connectionString;
		this.#onError = options.onError ?? (() => {});
		this.#reconnectDelayMs = options.reconnectDelayMs ?? 1000;
	}

	/** Connects and starts listening. Resolves once LISTEN is active. */
	async start(): Promise<void> {
		this.#stopped = false;
		const client = new pg.Client({
			connectionString: this.#connectionString,
			application_name: "petri-events",
		});
		client.on("notification", (message) => {
			if (message.channel !== EVENT_CHANNEL || !message.payload) return;
			this.#dispatch(message.payload);
		});
		client.on("error", (error) => {
			this.#onError(error);
			this.#handleDisconnect(client);
		});
		client.on("end", () => this.#handleDisconnect(client));

		try {
			await client.connect();
			await client.query(`listen ${EVENT_CHANNEL}`);
		} catch (error) {
			client.removeAllListeners();
			client.on("error", () => {});
			await client.end().catch(() => {});
			throw error;
		}
		this.#client = client;
	}

	subscribe(subscriber: Subscriber): () => void {
		this.#subscribers.add(subscriber);
		return () => this.#subscribers.delete(subscriber);
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
		const client = this.#client;
		this.#client = null;
		await client?.end();
	}

	#dispatch(payload: string) {
		let event: PetriEvent;
		try {
			event = JSON.parse(payload) as PetriEvent;
		} catch (error) {
			this.#onError(error as Error);
			return;
		}
		for (const subscriber of this.#subscribers) {
			try {
				subscriber(event);
			} catch (error) {
				this.#onError(error as Error);
			}
		}
	}

	#handleDisconnect(client: pg.Client) {
		if (this.#client !== client) return;
		this.#client = null;
		client.removeAllListeners();
		// Late errors from the dead connection must not crash the process.
		client.on("error", () => {});
		client.end().catch(() => {});
		this.#scheduleReconnect();
	}

	#scheduleReconnect() {
		if (this.#stopped || this.#reconnectTimer) return;
		this.#reconnectTimer = setTimeout(async () => {
			this.#reconnectTimer = null;
			if (this.#stopped) return;
			try {
				await this.start();
			} catch (error) {
				this.#onError(error as Error);
				this.#scheduleReconnect();
			}
		}, this.#reconnectDelayMs);
	}
}
