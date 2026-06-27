/**
 * Chrome E2E smoke test.
 *
 * Loads the built extension into Playwright's bundled Chromium via --load-extension
 * and exercises the full broker-discovery → session-listing → DOM-picker → feedback-delivery flow.
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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createBrowserBrokerServer, type BrowserBrokerServer } from "@oh-my-pi/browser-broker";
import { BROWSER_PROTOCOL_VERSION } from "@oh-my-pi/browser-protocol";
import type { BrowserContext, Server as BunServer, Worker as PlaywrightWorker } from "playwright";
import { chromium } from "playwright";

// ── Configuration ──────────────────────────────────────────────────────────

const SKIP = process.env["SKIP_CHROME_E2E"] === "1";
const EXTENSION_ROOT = path.resolve(import.meta.dir, "..");
const DIST_ENTRY = path.join(EXTENSION_ROOT, "dist", "background-entry.js");
const AUTH_TOKEN = "e2e-test-secret-token";
const SESSION_ID = "ses_e2e_01";
const SESSION_NAME = "E2E Test Session";

// ── Shared state ───────────────────────────────────────────────────────────

let broker: BrowserBrokerServer;
let context: BrowserContext;
let serviceWorker: PlaywrightWorker;
let extensionId: string;
let userDataDir: string;
let testServer: BunServer;
let testPageUrl: string;

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
		if (Date.now() >= deadline) throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
		await new Promise(r => setTimeout(r, intervalMs));
	}
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
	if (SKIP) return;

	if (!fs.existsSync(DIST_ENTRY)) {
		throw new Error(
			`Extension not built. Run: bun run build in packages/browser-extension\nExpected: ${DIST_ENTRY}`,
		);
	}

	// Start broker on a port in the default extension discovery range (4317-4337)
	let brokerStarted = false;
	for (let port = 4317; port <= 4337; port++) {
		try {
			broker = await createBrowserBrokerServer({ host: "127.0.0.1", port, authToken: AUTH_TOKEN });
			brokerStarted = true;
			break;
		} catch {
			// port occupied — try next
		}
	}
	if (!brokerStarted) throw new Error("All ports 4317–4337 are occupied; cannot start E2E broker.");

	// Register a test OMP session
	await fetch(`${broker.baseUrl}/api/sessions/register`, {
		method: "POST",
		headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			protocolVersion: BROWSER_PROTOCOL_VERSION,
			sessionId: SESSION_ID,
			channelId: SESSION_ID,
			sessionName: SESSION_NAME,
			displayName: SESSION_NAME,
			cwd: "/tmp/e2e-omp",
			status: "active",
			lastActiveAt: new Date().toISOString(),
			processId: process.pid,
		}),
	});

	// Serve a static test page over http:// so content scripts inject (they don't run on about:blank)
	testServer = Bun.serve({
		port: 0,
		fetch() {
			return new Response(
				`<!doctype html>
<html>
  <head><title>OMP E2E Target</title></head>
  <body>
    <button id="target" style="position:fixed;top:100px;left:100px;width:200px;height:60px;font-size:18px">
      Pick me
    </button>
  </body>
</html>`,
				{ headers: { "Content-Type": "text/html" } },
			);
		},
	});
	testPageUrl = `http://127.0.0.1:${testServer.port}/`;

	// Launch Playwright's bundled Chromium with the unpacked extension.
	// - headless:false is required — Chrome extensions do not run in headless mode.
	// - No executablePath — must use Playwright's own Chromium for CDP service worker visibility.
	userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-e2e-chrome-"));
	context = await chromium.launchPersistentContext(userDataDir, {
		headless: false,
		args: [
			`--load-extension=${EXTENSION_ROOT}`,
			`--disable-extensions-except=${EXTENSION_ROOT}`,
			"--no-first-run",
			"--no-default-browser-check",
		],
	});

	// Listen for service worker events before navigating (may fire immediately on launch)
	const swPromise = context.waitForEvent("serviceworker");

	const wakePage = await context.newPage();
	await wakePage.goto("about:blank");
	await wakePage.close();

	const existing = context.serviceWorkers()[0];
	serviceWorker = existing ?? (await Promise.race([
		swPromise,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("Extension service worker did not register within 15 s")), 15_000),
		),
	]));

	extensionId = serviceWorker.url().split("/")[2] ?? "";
	if (!extensionId) throw new Error(`Could not extract extension ID from: ${serviceWorker.url()}`);

	// Seed chrome.storage.local: auth token + selected session (popup reads these on open)
	await serviceWorker.evaluate(
		({ token, sessionId }) =>
			new Promise<void>(resolve => {
				chrome.storage.local.set({ authToken: token, selectedSessionId: sessionId }, resolve);
			}),
		{ token: AUTH_TOKEN, sessionId: SESSION_ID },
	);
}, 30_000);

afterAll(async () => {
	if (SKIP) return;
	await context?.close();
	broker?.stop();
	testServer?.stop();
	if (userDataDir) await fsp.rm(userDataDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)("Chrome extension smoke test", () => {
	test("popup discovers the broker and lists the registered OMP session", async () => {
		const popup = await context.newPage();
		await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);

		// "ready" state renders radio inputs named "session" — wait for the first one
		await popup.locator('input[type="radio"][name="session"]').first().waitFor({ state: "visible", timeout: 10_000 });

		const labelText = await popup.locator("label").first().textContent();
		expect(labelText).toContain(SESSION_NAME);

		await popup.close();
	}, 20_000);

	test("DOM picker activated via service worker delivers dom.selection feedback to the broker", async () => {
		// Navigate to the test page (http:// so content scripts inject)
		const testPage = await context.newPage();
		await testPage.goto(testPageUrl);

		// Wait for content script to initialise
		await testPage.waitForTimeout(800);

		// Get the test page's Chrome tab ID via the service worker
		const tabId = await serviceWorker.evaluate(async (title: string) => {
			const tabs = await chrome.tabs.query({ title });
			const id = tabs[0]?.id;
			if (!id) throw new Error(`Tab not found; titles: ${JSON.stringify(tabs.map(t => t.title))}`);
			return id;
		}, "OMP E2E Target");

		// Seed broker credentials in storage (background reads these on omp:element-selected)
		await serviceWorker.evaluate(
			({ baseUrl, token }) =>
				new Promise<void>(resolve => {
					chrome.storage.local.set({ brokerBaseUrl: baseUrl, brokerAuthToken: token }, resolve);
				}),
			{ baseUrl: broker.baseUrl, token: AUTH_TOKEN },
		);

		// Activate the picker in the content script.
		// The response only arrives after element selection — don't await yet or it deadlocks.
		const pickerActivation = serviceWorker.evaluate(
			({ tabId, channelId }: { tabId: number; channelId: string }) =>
				chrome.tabs.sendMessage(tabId, { type: "omp:activate-picker", channelId }),
			{ tabId, channelId: SESSION_ID },
		);

		// Wait for the picker overlay to appear in the test page DOM
		await testPage.locator('[data-omp-picker-overlay="true"]').waitFor({ state: "attached", timeout: 8_000 });

		// Hover then click the target element:
		//   - hover triggers the capture-phase mouseover handler → sets `current`
		//   - click is captured → calls callbacks.onSelect(current) → deactivates picker
		await testPage.locator("#target").hover();
		await testPage.locator("#target").click();

		// Picker callback fired → content script sends omp:element-selected → background submits to broker
		await pickerActivation.catch(() => {}); // response arrives now; swallow channel-closed errors

		// Poll the broker until the dom.selection feedback event appears
		const latest = await pollUntil(
			async () => {
				const res = await fetch(
					`${broker.baseUrl}/api/sessions/${SESSION_ID}/feedback/latest`,
					{ headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
				);
				return (await res.json()) as { feedback?: { payload?: { type?: string } } | null };
			},
			body => body.feedback?.payload?.type === "dom.selection",
			10_000,
		);

		expect(latest.feedback?.payload?.type).toBe("dom.selection");

		await testPage.close();
	}, 30_000);
});
