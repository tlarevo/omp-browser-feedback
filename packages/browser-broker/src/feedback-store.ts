import * as fs from "node:fs";
import * as path from "node:path";
import type { JournalEntry, JournalStore } from "./journal";

export type BrowserFeedbackDeliveryStatus = "pending" | "delivered";

export interface StoredBrowserFeedback {
	channelId: string;
	eventId: string;
	createdAt?: string;
	payload?: unknown;
	deliveryStatus?: BrowserFeedbackDeliveryStatus;
}

export interface InMemoryFeedbackStoreOptions {
	journal: JournalStore;
	screenshotRootDir?: string;
}

function extractScreenshotRefs(payload: unknown): string[] {
	if (!payload || typeof payload !== "object") return [];
	const refs: string[] = [];
	const p = payload as Record<string, unknown>;
	const screenshot = p.screenshot as Record<string, unknown> | undefined;
	if (screenshot && typeof screenshot.ref === "string") refs.push(screenshot.ref);
	return refs;
}

function removeScreenshotFiles(screenshotRootDir: string, refs: string[]): void {
	for (const ref of refs) {
		const filePath = path.join(screenshotRootDir, ref);
		if (!filePath.startsWith(screenshotRootDir)) continue;
		try {
			if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
		} catch {}
	}
	}
export class InMemoryFeedbackStore {
	readonly #journal: JournalStore;
	readonly #screenshotRootDir: string;

	constructor(options: InMemoryFeedbackStoreOptions) {
		this.#journal = options.journal;
		this.#screenshotRootDir = options.screenshotRootDir ?? "";
	}

	/**
	 * Add feedback event to the journal. Async — durability is guaranteed
	 * before the promise resolves. Returns a bounds error if the channel
	 * is saturated with unacknowledged events.
	 */
	async add(
		event: StoredBrowserFeedback,
	): Promise<StoredBrowserFeedback> {
		const journalEntry: JournalEntry = {
			type: "event",
			eventId: event.eventId,
			createdAt: event.createdAt,
			payload: event.payload,
		};
		await this.#journal.appendEvent(event.channelId, journalEntry);
		return { ...event, deliveryStatus: "pending" };
	}

	list(channelId: string): StoredBrowserFeedback[] {
		const lines = this.#journal.list(channelId);
		const ackedEventIds = new Set(
			lines.filter((l) => l.type === "ack").map((l) => l.eventId),
		);
		return lines
			.filter((l): l is JournalEntry => l.type === "event")
			.map((l) => ({
				channelId,
				eventId: l.eventId,
				createdAt: l.createdAt,
				payload: l.payload,
				deliveryStatus: ackedEventIds.has(l.eventId)
					? ("delivered" as const)
					: ("pending" as const),
			}));
	}

	latest(channelId: string): StoredBrowserFeedback | undefined {
		const events = this.list(channelId);
		return events.at(-1);
	}
	findByEventId(eventId: string): StoredBrowserFeedback | undefined {
		for (const channelId of this.#journal.listChannels()) {
			const events = this.list(channelId);
			const found = events.find((e) => e.eventId === eventId);
			if (found) return found;
		}
		return undefined;
	}

	/**
	 * Clear all journal entries for a channel and remove referenced screenshots.
	 * Screenshot deletion happens after journal clear succeeds.
	 */
	clear(channelId: string): number {
		const events = this.list(channelId);
		const count = this.#journal.clear(channelId);
		// Delete screenshots only AFTER the journal is durably cleared.
		if (this.#screenshotRootDir && count > 0) {
			for (const e of events) {
				const refs = extractScreenshotRefs(e.payload);
				if (refs.length > 0)
					removeScreenshotFiles(this.#screenshotRootDir, refs);
			}
		}
		return count;
	}

	/**
	 * Mark a single event as delivered (ACK received for v2).
	 * Async — ACK is durably recorded before the promise resolves.
	 * Screenshot is deleted only after successful ACK.
	 */
	async markDelivered(channelId: string, eventId: string): Promise<boolean> {
		const lines = this.#journal.list(channelId);
		const hasEvent = lines.some(
			(l) => l.type === "event" && l.eventId === eventId,
		);
		if (!hasEvent) return false;
		const alreadyAcked = lines.some(
			(l) => l.type === "ack" && l.eventId === eventId,
		);
		if (alreadyAcked) return false;
		await this.#journal.appendAck(channelId, eventId);
		// Delete screenshot only AFTER the ACK is durably recorded.
		if (this.#screenshotRootDir) {
			const event = lines.find(
				(l): l is JournalEntry =>
					l.type === "event" && l.eventId === eventId,
			);
			if (event) {
				const refs = extractScreenshotRefs(event.payload);
				if (refs.length > 0)
					removeScreenshotFiles(this.#screenshotRootDir, refs);
			}
		}
		return true;
	}

	/** Return pending events for a channel (replayed on v2 session reconnect). */
	pendingByChannel(channelId: string): StoredBrowserFeedback[] {
		return this.list(channelId).filter((e) => e.deliveryStatus === "pending");
	}

	pendingCount(channelId: string): number {
		return this.pendingByChannel(channelId).length;
	}
}
