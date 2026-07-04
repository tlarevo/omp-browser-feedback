import { describe, expect, test } from "bun:test";
import { InMemoryFeedbackStore } from "../src";

describe("InMemoryFeedbackStore", () => {
	test("stores feedback per channel without cross-routing", () => {
		const store = new InMemoryFeedbackStore({ maxEventsPerChannel: 5 });

		store.add({ channelId: "a", eventId: "evt-a" });
		store.add({ channelId: "b", eventId: "evt-b" });

		expect(store.latest("a")?.eventId).toBe("evt-a");
		expect(store.latest("b")?.eventId).toBe("evt-b");
	});

	test("keeps only the bounded recent history per channel", () => {
		const store = new InMemoryFeedbackStore({ maxEventsPerChannel: 2 });

		store.add({ channelId: "a", eventId: "evt-1" });
		store.add({ channelId: "a", eventId: "evt-2" });
		store.add({ channelId: "a", eventId: "evt-3" });

		expect(store.list("a").map((event) => event.eventId)).toEqual([
			"evt-2",
			"evt-3",
		]);
	});
});
