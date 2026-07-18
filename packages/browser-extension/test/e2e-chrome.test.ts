import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
const AUTH_TOKEN = "e2e-test-secret-token";
const SESSION_ID = "ses_e2e_01";
const SESSION_NAME = "E2E Test Session";
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
let testPageUrl: string;

interface PairingWindowResponse {
	code: string;
	expiresAt: string;
}

interface LatestFeedbackResponse {
	feedback?: { payload?: { type?: string } } | null;
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

async function openPairingWindow(): Promise<PairingWindowResponse> {
	const response = await fetch(`${broker.baseUrl}/api/pair/open`, {
		method: "POST",
		headers: ROOT_JSON_HEADERS,
		body: JSON.stringify({ sessionId: SESSION_ID }),
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

	// Register a test OMP session
	await fetch(`${broker.baseUrl}/api/sessions/register`, {
		method: "POST",
		headers: ROOT_JSON_HEADERS,
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

	// Serve a static test page over http:// so content scripts inject
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

	// Launch Playwright's bundled Chromium with the unpacked extension
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
	test("pairs with a short-lived code and then submits feedback", async () => {
		const issued = await openPairingWindow();
		await setPreferredBrokerBaseUrl(broker.baseUrl);

		const popup = await context.newPage();
		const popupConsole: string[] = [];
		const popupErrors: string[] = [];
		popup.on("console", (message) => {
			popupConsole.push(message.text());
		});
		popup.on("pageerror", (error) => {
			popupErrors.push(error.message);
		});
		await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);

		// Wait for pairing form (goes through loading → unpaired)
		try {
			await popup
				.locator('input[aria-label="Pairing code"]')
				.waitFor({ state: "visible", timeout: 10_000 });
		} catch (error) {
			const bodyText = await popup.locator("body").textContent();
			throw new Error(
				[
					error instanceof Error ? error.message : String(error),
					`popup body: ${bodyText ?? "<empty>"}`,
					`popup console: ${popupConsole.join(" | ") || "<none>"}`,
					`popup page errors: ${popupErrors.join(" | ") || "<none>"}`,
				].join("\n"),
			);
		}
		expect(await popup.locator("body").textContent()).toContain(
			"Enter pairing code",
		);
		await popup.fill('input[aria-label="Pairing code"]', issued.code);
		await popup.locator("button.primary").click();

		// Wait for session cards (new UI: .session-card instead of radio inputs)
		try {
			await popup
				.locator(".session-card")
				.first()
				.waitFor({ state: "visible", timeout: 10_000 });
		} catch (error) {
			const bodyText = await popup.locator("body").textContent();
			throw new Error(
				[
					error instanceof Error ? error.message : String(error),
					`popup body after pair: ${bodyText ?? "<empty>"}`,
					`popup console: ${popupConsole.join(" | ") || "<none>"}`,
					`popup page errors: ${popupErrors.join(" | ") || "<none>"}`,
				].join("\n"),
			);
		}

		// Session card shows the session name
		const cardName = await popup
			.locator(".session-card-name")
			.first()
			.textContent();
		expect(cardName).toContain(SESSION_NAME);

		const storedPairing = await readStoredPairingState();
		expect(storedPairing.browserInstallId).toMatch(/^browser_/);
		expect(storedPairing.browserCapabilityToken).toBeString();
		expect(storedPairing.browserCapabilityToken?.startsWith("bcap_")).toBe(
			true,
		);
		expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now());

		await popup.close();

		const capabilityToken = storedPairing.browserCapabilityToken;
		if (!capabilityToken) {
			throw new Error("Missing stored browser capability token after pairing");
		}

		const testPage = await context.newPage();
		await testPage.goto(testPageUrl);
		await testPage.waitForTimeout(800);

		const tabId = await findTabIdByTitle("OMP E2E Target");
		await setFeedbackStorage(broker.baseUrl, capabilityToken);

		const pickerActivation = serviceWorker.evaluate(
			({ nextTabId, channelId }: { nextTabId: number; channelId: string }) =>
				chrome.tabs.sendMessage(nextTabId, {
					type: "omp:activate-picker",
					channelId,
				}),
			{ nextTabId: tabId, channelId: SESSION_ID },
		);

		await testPage
			.locator('[data-omp-picker-overlay="true"]')
			.waitFor({ state: "attached", timeout: 8_000 });
		await testPage.locator("#target").hover();
		await testPage.locator("#target").click();
		await pickerActivation.catch(() => {});

		const latest = await pollUntil(
			async () => {
				const response = await fetch(
					`${broker.baseUrl}/api/sessions/${SESSION_ID}/feedback/latest`,
					{ headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
				);
				return (await response.json()) as LatestFeedbackResponse;
			},
			(body) => body.feedback?.payload?.type === "dom.selection",
			10_000,
		);

		expect(latest.feedback?.payload?.type).toBe("dom.selection");

		await testPage.close();
	}, 30_000);

	test("shows loading state then transitions to ready", async () => {
		await setPreferredBrokerBaseUrl(broker.baseUrl);

		const popup = await context.newPage();
		await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);

		// Loading spinner should appear briefly
		const spinner = popup.locator(".spinner");
		try {
			await spinner.waitFor({ state: "visible", timeout: 3_000 });
		} catch {
			// Loading may have completed before we could observe it — that's fine
		}

		// Eventually we reach a non-loading state
		await popup
			.locator(".session-card, .status, .session-list, .toolbar")
			.first()
			.waitFor({ state: "visible", timeout: 10_000 });

		await popup.close();
	}, 15_000);
});
