import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BROWSER_PROTOCOL_VERSION } from "@oh-my-pi/browser-protocol";
import { parseHTML } from "linkedom";
import {
	ensureBrowserInstallId,
	projectBasename,
	relativeFreshness,
	renderPopup,
	renderSessionLabel,
} from "../src/popup/main";

function documentWithRoot() {
	const { document } = parseHTML(
		`<div id="status-announcer" aria-live="polite" role="status"></div><main id='app'></main>`,
	);
	const root = document.getElementById("app");
	if (!root) throw new Error("Missing popup root");
	return { document, root };
}

function installPopupGlobals(initial: Record<string, unknown> = {}) {
	const stored = { ...initial };

	Reflect.set(globalThis, "document", {
		addEventListener() {},
	});
	Reflect.set(globalThis, "chrome", {
		storage: {
			local: {
				get(
					keys: string[],
					callback: (items: Record<string, unknown>) => void,
				) {
					callback(
						Object.fromEntries(
							keys
								.map((key) => [key, stored[key]])
								.filter((entry) => entry[1] !== undefined),
						),
					);
				},
				set(update: Record<string, unknown>, callback?: () => void) {
					Object.assign(stored, update);
					callback?.();
				},
			},
		},
	});

	return stored;
}

// ── Pure helper tests ─────────────────────────────────────────────────────

describe("renderSessionLabel", () => {
	test("includes name, cwd, branch, and status", () => {
		expect(
			renderSessionLabel({
				sessionId: "ses_1",
				displayName: "OMP",
				cwd: "/repo",
				gitBranch: "main",
				status: "active",
			}),
		).toBe("OMP · /repo · main · active");
	});

	test("omits branch when absent", () => {
		expect(
			renderSessionLabel({
				sessionId: "ses_1",
				displayName: "Test",
				cwd: "/code",
				status: "idle",
			}),
		).toBe("Test · /code · idle");
	});
});

describe("projectBasename", () => {
	test("uses projectName when present", () => {
		expect(
			projectBasename({
				sessionId: "s",
				displayName: "x",
				cwd: "/deep/path/repo",
				projectName: "my-project",
				status: "active",
			}),
		).toBe("my-project");
	});

	test("derives from cwd tail when no projectName", () => {
		expect(
			projectBasename({
				sessionId: "s",
				displayName: "x",
				cwd: "/Users/dev/work/my-repo",
				status: "active",
			}),
		).toBe("my-repo");
	});
});

describe("relativeFreshness", () => {
	test("returns 'just now' for negative diff", () => {
		const future = new Date(Date.now() + 60_000).toISOString();
		expect(relativeFreshness(future)).toBe("just now");
	});

	test("returns seconds for < 60s", () => {
		const recent = new Date(Date.now() - 30_000).toISOString();
		expect(relativeFreshness(recent)).toBe("30s ago");
	});

	test("returns minutes for < 60m", () => {
		const minutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
		expect(relativeFreshness(minutesAgo)).toBe("5m ago");
	});

	test("returns empty for undefined", () => {
		expect(relativeFreshness(undefined)).toBe("");
	});
});

// ── renderPopup state tests ───────────────────────────────────────────────

describe("renderPopup", () => {
	test("renders loading state with spinner and aria-label", () => {
		const { root } = documentWithRoot();
		renderPopup(root, { kind: "loading" });
		const spinner = root.querySelector(".spinner");
		expect(spinner).not.toBeNull();
		const loadingEl = root.querySelector("[role='status']");
		expect(loadingEl?.getAttribute("aria-label")).toBe("Loading");
	});

	test("renders no-broker state with port range", () => {
		const { root } = documentWithRoot();
		renderPopup(root, {
			kind: "no-broker",
			attemptedPorts: [4317, 4337],
		});
		expect(root.textContent).toContain("4317");
		expect(root.textContent).toContain("4337");
	});

	test("renders unpaired state with pairing code input", () => {
		const { root } = documentWithRoot();
		let savedCode = "";
		renderPopup(
			root,
			{ kind: "unpaired", baseUrl: "http://127.0.0.1:4317" },
			{ onPairWithCode: (code) => (savedCode = code) },
		);

		const input = root.querySelector("input[type='text']");
		expect(root.textContent).toContain("Enter pairing code");
		expect(input?.getAttribute("placeholder")).toContain("Pairing code");
		expect(input?.getAttribute("aria-label")).toBe("Pairing code");
		if (input) (input as HTMLInputElement).value = "A7K2Q9";
		(root.querySelector("button.primary") as HTMLButtonElement)?.click();
		expect(savedCode).toBe("A7K2Q9");
	});

	test("renders pairing-error with error message", () => {
		const { root } = documentWithRoot();
		renderPopup(root, {
			kind: "pairing-error",
			baseUrl: "http://127.0.0.1:4317",
			message: "Code expired",
		});
		expect(root.textContent).toContain("Code expired");
		const errorEl = root.querySelector(".status.error");
		expect(errorEl).not.toBeNull();
	});

	test("renders no-sessions state", () => {
		const { root } = documentWithRoot();
		renderPopup(root, {
			kind: "no-sessions",
			baseUrl: "http://127.0.0.1:4317",
		});
		expect(root.textContent).toContain("No active OMP sessions");
	});

	test("renders generic error state", () => {
		const { root } = documentWithRoot();
		renderPopup(root, { kind: "error", message: "Something broke" });
		expect(root.textContent).toContain("Something broke");
		const errorEl = root.querySelector(".status.error");
		expect(errorEl).not.toBeNull();
	});

	test("renders session cards with presence dot and meta", () => {
		const { root } = documentWithRoot();
		renderPopup(
			root,
			{
				kind: "ready",
				baseUrl: "http://127.0.0.1:4317",
				selectedSessionId: "ses_2",
				sessions: [
					{
						protocolVersion: BROWSER_PROTOCOL_VERSION,
						sessionId: "ses_1",
						channelId: "ses_1",
						sessionName: "One",
						displayName: "One",
						cwd: "/repo/one",
						status: "active",
						lastActiveAt: "2026-06-27T10:00:00.000Z",
						processId: 1,
					},
					{
						protocolVersion: BROWSER_PROTOCOL_VERSION,
						sessionId: "ses_2",
						channelId: "ses_2",
						sessionName: "Two",
						displayName: "Two",
						cwd: "/repo/two",
						projectName: "two",
						gitBranch: "feature",
						status: "idle",
						lastActiveAt: "2026-06-27T10:00:00.000Z",
						processId: 2,
					},
				],
			},
			{},
		);

		const cards = root.querySelectorAll(".session-card");
		expect(cards.length).toBe(2);

		const dots = root.querySelectorAll(".presence-dot");
		expect(dots[0]?.classList.contains("presence-active")).toBe(true);
		expect(dots[1]?.classList.contains("presence-idle")).toBe(true);

		expect(cards[1]?.classList.contains("selected")).toBe(true);

		const metas = root.querySelectorAll(".session-card-meta");
		expect(metas[1]?.textContent).toContain("two");
		expect(metas[1]?.textContent).toContain("feature");
	});

	test("calls onSelectSession when card is clicked", () => {
		const { root } = documentWithRoot();
		let selected = "";
		renderPopup(
			root,
			{
				kind: "ready",
				baseUrl: "http://127.0.0.1:4317",
				sessions: [
					{
						protocolVersion: BROWSER_PROTOCOL_VERSION,
						sessionId: "ses_1",
						channelId: "ses_1",
						sessionName: "One",
						displayName: "One",
						cwd: "/repo",
						status: "active",
						lastActiveAt: "2026-06-27T10:00:00.000Z",
						processId: 1,
					},
				],
			},
			{ onSelectSession: (id) => (selected = id) },
		);

		(root.querySelector(".session-card") as HTMLElement)?.click();
		expect(selected).toBe("ses_1");
	});

	test("renders pick element button and calls onStartPicker", () => {
		const { root } = documentWithRoot();
		let picked = "";
		renderPopup(
			root,
			{
				kind: "ready",
				baseUrl: "http://127.0.0.1:4317",
				selectedSessionId: "ses_1",
				sessions: [
					{
						protocolVersion: BROWSER_PROTOCOL_VERSION,
						sessionId: "ses_1",
						channelId: "ses_1",
						sessionName: "One",
						displayName: "One",
						cwd: "/repo",
						status: "active",
						lastActiveAt: "2026-06-27T10:00:00.000Z",
						processId: 1,
					},
				],
			},
			{ onStartPicker: (id) => (picked = id) },
		);

		const pickBtn = root.querySelector("button.primary");
		expect(pickBtn?.textContent).toContain("Pick element");
		(pickBtn as HTMLElement)?.click();
		expect(picked).toBe("ses_1");
	});

	test("renders refresh button and calls onRefresh", () => {
		const { root } = documentWithRoot();
		let refreshed = false;
		renderPopup(
			root,
			{
				kind: "ready",
				baseUrl: "http://127.0.0.1:4317",
				sessions: [],
			},
			{ onRefresh: () => (refreshed = true) },
		);

		const refreshBtn = root.querySelector("[aria-label='Refresh sessions']");
		expect(refreshBtn).not.toBeNull();
		(refreshBtn as HTMLElement)?.click();
		expect(refreshed).toBe(true);
	});

	test("renders forget button and calls onForget", () => {
		const { root } = documentWithRoot();
		let forgotten = false;
		renderPopup(
			root,
			{
				kind: "ready",
				baseUrl: "http://127.0.0.1:4317",
				sessions: [],
			},
			{ onForget: () => (forgotten = true) },
		);

		const forgetBtn = root.querySelector("[aria-label='Forget this browser']");
		expect(forgetBtn).not.toBeNull();
		(forgetBtn as HTMLElement)?.click();
		expect(forgotten).toBe(true);
	});

	test("renders shortcut hint link", () => {
		const { root } = documentWithRoot();
		renderPopup(root, { kind: "loading" });
		renderPopup(root, {
			kind: "ready",
			baseUrl: "http://127.0.0.1:4317",
			sessions: [],
		});
		const link = root.querySelector("button.link");
		expect(link?.textContent).toContain("Configure in Chrome");
	});

	test("renders loading state with connecting message", () => {
		const { root } = documentWithRoot();
		renderPopup(root, { kind: "loading" });
		expect(root.textContent).toContain("Connecting to broker");
		expect(root.querySelector("button")).toBeNull();
	});

	test("renders no-broker state with retry button that fires onRetry", () => {
		const { root } = documentWithRoot();
		let retried = false;
		renderPopup(
			root,
			{ kind: "no-broker", attemptedPorts: [4317, 4318] },
			{
				onRetry: () => {
					retried = true;
				},
			},
		);
		expect(root.textContent).toContain("No OMP browser broker found");
		expect(root.textContent).toContain("4317");
		const retryBtn = root.querySelector("button");
		expect(retryBtn).not.toBeNull();
		retryBtn?.click();
		expect(retried).toBe(true);
	});

	test("renders a hint message from the background shortcut handler", () => {
		const { root } = documentWithRoot();
		renderPopup(root, {
			kind: "loading",
			message: "Select a session to arm the picker shortcut.",
		});
		expect(root.textContent).toContain(
			"Select a session to arm the picker shortcut.",
		);
		// Hint view should not show session list or picker button
		expect(root.querySelector("ul")).toBeNull();
		expect(root.querySelector("button")).toBeNull();
	});
});

// ── A11y tests ────────────────────────────────────────────────────────────

describe("accessibility", () => {
	test("session list has role=listbox and aria-label", () => {
		const { root } = documentWithRoot();
		renderPopup(
			root,
			{
				kind: "ready",
				baseUrl: "http://127.0.0.1:4317",
				sessions: [
					{
						protocolVersion: BROWSER_PROTOCOL_VERSION,
						sessionId: "ses_1",
						channelId: "ses_1",
						sessionName: "One",
						displayName: "One",
						cwd: "/repo",
						status: "active",
						lastActiveAt: "2026-06-27T10:00:00.000Z",
						processId: 1,
					},
				],
			},
			{},
		);

		const list = root.querySelector("[role='listbox']");
		expect(list).not.toBeNull();
		expect(list?.getAttribute("aria-label")).toBe("OMP sessions");
	});

	test("session cards have role=option, tabindex=0, and aria-selected", () => {
		const { root } = documentWithRoot();
		renderPopup(
			root,
			{
				kind: "ready",
				baseUrl: "http://127.0.0.1:4317",
				selectedSessionId: "ses_1",
				sessions: [
					{
						protocolVersion: BROWSER_PROTOCOL_VERSION,
						sessionId: "ses_1",
						channelId: "ses_1",
						sessionName: "One",
						displayName: "One",
						cwd: "/repo",
						status: "active",
						lastActiveAt: "2026-06-27T10:00:00.000Z",
						processId: 1,
					},
				],
			},
			{},
		);

		const card = root.querySelector(".session-card");
		expect(card?.getAttribute("role")).toBe("option");
		expect(card?.getAttribute("tabindex")).toBe("0");
		expect(card?.getAttribute("aria-selected")).toBe("true");
	});

	test("status announcer receives status text", () => {
		const { document, root } = documentWithRoot();
		renderPopup(
			root,
			{
				kind: "ready",
				baseUrl: "http://127.0.0.1:4317",
				sessions: [
					{
						protocolVersion: BROWSER_PROTOCOL_VERSION,
						sessionId: "ses_1",
						channelId: "ses_1",
						sessionName: "One",
						displayName: "One",
						cwd: "/repo",
						status: "active",
						lastActiveAt: "2026-06-27T10:00:00.000Z",
						processId: 1,
					},
				],
			},
			{},
		);

		const announcer = document.getElementById("status-announcer");
		expect(announcer?.textContent).toContain("session");
	});

	test("pick button has aria-label", () => {
		const { root } = documentWithRoot();
		renderPopup(
			root,
			{
				kind: "ready",
				baseUrl: "http://127.0.0.1:4317",
				sessions: [
					{
						protocolVersion: BROWSER_PROTOCOL_VERSION,
						sessionId: "ses_1",
						channelId: "ses_1",
						sessionName: "One",
						displayName: "One",
						cwd: "/repo",
						status: "active",
						lastActiveAt: "2026-06-27T10:00:00.000Z",
						processId: 1,
					},
				],
			},
			{},
		);

		const btn = root.querySelector("button.primary");
		expect(btn?.getAttribute("aria-label")).toBe("Start picking an element");
	});

	test("session card has tabindex=0 for keyboard access", () => {
		const { root } = documentWithRoot();
		renderPopup(
			root,
			{
				kind: "ready",
				baseUrl: "http://127.0.0.1:4317",
				sessions: [
					{
						protocolVersion: BROWSER_PROTOCOL_VERSION,
						sessionId: "ses_1",
						channelId: "ses_1",
						sessionName: "One",
						displayName: "One",
						cwd: "/repo",
						status: "active",
						lastActiveAt: "2026-06-27T10:00:00.000Z",
						processId: 1,
					},
				],
			},
			{},
		);

		const card = root.querySelector(".session-card");
		expect(card?.getAttribute("tabindex")).toBe("0");
		expect(card?.getAttribute("role")).toBe("option");
	});
});

// ── ensureBrowserInstallId ─────────────────────────────────────────────────

describe("ensureBrowserInstallId", () => {
	test("creates and persists a browser install id when missing", async () => {
		const stored = installPopupGlobals();
		const installId = await ensureBrowserInstallId();
		expect(installId).toMatch(/^browser_/);
		expect(stored.browserInstallId).toBe(installId);
	});
});

// ── Manifest check ────────────────────────────────────────────────────────

describe("manifest", () => {
	test("requires icon files and default_title", () => {
		const manifestPath = path.resolve(import.meta.dir, "..", "manifest.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

		expect(manifest.icons).toBeDefined();
		expect(manifest.icons["16"]).toBe("icons/icon16.png");
		expect(manifest.icons["32"]).toBe("icons/icon32.png");
		expect(manifest.icons["48"]).toBe("icons/icon48.png");
		expect(manifest.icons["128"]).toBe("icons/icon128.png");

		expect(manifest.action.default_icon).toBeDefined();
		expect(manifest.action.default_title).toBe("OMP Browser Feedback");

		for (const size of [16, 32, 48, 128]) {
			const iconPath = path.resolve(
				import.meta.dir,
				"..",
				manifest.icons[String(size)],
			);
			expect(fs.existsSync(iconPath)).toBe(true);
		}
	});
});
