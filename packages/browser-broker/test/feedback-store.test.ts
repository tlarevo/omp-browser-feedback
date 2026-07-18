import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { InMemoryFeedbackStore } from "../src/feedback-store";
import { JournalStore } from "../src/journal";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
});

function makeStore(bounds?: {
	maxEventsPerChannel?: number;
	maxTotalBytes?: number;
	screenshotRootDir?: string;
}) {
	const dir = fs.mkdtempSync(path.join("/tmp", "omp-fb-store-test-"));
	dirs.push(dir);
	const journal = new JournalStore(path.join(dir, "journals"), {
		maxEventsPerChannel: bounds?.maxEventsPerChannel ?? 100,
		maxTotalBytes: bounds?.maxTotalBytes ?? 1024 * 1024,
		maxAgeMs: 7 * 24 * 60 * 60 * 1000,
	});
	journal.load();
	return new InMemoryFeedbackStore({
		journal,
		...(bounds?.screenshotRootDir ? { screenshotRootDir: bounds.screenshotRootDir } : {}),
	});
}

describe("InMemoryFeedbackStore", () => {
	test("stores feedback per channel without cross-routing", async () => {
		const store = makeStore();

		await store.add({ channelId: "a", eventId: "evt-a" });
		await store.add({ channelId: "b", eventId: "evt-b" });

		expect(store.latest("a")?.eventId).toBe("evt-a");
		expect(store.latest("b")?.eventId).toBe("evt-b");
	});

	test("pending events survive broker restart via journal", async () => {
		const dir = await fsp.mkdtemp(path.join("/tmp", "omp-fb-restart-"));
		dirs.push(dir);
		const journalDir = path.join(dir, "journals");

		// Phase 1: add events, ack one.
		const j1 = new JournalStore(journalDir, {
			maxEventsPerChannel: 10,
			maxTotalBytes: 1024 * 1024,
			maxAgeMs: 7 * 24 * 60 * 60 * 1000,
		});
		j1.load();
		const s1 = new InMemoryFeedbackStore({ journal: j1 });
		await s1.add({ channelId: "ch", eventId: "evt-1", payload: { data: 1 } });
		await s1.add({ channelId: "ch", eventId: "evt-2", payload: { data: 2 } });
		await s1.markDelivered("ch", "evt-1");

		// Phase 2: new store instance (simulates restart).
		const j2 = new JournalStore(journalDir, {
			maxEventsPerChannel: 10,
			maxTotalBytes: 1024 * 1024,
			maxAgeMs: 7 * 24 * 60 * 60 * 1000,
		});
		j2.load();
		const s2 = new InMemoryFeedbackStore({ journal: j2 });

		// Only pending event survives as unacknowledged; delivered event
		// is still in journal but marked as delivered.
		expect(s2.pendingCount("ch")).toBe(1);
		expect(s2.pendingByChannel("ch")[0]?.eventId).toBe("evt-2");
		expect(s2.list("ch")).toHaveLength(2);
	});

	test("pending and delivered events coexist with correct counts", async () => {
		const store = makeStore();

		await store.add({ channelId: "a", eventId: "evt-1" });
		await store.add({ channelId: "a", eventId: "evt-2" });
		await store.add({ channelId: "a", eventId: "evt-3" });
		await store.markDelivered("a", "evt-1");

		expect(store.pendingCount("a")).toBe(2);
		expect(store.pendingByChannel("a").map((e) => e.eventId)).toEqual([
			"evt-2",
			"evt-3",
		]);
	});

	test("add is idempotent: Chrome retry does not create duplicates", async () => {
		const store = makeStore();

		await store.add({ channelId: "a", eventId: "evt-1" });
		await store.add({ channelId: "a", eventId: "evt-1" }); // retry
		await store.add({ channelId: "a", eventId: "evt-1" }); // retry

		expect(store.list("a")).toHaveLength(1);
		expect(store.pendingCount("a")).toBe(1);
	});

	test("one ACK clears all pending state for a retried event", async () => {
		const store = makeStore();

		await store.add({ channelId: "a", eventId: "evt-1" });
		await store.add({ channelId: "a", eventId: "evt-1" }); // retry
		expect(store.pendingCount("a")).toBe(1);

		await store.markDelivered("a", "evt-1");
		expect(store.pendingCount("a")).toBe(0);
		expect(store.list("a")[0]?.deliveryStatus).toBe("delivered");
	});

	test("clear removes all entries from journal", async () => {
		const store = makeStore();

		await store.add({ channelId: "a", eventId: "evt-1" });
		await store.add({ channelId: "a", eventId: "evt-2" });

		const cleared = store.clear("a");
		expect(cleared).toBe(2);
		expect(store.list("a")).toHaveLength(0);
	});

	test("markDelivered is a no-op for unknown eventIds", async () => {
		const store = makeStore();

		await store.add({ channelId: "a", eventId: "evt-1" });
		const result = await store.markDelivered("a", "evt-unknown");
		expect(result).toBe(false);
		expect(store.pendingCount("a")).toBe(1);
	});

	test("markDelivered is idempotent for duplicate ACKs", async () => {
		const store = makeStore();

		await store.add({ channelId: "a", eventId: "evt-1" });
		await store.markDelivered("a", "evt-1");
		const result = await store.markDelivered("a", "evt-1"); // duplicate
		expect(result).toBe(false); // already delivered
		expect(store.list("a")).toHaveLength(1);
	});
});
