import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { BROWSER_PROTOCOL_VERSION } from "@oh-my-pi/browser-protocol";
import { createBrowserBrokerServer } from "../src/server";

const servers: Array<{ stop: () => void }> = [];
const dirs: string[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop();
	// Recursive cleanup; catch errors from open file handles.
	for (const dir of dirs.splice(0)) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
});

let _fileIdx = 0;

async function createServer() {
	const dir = await fsp.mkdtemp(path.join("/tmp", "omp-ws-test-"));
	dirs.push(dir);
	const server = await createBrowserBrokerServer({
		host: "127.0.0.1",
		port: 0,
		authToken: "secret",
		deliveryPath: path.join(dir, `delivery-${_fileIdx++}.json`),
	});
	servers.push(server);
	return server;
}

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

/**
 * Send feedback and wait for both the HTTP response AND the WS message.
 * Without this, `void fetch` is in-flight when afterEach stops the server,
 * causing ECONNRESET.
 */
async function sendFeedbackAndWaitForWs(
	server: { baseUrl: string },
	fb: {
		protocolVersion: number;
		eventId: string;
		type: string;
		channelId: string;
		createdAt: string;
		page: Record<string, unknown>;
		element: Record<string, unknown>;
	},
): Promise<{ response: Response; message: Record<string, unknown> }> {
	const { promise: opened, resolve: open } = Promise.withResolvers<void>();
	const messageP = new Promise<Record<string, unknown>>((resolve, reject) => {
		const ws = new WebSocket(
			`${server.baseUrl.replace("http://", "ws://")}/ws/omp/ses_1?token=secret`,
		);
		const timer = setTimeout(
			() => reject(new Error("Timed out waiting for WS feedback")),
			2_000,
		);
		ws.onopen = () => {
			open();
		};
		ws.onmessage = (event) => {
			clearTimeout(timer);
			ws.close();
			resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
		};
		ws.onerror = () => {
			clearTimeout(timer);
			reject(new Error("Broker websocket errored"));
		};
	});

	// Await socket open before POST to avoid broker sending to no socket.
	await opened;

	const response = await fetch(`${server.baseUrl}/api/feedback`, {
		method: "POST",
		headers,
		body: JSON.stringify(fb),
	});

	const message = await messageP;
	return { response, message };
}

describe("browser broker websocket security", () => {
	test("rejects WebSocket upgrade from a non-local Origin header", async () => {
		const server = await createServer();

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
		const server = await createServer();

		await fetch(`${server.baseUrl}/api/sessions/register`, {
			method: "POST",
			headers,
			body: JSON.stringify(registration()),
		});

		const { promise: opened, resolve: open } = Promise.withResolvers<void>();
		const wsP = new Promise<Record<string, unknown>>((resolve, reject) => {
			const ws = new WebSocket(
				`${server.baseUrl.replace("http://", "ws://")}/ws/omp/ses_1?token=secret`,
				{
					headers: {
						Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
				} as unknown as ConstructorParameters<typeof WebSocket>[1],
			);
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for WS feedback")),
				2_000,
			);
			ws.onopen = () => open();
			ws.onmessage = (event) => {
				clearTimeout(timer);
				ws.close();
				resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
			};
			ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error("Broker websocket errored"));
			};
		});

		await opened;
		const fbResponse = await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers,
			body: JSON.stringify(feedback()),
		});
		expect(fbResponse.ok).toBe(true);

		const message = await wsP;
		expect(message).toMatchObject({ type: "browser.feedback" });
	});

	test("allows WebSocket upgrade from a localhost Origin", async () => {
		const server = await createServer();

		await fetch(`${server.baseUrl}/api/sessions/register`, {
			method: "POST",
			headers,
			body: JSON.stringify(registration()),
		});

		const { promise: opened, resolve: open } = Promise.withResolvers<void>();
		const wsP = new Promise<Record<string, unknown>>((resolve, reject) => {
			const wsUrl = `${server.baseUrl.replace("http://", "ws://")}/ws/omp/ses_1?token=secret`;
			const ws = new WebSocket(wsUrl, {
				headers: { Origin: "http://localhost:3000" },
			} as unknown as ConstructorParameters<typeof WebSocket>[1]);
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for WS message")),
				2_000,
			);
			ws.onopen = () => open();
			ws.onmessage = (event) => {
				clearTimeout(timer);
				ws.close();
				resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
			};
			ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error("WS errored with localhost origin"));
			};
		});

		await opened;
		const fbResponse = await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers,
			body: JSON.stringify(feedback()),
		});
		expect(fbResponse.ok).toBe(true);

		const message = await wsP;
		expect(message).toMatchObject({ type: "browser.feedback" });
	});
});

describe("browser broker websocket routing", () => {
	test("pushes submitted feedback to a connected OMP session socket", async () => {
		const server = await createServer();

		await fetch(`${server.baseUrl}/api/sessions/register`, {
			method: "POST",
			headers,
			body: JSON.stringify(registration()),
		});

		const { message } = await sendFeedbackAndWaitForWs(server, feedback());

		expect(message).toMatchObject({
			type: "browser.feedback",
			event: { eventId: "evt_1", channelId: "ses_1" },
		});
	});

	test("replays stored feedback when an OMP session socket connects", async () => {
		const server = await createServer();

		await fetch(`${server.baseUrl}/api/sessions/register`, {
			method: "POST",
			headers,
			body: JSON.stringify(registration()),
		});

		const fbResponse = await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers,
			body: JSON.stringify(feedback()),
		});
		expect(fbResponse.ok).toBe(true);

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
		const server = await createServer();

		await fetch(`${server.baseUrl}/api/sessions/register`, {
			method: "POST",
			headers,
			body: JSON.stringify(registration()),
		});

		const ws = new WebSocket(
			`${server.baseUrl.replace("http://", "ws://")}/ws/omp/ses_1?token=secret`,
		);
		await new Promise<void>((resolve) => {
			ws.onopen = () => resolve();
		});
		ws.close();
		await new Promise((r) => setTimeout(r, 50));

		const list = (await (
			await fetch(`${server.baseUrl}/api/sessions`, { headers })
		).json()) as {
			sessions: Array<{ status: string }>;
		};
		expect(list.sessions[0]?.status).toBe("disconnected");
	});
});
