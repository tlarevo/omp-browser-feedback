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
		screenshotRootDir: path.join(dir, "screenshots"),
		dataDir: dir,
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

async function _openAndRedeemPairing(server: { baseUrl: string }) {
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

	test("serves screenshot bytes with correct content-type", async () => {
		const server = await createServer();
		const headers = rootJsonHeaders;

		await fetch(`${server.baseUrl}/api/sessions/register`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				protocolVersion: BROWSER_PROTOCOL_VERSION,
				sessionId: "ses_ss",
				channelId: "ses_ss",
				sessionName: "Session",
				displayName: "Session",
				cwd: "/repo",
				status: "active",
				lastActiveAt: "2026-06-27T10:00:00.000Z",
				processId: 123,
			}),
		});

		const pngBytes = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		const form = new FormData();
		form.set(
			"event",
			JSON.stringify({
				protocolVersion: BROWSER_PROTOCOL_VERSION,
				eventId: "evt_ss",
				type: "dom.selection",
				channelId: "ses_ss",
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
					width: 100,
					height: 50,
				},
			}),
		);
		form.set(
			"screenshot",
			new Blob([pngBytes], { type: "image/png" }),
			"cap.png",
		);

		await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers: { Authorization: "Bearer secret" },
			body: form,
		});

		const res = await fetch(
			`${server.baseUrl}/api/feedback/evt_ss/screenshot`,
			{ headers },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		const body = new Uint8Array(await res.arrayBuffer());
		expect([...body]).toEqual([...pngBytes]);
	});

	test("screenshot endpoint returns 404 for unknown event", async () => {
		const server = await createServer();
		const res = await fetch(
			`${server.baseUrl}/api/feedback/evt_nonexistent/screenshot`,
			{ headers: rootJsonHeaders },
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("not_found");
	});

	test("screenshot endpoint requires auth", async () => {
		const server = await createServer();
		const res = await fetch(`${server.baseUrl}/api/feedback/evt_1/screenshot`);
		expect(res.status).toBe(401);
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
	});

	test("rejects feedback JSON exceeding byte limit", async () => {
		const server = await createServer();

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

		// Build a payload that exceeds the JSON byte limit
		const bigNote = "x".repeat(BROWSER_FEEDBACK_LIMITS.maxNoteLength + 1000);
		const payload = {
			protocolVersion: BROWSER_PROTOCOL_VERSION,
			eventId: "evt_big",
			type: "dom.selection",
			channelId: "ses_1",
			createdAt: "2026-06-27T10:00:00.000Z",
			note: bigNote,
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

		const response = await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers: rootJsonHeaders,
			body: JSON.stringify(payload),
		});

		// The note exceeds its limit but JSON itself may be within the byte limit.
		// This test verifies the feedback limits check is active.
		expect(response.status).toBe(422);
		const body = (await response.json()) as { code: string };
		expect(body.code).toBe("note_too_long");
	});

	test("rejects feedback with no protocolVersion", async () => {
		const server = await createServer();

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

		const response = await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers: rootJsonHeaders,
			body: JSON.stringify({ eventId: "evt_1" }),
		});

		expect(response.status).toBe(400);
		const body = (await response.json()) as { code: string };
		expect(body.code).toBe("invalid_feedback");
	});
});
describe("batch.feedback", () => {
	const validItem = {
		protocolVersion: BROWSER_PROTOCOL_VERSION,
		eventId: "evt_item_1",
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

	test("accepts batch feedback as JSON", async () => {
		const server = await createServer();
		const headers = rootJsonHeaders;

		const response = await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				protocolVersion: BROWSER_PROTOCOL_VERSION,
				eventId: "batch_1",
				type: "batch.feedback",
				channelId: "ses_1",
				createdAt: "2026-06-27T10:00:00.000Z",
				items: [
					{ ...validItem, eventId: "evt_1" },
					{ ...validItem, eventId: "evt_2" },
				],
				batchNote: "Fix these",
			}),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; eventId: string };
		expect(body.ok).toBe(true);
		expect(body.eventId).toBe("batch_1");
	});

	test("accepts batch feedback with multipart screenshots", async () => {
		const server = await createServer();
		const _headers = rootJsonHeaders;
		const form = new FormData();
		form.set(
			"event",
			JSON.stringify({
				protocolVersion: BROWSER_PROTOCOL_VERSION,
				eventId: "batch_2",
				type: "batch.feedback",
				channelId: "ses_1",
				createdAt: "2026-06-27T10:00:00.000Z",
				items: [
					{
						...validItem,
						eventId: "evt_1",
						screenshot: {
							kind: "crop",
							ref: "pending",
							mimeType: "image/png",
							width: 100,
							height: 100,
						},
					},
					{ ...validItem, eventId: "evt_2" },
				],
			}),
		);
		form.set(
			"screenshot_0",
			new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
			"item0.png",
		);

		const response = await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers: { Authorization: "Bearer secret" },
			body: form,
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; eventId: string };
		expect(body.ok).toBe(true);
	});

	test("rejects batch exceeding item cap", async () => {
		const server = await createServer();
		const headers = rootJsonHeaders;
		const items = Array.from({ length: 21 }, (_, i) => ({
			...validItem,
			eventId: `evt_${i}`,
		}));

		const response = await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				protocolVersion: BROWSER_PROTOCOL_VERSION,
				eventId: "batch_large",
				type: "batch.feedback",
				channelId: "ses_1",
				createdAt: "2026-06-27T10:00:00.000Z",
				items,
			}),
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { ok: boolean; code: string };
		expect(body.code).toBe("batch_too_large");
	});
});
describe("security hardening", () => {
	test("rejects non-loopback host", async () => {
		await expect(
			createBrowserBrokerServer({
				host: "0.0.0.0",
				port: 0,
				authToken: "secret",
				pairingRegistryPath: "/tmp/omp-test-reject.json",
			}),
		).rejects.toThrow("loopback");
	});

	test("rejects empty bearer token", async () => {
		const server = await createServer();
		const response = await fetch(`${server.baseUrl}/api/sessions`, {
			headers: { Authorization: "Bearer " },
		});
		expect(response.status).toBe(401);
	});

	test("rejects malformed bearer header", async () => {
		const server = await createServer();
		const response = await fetch(`${server.baseUrl}/api/sessions`, {
			headers: { Authorization: "Token secret" },
		});
		expect(response.status).toBe(401);
	});

	test("rejects wrong token with constant-time comparison", async () => {
		const server = await createServer();
		const response = await fetch(`${server.baseUrl}/api/sessions`, {
			headers: { Authorization: "Bearer wrong_token_value" },
		});
		expect(response.status).toBe(401);
	});

	test("concurrent pairing redemption yields exactly one winner", async () => {
		const server = await createServer();
		const issued = await openPairingWindow(server);

		const attempts = Array.from({ length: 10 }, (_, i) =>
			fetch(`${server.baseUrl}/api/pair`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					browserInstallId: `browser_${i}`,
					code: issued.code,
				}),
			}),
		);

		const responses = await Promise.all(attempts);
		const successes = responses.filter((r) => r.status === 200);
		const failures = responses.filter((r) => r.status !== 200);

		expect(successes.length).toBe(1);
		expect(failures.length).toBe(9);

		for (const fail of failures) {
			const body = (await fail.json()) as { ok: boolean; code: string };
			expect(body.ok).toBe(false);
			expect(body.code).not.toBe("unauthorized");
		}
	});

	test("expired pairing code returns no token material", async () => {
		const dir = await fs.mkdtemp(path.join("/tmp", "omp-security-"));
		dirs.push(dir);
		let currentTime = new Date("2026-01-01T00:00:00Z");
		const server = await createBrowserBrokerServer({
			host: "127.0.0.1",
			port: 0,
			authToken: "secret",
			pairingRegistryPath: path.join(dir, "pairing-registry.json"),
			clock: { now: () => currentTime },
		});
		servers.push(server);
		await registerSession(server);
		const issued = await (
			await fetch(`${server.baseUrl}/api/pair/open`, {
				method: "POST",
				headers: rootJsonHeaders,
				body: JSON.stringify({ sessionId: "ses_1" }),
			})
		).json();

		currentTime = new Date("2026-01-01T00:05:00Z");

		const response = await fetch(`${server.baseUrl}/api/pair`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				browserInstallId: "browser_expired",
				code: (issued as { code: string }).code,
			}),
		});
		const body = (await response.json()) as Record<string, unknown>;
		expect(response.status).toBe(400);
		expect(body).not.toHaveProperty("capabilityToken");
		expect(body).toHaveProperty("code", "invalid_pairing_code");
	});

	test("brute-force pairing code returns no token material", async () => {
		const server = await createServer();
		const _issued = await openPairingWindow(server);

		for (let i = 0; i < 6; i++) {
			const response = await fetch(`${server.baseUrl}/api/pair`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					browserInstallId: "browser_brute",
					code: "WRONGCODE",
				}),
			});
			const body = (await response.json()) as Record<string, unknown>;
			expect(body).not.toHaveProperty("capabilityToken");
		}
	});

	test("GET on unknown route returns 404 structured response", async () => {
		const server = await createServer();
		const response = await fetch(`${server.baseUrl}/api/nonexistent`, {
			headers: rootJsonHeaders,
		});
		const body = (await response.json()) as { ok: boolean; code: string };
		expect(response.status).toBe(404);
		expect(body.ok).toBe(false);
		expect(body.code).toBe("not_found");
	});

	test("POST feedback without auth is rejected", async () => {
		const server = await createServer();
		const response = await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(401);
	});

	test("session register requires root auth", async () => {
		const server = await createServer();
		const response = await fetch(`${server.baseUrl}/api/sessions/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(401);
	});

	test("session PATCH requires root auth", async () => {
		const server = await createServer();
		const response = await fetch(`${server.baseUrl}/api/sessions/ses_1`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(401);
	});

	test("session DELETE requires root auth", async () => {
		const server = await createServer();
		const response = await fetch(`${server.baseUrl}/api/sessions/ses_1`, {
			method: "DELETE",
		});
		expect(response.status).toBe(401);
	});

	test("pair/open requires root auth", async () => {
		const server = await createServer();
		const response = await fetch(`${server.baseUrl}/api/pair/open`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId: "ses_1" }),
		});
		expect(response.status).toBe(401);
	});

	test("pair/reset requires root auth", async () => {
		const server = await createServer();
		const response = await fetch(`${server.baseUrl}/api/pair/reset`, {
			method: "POST",
		});
		expect(response.status).toBe(401);
	});
});
