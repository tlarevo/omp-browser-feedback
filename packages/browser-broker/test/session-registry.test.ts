import { describe, expect, test } from "bun:test";
import { BrowserSessionRegistry } from "../src";

describe("BrowserSessionRegistry", () => {
	test("keeps duplicate display names routable by stable ids", () => {
		const registry = new BrowserSessionRegistry({
			now: () => "2026-06-27T10:00:00.000Z",
		});

		registry.register(
			{
				protocolVersion: 1,
				sessionId: "a",
				channelId: "a",
				displayName: "same",
				sessionName: "same",
				cwd: "/a",
				status: "active",
				lastActiveAt: "2026-06-27T10:00:00.000Z",
				processId: 1,
			},
			1,
		);
		registry.register(
			{
				protocolVersion: 1,
				sessionId: "b",
				channelId: "b",
				displayName: "same",
				sessionName: "same",
				cwd: "/b",
				status: "active",
				lastActiveAt: "2026-06-27T10:00:00.000Z",
				processId: 2,
			},
			1,
		);

		expect(registry.getBySessionId("a")?.cwd).toBe("/a");
		expect(registry.getBySessionId("b")?.cwd).toBe("/b");
	});

	test("marks a session disconnected without losing its stable id", () => {
		const registry = new BrowserSessionRegistry({
			now: () => "2026-06-27T10:00:00.000Z",
		});

		registry.register(
			{
				protocolVersion: 1,
				sessionId: "ses_1",
				channelId: "ses_1",
				displayName: "OMP",
				sessionName: "OMP",
				cwd: "/repo",
				status: "active",
				lastActiveAt: "2026-06-27T10:00:00.000Z",
				processId: 1,
			},
			1,
		);

		registry.markDisconnected("ses_1");

		expect(registry.getBySessionId("ses_1")).toMatchObject({
			sessionId: "ses_1",
			status: "disconnected",
		});
	});
});
