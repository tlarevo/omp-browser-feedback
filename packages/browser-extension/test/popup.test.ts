import { describe, expect, test } from "bun:test";
import { BROWSER_PROTOCOL_VERSION } from "@oh-my-pi/browser-protocol";
import { parseHTML } from "linkedom";
import {
	ensureBrowserInstallId,
	renderPopup,
	renderSessionLabel,
} from "../src/popup/main";

function documentWithRoot() {
	const { document } = parseHTML("<main id='app'></main>");
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

describe("renderSessionLabel", () => {
	test("includes name, cwd, branch, and status for duplicate-session disambiguation", () => {
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
});

describe("renderPopup", () => {
	test("renders an unpaired state with a pairing code action", () => {
		const { root } = documentWithRoot();
		let savedCode = "";
		renderPopup(
			root,
			{ kind: "unpaired", baseUrl: "http://127.0.0.1:4317" },
			{ onPairWithCode: (code) => (savedCode = code) },
		);

		const input = root.querySelector("input");
		expect(root.textContent).toContain("Enter pairing code");
		expect(input?.getAttribute("placeholder")).toContain("Pairing code");
		if (input) input.value = "A7K2Q9";
		root.querySelector("button")?.click();

		expect(savedCode).toBe("A7K2Q9");
	});

	test("renders active sessions and starts picker for the selected session", () => {
		const { root } = documentWithRoot();
		let picked = "";
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
						gitBranch: "feature",
						status: "idle",
						lastActiveAt: "2026-06-27T10:00:00.000Z",
						processId: 2,
					},
				],
			},
			{ onStartPicker: (sessionId) => (picked = sessionId) },
		);

		expect(root.textContent).toContain("Two · /repo/two · feature · idle");
		root.querySelector("button")?.click();
		expect(picked).toBe("ses_2");
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
});

describe("ensureBrowserInstallId", () => {
	test("creates and persists a browser install id when missing", async () => {
		const stored = installPopupGlobals();

		const installId = await ensureBrowserInstallId();
		expect(installId).toMatch(/^browser_/);
		expect(stored.browserInstallId).toBe(installId);
	});
});
