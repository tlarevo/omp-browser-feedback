import type {
	BrowserSessionRegistration,
	BrowserSessionStatus,
} from "@oh-my-pi/browser-protocol";

export const HEARTBEAT_TIMEOUT_MS = 45_000;
export const IDLE_AFTER_MS = 5 * 60_000;
export const DISCONNECT_GRACE_MS = 10 * 60_000;

export interface BrowserSessionRegistryOptions {
	now?: () => string;
	heartbeatTimeoutMs?: number;
	idleAfterMs?: number;
	graceMs?: number;
}

export interface BrowserSessionRecord extends BrowserSessionRegistration {
	registeredAt: string;
	updatedAt: string;
	/** Last time the broker confirmed the session was alive (register/connect/pong). */
	lastSeenAt: string;
	/** Set when the socket explicitly closed; drives grace expiry. */
	disconnectedAt?: string;
}

export interface BrowserSessionView extends BrowserSessionRecord {
	presence: BrowserSessionStatus;
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
	readonly #heartbeatTimeoutMs: number;
	readonly #idleAfterMs: number;
	readonly #graceMs: number;

	constructor(options: BrowserSessionRegistryOptions = {}) {
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#heartbeatTimeoutMs =
			options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
		this.#idleAfterMs = options.idleAfterMs ?? IDLE_AFTER_MS;
		this.#graceMs = options.graceMs ?? DISCONNECT_GRACE_MS;
	}

	#nowMs(): number {
		return Date.parse(this.#now());
	}

	register(registration: BrowserSessionRegistration): BrowserSessionRecord {
		const timestamp = this.#now();
		const existing = this.#sessions.get(registration.sessionId);
		const record: BrowserSessionRecord = {
			...registration,
			registeredAt: existing?.registeredAt ?? timestamp,
			updatedAt: timestamp,
			lastSeenAt: timestamp,
		};
		this.#sessions.set(record.sessionId, record);
		return record;
	}

	update(
		sessionId: string,
		update: BrowserSessionUpdate,
	): BrowserSessionRecord | undefined {
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

	/** Restore an active, fresh session on (re)connect without a duplicate identity. */
	markConnected(sessionId: string): BrowserSessionRecord | undefined {
		const existing = this.#sessions.get(sessionId);
		if (!existing) return undefined;
		const timestamp = this.#now();
		const { disconnectedAt: _cleared, ...rest } = existing;
		const record: BrowserSessionRecord = {
			...rest,
			status: "active",
			lastActiveAt: timestamp,
			lastSeenAt: timestamp,
			updatedAt: timestamp,
		};
		this.#sessions.set(sessionId, record);
		return record;
	}

	/** Record a native pong, refreshing heartbeat freshness. */
	recordPong(sessionId: string): BrowserSessionRecord | undefined {
		const existing = this.#sessions.get(sessionId);
		if (!existing) return undefined;
		const record: BrowserSessionRecord = {
			...existing,
			lastSeenAt: this.#now(),
		};
		this.#sessions.set(sessionId, record);
		return record;
	}

	markDisconnected(sessionId: string): BrowserSessionRecord | undefined {
		const existing = this.#sessions.get(sessionId);
		if (!existing) return undefined;
		const timestamp = this.#now();
		const record: BrowserSessionRecord = {
			...existing,
			status: "disconnected",
			disconnectedAt: existing.disconnectedAt ?? timestamp,
			updatedAt: timestamp,
		};
		this.#sessions.set(sessionId, record);
		return record;
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

	#presence(record: BrowserSessionRecord, nowMs: number): BrowserSessionStatus {
		if (record.disconnectedAt) return "disconnected";
		if (nowMs - Date.parse(record.lastSeenAt) > this.#heartbeatTimeoutMs)
			return "disconnected";
		if (nowMs - Date.parse(record.lastActiveAt) > this.#idleAfterMs)
			return "idle";
		return "active";
	}

	#disconnectedSinceMs(record: BrowserSessionRecord): number {
		if (record.disconnectedAt) return Date.parse(record.disconnectedAt);
		return Date.parse(record.lastSeenAt) + this.#heartbeatTimeoutMs;
	}

	presenceOf(sessionId: string): BrowserSessionStatus | undefined {
		const record = this.#sessions.get(sessionId);
		if (!record) return undefined;
		return this.#presence(record, this.#nowMs());
	}

	/** Remove disconnected sessions whose grace period has elapsed. */
	prune(): void {
		const nowMs = this.#nowMs();
		for (const [id, record] of this.#sessions) {
			if (this.#presence(record, nowMs) !== "disconnected") continue;
			if (nowMs - this.#disconnectedSinceMs(record) > this.#graceMs)
				this.#sessions.delete(id);
		}
	}

	list(): BrowserSessionView[] {
		this.prune();
		const nowMs = this.#nowMs();
		return [...this.#sessions.values()]
			.map((record) => ({
				...record,
				presence: this.#presence(record, nowMs),
			}))
			.sort((left, right) =>
				right.lastActiveAt.localeCompare(left.lastActiveAt),
			);
	}
}
