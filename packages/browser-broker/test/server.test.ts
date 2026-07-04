import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	BROWSER_BROKER_SERVICE,
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

async function openAndRedeemPairing(server: { baseUrl: string }) {
	await registerSession(server);
	const issued = (await (
		await fetch(`${server.baseUrl}/api/pair/open`, {
			method: "POST",
			headers: rootJsonHeaders,
			body: JSON.stringify({ sessionId: "ses_1" }),
		})
	).json()) as {
		code: string;
	};
	return (await (
		await fetch(`${server.baseUrl}/api/pair`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				browserInstallId: "browser_a",
				code: issued.code,
				label: "Primary Browser",
			}),
		})
	).json()) as {
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
