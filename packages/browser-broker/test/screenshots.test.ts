import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BrowserScreenshotStore } from "../src/screenshots";

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("BrowserScreenshotStore", () => {
	test("stores screenshots under sanitized event-owned names", async () => {
		const dir = await fs.mkdtemp(path.join("/tmp", "omp-browser-screens-"));
		dirs.push(dir);
		const store = new BrowserScreenshotStore({ rootDir: dir, maxBytes: 1024 });

		const saved = await store.save({
			eventId: "../evt-1",
			mimeType: "image/png",
			bytes: new Uint8Array([1, 2, 3]),
		});

		expect(saved.ref).toBe("screenshots/evt-1.png");
		expect(await Bun.file(path.join(dir, "evt-1.png")).arrayBuffer()).toHaveProperty("byteLength", 3);
	});

	test("rejects oversized screenshots", async () => {
		const dir = await fs.mkdtemp(path.join("/tmp", "omp-browser-screens-"));
		dirs.push(dir);
		const store = new BrowserScreenshotStore({ rootDir: dir, maxBytes: 2 });

		await expect(
			store.save({
				eventId: "evt-1",
				mimeType: "image/png",
				bytes: new Uint8Array([1, 2, 3]),
			}),
		).rejects.toThrow("exceeds");
	});
});
