import { describe, expect, test } from "bun:test";
import { BROWSER_PROTOCOL_VERSION } from "@oh-my-pi/browser-protocol";
import { parseHTML } from "linkedom";
import { renderPopup, renderSessionLabel } from "../src/popup/main";

function documentWithRoot() {
	const { document } = parseHTML("<main id='app'></main>");
	const root = document.getElementById("app");
	if (!root) throw new Error("Missing popup root");
	return { document, root };
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
	test("renders a missing-auth state with a token save action", () => {
		const { root } = documentWithRoot();
		let saved = "";
		renderPopup(
			root,
			{ kind: "missing-auth", baseUrl: "http://127.0.0.1:4317" },
			{ onSaveToken: (token) => (saved = token) },
		);

		const input = root.querySelector("input");
		expect(root.textContent).toContain("Broker found");
		expect(input).toBeTruthy();
		if (input) input.value = "secret";
		root.querySelector("button")?.click();

		expect(saved).toBe("secret");
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
});
