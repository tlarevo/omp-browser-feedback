import { describe, expect, test } from "bun:test";
import {
	BROWSER_PROTOCOL_VERSION,
	type BrowserFeedbackEvent,
} from "@oh-my-pi/browser-protocol";
import {
	formatFeedbackAsPrompt,
	renderBrowserFeedbackContext,
} from "../src/renderer";

function makeEvent(
	overrides: Partial<BrowserFeedbackEvent["element"]> = {},
): BrowserFeedbackEvent {
	return {
		protocolVersion: BROWSER_PROTOCOL_VERSION,
		eventId: "evt_1",
		type: "dom.selection",
		channelId: "ses_1",
		createdAt: "2026-07-18T12:00:00.000Z",
		page: {
			url: "https://example.com/app",
			title: "App",
			viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
		},
		element: {
			selector: "#submit",
			tagName: "button",
			outerHtml: '<button id="submit">Go</button>',
			attributes: { id: "submit" },
			bounds: { x: 10, y: 20, width: 100, height: 40 },
			computedStyles: {},
			...overrides,
		},
	};
}

describe("formatFeedbackAsPrompt — component line", () => {
	test("includes component info when present", () => {
		const event = makeEvent({
			component: {
				framework: "react",
				ancestors: [
					{ name: "CheckoutButton", source: "src/CheckoutButton.tsx:42" },
					{ name: "PricingCard" },
				],
			},
		});
		const prompt = formatFeedbackAsPrompt(event);
		expect(prompt).toContain(
			"Component: react — in CheckoutButton › PricingCard (src/CheckoutButton.tsx:42)",
		);
	});

	test("omits component line when absent", () => {
		const event = makeEvent();
		const prompt = formatFeedbackAsPrompt(event);
		expect(prompt).not.toContain("Component:");
	});

	test("omits source path when no source on first ancestor", () => {
		const event = makeEvent({
			component: {
				framework: "vue",
				ancestors: [{ name: "SubmitForm" }],
			},
		});
		const prompt = formatFeedbackAsPrompt(event);
		expect(prompt).toContain("Component: vue — in SubmitForm");
		expect(prompt).not.toContain("Component: vue — in SubmitForm (");
	});
});

describe("renderBrowserFeedbackContext — Component section", () => {
	test("renders component chain with sources", () => {
		const event = makeEvent({
			component: {
				framework: "react",
				ancestors: [
					{ name: "Button", source: "src/Button.tsx:10" },
					{ name: "Form", source: "src/Form.tsx:5" },
				],
			},
		});
		const ctx = renderBrowserFeedbackContext(event);
		expect(ctx).toContain("Component");
		expect(ctx).toContain("Button (src/Button.tsx:10) › Form (src/Form.tsx:5)");
	});

	test("renders 'None detected' when no component", () => {
		const event = makeEvent();
		const ctx = renderBrowserFeedbackContext(event);
		expect(ctx).toContain("Component\nNone detected");
	});
});
