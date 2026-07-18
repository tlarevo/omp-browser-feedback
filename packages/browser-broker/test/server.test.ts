import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	BROWSER_BROKER_SERVICE,
	BROWSER_FEEDBACK_LIMITS,
	BROWSER_PROTOCOL_VERSION,
} from "@oh-my-pi/browser-protocol";
import { createBrowserBrokerServer } from "../src/server";

const servers: Array<{ stop: () => void }> = [];
const dirs: string[] = [];

interface HealthResponse {
	service: string;
	protocol_version: number;
}

async function createServer() {
	const dir = await fs.mkdtemp(path.join("/tmp", "omp-browser-broker-"));
	dirs.push(dir);
	const server = await createBrowserBrokerServer({
		host: "127.0.0.1",
		port: 0,
		authToken: "secret",
		pairingRegistryPath: path.join(dir, "pairing-registry.json"),
		deliveryPath: path.join(dir, "delivery.json"),
	});
	servers.push(server);
	return server;
}

const rootJsonHeaders = {
	Authorization: "Bearer secret",
	"Content-Type": "application/json",
} satisfies Record<string, string>;

async function registerSession(server: { baseUrl: string }) {
	await fetch(`${server.baseUrl}/api/sessions/register`, {
		method: "POST",
		headers: rootJsonHeaders,
		body: JSON.stringify({
			protocolVersion: BROWSER_PROTOCOL_VERSION,
			sessionId: "ses_1",
			channelId: "ses_1",
			sessionName: "Session",
			displayName: "Session",
			cwd: "/repo",
			status: "active",
			lastActiveAt: "2026-06-27T10:00:00.000Z",
			processId: 123,
		}),
	});
}

async function openPairingWindow(server: { baseUrl: string }) {
	await registerSession(server);
	return (await (
		await fetch(`${server.baseUrl}/api/pair/open`, {
			method: "POST",
			headers: rootJsonHeaders,
			body: JSON.stringify({ sessionId: "ses_1" }),
		})
	).json()) as {
		code: string;
	};
}

async function redeemPairingCode(
	server: { baseUrl: string },
	code: string,
	headers: Record<string, string> = { "Content-Type": "application/json" },
) {
	return await fetch(`${server.baseUrl}/api/pair`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			browserInstallId: "browser_a",
			code,
			label: "Primary Browser",
		}),
	});
}

async function openAndRedeemPairing(server: { baseUrl: string }) {
	const issued = await openPairingWindow(server);
	return (await (await redeemPairingCode(server, issued.code)).json()) as {
		capabilityToken: string;
	};
}

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop();
	for (const dir of dirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("browser broker server", () => {
	test("serves unauthenticated health with broker identity", async () => {
		const server = await createServer();

		const response = await fetch(`${server.baseUrl}/api/health`);
		const body = (await response.json()) as HealthResponse;

		expect(response.status).toBe(200);
		expect(body.service).toBe(BROWSER_BROKER_SERVICE);
		expect(body.protocol_version).toBe(BROWSER_PROTOCOL_VERSION);
	});

	test("rejects session listing without bearer auth", async () => {
		const server = await createServer();

		const response = await fetch(`${server.baseUrl}/api/sessions`);

		expect(response.status).toBe(401);
	});

	test("updates and unregisters sessions by stable session id", async () => {
		const server = await createServer();
		const headers = rootJsonHeaders;

		await fetch(`${server.baseUrl}/api/sessions/register`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				protocolVersion: BROWSER_PROTOCOL_VERSION,
				sessionId: "ses_1",
				channelId: "ses_1",
				sessionName: "Before",
				displayName: "Before",
				cwd: "/repo",
				status: "active",
				lastActiveAt: "2026-06-27T10:00:00.000Z",
				processId: 123,
			}),
		});

		const patch = await fetch(`${server.baseUrl}/api/sessions/ses_1`, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ displayName: "After", status: "idle" }),
		});
		expect(patch.status).toBe(200);

		const list = (await (
			await fetch(`${server.baseUrl}/api/sessions`, { headers })
		).json()) as {
			sessions: Array<{ displayName: string; status: string }>;
		};
		expect(list.sessions[0]).toMatchObject({
			displayName: "After",
			status: "idle",
		});

		const remove = await fetch(`${server.baseUrl}/api/sessions/ses_1`, {
			method: "DELETE",
			headers,
		});
		expect(remove.status).toBe(200);

		const afterRemove = (await (
			await fetch(`${server.baseUrl}/api/sessions`, { headers })
		).json()) as {
			sessions: unknown[];
		};
		expect(afterRemove.sessions).toEqual([]);
	});

	test("accepts multipart feedback with screenshot binary", async () => {
		const server = await createServer();
		const headers = rootJsonHeaders;

		await fetch(`${server.baseUrl}/api/sessions/register`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				protocolVersion: BROWSER_PROTOCOL_VERSION,
				sessionId: "ses_1",
				channelId: "ses_1",
				sessionName: "Session",
				displayName: "Session",
				cwd: "/repo",
				status: "active",
				lastActiveAt: "2026-06-27T10:00:00.000Z",
				processId: 123,
			}),
		});

		const form = new FormData();
		form.set(
			"event",
			JSON.stringify({
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
				screenshot: {
					kind: "crop",
					ref: "pending",
					mimeType: "image/png",
					width: 1,
					height: 1,
				},
			}),
		);
		form.set(
			"screenshot",
			new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
			"capture.png",
		);

		const response = await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers: { Authorization: "Bearer secret" },
			body: form,
		});

		expect(response.status).toBe(200);
		const latest = (await (
			await fetch(`${server.baseUrl}/api/sessions/ses_1/feedback/latest`, {
				headers,
			})
		).json()) as {
			feedback: { payload: { screenshot: { ref: string } } };
		};
		expect(latest.feedback.payload.screenshot.ref).toBe(
			"screenshots/evt_1.png",
		);
	});

	test("pairing accepts requests without an Origin header", async () => {
		const server = await createServer();
		const issued = await openPairingWindow(server);

		const response = await redeemPairingCode(server, issued.code);
		const body = (await response.json()) as { capabilityToken: string };

		expect(response.status).toBe(200);
		expect(body.capabilityToken).toMatch(/^bcap_/);
	});

	test("pairing accepts a chrome-extension Origin header", async () => {
		const server = await createServer();
		const issued = await openPairingWindow(server);

		const response = await redeemPairingCode(server, issued.code, {
			"Content-Type": "application/json",
			Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});
		const body = (await response.json()) as { capabilityToken: string };

		expect(response.status).toBe(200);
		expect(body.capabilityToken).toMatch(/^bcap_/);
	});

	test("pairing accepts a localhost Origin header", async () => {
		const server = await createServer();
		const issued = await openPairingWindow(server);

		const response = await redeemPairingCode(server, issued.code, {
			"Content-Type": "application/json",
			Origin: "http://localhost:3000",
		});
		const body = (await response.json()) as { capabilityToken: string };

		expect(response.status).toBe(200);
		expect(body.capabilityToken).toMatch(/^bcap_/);
	});

	test("pairing rejects a hostile Origin header", async () => {
		const server = await createServer();
		const issued = await openPairingWindow(server);

		const response = await redeemPairingCode(server, issued.code, {
			"Content-Type": "application/json",
			Origin: "https://evil.example.com",
		});
		const body = (await response.json()) as {
			ok: false;
			code: string;
			message: string;
		};

		expect(response.status).toBe(403);
		expect(body.code).toBe("forbidden");
		expect(body.message).toContain("Cross-origin");
	});

	test("browser capability can list sessions without root token", async () => {
		const server = await createServer();
		const pair = await openAndRedeemPairing(server);
		const response = await fetch(`${server.baseUrl}/api/sessions`, {
			headers: { Authorization: `Bearer ${pair.capabilityToken}` },
		});
		const body = (await response.json()) as {
			sessions: Array<{ sessionId: string }>;
		};

		expect(response.ok).toBe(true);
		expect(body.sessions.map((session) => session.sessionId)).toContain(
			"ses_1",
		);
	});

	test("browser capability cannot read feedback history", async () => {
		const server = await createServer();
		const pair = await openAndRedeemPairing(server);
		const response = await fetch(
			`${server.baseUrl}/api/sessions/ses_1/feedback/latest`,
			{
				headers: { Authorization: `Bearer ${pair.capabilityToken}` },
			},
		);

		expect(response.status).toBe(401);
	});

	test("browser capability cannot open pairing windows", async () => {
		const server = await createServer();
		const pair = await openAndRedeemPairing(server);
		const response = await fetch(`${server.baseUrl}/api/pair/open`, {
			method: "POST",
			headers: { Authorization: `Bearer ${pair.capabilityToken}` },
		});

		expect(response.status).toBe(401);
	});
});

function wsUrl(
	server: { baseUrl: string },
	sessionId: string,
	token = "secret",
) {
	const base = server.baseUrl.replace("http", "ws");
	return `${base}/ws/omp/${encodeURIComponent(sessionId)}?token=${token}`;
}

function waitForOpen(ws: WebSocket): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	ws.addEventListener("open", () => resolve(), { once: true });
	ws.addEventListener("error", (e) => reject(e), { once: true });
	return promise;
}

function waitForClose(ws: WebSocket): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	ws.addEventListener("close", (e) => resolve(e.code), { once: true });
	return promise;
}

async function listSessions(server: {
	baseUrl: string;
}): Promise<Array<{ sessionId: string; presence: string }>> {
	const res = (await (
		await fetch(`${server.baseUrl}/api/sessions`, {
			headers: rootJsonHeaders,
		})
	).json()) as { sessions: Array<{ sessionId: string; presence: string }> };
	return res.sessions;
}

describe("websocket heartbeat and reconnect", () => {
	test("native pong keeps session active", async () => {
		const server = await createServer();
		await registerSession(server);

		const ws = new WebSocket(wsUrl(server, "ses_1"));
		await waitForOpen(ws);

		// Server sends pings at 15s intervals; Bun auto-pongs.
		// Presence should remain active while the socket is open.
		const sessions = await listSessions(server);
		expect(sessions[0]?.presence).toBe("active");

		ws.close();
		await waitForClose(ws);
	});

	test("socket close marks session disconnected", async () => {
		const server = await createServer();
		await registerSession(server);

		const ws = new WebSocket(wsUrl(server, "ses_1"));
		await waitForOpen(ws);
		ws.close();
		await waitForClose(ws);

		const sessions = await listSessions(server);
		expect(sessions[0]?.presence).toBe("disconnected");
	});

	test("reconnect restores same session id", async () => {
		const server = await createServer();
		await registerSession(server);

		// First connection then close
		const ws1 = new WebSocket(wsUrl(server, "ses_1"));
		await waitForOpen(ws1);
		ws1.close();
		await waitForClose(ws1);

		// Reconnect with same session id
		const ws2 = new WebSocket(wsUrl(server, "ses_1"));
		await waitForOpen(ws2);

		const sessions = await listSessions(server);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.sessionId).toBe("ses_1");
		expect(sessions[0]?.presence).toBe("active");

		ws2.close();
		await waitForClose(ws2);
	});

	test("feedback to disconnected session returns queued: true", async () => {
		const server = await createServer();
		await registerSession(server);

		// Connect then disconnect
		const ws = new WebSocket(wsUrl(server, "ses_1"));
		await waitForOpen(ws);
		ws.close();
		await waitForClose(ws);

		// Send feedback to the disconnected session
		const response = (await (
			await fetch(`${server.baseUrl}/api/feedback`, {
				method: "POST",
				headers: rootJsonHeaders,
				body: JSON.stringify({
					protocolVersion: BROWSER_PROTOCOL_VERSION,
					eventId: "evt_q1",
					type: "dom.selection",
					channelId: "ses_1",
					createdAt: "2026-07-18T10:00:00.000Z",
					page: {
						url: "https://example.com",
						title: "Example",
						viewport: {
							width: 1200,
							height: 800,
							devicePixelRatio: 2,
						},
					},
					element: {
						selector: "button",
						tagName: "BUTTON",
						outerHtml: "<button>Save</button>",
						attributes: {},
						bounds: { x: 1, y: 2, width: 3, height: 4 },
						computedStyles: { display: "block" },
					},
				}),
			})
		).json()) as {
			ok: boolean;
			eventId: string;
			queued: boolean;
			presence: string;
		};

		expect(response.ok).toBe(true);
		expect(response.queued).toBe(true);
		expect(response.presence).toBe("disconnected");
	});
	test("v1 client stays active via native pong without heartbeat frames", async () => {
		const server = await createServer();

		// Register a v1 session — no custom heartbeat frames
		await fetch(`${server.baseUrl}/api/sessions/register`, {
			method: "POST",
			headers: rootJsonHeaders,
			body: JSON.stringify({
				protocolVersion: 1,
				sessionId: "v1_ses",
				channelId: "v1_ses",
				sessionName: "V1 Session",
				displayName: "V1 Session",
				cwd: "/repo",
				status: "active",
				lastActiveAt: "2026-07-18T10:00:00.000Z",
				processId: 1,
			}),
		});

		// v1 client opens WebSocket — server pings, runtime auto-pongs
		const ws = new WebSocket(wsUrl(server, "v1_ses"));
		await waitForOpen(ws);

		const sessions = await listSessions(server);
		const v1 = sessions.find((s) => s.sessionId === "v1_ses");
		expect(v1).toBeDefined();
		expect(v1?.presence).toBe("active");

		ws.close();
		await waitForClose(ws);
	});
});
// ── Payload limit enforcement ──────────────────────────────────────────────

describe("payload limit enforcement", () => {
	const AUTH = { Authorization: "Bearer secret" };
	const VERSION = BROWSER_PROTOCOL_VERSION;

	function feedbackJson(overrides: Record<string, unknown> = {}) {
		return JSON.stringify({
			protocolVersion: VERSION,
			eventId: "evt_limit_1",
			type: "dom.selection",
			channelId: "ses_lim",
			createdAt: "2026-07-18T00:00:00.000Z",
			page: {
				url: "https://example.com",
				title: "Example",
				viewport: { width: 1200, height: 800, devicePixelRatio: 2 },
			},
			element: {
				selector: "div",
				tagName: "DIV",
				outerHtml: "<div>x</div>",
				attributes: {},
				bounds: { x: 0, y: 0, width: 10, height: 10 },
				computedStyles: {},
			},
			...overrides,
		});
	}

	async function registerTestSession(
		server: { baseUrl: string },
		sessionId: string,
	) {
		await fetch(`${server.baseUrl}/api/sessions/register`, {
			method: "POST",
			headers: rootJsonHeaders,
			body: JSON.stringify({
				protocolVersion: VERSION,
				sessionId,
				channelId: sessionId,
				sessionName: "Test",
				displayName: "Test",
				cwd: "/repo",
				status: "active",
				lastActiveAt: "2026-07-18T00:00:00.000Z",
				processId: 1,
			}),
		});
	}

	async function feedbackCount(
		server: { baseUrl: string },
		sessionId: string,
	): Promise<number> {
		const resp = await fetch(
			`${server.baseUrl}/api/sessions/${sessionId}/feedback`,
			{ headers: AUTH },
		);
		const body = (await resp.json()) as { feedback: unknown[] };
		return body.feedback.length;
	}

	test("returns 413 for oversized JSON body and persists nothing", async () => {
		const server = await createServer();
		await registerTestSession(server, "ses_lim");
		const bigNote = "x".repeat(600 * 1024);
		const body = feedbackJson({ note: bigNote, channelId: "ses_lim" });
		const response = await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers: { ...AUTH, "Content-Type": "application/json" },
			body,
		});
		expect(response.status).toBe(413);
		const json = (await response.json()) as { code: string };
		expect(json.code).toBe("payload_too_large");
		expect(await feedbackCount(server, "ses_lim")).toBe(0);
	});

	test("returns 413 for oversized multipart container and persists nothing", async () => {
		const server = await createServer();
		await registerTestSession(server, "ses_lim");
		const form = new FormData();
		form.set("event", feedbackJson({ channelId: "ses_lim" }));
		const padSize = 11 * 1024 * 1024; // > maxMultipartBytes
		form.set(
			"screenshot",
			new Blob([new Uint8Array(padSize)], { type: "image/png" }),
			"big.png",
		);
		const response = await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers: AUTH,
			body: form,
		});
		expect(response.status).toBe(413);
		const json = (await response.json()) as { code: string };
		expect(json.code).toBe("payload_too_large");
		expect(await feedbackCount(server, "ses_lim")).toBe(0);
	});

	test("returns 413 for oversized screenshot and persists no file", async () => {
		const screenshotDir = await fs.mkdtemp(
			path.join("/tmp", "omp-screenshots-"),
		);
		dirs.push(screenshotDir);
		const server = await createBrowserBrokerServer({
			host: "127.0.0.1",
			port: 0,
			authToken: "secret",
			screenshotRootDir: screenshotDir,
		});
		servers.push(server);
		await registerTestSession(server, "ses_lim");
		const form = new FormData();
		form.set(
			"event",
			feedbackJson({
				channelId: "ses_lim",
				screenshot: {
					kind: "crop",
					ref: "pending",
					mimeType: "image/png",
					width: 100,
					height: 100,
				},
			}),
		);
		const bigScreenshot = new Uint8Array(
			BROWSER_FEEDBACK_LIMITS.maxScreenshotBytes + 1,
		);
		form.set(
			"screenshot",
			new Blob([bigScreenshot], { type: "image/png" }),
			"big.png",
		);
		const response = await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers: AUTH,
			body: form,
		});
		expect(response.status).toBe(413);
		const json = (await response.json()) as { code: string };
		expect(json.code).toBe("payload_too_large");
		const files = await fs.readdir(screenshotDir);
		expect(files).toHaveLength(0);
		expect(await feedbackCount(server, "ses_lim")).toBe(0);
	});

	test("returns 422 for note exceeding maxNoteLength and persists nothing", async () => {
		const server = await createServer();
		await registerTestSession(server, "ses_lim");
		const bigNote = "n".repeat(8_001);
		const body = feedbackJson({ note: bigNote, channelId: "ses_lim" });
		const response = await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers: { ...AUTH, "Content-Type": "application/json" },
			body,
		});
		expect(response.status).toBe(422);
		const json = (await response.json()) as {
			code: string;
			path: string;
			violations: Array<{ code: string; path: string }>;
		};
		expect(json.code).toBe("note_too_long");
		expect(json.path).toBe("note");
		expect(json.violations).toHaveLength(1);
		expect(json.violations[0].code).toBe("note_too_long");
		expect(await feedbackCount(server, "ses_lim")).toBe(0);
	});

	test("accepts note exactly at maxNoteLength", async () => {
		const server = await createServer();
		await registerTestSession(server, "ses_lim");
		const note = "n".repeat(8_000);
		const body = feedbackJson({ note, channelId: "ses_lim" });
		const response = await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers: { ...AUTH, "Content-Type": "application/json" },
			body,
		});
		expect(response.status).toBe(200);
		expect(await feedbackCount(server, "ses_lim")).toBe(1);
	});

	test("returns 422 for outerHtml exceeding maxOuterHtmlLength", async () => {
		const server = await createServer();
		await registerTestSession(server, "ses_lim");
		const bigHtml = "<div>".repeat(4_001);
		const body = feedbackJson({
			channelId: "ses_lim",
			element: {
				selector: "div",
				tagName: "DIV",
				outerHtml: bigHtml,
				attributes: {},
				bounds: { x: 0, y: 0, width: 10, height: 10 },
				computedStyles: {},
			},
		});
		const response = await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers: { ...AUTH, "Content-Type": "application/json" },
			body,
		});
		expect(response.status).toBe(422);
		const json = (await response.json()) as { code: string; path: string };
		expect(json.code).toBe("outer_html_too_long");
		expect(json.path).toBe("element.outerHtml");
		expect(await feedbackCount(server, "ses_lim")).toBe(0);
	});

	test("returns 422 for attribute count exceeding maxAttributeCount", async () => {
		const server = await createServer();
		await registerTestSession(server, "ses_lim");
		const attrs: Record<string, string> = {};
		for (let i = 0; i < 81; i++) attrs[`a${i}`] = "v";
		const body = feedbackJson({
			channelId: "ses_lim",
			element: {
				selector: "div",
				tagName: "DIV",
				outerHtml: "<div>x</div>",
				attributes: attrs,
				bounds: { x: 0, y: 0, width: 10, height: 10 },
				computedStyles: {},
			},
		});
		const response = await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers: { ...AUTH, "Content-Type": "application/json" },
			body,
		});
		expect(response.status).toBe(422);
		const json = (await response.json()) as { code: string };
		expect(json.code).toBe("attribute_count_exceeded");
		expect(await feedbackCount(server, "ses_lim")).toBe(0);
	});
});
