import { describe, expect, test } from "bun:test";
import {
	BROWSER_PROTOCOL_VERSION,
	validateFeedbackEvent,
	validateSessionRegistration,
} from "../src";

describe("browser protocol validation", () => {
	test("accepts a valid session registration", () => {
		const result = validateSessionRegistration({
			protocolVersion: BROWSER_PROTOCOL_VERSION,
			sessionId: "ses_123",
			channelId: "ses_123",
			sessionName: "OMP session",
			displayName: "OMP session",
			cwd: "/repo",
			projectName: "oh-my-pi",
			gitBranch: "main",
			status: "active",
			lastActiveAt: "2026-06-27T10:00:00.000Z",
			processId: 123,
		});

		expect(result.ok).toBe(true);
	});

	test("rejects feedback routed without a channel id", () => {
		const result = validateFeedbackEvent({
			protocolVersion: BROWSER_PROTOCOL_VERSION,
			eventId: "evt_123",
			type: "dom.selection",
			channelId: "",
			createdAt: "2026-06-27T10:00:00.000Z",
			page: {
				url: "https://example.com",
				title: "Example",
				viewport: { width: 1200, height: 800, devicePixelRatio: 2 },
			},
			element: {
				selector: "button[data-testid='save']",
				tagName: "BUTTON",
				outerHtml: '<button data-testid="save">Save</button>',
				attributes: { "data-testid": "save" },
				bounds: { x: 10, y: 20, width: 80, height: 32 },
				computedStyles: { display: "inline-flex" },
			},
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected feedback validation to fail");
		expect(result.error).toContain("channelId");
	});
});
