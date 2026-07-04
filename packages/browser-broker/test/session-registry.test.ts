import { describe, expect, test } from "bun:test";
import { BrowserSessionRegistry } from "../src";

describe("BrowserSessionRegistry", () => {
	test("keeps duplicate display names routable by stable ids", () => {
		const registry = new BrowserSessionRegistry({
			now: () => "2026-06-27T10:00:00.000Z",
		});

		registry.register({
			protocolVersion: 1,
			sessionId: "a",
			channelId: "a",
			displayName: "same",
			sessionName: "same",
			cwd: "/a",
			status: "active",
			lastActiveAt: "2026-06-27T10:00:00.000Z",
			processId: 1,
		});
		registry.register({
			protocolVersion: 1,
			sessionId: "b",
			channelId: "b",
			displayName: "same",
			sessionName: "same",
			cwd: "/b",
			status: "active",
			lastActiveAt: "2026-06-27T10:00:00.000Z",
			processId: 2,
		});

		expect(registry.getBySessionId("a")?.cwd).toBe("/a");
		expect(registry.getBySessionId("b")?.cwd).toBe("/b");
	});
});
