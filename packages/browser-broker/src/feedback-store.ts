import * as fs from "node:fs";
import * as path from "node:path";

export type BrowserFeedbackDeliveryStatus = "pending" | "delivered";

export interface StoredBrowserFeedback {
	channelId: string;
	eventId: string;
	createdAt?: string;
	payload?: unknown;
	deliveryStatus?: BrowserFeedbackDeliveryStatus;
}

interface DeliveryFileEntry {
	eventId: string;
	createdAt?: string;
	payload?: unknown;
}

interface DeliveryFile {
	version: 1;
	pending: Record<string, DeliveryFileEntry[]>;
}

export interface InMemoryFeedbackStoreOptions {
	maxEventsPerChannel: number;
	/** When set, pending events survive broker restarts. */
	deliveryPath?: string;
}

function loadDeliveryFile(filePath: string): DeliveryFile {
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		if (
			typeof raw === "object" &&
			raw !== null &&
			raw.version === 1 &&
			typeof raw.pending === "object"
		) {
			return raw as DeliveryFile;
		}
		return { version: 1, pending: {} };
	} catch {
		return { version: 1, pending: {} };
	}
}

function persistDeliveryFile(filePath: string, file: DeliveryFile): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(file, null, 2)}\n`, {
		mode: 0o600,
	});
	fs.chmodSync(tmpPath, 0o600);
	fs.renameSync(tmpPath, filePath);
	fs.chmodSync(filePath, 0o600);
}

export class InMemoryFeedbackStore {
	readonly #eventsByChannel = new Map<string, StoredBrowserFeedback[]>();
	readonly #maxEventsPerChannel: number;
	readonly #deliveryPath: string | undefined;

	constructor(options: InMemoryFeedbackStoreOptions) {
		this.#maxEventsPerChannel = Math.max(
			1,
			Math.floor(options.maxEventsPerChannel),
		);
		this.#deliveryPath = options.deliveryPath;

		// Hydrate in-memory history from persisted pending events on startup.
		if (this.#deliveryPath) {
			const file = loadDeliveryFile(this.#deliveryPath);
			for (const [channelId, entries] of Object.entries(file.pending)) {
				const events: StoredBrowserFeedback[] = entries.map((e) => ({
					channelId,
					eventId: e.eventId,
					createdAt: e.createdAt,
					payload: e.payload,
					deliveryStatus: "pending",
				}));
				this.#eventsByChannel.set(channelId, events);
			}
		}
	}

	add(event: StoredBrowserFeedback): StoredBrowserFeedback {
		const events = this.#eventsByChannel.get(event.channelId) ?? [];
		// Idempotent: Chrome retries must not create duplicate pending entries.
		const existing = events.find((e) => e.eventId === event.eventId);
		if (existing) return existing;
		const entry: StoredBrowserFeedback = {
			...event,
			deliveryStatus: "pending",
		};
		events.push(entry);
		// Evict only delivered records to free history slots.
		// Pending v2 events MUST survive until their matching ACK.
		while (events.length > this.#maxEventsPerChannel) {
			const idx = events.findIndex((e) => e.deliveryStatus === "delivered");
			if (idx === -1) break;
			events.splice(idx, 1);
		}
		this.#eventsByChannel.set(entry.channelId, events);
		this.#persist();
		return entry;
	}

	list(channelId: string): StoredBrowserFeedback[] {
		return [...(this.#eventsByChannel.get(channelId) ?? [])];
	}

	latest(channelId: string): StoredBrowserFeedback | undefined {
		return this.#eventsByChannel.get(channelId)?.at(-1);
	}

	clear(channelId: string): number {
		const count = this.#eventsByChannel.get(channelId)?.length ?? 0;
		this.#eventsByChannel.delete(channelId);
		this.#persist();
		return count;
	}

	/** Mark a single event as delivered (ACK received for v2). */
	markDelivered(channelId: string, eventId: string): boolean {
		const events = this.#eventsByChannel.get(channelId);
		if (!events) return false;
		const event = events.find((e) => e.eventId === eventId);
		if (!event || event.deliveryStatus === "delivered") return false;
		event.deliveryStatus = "delivered";
		this.#persist();
		return true;
	}

	/** Return pending events for a channel (replayed on v2 session reconnect). */
	pendingByChannel(channelId: string): StoredBrowserFeedback[] {
		return this.list(channelId).filter((e) => e.deliveryStatus === "pending");
	}

	pendingCount(channelId: string): number {
		return this.pendingByChannel(channelId).length;
	}

	#persist(): void {
		if (!this.#deliveryPath) return;
		const pending: Record<string, DeliveryFileEntry[]> = {};
		for (const [channelId, events] of this.#eventsByChannel) {
			const pendingEvents = events.filter(
				(e) => e.deliveryStatus === "pending",
			);
			if (pendingEvents.length > 0) {
				pending[channelId] = pendingEvents.map((e) => ({
					eventId: e.eventId,
					createdAt: e.createdAt,
					payload: e.payload,
				}));
			}
		}
		persistDeliveryFile(this.#deliveryPath, { version: 1, pending });
	}
}
