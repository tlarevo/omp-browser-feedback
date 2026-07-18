import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { InMemoryFeedbackStore } from "../src";

describe("InMemoryFeedbackStore", () => {
	test("stores feedback per channel without cross-routing", () => {
		const store = new InMemoryFeedbackStore({ maxEventsPerChannel: 5 });

		store.add({ channelId: "a", eventId: "evt-a" });
		store.add({ channelId: "b", eventId: "evt-b" });

		expect(store.latest("a")?.eventId).toBe("evt-a");
		expect(store.latest("b")?.eventId).toBe("evt-b");
	});

	test("evicts delivered records to make room but never pending", () => {
		const store = new InMemoryFeedbackStore({ maxEventsPerChannel: 3 });

		// Add 3 events, mark first two as delivered.
		store.add({ channelId: "a", eventId: "evt-1" });
		store.add({ channelId: "a", eventId: "evt-2" });
		store.add({ channelId: "a", eventId: "evt-3" });
		store.markDelivered("a", "evt-1");
		store.markDelivered("a", "evt-2");

		// Adding a 4th evicts the oldest delivered record.
		store.add({ channelId: "a", eventId: "evt-4" });

		const ids = store.list("a").map((e) => e.eventId);
		expect(ids).toEqual(["evt-2", "evt-3", "evt-4"]);
	});

	test("pending events accumulate beyond the cap when no delivered records exist", () => {
		const store = new InMemoryFeedbackStore({ maxEventsPerChannel: 2 });

		// All pending — nothing to evict, so all stay.
		store.add({ channelId: "a", eventId: "evt-1" });
		store.add({ channelId: "a", eventId: "evt-2" });
		store.add({ channelId: "a", eventId: "evt-3" });

		expect(store.list("a").map((e) => e.eventId)).toEqual([
			"evt-1",
			"evt-2",
			"evt-3",
		]);
		expect(store.pendingCount("a")).toBe(3);
	});

	test("pending and delivered events coexist with correct counts", () => {
		const store = new InMemoryFeedbackStore({ maxEventsPerChannel: 10 });

		store.add({ channelId: "a", eventId: "evt-1" });
		store.add({ channelId: "a", eventId: "evt-2" });
		store.add({ channelId: "a", eventId: "evt-3" });
		store.markDelivered("a", "evt-1");

		expect(store.pendingCount("a")).toBe(2);
		expect(store.pendingByChannel("a").map((e) => e.eventId)).toEqual([
			"evt-2",
			"evt-3",
		]);
	});

	test("add is idempotent: Chrome retry does not create duplicates", () => {
		const store = new InMemoryFeedbackStore({ maxEventsPerChannel: 10 });

		store.add({ channelId: "a", eventId: "evt-1" });
		store.add({ channelId: "a", eventId: "evt-1" }); // retry
		store.add({ channelId: "a", eventId: "evt-1" }); // retry

		expect(store.list("a")).toHaveLength(1);
		expect(store.pendingCount("a")).toBe(1);
	});

	test("one ACK clears all pending state for a retried event", () => {
		const store = new InMemoryFeedbackStore({ maxEventsPerChannel: 10 });

		store.add({ channelId: "a", eventId: "evt-1" });
		store.add({ channelId: "a", eventId: "evt-1" }); // retry
		expect(store.pendingCount("a")).toBe(1);

		store.markDelivered("a", "evt-1");
		expect(store.pendingCount("a")).toBe(0);
		expect(store.list("a")[0]?.deliveryStatus).toBe("delivered");
	});

	test("pending events survive broker restart via delivery file", async () => {
		const dir = await fsp.mkdtemp(path.join("/tmp", "omp-delivery-test-"));
		const deliveryPath = path.join(dir, "delivery.json");

		// Phase 1: add events, restart the store.
		const s1 = new InMemoryFeedbackStore({
			maxEventsPerChannel: 10,
			deliveryPath,
		});
		s1.add({ channelId: "ch", eventId: "evt-1", payload: { data: 1 } });
		s1.add({ channelId: "ch", eventId: "evt-2", payload: { data: 2 } });
		s1.markDelivered("ch", "evt-1");

		// Phase 2: new store instance (simulates restart).
		const s2 = new InMemoryFeedbackStore({
			maxEventsPerChannel: 10,
			deliveryPath,
		});

		// Only pending event survives; delivered event is not persisted.
		expect(s2.pendingCount("ch")).toBe(1);
		expect(s2.pendingByChannel("ch")[0]?.eventId).toBe("evt-2");
		expect(s2.list("ch")).toHaveLength(1);

		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	});
});
