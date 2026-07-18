import { describe, expect, test } from "bun:test";
import type {
	BrowserFeedbackEvent,
	DomSelectionFeedback,
} from "@oh-my-pi/browser-protocol";
import {
	formatFeedbackAsPrompt,
	renderBrowserFeedbackContext,
} from "../src/renderer";

function makeDomSelection(
	overrides: Partial<DomSelectionFeedback> = {},
): DomSelectionFeedback {
	return {
		protocolVersion: "1.0.0",
		eventId: "evt_test",
		type: "dom.selection",
		channelId: "ch_1",
		createdAt: "2026-07-01T12:00:00.000Z",
		page: {
			url: "https://example.com/page",
			title: "Test Page",
			viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
		},
		element: {
			selector: '[data-testid="save"]',
			tagName: "BUTTON",
			text: "Save",
			outerHtml: '<button data-testid="save">Save</button>',
			attributes: { "data-testid": "save", "aria-label": "Save changes" },
			bounds: { x: 10, y: 20, width: 100, height: 40 },
			computedStyles: { display: "inline-block" },
		},
		...overrides,
	};
}

describe("renderBrowserFeedbackContext", () => {
	test("includes xpath and accessible info when present", () => {
		const event = makeDomSelection({
			element: {
				selector: '[data-testid="save"]',
				xpath: '//*[@id="save"]',
				tagName: "BUTTON",
				text: "Save",
				outerHtml: '<button id="save" data-testid="save">Save</button>',
				attributes: {
					"data-testid": "save",
					id: "save",
					"aria-label": "Save changes",
				},
				bounds: { x: 10, y: 20, width: 100, height: 40 },
				computedStyles: { display: "inline-block" },
				accessibility: {
					role: "button",
					name: "Save changes",
				},
			},
		});

		const output = renderBrowserFeedbackContext(event);
		expect(output).toContain('XPath: //*[@id="save"]');
		expect(output).toContain('Accessible: button "Save changes"');
	});

	test("omits xpath line when xpath is absent", () => {
		const event = makeDomSelection();
		const output = renderBrowserFeedbackContext(event);
		expect(output).not.toContain("XPath:");
	});

	test("omits accessible line when accessibility is absent", () => {
		const event = makeDomSelection();
		const output = renderBrowserFeedbackContext(event);
		expect(output).not.toContain("Accessible:");
	});

	test("renders accessibility description when present", () => {
		const event = makeDomSelection({
			element: {
				selector: "#submit",
				tagName: "BUTTON",
				outerHtml: '<button id="submit">OK</button>',
				attributes: { id: "submit" },
				bounds: { x: 0, y: 0, width: 50, height: 30 },
				computedStyles: {},
				accessibility: {
					role: "button",
					name: "OK",
					description: "Submits the form",
				},
			},
		});

		const output = renderBrowserFeedbackContext(event);
		expect(output).toContain('Accessible: button "OK" (Submits the form)');
	});

	test("omits text line when element text is absent", () => {
		const event = makeDomSelection({
			element: {
				selector: "#icon",
				tagName: "IMG",
				outerHtml: '<img id="icon" alt="Icon" />',
				attributes: { id: "icon", alt: "Icon" },
				bounds: { x: 0, y: 0, width: 24, height: 24 },
				computedStyles: {},
				accessibility: { role: "img", name: "Icon" },
			},
		});

		const output = renderBrowserFeedbackContext(event);
		expect(output).not.toContain("- Text:");
		expect(output).toContain('Accessible: img "Icon"');
	});
});

describe("formatFeedbackAsPrompt", () => {
	test("still works for basic rendering", () => {
		const event = makeDomSelection({
			note: "Make this bigger",
		});
		const output = formatFeedbackAsPrompt(event as BrowserFeedbackEvent);
		expect(output).toContain("Browser feedback from Chrome extension:");
		expect(output).toContain("Page: https://example.com/page");
		expect(output).toContain('Note: "Make this bigger"');
	});
});
