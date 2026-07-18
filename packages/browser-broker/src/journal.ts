import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Append-only JSONL journal for per-channel feedback persistence.
 *
 * Each channel gets its own `.jsonl` file under the data directory.
 * Entries are either events or ACKs.
 *
 * Append (event/ACK): open + append + fsync — truly append-only.
 * Compaction: temp-write + fsync(temp) + rename + fsync(dir) — atomic.
 *
 * Channel IDs are encoded as base64url in filenames (reversible,
 * collision-free, no lossy sanitization).
 *
 * INVARIANT: acknowledged/legacy-delivered entries may be reclaimed
 * during compaction; unacknowledged entries are NEVER silently removed.
 */

export interface JournalBounds {
	maxEventsPerChannel: number;
	maxTotalBytes: number;
	maxAgeMs: number;
}

export interface JournalEntry {
	type: "event";
	eventId: string;
	createdAt?: string;
	payload?: unknown;
}

export interface JournalAckEntry {
	type: "ack";
	eventId: string;
}

export type JournalLine = JournalEntry | JournalAckEntry;

export interface JournalAppendResult {
	appended: true;
}

export interface JournalBoundsError {
	error: true;
	code: "storage_limit";
	message: string;
}

function encodeChannelId(channelId: string): string {
	return Buffer.from(channelId, "utf8").toString("base64url");
}

function decodeChannelId(encoded: string): string {
	return Buffer.from(encoded, "base64url").toString("utf8");
}

function journalPath(dataDir: string, channelId: string): string {
	return path.join(dataDir, `${encodeChannelId(channelId)}.jsonl`);
}

/**
 * Load a single journal file. Returns parsed lines.
 * Trailing corruption (last non-empty record): truncates file, returns valid prefix.
 * Mid-file corruption: throws, leaves file untouched for operator inspection.
 */
function loadJournal(filePath: string): JournalLine[] {
	if (!fs.existsSync(filePath)) return [];
	const lines: JournalLine[] = [];
	let firstCorruptOffset = -1;
	let lastValidEndOffset = 0;
	try {
		const content = fs.readFileSync(filePath, "utf8");
		let byteOffset = 0;
		for (const raw of content.split("\n")) {
			const lineBytes = Buffer.byteLength(raw + "\n", "utf8");
			if (raw.trim() === "") {
				byteOffset += lineBytes;
				continue;
			}
			try {
				const parsed = JSON.parse(raw) as JournalLine;
				if (parsed.type === "event" || parsed.type === "ack") {
					lines.push(parsed);
					lastValidEndOffset = byteOffset + lineBytes;
				}
			} catch {
				if (firstCorruptOffset < 0) firstCorruptOffset = byteOffset;
			}
			byteOffset += lineBytes;
		}
	} catch {
		return lines;
	}
	if (firstCorruptOffset >= 0) {
		// Trailing corruption: corruption starts at or after the last valid line end.
		// Mid-file corruption: corruption is before any valid line that follows.
		const isTrailing =
			firstCorruptOffset >= lastValidEndOffset || lines.length === 0;
		if (!isTrailing) {
			throw new Error(
				`Mid-file corruption in ${filePath}: operator must inspect and repair`,
			);
		}
		const fd = fs.openSync(filePath, "r+");
		try {
			fs.ftruncateSync(fd, firstCorruptOffset);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	}
	return lines;
}
/**
 * Append a single line to a journal file using open + write + fsync.
 * Truly append-only: never reads or rewrites existing content.
 */
async function appendLine(filePath: string, line: string): Promise<void> {
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const fd = fs.openSync(filePath, "a", 0o600);
	try {
		fs.writeSync(fd, line);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Atomically replace a journal file: write temp + fsync + rename + fsync(dir).
 */
function atomicReplace(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmpPath, content, { mode: 0o600 });
	const tmpFd = fs.openSync(tmpPath, "r");
	try {
		fs.fsyncSync(tmpFd);
	} finally {
		fs.closeSync(tmpFd);
	}
	fs.renameSync(tmpPath, filePath);
	fs.chmodSync(filePath, 0o600);
	const dirFd = fs.openSync(path.dirname(filePath), "r");
	try {
		fs.fsyncSync(dirFd);
	} finally {
		fs.closeSync(dirFd);
	}
}

/**
 * Filter journal entries by an event predicate, also removing acks
 * for events the predicate rejected.
 */
function filterEntries(
	lines: JournalLine[],
	keepEvent: (e: JournalEntry) => boolean,
): JournalLine[] {
	const keptEventIds = new Set<string>();
	const result: JournalLine[] = [];
	for (const line of lines) {
		if (line.type === "event") {
			if (keepEvent(line)) {
				keptEventIds.add(line.eventId);
				result.push(line);
			}
		} else if (keptEventIds.has(line.eventId)) {
			result.push(line);
		}
	}
	return result;
}

export class JournalStore {
	readonly #dataDir: string;
	readonly #bounds: JournalBounds;
	readonly #channelLines = new Map<string, JournalLine[]>();
	readonly #channelBytes = new Map<string, number>();

	constructor(dataDir: string, bounds: JournalBounds) {
		this.#dataDir = dataDir;
		this.#bounds = bounds;
	}

	load(): void {
		fs.mkdirSync(this.#dataDir, { recursive: true, mode: 0o700 });
		let files: string[];
		try {
			files = fs
				.readdirSync(this.#dataDir)
				.filter((f: string) => f.endsWith(".jsonl"));
		} catch {
			return;
		}
		for (const file of files) {
			const filePath = path.join(this.#dataDir, file);
			const lines = loadJournal(filePath);
			const channelId = decodeChannelId(file.replace(/\.jsonl$/, ""));
			this.#channelLines.set(channelId, lines);
			this.#channelBytes.set(
				channelId,
				fs.statSync(filePath, { throwIfNoEntry: false })?.size ?? 0,
			);
		}
	}

	async appendEvent(
		channelId: string,
		event: JournalEntry,
	): Promise<JournalAppendResult | JournalBoundsError> {
		const lines = this.#getLines(channelId);

		if (lines.some((l) => l.type === "event" && l.eventId === event.eventId))
			return { appended: true };

		const eventCount = lines.filter((l) => l.type === "event").length;
		if (eventCount >= this.#bounds.maxEventsPerChannel) {
			this.compact(channelId);
			const afterCount = this.#getLines(channelId).filter(
				(l) => l.type === "event",
			).length;
			if (afterCount >= this.#bounds.maxEventsPerChannel) {
				return {
					error: true,
					code: "storage_limit",
					message: `Channel ${channelId} has ${afterCount} unacknowledged events (max ${this.#bounds.maxEventsPerChannel}). Acknowledge or clear existing events.`,
				};
			}
		}

		const entryBytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
		if (this.totalBytes + entryBytes > this.#bounds.maxTotalBytes) {
			this.#compactAllChannels();
			if (this.totalBytes + entryBytes > this.#bounds.maxTotalBytes) {
				return {
					error: true,
					code: "storage_limit",
					message: `Total journal size is ${this.totalBytes} bytes (max ${this.#bounds.maxTotalBytes}). Acknowledge or clear existing events.`,
				};
			}
		}

		await appendLine(
			journalPath(this.#dataDir, channelId),
			`${JSON.stringify(event)}\n`,
		);
		this.#syncBytes(channelId);
		const fresh = this.#getLines(channelId);
		fresh.push(event);
		this.#channelLines.set(channelId, fresh);
		return { appended: true };
	}

	async appendAck(channelId: string, eventId: string): Promise<void> {
		const lines = this.#getLines(channelId);
		// Only ACK events that exist in the journal. Unknown eventIds are
		// no-ops — an early/stale ACK must not pre-ack a future event.
		const hasEvent = lines.some(
			(l) => l.type === "event" && l.eventId === eventId,
		);
		if (!hasEvent) return;
		// Idempotent: duplicate ACKs are no-ops.
		if (lines.some((l) => l.type === "ack" && l.eventId === eventId)) return;
		await appendLine(
			journalPath(this.#dataDir, channelId),
			`${JSON.stringify({ type: "ack", eventId } as JournalAckEntry)}\n`,
		);
		this.#syncBytes(channelId);
		lines.push({ type: "ack", eventId });
		this.#channelLines.set(channelId, lines);
	}

	list(channelId: string): JournalLine[] {
		return [...this.#getLines(channelId)];
	}

	unacknowledged(channelId: string): JournalEntry[] {
		const lines = this.#getLines(channelId);
		const ackedEventIds = new Set(
			lines.filter((l) => l.type === "ack").map((l) => l.eventId),
		);
		return lines.filter(
			(l): l is JournalEntry =>
				l.type === "event" && !ackedEventIds.has(l.eventId),
		);
	}

	compact(channelId: string): JournalLine[] {
		const lines = this.#getLines(channelId);
		const ackedEventIds = new Set(
			lines.filter((l) => l.type === "ack").map((l) => l.eventId),
		);
		const compacted = lines.filter(
			(l) => l.type === "event" && !ackedEventIds.has(l.eventId),
		);
		this.#channelLines.set(channelId, compacted);
		const content =
			compacted.length > 0
				? compacted.map((l) => JSON.stringify(l)).join("\n") + "\n"
				: "";
		atomicReplace(journalPath(this.#dataDir, channelId), content);
		this.#syncBytes(channelId);
		return compacted;
	}

	evictByAge(channelId: string): JournalLine[] {
		const now = Date.now();
		const lines = this.#getLines(channelId);
		const filtered = filterEntries(lines, (l) => {
			if (l.type !== "event") return true;
			if (!lines.some((a) => a.type === "ack" && a.eventId === l.eventId))
				return true;
			return !(
				l.createdAt && now - Date.parse(l.createdAt) > this.#bounds.maxAgeMs
			);
		});
		this.#channelLines.set(channelId, filtered);
		const content =
			filtered.length > 0
				? filtered.map((l) => JSON.stringify(l)).join("\n") + "\n"
				: "";
		atomicReplace(journalPath(this.#dataDir, channelId), content);
		this.#syncBytes(channelId);
		return filtered;
	}

	clear(channelId: string): number {
		const lines = this.#getLines(channelId);
		const eventCount = lines.filter((l) => l.type === "event").length;
		this.#channelLines.set(channelId, []);
		atomicReplace(journalPath(this.#dataDir, channelId), "");
		this.#channelBytes.set(channelId, 0);
		return eventCount;
	}

	listChannels(): string[] {
		try {
			return fs
				.readdirSync(this.#dataDir)
				.filter((f: string) => f.endsWith(".jsonl"))
				.map((f: string) => decodeChannelId(f.replace(/\.jsonl$/, "")));
		} catch {
			return [];
		}
	}

	get dataDir(): string {
		return this.#dataDir;
	}

	get totalBytes(): number {
		let total = 0;
		for (const bytes of this.#channelBytes.values()) total += bytes;
		return total;
	}

	#getLines(channelId: string): JournalLine[] {
		return this.#channelLines.get(channelId) ?? [];
	}

	#syncBytes(channelId: string): void {
		const filePath = journalPath(this.#dataDir, channelId);
		this.#channelBytes.set(
			channelId,
			fs.statSync(filePath, { throwIfNoEntry: false })?.size ?? 0,
		);
	}

	#compactAllChannels(): void {
		for (const channelId of [...this.#channelLines.keys()]) {
			this.compact(channelId);
		}
	}
}
