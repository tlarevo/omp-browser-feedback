import { describe, expect, test } from "bun:test";
import type {
<<<<<<< HEAD
	BrowserFeedbackEvent,
=======
	BatchFeedback,
>>>>>>> tharinduabeydeera/tha-30-extension-batch-feedback-composer-collect-multiple-picks-and
	DomSelectionFeedback,
} from "@oh-my-pi/browser-protocol";
import {
	formatFeedbackAsPrompt,
	renderBrowserFeedbackContext,
} from "../src/renderer";

<<<<<<< HEAD
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
=======
const stubItem: DomSelectionFeedback = {
	protocolVersion: 1,
	eventId: "evt_1",
	type: "dom.selection",
	channelId: "ses_1",
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
		attributes: { "data-testid": "save", class: "btn primary" },
		bounds: { x: 10, y: 20, width: 80, height: 32 },
		computedStyles: { display: "inline-flex" },
	},
};

function makeBatch(
	items: DomSelectionFeedback[],
	batchNote?: string,
): BatchFeedback {
	return {
		protocolVersion: 1,
		eventId: "batch_1",
		type: "batch.feedback",
		channelId: "ses_1",
		createdAt: "2026-06-27T10:00:00.000Z",
		items,
		...(batchNote ? { batchNote } : {}),
	};
}

describe("formatFeedbackAsPrompt — batch", () => {
	test("formats single-item batch", () => {
		const prompt = formatFeedbackAsPrompt(makeBatch([stubItem]));
		expect(prompt).toContain("batch feedback from Chrome extension (1 items)");
		expect(prompt).toContain("1.");
		expect(prompt).toContain("<button.btn.primary>");
		expect(prompt).toContain("Please apply all changes.");
	});

	test("formats multi-item batch with notes", () => {
		const item2: DomSelectionFeedback = {
			...stubItem,
			eventId: "evt_2",
			note: "Change color",
			element: { ...stubItem.element, tagName: "DIV", selector: "div.card" },
		};
		const prompt = formatFeedbackAsPrompt(
			makeBatch([stubItem, item2], "Fix layout"),
		);
		expect(prompt).toContain("2 items");
		expect(prompt).toContain('Note: "Change color"');
		expect(prompt).toContain('Batch note: "Fix layout"');
	});

	test("formats batch without notes", () => {
		const prompt = formatFeedbackAsPrompt(makeBatch([stubItem]));
		expect(prompt).not.toContain("Note:");
		expect(prompt).not.toContain("Batch note:");
	});
});

describe("renderBrowserFeedbackContext — batch", () => {
	test("renders batch with items list", () => {
		const ctx = renderBrowserFeedbackContext(makeBatch([stubItem, stubItem]));
		expect(ctx).toContain("batch browser feedback (2 items)");
		expect(ctx).toContain("1.");
		expect(ctx).toContain("2.");
		expect(ctx).toContain("batch_1");
	});

	test("renders batch note", () => {
		const ctx = renderBrowserFeedbackContext(makeBatch([stubItem], "Urgent"));
		expect(ctx).toContain('Batch note: "Urgent"');
>>>>>>> tharinduabeydeera/tha-30-extension-batch-feedback-composer-collect-multiple-picks-and
	});
});
