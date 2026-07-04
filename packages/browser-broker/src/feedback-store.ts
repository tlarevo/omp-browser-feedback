export interface StoredBrowserFeedback {
	channelId: string;
	eventId: string;
	createdAt?: string;
	payload?: unknown;
}

export interface InMemoryFeedbackStoreOptions {
	maxEventsPerChannel: number;
}

export class InMemoryFeedbackStore {
	readonly #eventsByChannel = new Map<string, StoredBrowserFeedback[]>();
	readonly #maxEventsPerChannel: number;

	constructor(options: InMemoryFeedbackStoreOptions) {
		this.#maxEventsPerChannel = Math.max(
			1,
			Math.floor(options.maxEventsPerChannel),
		);
	}

	add(event: StoredBrowserFeedback): StoredBrowserFeedback {
		const events = this.#eventsByChannel.get(event.channelId) ?? [];
		events.push(event);
		while (events.length > this.#maxEventsPerChannel) {
			events.shift();
		}
		this.#eventsByChannel.set(event.channelId, events);
		return event;
	}

	list(channelId: string): StoredBrowserFeedback[] {
		return [...(this.#eventsByChannel.get(channelId) ?? [])];
	}

	latest(channelId: string): StoredBrowserFeedback | undefined {
		const events = this.#eventsByChannel.get(channelId);
		return events?.at(-1);
	}

	clear(channelId: string): number {
		const count = this.#eventsByChannel.get(channelId)?.length ?? 0;
		this.#eventsByChannel.delete(channelId);
		return count;
	}
}
