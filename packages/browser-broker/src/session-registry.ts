import type { BrowserSessionRegistration, BrowserSessionStatus } from "@oh-my-pi/browser-protocol";

export interface BrowserSessionRegistryOptions {
	now?: () => string;
}

export interface BrowserSessionRecord extends BrowserSessionRegistration {
	registeredAt: string;
	updatedAt: string;
}

export interface BrowserSessionUpdate {
	displayName?: string;
	sessionName?: string;
	cwd?: string;
	projectName?: string;
	gitBranch?: string;
	urlPatterns?: string[];
	status?: BrowserSessionStatus;
	lastActiveAt?: string;
	processId?: number;
}

export class BrowserSessionRegistry {
	readonly #sessions = new Map<string, BrowserSessionRecord>();
	readonly #now: () => string;

	constructor(options: BrowserSessionRegistryOptions = {}) {
		this.#now = options.now ?? (() => new Date().toISOString());
	}

	register(registration: BrowserSessionRegistration): BrowserSessionRecord {
		const timestamp = this.#now();
		const existing = this.#sessions.get(registration.sessionId);
		const record: BrowserSessionRecord = {
			...registration,
			registeredAt: existing?.registeredAt ?? timestamp,
			updatedAt: timestamp,
		};
		this.#sessions.set(record.sessionId, record);
		return record;
	}

	update(sessionId: string, update: BrowserSessionUpdate): BrowserSessionRecord | undefined {
		const existing = this.#sessions.get(sessionId);
		if (!existing) return undefined;
		const record: BrowserSessionRecord = {
			...existing,
			...update,
			updatedAt: this.#now(),
		};
		this.#sessions.set(sessionId, record);
		return record;
	}

	markDisconnected(sessionId: string): BrowserSessionRecord | undefined {
		return this.update(sessionId, { status: "disconnected" });
	}

	unregister(sessionId: string): boolean {
		return this.#sessions.delete(sessionId);
	}

	getBySessionId(sessionId: string): BrowserSessionRecord | undefined {
		return this.#sessions.get(sessionId);
	}

	getByChannelId(channelId: string): BrowserSessionRecord | undefined {
		for (const session of this.#sessions.values()) {
			if (session.channelId === channelId) return session;
		}
		return undefined;
	}

	list(): BrowserSessionRecord[] {
		return [...this.#sessions.values()].sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
	}
}
