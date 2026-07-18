import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	BROWSER_BROKER_SERVICE,
	BROWSER_PROTOCOL_VERSION,
	type BrowserProtocolVersion,
} from "@oh-my-pi/browser-protocol";
import {
	discoverCompatibleBroker,
	readDiscoveryFile,
	writeDiscoveryFile,
	type BrowserBrokerDiscovery,
} from "../src/discovery";
import { createBrowserBrokerServer } from "../src/server";

const servers: Array<{ stop: () => void }> = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop();
	for (const dir of dirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

const AUTH_TOKEN = "root-secret";

async function createServer(pairingRegistryPath?: string) {
	const dir = await fs.mkdtemp(path.join("/tmp", "omp-broker-recovery-"));
	dirs.push(dir);
	const registryPath =
		pairingRegistryPath ?? path.join(dir, "pairing-registry.json");
	const server = await createBrowserBrokerServer({
		host: "127.0.0.1",
		port: 0,
		authToken: AUTH_TOKEN,
		pairingRegistryPath: registryPath,
	});
	servers.push(server);
	return { server, dir, registryPath };
}

function authHeaders(token = AUTH_TOKEN) {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	} satisfies Record<string, string>;
}

async function registerSession(
	baseUrl: string,
	sessionId: string,
	channelId = sessionId,
) {
	await fetch(`${baseUrl}/api/sessions/register`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			protocolVersion: BROWSER_PROTOCOL_VERSION,
			sessionId,
			channelId,
			sessionName: "Test",
			displayName: "Test",
			cwd: "/repo",
			status: "active",
			lastActiveAt: "2026-06-27T10:00:00.000Z",
			processId: 100,
		}),
	});
}

async function openPairing(baseUrl: string, sessionId: string) {
	await registerSession(baseUrl, sessionId);
	return (await (
		await fetch(`${baseUrl}/api/pair/open`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({ sessionId }),
		})
	).json()) as { code: string };
}

async function redeemCode(
	baseUrl: string,
	code: string,
	browserInstallId = "browser_a",
) {
	return (await (
		await fetch(`${baseUrl}/api/pair`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ browserInstallId, code, label: "Primary" }),
		})
	).json()) as { capabilityToken: string };
}

async function openAndRedeem(
	baseUrl: string,
	sessionId: string,
	browserInstallId = "browser_a",
) {
	const issued = await openPairing(baseUrl, sessionId);
	return redeemCode(baseUrl, issued.code, browserInstallId);
}

function feedbackPayload(channelId: string, eventId: string) {
	return {
		protocolVersion: BROWSER_PROTOCOL_VERSION,
		eventId,
		type: "dom.selection" as const,
		channelId,
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
			bounds: { x: 0, y: 0, width: 10, height: 10 },
			computedStyles: { display: "block" },
		},
	};
}

async function sendFeedback(
	baseUrl: string,
	token: string,
	channelId: string,
	eventId: string,
) {
	return fetch(`${baseUrl}/api/feedback`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(feedbackPayload(channelId, eventId)),
	});
}

async function getFeedbackList(baseUrl: string, sessionId: string) {
	const resp = await fetch(
		`${baseUrl}/api/sessions/${sessionId}/feedback`,
		{ headers: authHeaders() },
	);
	return (await resp.json()) as {
		feedback: Array<{ eventId: string }>;
	};
}

// --- Scenario 1: Port handling ---
describe("port recovery", () => {
	test("port 0 resolves to a random available port", async () => {
		const { server } = await createServer();
		expect(server.port).toBeGreaterThan(0);

		const health = await (
			await fetch(`${server.baseUrl}/api/health`)
		).json() as { service: string };
		expect(health.service).toBe(BROWSER_BROKER_SERVICE);
	});

	test("each server instance gets a unique port", async () => {
		const s1 = await createServer();
		const s2 = await createServer();
		expect(s1.server.port).not.toBe(s2.server.port);
	});

	test("rejects non-loopback host", async () => {
		const dir = await fs.mkdtemp(path.join("/tmp", "omp-host-"));
		dirs.push(dir);
		await expect(
			createBrowserBrokerServer({
				host: "0.0.0.0",
				port: 0,
				authToken: AUTH_TOKEN,
				pairingRegistryPath: path.join(dir, "registry.json"),
			}),
		).rejects.toThrow(/loopback/);
	});
});

// --- Scenario 2: Discovery file stale detection ---
describe("discovery recovery", () => {
	test("returns undefined for stale discovery metadata pointing to dead port", async () => {
		const broker = await discoverCompatibleBroker({
			host: "127.0.0.1",
			ports: [59999],
			fetch: async () => new Response("nope", { status: 404 }),
		});
		expect(broker).toBeUndefined();
	});

	test("skips incompatible protocol versions and finds compatible broker", async () => {
		const broker = await discoverCompatibleBroker({
			host: "127.0.0.1",
			ports: [4317, 4318],
			fetch: async (url) => {
				const port = String(url).includes(":4317/") ? 4317 : 4318;
				if (port === 4317) {
					return Response.json({
						service: BROWSER_BROKER_SERVICE,
						protocol_version: 999999,
						broker_id: "old-version",
					});
				}
				return Response.json({
					service: BROWSER_BROKER_SERVICE,
					protocol_version: BROWSER_PROTOCOL_VERSION,
					broker_id: "compatible",
				});
			},
		});
		expect(broker).toEqual({
			baseUrl: "http://127.0.0.1:4318",
			brokerId: "compatible",
			port: 4318,
		});
	});

	test("detects and reads a valid discovery file, rejects a corrupt one", async () => {
		const dir = await fs.mkdtemp(path.join("/tmp", "omp-discov-"));
		dirs.push(dir);
		const validPath = path.join(dir, "valid.json");
		const corruptPath = path.join(dir, "corrupt.json");

		const valid: BrowserBrokerDiscovery = {
			protocol_version: BROWSER_PROTOCOL_VERSION as BrowserProtocolVersion,
			broker_id: "ok",
			host: "127.0.0.1",
			port: 4317,
			base_url: "http://127.0.0.1:4317",
			ws_url: "ws://127.0.0.1:4317",
			auth_token: "tok",
			pid: 12345,
			started_at: "2026-06-27T10:00:00.000Z",
		};
		await writeDiscoveryFile(validPath, valid);
		const read = await readDiscoveryFile(validPath);
		expect(read).toEqual(valid);

		await fs.writeFile(corruptPath, "not json {{{");
		await expect(readDiscoveryFile(corruptPath)).rejects.toThrow();
	});
});

// --- Scenario 3: Broker restart with capability preserved ---
describe("restart with capability registry preserved", () => {
	test("capability survives broker stop and restart with same registry path", async () => {
		const dir = await fs.mkdtemp(path.join("/tmp", "omp-restart-"));
		dirs.push(dir);
		const registryPath = path.join(dir, "registry.json");

		// Start broker, pair, get capability token
		const s1 = await createBrowserBrokerServer({
			host: "127.0.0.1",
			port: 0,
			authToken: AUTH_TOKEN,
			pairingRegistryPath: registryPath,
		});
		await registerSession(s1.baseUrl, "ses_1");
		const issued = await openPairing(s1.baseUrl, "ses_1");
		const { capabilityToken } = await redeemCode(s1.baseUrl, issued.code);
		expect(capabilityToken).toMatch(/^bcap_/);
		s1.stop();

		// Registry file should exist after pairing
		expect(await fs.access(registryPath).then(() => true, () => false)).toBe(
			true,
		);

		// Start new broker with same registry path
		const s2 = await createBrowserBrokerServer({
			host: "127.0.0.1",
			port: 0,
			authToken: AUTH_TOKEN,
			pairingRegistryPath: registryPath,
		});
		servers.push(s2);

		// Capability still valid — can list sessions
		const resp = await fetch(`${s2.baseUrl}/api/sessions`, {
			headers: authHeaders(capabilityToken),
		});
		expect(resp.ok).toBe(true);
		const body = (await resp.json()) as { sessions: unknown[] };
		expect(body.sessions).toBeDefined();
	});
});

// --- Scenario 4: Broker restart with registry lost ---
describe("restart with registry lost or reset", () => {
	test("registry loss invalidates existing capability tokens", async () => {
		const dir = await fs.mkdtemp(path.join("/tmp", "omp-lost-"));
		dirs.push(dir);
		const registryPath = path.join(dir, "registry.json");

		// Pair
		const s1 = await createBrowserBrokerServer({
			host: "127.0.0.1",
			port: 0,
			authToken: AUTH_TOKEN,
			pairingRegistryPath: registryPath,
		});
		await registerSession(s1.baseUrl, "ses_1");
		const issued = await openPairing(s1.baseUrl, "ses_1");
		const { capabilityToken } = await redeemCode(s1.baseUrl, issued.code);

		// Verify valid before restart
		const before = await fetch(`${s1.baseUrl}/api/sessions`, {
			headers: authHeaders(capabilityToken),
		});
		expect(before.ok).toBe(true);
		s1.stop();

		// Delete registry (simulates data loss)
		await fs.unlink(registryPath);

		// New broker starts fresh — capability invalid
		const s2 = await createBrowserBrokerServer({
			host: "127.0.0.1",
			port: 0,
			authToken: AUTH_TOKEN,
			pairingRegistryPath: registryPath,
		});
		servers.push(s2);

		const resp = await fetch(`${s2.baseUrl}/api/sessions`, {
			headers: authHeaders(capabilityToken),
		});
		expect(resp.status).toBe(401);
	});

	test("capability invalid after /api/pair/reset", async () => {
		const { server } = await createServer();
		const { capabilityToken } = await openAndRedeem(server.baseUrl, "ses_1");

		// Confirm valid first
		const before = await fetch(`${server.baseUrl}/api/sessions`, {
			headers: authHeaders(capabilityToken),
		});
		expect(before.ok).toBe(true);

		// Reset via HTTP endpoint (server's own store)
		const reset = await fetch(`${server.baseUrl}/api/pair/reset`, {
			method: "POST",
			headers: authHeaders(),
		});
		expect(reset.ok).toBe(true);

		// Capability now invalid
		const after = await fetch(`${server.baseUrl}/api/sessions`, {
			headers: authHeaders(capabilityToken),
		});
		expect(after.status).toBe(401);
	});

	test("new pairing required after capability revoked via /api/pair/reset", async () => {
		const { server } = await createServer();

		// First pairing
		const { capabilityToken } = await openAndRedeem(server.baseUrl, "ses_1");

		// Revoke via HTTP
		const reset = await fetch(`${server.baseUrl}/api/pair/reset`, {
			method: "POST",
			headers: authHeaders(),
		});
		expect(reset.ok).toBe(true);

		// Old token rejected
		const oldResp = await fetch(`${server.baseUrl}/api/sessions`, {
			headers: authHeaders(capabilityToken),
		});
		expect(oldResp.status).toBe(401);

		// New pairing works
		const { capabilityToken: newToken } = await openAndRedeem(
			server.baseUrl,
			"ses_1",
			"browser_b",
		);
		expect(newToken).not.toBe(capabilityToken);
		expect(newToken).toMatch(/^bcap_/);

		// New token works
		const newResp = await fetch(`${server.baseUrl}/api/sessions`, {
			headers: authHeaders(newToken),
		});
		expect(newResp.ok).toBe(true);
	});
});

// --- Scenario 5: Capability registry corruption recovery ---
describe("capability registry corruption recovery", () => {
	test("recovers from corrupted registry file by starting fresh", async () => {
		const dir = await fs.mkdtemp(path.join("/tmp", "omp-corrupt-"));
		dirs.push(dir);
		const registryPath = path.join(dir, "registry.json");
		await fs.writeFile(registryPath, "{ invalid json !!!");

		// Broker starts despite corruption — quarantine + fresh start
		const { server } = await createServer(registryPath);
		const { capabilityToken } = await openAndRedeem(
			server.baseUrl,
			"ses_1",
		);
		expect(capabilityToken).toMatch(/^bcap_/);

		// New capability works
		const resp = await fetch(`${server.baseUrl}/api/sessions`, {
			headers: authHeaders(capabilityToken),
		});
		expect(resp.ok).toBe(true);
	});

	test("recovers from malformed capability record in registry", async () => {
		const dir = await fs.mkdtemp(path.join("/tmp", "omp-malformed-"));
		dirs.push(dir);
		const registryPath = path.join(dir, "registry.json");
		await fs.writeFile(
			registryPath,
			JSON.stringify({
				version: 1,
				browserCapabilities: [
					{
						browserInstallId: "browser_x",
						capabilityTokenHash: "hash_1",
						createdAt: "not-a-date",
					},
				],
			}),
		);

		const { server } = await createServer(registryPath);
		const { capabilityToken } = await openAndRedeem(
			server.baseUrl,
			"ses_1",
		);
		expect(capabilityToken).toMatch(/^bcap_/);
	});
});

// --- Scenario 6: Feedback ordering on reconnect ---
describe("feedback ordering and replay", () => {
	test("returns feedback in submission order on reconnect replay", async () => {
		const { server } = await createServer();
		await registerSession(server.baseUrl, "ses_1");

		// Submit 3 feedback events in order
		for (const id of ["evt_1", "evt_2", "evt_3"]) {
			const resp = await sendFeedback(
				server.baseUrl,
				AUTH_TOKEN,
				"ses_1",
				id,
			);
			expect(resp.ok).toBe(true);
		}

		// GET all feedback — should be in order
		const { feedback: list } = await getFeedbackList(server.baseUrl, "ses_1");
		expect(list.map((f) => f.eventId)).toEqual(["evt_1", "evt_2", "evt_3"]);

		// Latest is the last submitted
		const latestResp = await fetch(
			`${server.baseUrl}/api/sessions/ses_1/feedback/latest`,
			{ headers: authHeaders() },
		);
		const { feedback: latest } = (await latestResp.json()) as {
			feedback: { eventId: string };
		};
		expect(latest.eventId).toBe("evt_3");
	});

	test("capability token can submit feedback but cannot read feedback history", async () => {
		const { server } = await createServer();
		const { capabilityToken } = await openAndRedeem(
			server.baseUrl,
			"ses_1",
		);

		// Browser can submit feedback with capability token
		const submit = await sendFeedback(
			server.baseUrl,
			capabilityToken,
			"ses_1",
			"evt_cap_1",
		);
		expect(submit.ok).toBe(true);

		// Browser cannot read feedback history (requires root token)
		const read = await fetch(
			`${server.baseUrl}/api/sessions/ses_1/feedback`,
			{ headers: authHeaders(capabilityToken) },
		);
		expect(read.status).toBe(401);
	});
});

// --- Scenario 7: Full lifecycle ---
describe("full lifecycle recovery", () => {
	test("pair → feedback → reset → new pairing required → new pair → feedback", async () => {
		const { server } = await createServer();

		// 1. Register and pair
		const { capabilityToken } = await openAndRedeem(server.baseUrl, "ses_1");

		// 2. Submit feedback with capability token
		const fbResp = await sendFeedback(
			server.baseUrl,
			capabilityToken,
			"ses_1",
			"evt_a",
		);
		expect(fbResp.ok).toBe(true);

		// 3. Reset pairing
		const resetResp = await fetch(`${server.baseUrl}/api/pair/reset`, {
			method: "POST",
			headers: authHeaders(),
		});
		expect(resetResp.ok).toBe(true);

		// 4. Old capability rejected
		const oldResp = await fetch(`${server.baseUrl}/api/sessions`, {
			headers: authHeaders(capabilityToken),
		});
		expect(oldResp.status).toBe(401);

		// 5. New pairing needed
		const { capabilityToken: newToken } = await openAndRedeem(
			server.baseUrl,
			"ses_1",
			"browser_b",
		);

		// 6. New capability works for submitting feedback
		const newFb = await sendFeedback(
			server.baseUrl,
			newToken,
			"ses_1",
			"evt_c",
		);
		expect(newFb.ok).toBe(true);

		// 7. Original feedback still present (evt_a), plus new (evt_c)
		const { feedback: list } = await getFeedbackList(server.baseUrl, "ses_1");
		const eventIds = list.map((f) => f.eventId);
		expect(eventIds).toContain("evt_a");
		expect(eventIds).toContain("evt_c");
	});

	test("broker restart preserves capabilities across stop/start cycle", async () => {
		const dir = await fs.mkdtemp(path.join("/tmp", "omp-lifecycle-"));
		dirs.push(dir);
		const registryPath = path.join(dir, "registry.json");

		// Start → pair → submit feedback → stop
		const s1 = await createBrowserBrokerServer({
			host: "127.0.0.1",
			port: 0,
			authToken: AUTH_TOKEN,
			pairingRegistryPath: registryPath,
		});
		await registerSession(s1.baseUrl, "ses_1");
		const { capabilityToken } = await openAndRedeem(s1.baseUrl, "ses_1");
		const fb1 = await sendFeedback(
			s1.baseUrl,
			capabilityToken,
			"ses_1",
			"evt_before",
		);
		expect(fb1.ok).toBe(true);
		s1.stop();

		// Restart → re-register session → capability still works
		const s2 = await createBrowserBrokerServer({
			host: "127.0.0.1",
			port: 0,
			authToken: AUTH_TOKEN,
			pairingRegistryPath: registryPath,
		});
		servers.push(s2);

		// Re-register session (session registry is in-memory)
		await registerSession(s2.baseUrl, "ses_1");

		// Capability token from first pairing still works
		const fb2 = await sendFeedback(
			s2.baseUrl,
			capabilityToken,
			"ses_1",
			"evt_after",
		);
		expect(fb2.ok).toBe(true);

		// Only new feedback present (InMemoryFeedbackStore is ephemeral)
		const { feedback: list } = await getFeedbackList(s2.baseUrl, "ses_1");
		const eventIds = list.map((f) => f.eventId);
		expect(eventIds).toEqual(["evt_after"]);
	});
});
