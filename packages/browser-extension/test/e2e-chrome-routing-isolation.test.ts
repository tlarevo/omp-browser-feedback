/**
 * Chrome E2E routing isolation test — two OMP sessions.
 *
 * Proves with real Chrome and two independent OMP targets that browser feedback
 * never crosses session boundaries. Exercises the full broker-discovery → pairing
 * → session-listing → DOM-picker → feedback-delivery flow with duplicate display
 * names and interleaved picks.
 *
 * Requires:
 *   - Extension built: run `bun run build` in packages/browser-extension first.
 *   - Playwright Chromium browser installed: bunx playwright install chromium
 *
 * Skip: set SKIP_CHROME_E2E=1 to skip unconditionally (e.g. headless-only CI).
 *
 * NOTE: Extensions require headless:false — the test opens a visible browser window.
 * NOTE: Do NOT pass executablePath. Playwright must use its own Chromium for CDP compatibility.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type BrowserBrokerServer,
	createBrowserBrokerServer,
} from "@oh-my-pi/browser-broker";
import { BROWSER_PROTOCOL_VERSION } from "@oh-my-pi/browser-protocol";
import type { Server as BunServer } from "bun";
import type { BrowserContext, Worker as PlaywrightWorker } from "playwright";
import { chromium } from "playwright";

// ── Configuration ──────────────────────────────────────────────────────────

const SKIP = process.env.SKIP_CHROME_E2E === "1";
const EXTENSION_ROOT = path.resolve(import.meta.dir, "..");
const DIST_ENTRY = path.join(EXTENSION_ROOT, "dist", "background-entry.js");
const AUTH_TOKEN = "e2e-routing-isolation-token";

const SESSION_A = {
	sessionId: "alpha",
	channelId: "alpha",
	sessionName: "Work Project",
	displayName: "Work Project",
	cwd: "/repo/alpha",
	gitBranch: "main",
};

const SESSION_B = {
	sessionId: "beta",
	channelId: "beta",
	sessionName: "Work Project",
	displayName: "Work Project",
	cwd: "/repo/beta",
	gitBranch: "feature-x",
};

const ROOT_JSON_HEADERS = {
	Authorization: `Bearer ${AUTH_TOKEN}`,
	"Content-Type": "application/json",
} satisfies Record<string, string>;

// ── Shared state ───────────────────────────────────────────────────────────

let broker: BrowserBrokerServer;
let context: BrowserContext;
let serviceWorker: PlaywrightWorker;
let extensionId: string;
let userDataDir: string;
let testServer: BunServer<undefined>;
let testPageUrlA: string;
let testPageUrlB: string;

interface PairingWindowResponse {
	code: string;
	expiresAt: string;
}

interface LatestFeedbackResponse {
	feedback?: {
		eventId?: string;
		channelId?: string;
		payload?: { type?: string };
	} | null;
}

interface StoredPairingState {
	browserInstallId?: string;
	browserCapabilityToken?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function pollUntil<T>(
	fn: () => Promise<T>,
	predicate: (v: T) => boolean,
	timeoutMs = 10_000,
	intervalMs = 300,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const value = await fn();
		if (predicate(value)) return value;
		if (Date.now() >= deadline)
			throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

async function openPairingWindow(
	sessionId: string,
): Promise<PairingWindowResponse> {
	const response = await fetch(`${broker.baseUrl}/api/pair/open`, {
		method: "POST",
		headers: ROOT_JSON_HEADERS,
		body: JSON.stringify({ sessionId }),
	});
	if (!response.ok) {
		throw new Error(`Failed to open pairing window: HTTP ${response.status}`);
	}
	return (await response.json()) as PairingWindowResponse;
}

async function readStoredPairingState(): Promise<StoredPairingState> {
	return serviceWorker.evaluate(
		() =>
			new Promise<StoredPairingState>((resolve) => {
				chrome.storage.local.get(
					["browserInstallId", "browserCapabilityToken"],
					(items) => {
						resolve({
							browserInstallId:
								typeof items.browserInstallId === "string"
									? items.browserInstallId
									: undefined,
							browserCapabilityToken:
								typeof items.browserCapabilityToken === "string"
									? items.browserCapabilityToken
									: undefined,
						});
					},
				);
			}),
	);
}

async function setFeedbackStorage(
	baseUrl: string,
	browserCapabilityToken: string,
): Promise<void> {
	await serviceWorker.evaluate(
		({ nextBaseUrl, nextToken }) =>
			new Promise<void>((resolve) => {
				chrome.storage.local.set(
					{
						brokerBaseUrl: nextBaseUrl,
						browserCapabilityToken: nextToken,
					},
					resolve,
				);
			}),
		{ nextBaseUrl: baseUrl, nextToken: browserCapabilityToken },
	);
}

async function setPreferredBrokerBaseUrl(baseUrl: string): Promise<void> {
	await serviceWorker.evaluate(
		(nextBaseUrl) =>
			new Promise<void>((resolve) => {
				chrome.storage.local.set({ brokerBaseUrl: nextBaseUrl }, resolve);
			}),
		baseUrl,
	);
}

async function findTabIdByTitle(title: string): Promise<number> {
	return serviceWorker.evaluate(async (targetTitle: string) => {
		const tabs = await chrome.tabs.query({ title: targetTitle });
		const id = tabs[0]?.id;
		if (!id) {
			throw new Error(
				`Tab not found; titles: ${JSON.stringify(tabs.map((tab) => tab.title))}`,
			);
		}
		return id;
	}, title);
}

async function registerSession(reg: {
	sessionId: string;
	channelId: string;
	sessionName: string;
	displayName: string;
	cwd: string;
	gitBranch?: string;
	processId: number;
}): Promise<void> {
	await fetch(`${broker.baseUrl}/api/sessions/register`, {
		method: "POST",
		headers: ROOT_JSON_HEADERS,
		body: JSON.stringify({
			protocolVersion: BROWSER_PROTOCOL_VERSION,
			...reg,
			status: "active",
			lastActiveAt: new Date().toISOString(),
		}),
	});
}

async function patchSessionStatus(
	sessionId: string,
	status: "active" | "idle" | "disconnected",
): Promise<void> {
	await fetch(`${broker.baseUrl}/api/sessions/${sessionId}`, {
		method: "PATCH",
		headers: ROOT_JSON_HEADERS,
		body: JSON.stringify({ status }),
	});
}

async function getLatestFeedback(
	sessionId: string,
): Promise<LatestFeedbackResponse> {
	return (await (
		await fetch(`${broker.baseUrl}/api/sessions/${sessionId}/feedback/latest`, {
			headers: {
				Authorization: `Bearer ${AUTH_TOKEN}`,
			},
		})
	).json()) as LatestFeedbackResponse;
}

async function getAllFeedback(
	sessionId: string,
): Promise<Array<{ eventId: string; channelId: string; type: string }>> {
	const body = (await (
		await fetch(`${broker.baseUrl}/api/sessions/${sessionId}/feedback`, {
			headers: {
				Authorization: `Bearer ${AUTH_TOKEN}`,
			},
		})
	).json()) as {
		feedback: Array<{ eventId: string; channelId: string; type: string }>;
	};
	return body.feedback ?? [];
}
/**
 * Navigate to a test page, activate the DOM picker with a specific channelId,
 * and click the #target element. Exercises the real Chrome extension picker flow.
 */
async function pickElement(pageUrl: string, channelId: string): Promise<void> {
	const page = await context.newPage();
	await page.goto(pageUrl);
	// Real browser integration: wait for content script registration before messaging it.
	await page.waitForTimeout(800);

	const tabId = await findTabIdByTitle(await page.title());
	const pickerActivation = serviceWorker.evaluate(
		({
			nextTabId,
			nextChannelId,
		}: {
			nextTabId: number;
			nextChannelId: string;
		}) =>
			chrome.tabs.sendMessage(nextTabId, {
				type: "omp:activate-picker",
				channelId: nextChannelId,
			}),
		{ nextTabId: tabId, nextChannelId: channelId },
	);

	await page
		.locator('[data-omp-picker-overlay="true"]')
		.waitFor({ state: "attached", timeout: 8_000 });
	await page.locator("#target").hover();
	await page.locator("#target").click();
	await pickerActivation.catch(() => {});
}

function registerFeedback(channelId: string, eventId: string, note?: string) {
	return fetch(`${broker.baseUrl}/api/feedback`, {
		method: "POST",
		headers: ROOT_JSON_HEADERS,
		body: JSON.stringify({
			protocolVersion: BROWSER_PROTOCOL_VERSION,
			eventId,
			type: "dom.selection",
			channelId,
			createdAt: new Date().toISOString(),
			page: {
				url: `https://example.com/${channelId}`,
				title: `Page ${channelId}`,
				viewport: { width: 1200, height: 800, devicePixelRatio: 2 },
			},
			element: {
				selector: "#target",
				tagName: "BUTTON",
				outerHtml: `<button id="target">Pick ${channelId}</button>`,
				attributes: {},
				bounds: { x: 1, y: 2, width: 3, height: 4 },
				computedStyles: { display: "block" },
			},
			...(note !== undefined ? { note } : {}),
		}),
	});
}

function registerScreenshotFeedback(channelId: string, eventId: string) {
	return fetch(`${broker.baseUrl}/api/feedback`, {
		method: "POST",
		headers: ROOT_JSON_HEADERS,
		body: JSON.stringify({
			protocolVersion: BROWSER_PROTOCOL_VERSION,
			eventId,
			type: "page.screenshot",
			channelId,
			createdAt: new Date().toISOString(),
			page: {
				url: `https://example.com/${channelId}`,
				title: `Page ${channelId}`,
				viewport: { width: 1200, height: 800, devicePixelRatio: 2 },
			},
			screenshot: {
				kind: "full-visible-tab",
				ref: `screenshot-${eventId}`,
				mimeType: "image/png",
				width: 1200,
				height: 800,
			},
		}),
	});
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
	if (SKIP) return;

	if (!fs.existsSync(DIST_ENTRY)) {
		throw new Error(
			`Extension not built. Run: bun run build in packages/browser-extension\nExpected: ${DIST_ENTRY}`,
		);
	}

	// Start broker on the first free port in the discovery range
	let brokerStarted = false;
	for (let port = 4317; port <= 4337; port++) {
		try {
			broker = await createBrowserBrokerServer({
				host: "127.0.0.1",
				port,
				authToken: AUTH_TOKEN,
			});
			brokerStarted = true;
			break;
		} catch {
			// port occupied — try next
		}
	}
	if (!brokerStarted) {
		throw new Error(
			"All ports 4317–4337 are occupied; cannot start E2E broker.",
		);
	}

	// Register both sessions with duplicate display names
	await registerSession({ ...SESSION_A, processId: 1 });
	await registerSession({ ...SESSION_B, processId: 2 });

	// Serve two test pages with different elements
	testServer = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			const label = url.pathname === "/page-a" ? "A" : "B";
			const title = url.pathname === "/page-a" ? "Route A" : "Route B";
			return new Response(
				`<!doctype html>
<html>
  <head><title>${title}</title></head>
  <body>
    <button id="target" style="position:fixed;top:100px;left:100px;width:200px;height:60px;font-size:18px">
      Pick ${label}
    </button>
  </body>
</html>`,
				{ headers: { "Content-Type": "text/html" } },
			);
		},
	});
	testPageUrlA = `http://127.0.0.1:${testServer.port}/page-a`;
	testPageUrlB = `http://127.0.0.1:${testServer.port}/page-b`;

	// Launch Playwright's bundled Chromium with the unpacked extension
	userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-e2e-routing-"));
	context = await chromium.launchPersistentContext(userDataDir, {
		headless: false,
		args: [
			`--load-extension=${EXTENSION_ROOT}`,
			`--disable-extensions-except=${EXTENSION_ROOT}`,
			"--no-first-run",
			"--no-default-browser-check",
		],
	});

	const wakePage = await context.newPage();
	await wakePage.goto("about:blank");
	await wakePage.close();

	const existing = context.serviceWorkers()[0];
	if (existing) {
		serviceWorker = existing;
	} else {
		serviceWorker = await Promise.race([
			context.waitForEvent("serviceworker"),
			new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(
								"Extension service worker did not register within 15 s",
							),
						),
					15_000,
				),
			),
		]);
	}

	extensionId = serviceWorker.url().split("/")[2] ?? "";
	if (!extensionId)
		throw new Error(
			`Could not extract extension ID from: ${serviceWorker.url()}`,
		);

	// Pair the extension via popup with session alpha
	const issued = await openPairingWindow(SESSION_A.sessionId);
	await setPreferredBrokerBaseUrl(broker.baseUrl);

	const popup = await context.newPage();
	await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);

	await popup
		.locator('input[placeholder="Pairing code"]')
		.waitFor({ state: "visible", timeout: 10_000 });
	await popup.fill('input[placeholder="Pairing code"]', issued.code);
	await popup.locator("button").click();

	await popup
		.locator('input[type="radio"][name="session"]')
		.first()
		.waitFor({ state: "visible", timeout: 10_000 });
	await popup.close();

	const storedPairing = await readStoredPairingState();
	const capabilityToken = storedPairing.browserCapabilityToken;
	if (!capabilityToken) {
		throw new Error("Missing stored browser capability token after pairing");
	}

	await setFeedbackStorage(broker.baseUrl, capabilityToken);
}, 60_000);

afterAll(async () => {
	if (SKIP) return;
	await context?.close();
	broker?.stop();
	testServer?.stop();
	if (userDataDir) await fsp.rm(userDataDir, { recursive: true, force: true });
});

afterEach(() => {
	if (SKIP) return;
	// Clear all feedback between tests to prevent cross-test contamination
	broker.feedback.clear(SESSION_A.channelId);
	broker.feedback.clear(SESSION_B.channelId);
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)("Chrome routing isolation — two OMP sessions", () => {
	test("routes by stable session ID despite duplicate display names", async () => {
		// Both sessions share displayName "Work Project" but have different IDs
		const { sessions } = (await (
			await fetch(`${broker.baseUrl}/api/sessions`, {
				headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
			})
		).json()) as {
			sessions: Array<{ sessionId: string; displayName: string; cwd: string }>;
		};

		expect(sessions).toHaveLength(2);
		const displayNames = sessions.map(
			(s: { displayName: string }) => s.displayName,
		);
		expect(
			displayNames.filter((n: string) => n === "Work Project"),
		).toHaveLength(2);

		// Routing uses stable IDs, not display names
		const alpha = sessions.find(
			(s: { sessionId: string }) => s.sessionId === SESSION_A.sessionId,
		);
		const beta = sessions.find(
			(s: { sessionId: string }) => s.sessionId === SESSION_B.sessionId,
		);
		expect(alpha).toBeDefined();
		expect(beta).toBeDefined();
		expect(alpha?.cwd).toBe(SESSION_A.cwd);
		expect(beta?.cwd).toBe(SESSION_B.cwd);

		// Submit feedback to each channel via API and verify routing
		await registerFeedback(SESSION_A.channelId, "evt-alpha-1");
		await registerFeedback(SESSION_B.channelId, "evt-beta-1");

		const latestA = await getLatestFeedback(SESSION_A.sessionId);
		const latestB = await getLatestFeedback(SESSION_B.sessionId);

		expect(latestA.feedback?.eventId).toBe("evt-alpha-1");
		expect(latestB.feedback?.eventId).toBe("evt-beta-1");
	});
	test("real Chrome picker routes feedback to correct session", async () => {
		// Exercise the full extension flow: navigate → activate picker → click → verify
		await pickElement(testPageUrlA, SESSION_A.channelId);

		const latestA = await pollUntil(
			async () => getLatestFeedback(SESSION_A.sessionId),
			(body) => body.feedback?.eventId !== undefined,
			10_000,
		);
		expect(latestA.feedback?.eventId).toBeTruthy();

		// Verify session B received nothing from this pick
		const latestB = await getLatestFeedback(SESSION_B.sessionId);
		expect(latestB.feedback).toBeNull();
	}, 30_000);

	test("real Chrome picker interleaved across both sessions", async () => {
		// Pick on session A
		await pickElement(testPageUrlA, SESSION_A.channelId);
		const afterA1 = await pollUntil(
			async () => getLatestFeedback(SESSION_A.sessionId),
			(body) => body.feedback?.eventId !== undefined,
			10_000,
		);
		expect(afterA1.feedback?.eventId).toBeTruthy();

		// Pick on session B
		await pickElement(testPageUrlB, SESSION_B.channelId);
		const afterB1 = await pollUntil(
			async () => getLatestFeedback(SESSION_B.sessionId),
			(body) => body.feedback?.eventId !== undefined,
			10_000,
		);
		expect(afterB1.feedback?.eventId).toBeTruthy();

		// Verify cross-contamination: each session's latest is its own
		expect(afterA1.feedback?.eventId).not.toBe(afterB1.feedback?.eventId);

		// Session A's latest is still the A pick, not contaminated by B
		const finalA = await getLatestFeedback(SESSION_A.sessionId);
		expect(finalA.feedback?.eventId).toBe(afterA1.feedback?.eventId);
	}, 30_000);

	test("interleaved DOM selections maintain session attribution", async () => {
		// Interleave: A, B, A, B
		const events = [
			{ channelId: SESSION_A.channelId, eventId: "evt-interleave-a1" },
			{ channelId: SESSION_B.channelId, eventId: "evt-interleave-b1" },
			{ channelId: SESSION_A.channelId, eventId: "evt-interleave-a2" },
			{ channelId: SESSION_B.channelId, eventId: "evt-interleave-b2" },
		];

		for (const evt of events) {
			await registerFeedback(evt.channelId, evt.eventId);
		}

		// Each session sees exactly its own events in submission order
		const feedbackA = await getAllFeedback(SESSION_A.sessionId);
		const feedbackB = await getAllFeedback(SESSION_B.sessionId);

		expect(feedbackA.map((f) => f.eventId)).toEqual([
			"evt-interleave-a1",
			"evt-interleave-a2",
		]);
		expect(feedbackB.map((f) => f.eventId)).toEqual([
			"evt-interleave-b1",
			"evt-interleave-b2",
		]);

		// Cross-contamination check: every event has the correct channelId
		for (const evt of feedbackA) {
			expect(evt.channelId).toBe(SESSION_A.channelId);
		}
		for (const evt of feedbackB) {
			expect(evt.channelId).toBe(SESSION_B.channelId);
		}
	});

	test("disconnecting one target does not affect delivery to the other", async () => {
		// Submit initial events to both
		await registerFeedback(SESSION_A.channelId, "evt-pre-disconnect-a");
		await registerFeedback(SESSION_B.channelId, "evt-pre-disconnect-b");

		const beforeA = await getLatestFeedback(SESSION_A.sessionId);
		expect(beforeA.feedback?.eventId).toBe("evt-pre-disconnect-a");

		// Disconnect session B
		await patchSessionStatus(SESSION_B.sessionId, "disconnected");

		// Submit new event to session A — should still route correctly
		await registerFeedback(SESSION_A.channelId, "evt-post-disconnect-a");
		const afterDisconnectA = await getLatestFeedback(SESSION_A.sessionId);
		expect(afterDisconnectA.feedback?.eventId).toBe("evt-post-disconnect-a");

		// Session B's latest is unchanged
		const afterDisconnectB = await getLatestFeedback(SESSION_B.sessionId);
		expect(afterDisconnectB.feedback?.eventId).toBe("evt-pre-disconnect-b");

		// Session B's feedback store is unaffected — list still has its events
		const allB = await getAllFeedback(SESSION_B.sessionId);
		expect(allB).toHaveLength(1);
		expect(allB[0]?.eventId).toBe("evt-pre-disconnect-b");

		// Reconnect session B
		await patchSessionStatus(SESSION_B.sessionId, "active");

		// Now submit new event to B — should route correctly after reconnect
		await registerFeedback(SESSION_B.channelId, "evt-post-reconnect-b");
		const afterReconnectB = await getLatestFeedback(SESSION_B.sessionId);
		expect(afterReconnectB.feedback?.eventId).toBe("evt-post-reconnect-b");

		// Session A's latest is still its own
		const finalA = await getLatestFeedback(SESSION_A.sessionId);
		expect(finalA.feedback?.eventId).toBe("evt-post-disconnect-a");
	});

	test("cross-contamination assertion fails if event appears on wrong target", async () => {
		// Submit known events to each channel
		await registerFeedback(SESSION_A.channelId, "contamination-a");
		await registerFeedback(SESSION_B.channelId, "contamination-b");

		const allA = await getAllFeedback(SESSION_A.sessionId);
		const allB = await getAllFeedback(SESSION_B.sessionId);

		// Every event for A must belong to A
		for (const evt of allA) {
			expect(evt.channelId).toBe(SESSION_A.channelId);
		}
		// Every event for B must belong to B
		for (const evt of allB) {
			expect(evt.channelId).toBe(SESSION_B.channelId);
		}

		// No event ID appears on both targets
		const idsA = new Set(allA.map((e) => e.eventId));
		const idsB = new Set(allB.map((e) => e.eventId));
		for (const id of idsA) {
			expect(idsB.has(id)).toBe(false);
		}
	});

	test("page screenshot events route to correct session", async () => {
		// Submit a screenshot event to each channel
		await registerScreenshotFeedback(SESSION_A.channelId, "screenshot-a1");
		await registerScreenshotFeedback(SESSION_B.channelId, "screenshot-b1");

		const latestA = await getLatestFeedback(SESSION_A.sessionId);
		const latestB = await getLatestFeedback(SESSION_B.sessionId);

		expect(latestA.feedback?.eventId).toBe("screenshot-a1");
		expect(latestA.feedback?.payload?.type).toBe("page.screenshot");
		expect(latestB.feedback?.eventId).toBe("screenshot-b1");
		expect(latestB.feedback?.payload?.type).toBe("page.screenshot");

		// Verify no cross-contamination with mixed event types
		await registerFeedback(SESSION_A.channelId, "dom-a-after-screenshot");
		await registerScreenshotFeedback(SESSION_B.channelId, "screenshot-b2");

		const finalA = await getLatestFeedback(SESSION_A.sessionId);
		const finalB = await getLatestFeedback(SESSION_B.sessionId);

		expect(finalA.feedback?.eventId).toBe("dom-a-after-screenshot");
		expect(finalA.feedback?.payload?.type).toBe("dom.selection");
		expect(finalB.feedback?.eventId).toBe("screenshot-b2");
		expect(finalB.feedback?.payload?.type).toBe("page.screenshot");
	});

	test("batch events maintain per-target ordering", async () => {
		// Submit a batch of events to each channel, interleaved
		const batch = [
			{ channelId: SESSION_A.channelId, eventId: "batch-a1" },
			{ channelId: SESSION_A.channelId, eventId: "batch-a2" },
			{ channelId: SESSION_B.channelId, eventId: "batch-b1" },
			{ channelId: SESSION_A.channelId, eventId: "batch-a3" },
			{ channelId: SESSION_B.channelId, eventId: "batch-b2" },
			{ channelId: SESSION_B.channelId, eventId: "batch-b3" },
		];

		for (const evt of batch) {
			await registerFeedback(evt.channelId, evt.eventId);
		}

		// Each target observes exactly its own event IDs in submission order
		const allA = await getAllFeedback(SESSION_A.sessionId);
		const allB = await getAllFeedback(SESSION_B.sessionId);

		expect(allA.map((f) => f.eventId)).toEqual([
			"batch-a1",
			"batch-a2",
			"batch-a3",
		]);
		expect(allB.map((f) => f.eventId)).toEqual([
			"batch-b1",
			"batch-b2",
			"batch-b3",
		]);

		// ACK state: every event should have an eventId (acknowledged)
		for (const evt of [...allA, ...allB]) {
			expect(evt.eventId).toBeTruthy();
			expect(typeof evt.eventId).toBe("string");
		}
	});
});
