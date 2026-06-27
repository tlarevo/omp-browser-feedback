import * as path from "node:path";

export interface BrowserScreenshotStoreOptions {
	rootDir: string;
	maxBytes: number;
}

export interface BrowserScreenshotSaveInput {
	eventId: string;
	mimeType: "image/png" | "image/jpeg";
	bytes: Uint8Array;
}

export interface BrowserScreenshotSaveResult {
	ref: string;
	path: string;
}

function extensionForMimeType(mimeType: string): string {
	if (mimeType === "image/jpeg") return "jpg";
	return "png";
}

function sanitizeEventId(eventId: string): string {
	const base = eventId.split(/[\\/]/).filter(Boolean).at(-1) ?? "screenshot";
	return base.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export class BrowserScreenshotStore {
	readonly #rootDir: string;
	readonly #maxBytes: number;

	constructor(options: BrowserScreenshotStoreOptions) {
		this.#rootDir = options.rootDir;
		this.#maxBytes = options.maxBytes;
	}

	async save(input: BrowserScreenshotSaveInput): Promise<BrowserScreenshotSaveResult> {
		if (input.bytes.byteLength > this.#maxBytes) {
			throw new Error(`Screenshot exceeds ${this.#maxBytes} byte limit`);
		}
		const filename = `${sanitizeEventId(input.eventId)}.${extensionForMimeType(input.mimeType)}`;
		const filePath = path.join(this.#rootDir, filename);
		if (!filePath.startsWith(this.#rootDir)) {
			throw new Error("Invalid screenshot path");
		}
		await Bun.write(filePath, input.bytes);
		return { ref: `screenshots/${filename}`, path: filePath };
	}
}
