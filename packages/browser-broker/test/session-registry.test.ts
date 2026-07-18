import { describe, expect, test } from "bun:test";
import {
	BrowserSessionRegistry,
	DISCONNECT_GRACE_MS,
	HEARTBEAT_TIMEOUT_MS,
	IDLE_AFTER_MS,
} from "../src";

function fakeRegistry(nowMs: number) {
	return new BrowserSessionRegistry({
		now: () => new Date(nowMs).toISOString(),
	});
}

function registerSession(
	registry: BrowserSessionRegistry,
	sessionId: string,
	lastActiveAtMs = T0,
) {
	registry.register({
		protocolVersion: 1,
		sessionId,
		channelId: sessionId,
		sessionName: "test",
		displayName: "test",
		cwd: "/repo",
		status: "active",
		lastActiveAt: new Date(lastActiveAtMs).toISOString(),
		processId: 1,
	});
}

const T0 = Date.parse("2026-07-18T10:00:00.000Z");

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

	test("marks a session disconnected without losing its stable id", () => {
		const registry = new BrowserSessionRegistry({
			now: () => "2026-06-27T10:00:00.000Z",
		});

		registry.register({
			protocolVersion: 1,
			sessionId: "ses_1",
			channelId: "ses_1",
			displayName: "OMP",
			sessionName: "OMP",
			cwd: "/repo",
			status: "active",
			lastActiveAt: "2026-06-27T10:00:00.000Z",
			processId: 1,
		});

		registry.markDisconnected("ses_1");

		expect(registry.getBySessionId("ses_1")).toMatchObject({
			sessionId: "ses_1",
			status: "disconnected",
		});
	});

	test("active → idle after idleAfterMs without user activity", () => {
		let nowMs = T0;
		const registry = new BrowserSessionRegistry({
			now: () => new Date(nowMs).toISOString(),
		});
		registerSession(registry, "s1");
		expect(registry.presenceOf("s1")).toBe("active");

		// Keep heartbeat fresh with pongs every 30s while time passes
		for (let elapsed = 30_000; elapsed <= IDLE_AFTER_MS; elapsed += 30_000) {
			nowMs = T0 + elapsed;
			registry.recordPong("s1");
		}

		// 4 min 59 sec — still active
		nowMs = T0 + 4 * 60_000 + 59_000;
		expect(registry.presenceOf("s1")).toBe("active");

		// 1ms past 5 min — idle (strict >, heartbeat fresh from last pong)
		nowMs = T0 + IDLE_AFTER_MS + 1;
		expect(registry.presenceOf("s1")).toBe("idle");
	});

	test("active → disconnected after heartbeatTimeoutMs without pong", () => {
		let nowMs = T0;
		const registry = new BrowserSessionRegistry({
			now: () => new Date(nowMs).toISOString(),
		});
		registerSession(registry, "s1");
		expect(registry.presenceOf("s1")).toBe("active");

		// 44 sec — still active
		nowMs = T0 + 44_000;
		expect(registry.presenceOf("s1")).toBe("active");

		// Exactly at boundary — still active (strict >)
		nowMs = T0 + HEARTBEAT_TIMEOUT_MS;
		expect(registry.presenceOf("s1")).toBe("active");

		// 1ms past — disconnected
		nowMs = T0 + HEARTBEAT_TIMEOUT_MS + 1;
		expect(registry.presenceOf("s1")).toBe("disconnected");
	});

	test("idle → disconnected after heartbeatTimeoutMs without pong", () => {
		let nowMs = T0;
		const registry = new BrowserSessionRegistry({
			now: () => new Date(nowMs).toISOString(),
		});
		registerSession(registry, "s1");

		// Keep heartbeat fresh with pongs while reaching idle
		for (let elapsed = 30_000; elapsed <= IDLE_AFTER_MS; elapsed += 30_000) {
			nowMs = T0 + elapsed;
			registry.recordPong("s1");
		}

		// Go idle at 5min+1ms (strict >)
		nowMs = T0 + IDLE_AFTER_MS + 1;
		expect(registry.presenceOf("s1")).toBe("idle");

		// Stop pongs — heartbeat timeout from last pong → disconnected
		nowMs = T0 + IDLE_AFTER_MS + HEARTBEAT_TIMEOUT_MS + 1;
		expect(registry.presenceOf("s1")).toBe("disconnected");
	});

	test("recordPong refreshes heartbeat freshness", () => {
		let nowMs = T0;
		const registry = new BrowserSessionRegistry({
			now: () => new Date(nowMs).toISOString(),
		});
		registerSession(registry, "s1");

		// 40 sec — no pong yet
		nowMs = T0 + 40_000;
		expect(registry.presenceOf("s1")).toBe("active");

		// Pong at 40 sec — resets lastSeenAt
		registry.recordPong("s1");

		// 44 sec from T0 — only 4 sec from pong, still active
		nowMs = T0 + 44_000;
		expect(registry.presenceOf("s1")).toBe("active");

		// 45 sec from T0 — only 5 sec from pong, still active
		nowMs = T0 + 45_000;
		expect(registry.presenceOf("s1")).toBe("active");

		// 85001ms from T0 — 45001ms from pong, disconnected (strict >)
		nowMs = T0 + 85_001;
		expect(registry.presenceOf("s1")).toBe("disconnected");
	});

	test("markConnected restores active without duplicate", () => {
		let nowMs = T0;
		const registry = new BrowserSessionRegistry({
			now: () => new Date(nowMs).toISOString(),
		});
		registerSession(registry, "s1");

		// Disconnect
		nowMs = T0 + 10_000;
		registry.markDisconnected("s1");
		expect(registry.presenceOf("s1")).toBe("disconnected");

		// Reconnect — same id, no duplicate
		nowMs = T0 + 15_000;
		const restored = registry.markConnected("s1");
		expect(restored).toBeDefined();
		expect(restored?.sessionId).toBe("s1");
		expect(registry.presenceOf("s1")).toBe("active");

		// Only one session with this id
		const all = registry.list();
		expect(all.filter((s) => s.sessionId === "s1")).toHaveLength(1);
	});

	test("disconnected session expires after grace period", () => {
		let nowMs = T0;
		const registry = new BrowserSessionRegistry({
			now: () => new Date(nowMs).toISOString(),
		});
		registerSession(registry, "s1");

		// Explicit disconnect
		registry.markDisconnected("s1");
		nowMs = T0 + 1000;
		expect(registry.presenceOf("s1")).toBe("disconnected");

		// 9 min 59 sec after disconnect — still present
		nowMs = T0 + 1000 + DISCONNECT_GRACE_MS - 1000;
		registry.prune();
		expect(registry.getBySessionId("s1")).toBeDefined();

		// Exactly grace period — pruned
		nowMs = T0 + 1000 + DISCONNECT_GRACE_MS;
		registry.prune();
		expect(registry.getBySessionId("s1")).toBeUndefined();
	});

	test("heartbeat loss → disconnected → expires after grace", () => {
		let nowMs = T0;
		const registry = new BrowserSessionRegistry({
			now: () => new Date(nowMs).toISOString(),
		});
		registerSession(registry, "s1");

		// Heartbeat timeout at 45001ms (strict >)
		nowMs = T0 + HEARTBEAT_TIMEOUT_MS + 1;
		expect(registry.presenceOf("s1")).toBe("disconnected");

		// Grace expires 10 min after heartbeat timeout
		nowMs = T0 + HEARTBEAT_TIMEOUT_MS + DISCONNECT_GRACE_MS - 1;
		registry.prune();
		expect(registry.getBySessionId("s1")).toBeDefined();

		nowMs = T0 + HEARTBEAT_TIMEOUT_MS + DISCONNECT_GRACE_MS + 1;
		registry.prune();
		expect(registry.getBySessionId("s1")).toBeUndefined();
	});

	test("presenceOf returns undefined for unknown session", () => {
		const registry = fakeRegistry(T0);
		expect(registry.presenceOf("unknown")).toBeUndefined();
	});

	test("list returns presence field on each session", () => {
		const nowMs = T0;
		const registry = new BrowserSessionRegistry({
			now: () => new Date(nowMs).toISOString(),
		});
		registerSession(registry, "s1");
		registerSession(registry, "s2");

		const sessions = registry.list();
		expect(sessions).toHaveLength(2);
		for (const session of sessions) {
			expect(session).toHaveProperty("presence");
			expect(["active", "idle", "disconnected"]).toContain(session.presence);
		}
	});

	test("custom timing thresholds are respected", () => {
		let nowMs = T0;
		const registry = new BrowserSessionRegistry({
			now: () => new Date(nowMs).toISOString(),
			heartbeatTimeoutMs: 10_000,
			idleAfterMs: 30_000,
			graceMs: 60_000,
		});
		registerSession(registry, "s1");

		// 9 sec — still active
		nowMs = T0 + 9_000;
		expect(registry.presenceOf("s1")).toBe("active");

		// Exactly at boundary — still active (strict >)
		nowMs = T0 + 10_000;
		expect(registry.presenceOf("s1")).toBe("active");

		// 1ms past — disconnected
		nowMs = T0 + 10_001;
		expect(registry.presenceOf("s1")).toBe("disconnected");

		// Custom idle threshold — with pongs to keep heartbeat fresh
		let nowMs2 = T0;
		const registry2 = new BrowserSessionRegistry({
			now: () => new Date(nowMs2).toISOString(),
			heartbeatTimeoutMs: 10_000,
			idleAfterMs: 30_000,
			graceMs: 60_000,
		});
		registerSession(registry2, "s2");

		// Pong every 8 sec to stay under 10s heartbeat timeout
		for (let elapsed = 8_000; elapsed <= 30_000; elapsed += 8_000) {
			nowMs2 = T0 + elapsed;
			registry2.recordPong("s2");
		}

		// 29 sec — active (idle threshold is 30s)
		nowMs2 = T0 + 29_000;
		expect(registry2.presenceOf("s2")).toBe("active");

		// 30001ms — idle (strict >)
		nowMs2 = T0 + 30_001;
		expect(registry2.presenceOf("s2")).toBe("idle");
	});
});
