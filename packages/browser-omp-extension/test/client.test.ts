import { describe, expect, test } from "bun:test";
import {
	BROWSER_PROTOCOL_VERSION,
	type BrowserFeedbackEvent,
} from "@oh-my-pi/browser-protocol";
import { BrowserBrokerClient } from "../src/client";

function createFeedbackEvent(eventId: string): BrowserFeedbackEvent {
	return {
		protocolVersion: BROWSER_PROTOCOL_VERSION,
		eventId,
		type: "dom.selection",
		channelId: "ses_1",
		createdAt: "2026-07-11T12:00:00.000Z",
		page: {
			url: "https://example.com",
			title: "Example",
			viewport: {
				width: 1280,
				height: 720,
				devicePixelRatio: 2,
			},
		},
		element: {
			selector: "#submit",
			tagName: "button",
			text: "Submit",
			outerHtml: '<button id="submit">Submit</button>',
			attributes: { id: "submit" },
			bounds: { x: 10, y: 20, width: 30, height: 40 },
			computedStyles: { display: "block" },
		},
	};
}

function createTimerHarness() {
	let nextId = 1;
	const queue = new Map<number, () => void | Promise<void>>();
	const delays: number[] = [];

	return {
		delays,
		setTimeout(callback: () => void | Promise<void>, delay?: number) {
			const id = nextId++;
			queue.set(id, callback);
			delays.push(delay ?? 0);
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout(handle: ReturnType<typeof setTimeout>) {
			queue.delete(Number(handle));
		},
		pending() {
			return queue.size;
		},
		async fireNext() {
			const next = queue.entries().next().value;
			if (!next) throw new Error("No timer scheduled");
			const [id, callback] = next;
			queue.delete(id);
			await callback();
		},
		async fireAll() {
			while (queue.size > 0) {
				await this.fireNext();
			}
		},
	};
}

type FakeSocket = {
	url: string;
	closeCalls: number;
	onopen?: (() => void) | null;
	onclose?: (() => void) | null;
	onerror?: (() => void) | null;
	onmessage?: ((event: { data: string }) => void) | null;
	emitOpen(): void;
	emitClose(): void;
	emitError(): void;
	emitMessage(message: unknown): void;
	close(): void;
};

function createSocketHarness() {
	const sockets: FakeSocket[] = [];

	return {
		sockets,
		createWebSocket(url: string) {
			const socket: FakeSocket = {
				url,
				closeCalls: 0,
				onopen: null,
				onclose: null,
				onerror: null,
				onmessage: null,
				emitOpen() {
					this.onopen?.();
				},
				emitClose() {
					this.onclose?.();
				},
				emitError() {
					this.onerror?.();
				},
				emitMessage(message: unknown) {
					this.onmessage?.({ data: JSON.stringify(message) });
				},
				close() {
					this.closeCalls += 1;
				},
			};
			sockets.push(socket);
			return socket as unknown as WebSocket;
		},
	};
}

describe("BrowserBrokerClient.subscribeFeedback", () => {
	test("backs off reconnect attempts and resets after a successful reopen", async () => {
		const timers = createTimerHarness();
		const socketHarness = createSocketHarness();
		const client = new BrowserBrokerClient({
			baseUrl: "http://127.0.0.1:4317",
			authToken: "root-token",
		});
		const states: string[] = [];
		const reconnects: Array<{ baseUrl: string; authToken: string }> = [];

		const subscription = client.subscribeFeedback("ses_1", () => {}, {
			createWebSocket: socketHarness.createWebSocket,
			reconnect: async () => {
				const next =
					reconnects.length === 0
						? {
								baseUrl: "http://127.0.0.1:4411",
								authToken: "token-2",
							}
						: {
								baseUrl: "http://127.0.0.1:5522",
								authToken: "token-3",
							};
				reconnects.push(next);
				return next;
			},
			onStateChange: (status) => {
				states.push(`${status.state}:${status.reconnectAttempts}`);
			},
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});

		expect(socketHarness.sockets[0]?.url).toContain("127.0.0.1:4317");
		expect(socketHarness.sockets[0]?.url).toContain("token=root-token");

		socketHarness.sockets[0]?.emitClose();
		expect(timers.delays).toEqual([500]);
		expect(states.at(-1)).toBe("reconnecting:1");

		await timers.fireNext();
		expect(reconnects).toEqual([
			{ baseUrl: "http://127.0.0.1:4411", authToken: "token-2" },
		]);
		expect(socketHarness.sockets[1]?.url).toContain("127.0.0.1:4411");
		expect(socketHarness.sockets[1]?.url).toContain("token=token-2");

		socketHarness.sockets[1]?.emitClose();
		expect(timers.delays).toEqual([500, 1000]);

		await timers.fireNext();
		expect(reconnects).toEqual([
			{ baseUrl: "http://127.0.0.1:4411", authToken: "token-2" },
			{ baseUrl: "http://127.0.0.1:5522", authToken: "token-3" },
		]);

		socketHarness.sockets[2]?.emitOpen();
		expect(subscription.getStatus()).toMatchObject({
			state: "connected",
			reconnectAttempts: 0,
			baseUrl: "http://127.0.0.1:5522",
		});

		socketHarness.sockets[2]?.emitClose();
		expect(timers.delays.at(-1)).toBe(500);
	});

	test("dedupes replayed event ids across reconnects", async () => {
		const timers = createTimerHarness();
		const socketHarness = createSocketHarness();
		const client = new BrowserBrokerClient({
			baseUrl: "http://127.0.0.1:4317",
			authToken: "root-token",
		});
		const received: string[] = [];

		client.subscribeFeedback(
			"ses_1",
			(event) => {
				received.push(event.eventId);
			},
			{
				createWebSocket: socketHarness.createWebSocket,
				reconnect: async () => ({
					baseUrl: "http://127.0.0.1:4411",
					authToken: "token-2",
				}),
				setTimeout: timers.setTimeout,
				clearTimeout: timers.clearTimeout,
			},
		);

		socketHarness.sockets[0]?.emitMessage({
			type: "browser.feedback",
			event: createFeedbackEvent("evt-1"),
		});
		socketHarness.sockets[0]?.emitClose();
		await timers.fireNext();
		socketHarness.sockets[1]?.emitMessage({
			type: "browser.feedback",
			event: createFeedbackEvent("evt-1"),
		});
		socketHarness.sockets[1]?.emitMessage({
			type: "browser.feedback",
			event: createFeedbackEvent("evt-2"),
		});

		expect(received).toEqual(["evt-1", "evt-2"]);
	});

	test("close cancels any pending reconnect timer", async () => {
		const timers = createTimerHarness();
		const socketHarness = createSocketHarness();
		const client = new BrowserBrokerClient({
			baseUrl: "http://127.0.0.1:4317",
			authToken: "root-token",
		});
		let reconnectCalls = 0;

		const subscription = client.subscribeFeedback("ses_1", () => {}, {
			createWebSocket: socketHarness.createWebSocket,
			reconnect: async () => {
				reconnectCalls += 1;
				return {
					baseUrl: "http://127.0.0.1:4411",
					authToken: "token-2",
				};
			},
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});

		socketHarness.sockets[0]?.emitClose();
		expect(timers.pending()).toBe(1);

		subscription.close();
		expect(timers.pending()).toBe(0);
		expect(subscription.getStatus().state).toBe("closed");

		await timers.fireAll();
		expect(reconnectCalls).toBe(0);
	});

	test("ignores stale socket messages after an error-triggered reconnect", async () => {
		const timers = createTimerHarness();
		const socketHarness = createSocketHarness();
		const client = new BrowserBrokerClient({
			baseUrl: "http://127.0.0.1:4317",
			authToken: "root-token",
		});
		const received: string[] = [];

		client.subscribeFeedback(
			"ses_1",
			(event) => {
				received.push(event.eventId);
			},
			{
				createWebSocket: socketHarness.createWebSocket,
				reconnect: async () => ({
					baseUrl: "http://127.0.0.1:4411",
					authToken: "token-2",
				}),
				setTimeout: timers.setTimeout,
				clearTimeout: timers.clearTimeout,
			},
		);

		socketHarness.sockets[0]?.emitError();
		await timers.fireNext();
		expect(socketHarness.sockets[0]?.closeCalls).toBe(1);
		socketHarness.sockets[0]?.emitMessage({
			type: "browser.feedback",
			event: createFeedbackEvent("evt-stale"),
		});
		socketHarness.sockets[1]?.emitMessage({
			type: "browser.feedback",
			event: createFeedbackEvent("evt-live"),
		});

		expect(received).toEqual(["evt-live"]);
	});

	test("evicts old event ids from the dedupe cache", () => {
		const socketHarness = createSocketHarness();
		const client = new BrowserBrokerClient({
			baseUrl: "http://127.0.0.1:4317",
			authToken: "root-token",
		});
		const received: string[] = [];

		client.subscribeFeedback("ses_1", (event) => received.push(event.eventId), {
			createWebSocket: socketHarness.createWebSocket,
		});

		for (let i = 0; i <= 1000; i += 1) {
			socketHarness.sockets[0]?.emitMessage({
				type: "browser.feedback",
				event: createFeedbackEvent(`evt-${i}`),
			});
		}

		socketHarness.sockets[0]?.emitMessage({
			type: "browser.feedback",
			event: createFeedbackEvent("evt-0"),
		});
		socketHarness.sockets[0]?.emitMessage({
			type: "browser.feedback",
			event: createFeedbackEvent("evt-1000"),
		});

		expect(received.slice(-2)).toEqual(["evt-1000", "evt-0"]);
		expect(received.filter((eventId) => eventId === "evt-0")).toHaveLength(2);
		expect(received.filter((eventId) => eventId === "evt-1000")).toHaveLength(
			1,
		);
	});
});

describe("BrowserBrokerClient.fetchScreenshot", () => {
	test("returns bytes and mimeType on success", async () => {
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		const client = new BrowserBrokerClient({
			baseUrl: "http://127.0.0.1:4317",
			authToken: "root-token",
			fetch: async (url, init) => {
				expect(url).toContain("/api/feedback/evt_1/screenshot");
				expect(init?.headers).toMatchObject({
					Authorization: "Bearer root-token",
				});
				return new Response(pngBytes, {
					status: 200,
					headers: { "Content-Type": "image/png" },
				});
			},
		});
		const result = await client.fetchScreenshot("evt_1");
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect([...(result?.bytes ?? [])]).toEqual([...pngBytes]);
	});

	test("returns null when screenshot not found", async () => {
		const client = new BrowserBrokerClient({
			baseUrl: "http://127.0.0.1:4317",
			authToken: "root-token",
			fetch: async () => new Response(null, { status: 404 }),
		});
		const result = await client.fetchScreenshot("evt_missing");
		expect(result).toBeNull();
	});
});
