import { describe, expect, test } from "bun:test";
import type {
	BatchFeedback,
	DomSelectionFeedback,
} from "@oh-my-pi/browser-protocol";
import {
	formatFeedbackAsPrompt,
	renderBrowserFeedbackContext,
} from "../src/renderer";

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
	});
});
