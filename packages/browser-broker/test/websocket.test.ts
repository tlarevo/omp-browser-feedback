import { afterEach, describe, expect, test } from "bun:test";
import { BROWSER_PROTOCOL_VERSION } from "@oh-my-pi/browser-protocol";
import { createBrowserBrokerServer } from "../src/server";

const servers: Array<{ stop: () => void }> = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop();
});

const headers = {
	Authorization: "Bearer secret",
	"Content-Type": "application/json",
};

function registration() {
	return {
		protocolVersion: BROWSER_PROTOCOL_VERSION,
		sessionId: "ses_1",
		channelId: "ses_1",
		sessionName: "Session",
		displayName: "Session",
		cwd: "/repo",
		status: "active",
		lastActiveAt: "2026-06-27T10:00:00.000Z",
		processId: 123,
	};
}

function feedback() {
	return {
		protocolVersion: BROWSER_PROTOCOL_VERSION,
		eventId: "evt_1",
		type: "dom.selection",
		channelId: "ses_1",
		createdAt: "2026-06-27T10:00:00.000Z",
		page: {
			url: "https://example.com",
			title: "Example",
			viewport: { width: 1200, height: 800, devicePixelRatio: 2 },
		},
		element: {
			selector: "button",
			tagName: "BUTTON",
			outerHtml: "<button>Save</button>",
			attributes: {},
			bounds: { x: 1, y: 2, width: 3, height: 4 },
			computedStyles: { display: "block" },
		},
	};
}

describe("browser broker websocket security", () => {
	test("rejects WebSocket upgrade from a non-local Origin header", async () => {
		const server = await createBrowserBrokerServer({
			host: "127.0.0.1",
			port: 0,
			authToken: "secret",
		});
		servers.push(server);

		const wsUrl = `${server.baseUrl.replace("http://", "ws://")}/ws/omp/ses_1?token=secret`;
		const rejected = await new Promise<boolean>((resolve, reject) => {
			const ws = new WebSocket(wsUrl, {
				headers: { Origin: "https://evil.example.com" },
			} as unknown as ConstructorParameters<typeof WebSocket>[1]);
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for WS rejection")),
				2_000,
			);
			ws.onerror = () => {
				clearTimeout(timer);
				resolve(true);
			};
			ws.onclose = (event) => {
				clearTimeout(timer);
				resolve(!event.wasClean || event.code !== 1000);
			};
		});
		expect(rejected).toBe(true);
	});

	test("allows WebSocket upgrade from a chrome-extension Origin", async () => {
		const server = await createBrowserBrokerServer({
			host: "127.0.0.1",
			port: 0,
			authToken: "secret",
		});
		servers.push(server);

		await fetch(`${server.baseUrl}/api/sessions/register`, {
			method: "POST",
			headers,
			body: JSON.stringify(registration()),
		});
		const message = await new Promise<Record<string, unknown>>(
			(resolve, reject) => {
				const wsUrl = `${server.baseUrl.replace("http://", "ws://")}/ws/omp/ses_1?token=secret`;
				const ws = new WebSocket(wsUrl, {
					headers: {
						Origin: "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef",
					},
				} as unknown as ConstructorParameters<typeof WebSocket>[1]);
				const timer = setTimeout(
					() =>
						reject(
							new Error("Timed out waiting for chrome-extension WS message"),
						),
					2_000,
				);
				ws.onmessage = (event) => {
					clearTimeout(timer);
					ws.close();
					resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
				};
				ws.onerror = () => {
					clearTimeout(timer);
					reject(new Error("WS errored with chrome-extension origin"));
				};
				ws.onopen = () => {
					void fetch(`${server.baseUrl}/api/feedback`, {
						method: "POST",
						headers,
						body: JSON.stringify(feedback()),
					});
				};
			},
		);
		expect(message).toMatchObject({ type: "browser.feedback" });
	});
});

describe("browser broker websocket routing", () => {
	test("pushes submitted feedback to a connected OMP session socket", async () => {
		const server = await createBrowserBrokerServer({
			host: "127.0.0.1",
			port: 0,
			authToken: "secret",
		});
		servers.push(server);

		await fetch(`${server.baseUrl}/api/sessions/register`, {
			method: "POST",
			headers,
			body: JSON.stringify(registration()),
		});

		const message = await new Promise<Record<string, unknown>>(
			(resolve, reject) => {
				const ws = new WebSocket(
					`${server.baseUrl.replace("http://", "ws://")}/ws/omp/ses_1?token=secret`,
				);
				const timer = setTimeout(
					() =>
						reject(
							new Error("Timed out waiting for broker websocket feedback"),
						),
					2_000,
				);
				ws.onmessage = (event) => {
					clearTimeout(timer);
					ws.close();
					resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
				};
				ws.onerror = () => {
					clearTimeout(timer);
					reject(new Error("Broker websocket errored"));
				};
				ws.onopen = () => {
					void fetch(`${server.baseUrl}/api/feedback`, {
						method: "POST",
						headers,
						body: JSON.stringify(feedback()),
					});
				};
			},
		);

		expect(message).toMatchObject({
			type: "browser.feedback",
			event: { eventId: "evt_1", channelId: "ses_1" },
		});
	});

	test("replays stored feedback when an OMP session socket connects", async () => {
		const server = await createBrowserBrokerServer({
			host: "127.0.0.1",
			port: 0,
			authToken: "secret",
		});
		servers.push(server);

		await fetch(`${server.baseUrl}/api/sessions/register`, {
			method: "POST",
			headers,
			body: JSON.stringify(registration()),
		});
		await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers,
			body: JSON.stringify(feedback()),
		});

		const message = await new Promise<Record<string, unknown>>(
			(resolve, reject) => {
				const ws = new WebSocket(
					`${server.baseUrl.replace("http://", "ws://")}/ws/omp/ses_1?token=secret`,
				);
				const timer = setTimeout(
					() =>
						reject(new Error("Timed out waiting for replayed broker feedback")),
					2_000,
				);
				ws.onmessage = (event) => {
					clearTimeout(timer);
					ws.close();
					resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
				};
				ws.onerror = () => {
					clearTimeout(timer);
					reject(new Error("Broker websocket errored"));
				};
			},
		);

		expect(message).toMatchObject({
			type: "browser.feedback",
			event: { eventId: "evt_1", channelId: "ses_1" },
		});
	});

	test("marks a session disconnected when the OMP socket closes", async () => {
		const server = await createBrowserBrokerServer({
			host: "127.0.0.1",
			port: 0,
			authToken: "secret",
		});
		servers.push(server);

		await fetch(`${server.baseUrl}/api/sessions/register`, {
			method: "POST",
			headers,
			body: JSON.stringify(registration()),
		});

		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(
				`${server.baseUrl.replace("http://", "ws://")}/ws/omp/ses_1?token=secret`,
			);
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for websocket open/close")),
				2_000,
			);
			ws.onopen = () => ws.close();
			ws.onclose = () => {
				clearTimeout(timer);
				resolve();
			};
			ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error("Broker websocket errored"));
			};
		});

		const body = (await (
			await fetch(`${server.baseUrl}/api/sessions`, { headers })
		).json()) as {
			sessions: Array<{ sessionId: string; status: string }>;
		};

		expect(body.sessions).toEqual([
			expect.objectContaining({
				sessionId: "ses_1",
				status: "disconnected",
			}),
		]);
	});
});
