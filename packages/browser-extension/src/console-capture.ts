import type {
	ConsoleEntry,
	ConsoleEntryLevel,
} from "@oh-my-pi/browser-protocol";

const MAX_ENTRIES = 20;
const MAX_ENTRY_BYTES = 8 * 1024;
const MAX_SECTION_BYTES = 64 * 1024;
const MAX_STRING_LENGTH = 2_000;

function safeStringify(value: unknown): string {
	try {
		if (value === null) return "null";
		if (value === undefined) return "undefined";
		if (typeof value === "string") return value.slice(0, MAX_STRING_LENGTH);
		if (typeof value === "number" || typeof value === "boolean")
			return String(value);
		if (typeof value === "function")
			return `[Function: ${value.name || "anonymous"}]`;
		if (typeof value !== "object") return String(value);

		// DOM nodes
		if (value instanceof Node) {
			return value instanceof Element
				? `<${value.tagName.toLowerCase()}>`
				: `[${value.nodeName}]`;
		}

		// Errors with useful message
		if (value instanceof Error) {
			return `${value.name}: ${value.message}`;
		}

		// Depth-limited, circular-safe JSON
		const seen = new WeakSet();
		const result = JSON.stringify(
			value,
			(_key, val) => {
				if (typeof val === "object" && val !== null) {
					if (seen.has(val)) return "[Circular]";
					seen.add(val);
				}
				if (typeof val === "function")
					return `[Function: ${val.name || "anonymous"}]`;
				if (val instanceof Node) {
					return val instanceof Element
						? `<${val.tagName.toLowerCase()}>`
						: `[${val.nodeName}]`;
				}
				if (val instanceof Error) return `${val.name}: ${val.message}`;
				return val;
			},
			2,
		);
		return result.length > MAX_STRING_LENGTH
			? `${result.slice(0, MAX_STRING_LENGTH)}...`
			: result;
	} catch {
		return "[Unserializable]";
	}
}

function measureBytes(s: string): number {
	return new TextEncoder().encode(s).byteLength;
}

function buildEntry(
	level: ConsoleEntryLevel,
	args: unknown[],
	error?: Error,
): ConsoleEntry {
	const message = args.map((a) => safeStringify(a)).join(" ");
	const truncated =
		message.length > MAX_STRING_LENGTH
			? `${message.slice(0, MAX_STRING_LENGTH)}...`
			: message;

	const entry: ConsoleEntry = {
		timestamp: new Date().toISOString(),
		level,
		message: truncated,
	};

	if (error?.stack) {
		entry.stack = error.stack;
	}

	return entry;
}

export class ConsoleCapture {
	#buffer: ConsoleEntry[] = [];
	#totalBytes = 0;
	#originalConsole: {
		error: typeof console.error;
		warn: typeof console.warn;
	} | null = null;
	#onError: ((event: ErrorEvent) => void) | null = null;
	#onRejection: ((event: PromiseRejectionEvent) => void) | null = null;
	#active = false;
	#win: typeof globalThis;

	constructor(win: typeof globalThis = globalThis) {
		this.#win = win;
	}

	get active(): boolean {
		return this.#active;
	}

	start(): void {
		if (this.#active) return;
		this.#active = true;

		const origError = this.#win.console.error.bind(this.#win.console);
		const origWarn = this.#win.console.warn.bind(this.#win.console);

		this.#originalConsole = { error: origError, warn: origWarn };

		this.#win.console.error = (...args: unknown[]) => {
			origError(...args);
			this.#push(buildEntry("error", args));
		};

		this.#win.console.warn = (...args: unknown[]) => {
			origWarn(...args);
			this.#push(buildEntry("warn", args));
		};

		this.#onError = (event: ErrorEvent) => {
			this.#push(
				buildEntry(
					"error",
					[event.message],
					event.error instanceof Error ? event.error : undefined,
				),
			);
		};
		this.#win.addEventListener("error", this.#onError);

		this.#onRejection = (event: PromiseRejectionEvent) => {
			const reason = event.reason;
			this.#push(buildEntry("error", [reason]));
		};
		this.#win.addEventListener("unhandledrejection", this.#onRejection);
	}

	stop(): void {
		if (!this.#active) return;
		this.#active = false;

		if (this.#originalConsole) {
			this.#win.console.error = this.#originalConsole.error;
			this.#win.console.warn = this.#originalConsole.warn;
			this.#originalConsole = null;
		}

		if (this.#onError) {
			this.#win.removeEventListener("error", this.#onError);
			this.#onError = null;
		}

		if (this.#onRejection) {
			this.#win.removeEventListener("unhandledrejection", this.#onRejection);
			this.#onRejection = null;
		}

		this.#buffer = [];
		this.#totalBytes = 0;
	}

	drain(): ConsoleEntry[] {
		const entries = this.#buffer;
		this.#buffer = [];
		this.#totalBytes = 0;
		return entries;
	}

	#push(entry: ConsoleEntry): void {
		if (!this.#active) return;

		let entryBytes: number;
		try {
			entryBytes = measureBytes(JSON.stringify(entry));
		} catch {
			entryBytes = 0;
		}

		// Single entry too large — skip it
		if (entryBytes > MAX_ENTRY_BYTES) return;

		// Evict oldest until we have room
		while (
			this.#buffer.length > 0 &&
			(this.#buffer.length >= MAX_ENTRIES ||
				this.#totalBytes + entryBytes > MAX_SECTION_BYTES)
		) {
			const evicted = this.#buffer.shift();
			if (!evicted) break;
			try {
				this.#totalBytes -= measureBytes(JSON.stringify(evicted));
			} catch {
				// rough estimate
				this.#totalBytes -= 100;
			}
		}

		this.#buffer.push(entry);
		this.#totalBytes += entryBytes;
	}
}

let instance: ConsoleCapture | undefined;

export function getConsoleCapture(
	win: typeof globalThis = globalThis,
): ConsoleCapture {
	if (!instance) {
		instance = new ConsoleCapture(win);
	}
	return instance;
}

export function resetConsoleCaptureForTesting(): void {
	instance?.stop();
	instance = undefined;
}
