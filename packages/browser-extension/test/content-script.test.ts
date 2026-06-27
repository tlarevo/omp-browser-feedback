import { describe, expect, test } from "bun:test";
import { BROWSER_PROTOCOL_VERSION } from "@oh-my-pi/browser-protocol";
import { parseHTML } from "linkedom";
import { activatePickerAndCapture, buildDomSelectionFeedback } from "../src/content-script";

describe("buildDomSelectionFeedback", () => {
	test("captures page, selector, attributes, bounds, and note", () => {
		const { document, window } = parseHTML(
			"<!doctype html><title>Checkout</title><button data-testid='submit' aria-label='Submit order'>Buy</button>",
		);
		document.title = "Checkout";
		Object.defineProperty(window, "location", { value: { href: "https://example.com/cart" } });
		Object.defineProperty(window, "innerWidth", { value: 1280 });
		Object.defineProperty(window, "innerHeight", { value: 720 });
		Object.defineProperty(window, "devicePixelRatio", { value: 2 });
		window.getComputedStyle = () =>
			({
				getPropertyValue: (property: string) => (property === "display" ? "inline-block" : ""),
			}) as CSSStyleDeclaration;
		const button = document.querySelector("button");
		if (!button) throw new Error("Missing button");
		button.getBoundingClientRect = () =>
			({
				x: 10,
				y: 20,
				width: 100,
				height: 40,
				top: 20,
				right: 110,
				bottom: 60,
				left: 10,
				toJSON: () => ({}),
			}) as DOMRect;

		const event = buildDomSelectionFeedback({
			channelId: "ses_1",
			element: button,
			eventId: "evt_1",
			createdAt: "2026-06-27T10:00:00.000Z",
			note: "Make this clearer",
			window,
		});

		expect(event.protocolVersion).toBe(BROWSER_PROTOCOL_VERSION);
		expect(event).toMatchObject({
			eventId: "evt_1",
			type: "dom.selection",
			channelId: "ses_1",
			page: {
				url: "https://example.com/cart",
				title: "Checkout",
				viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
			},
			note: "Make this clearer",
		});
		if (event.type !== "dom.selection") throw new Error("Expected DOM selection feedback");
		expect(event.element).toMatchObject({
			selector: '[data-testid="submit"]',
			tagName: "BUTTON",
			text: "Buy",
			attributes: { "data-testid": "submit", "aria-label": "Submit order" },
			bounds: { x: 10, y: 20, width: 100, height: 40 },
		});
		expect(event.element.computedStyles.display).toBe("inline-block");
	});
});

describe("activatePickerAndCapture", () => {
	test("returns a handle and calls callback with null on deactivate without selection", () => {
		const { document } = parseHTML("<!doctype html><body><button id='btn'>OK</button></body>");
		let result: unknown = "not-called";

		const handle = activatePickerAndCapture(document, { channelId: "ses_1" }, event => {
			result = event;
		});

		handle.deactivate();
		expect(result).toBe("not-called");
	});

	test("appends an overlay element to the body", () => {
		const { document } = parseHTML("<!doctype html><body></body>");
		const handle = activatePickerAndCapture(document, { channelId: "ses_1" }, () => {});
		expect(document.querySelector("[data-omp-picker-overlay]")).not.toBeNull();
		handle.deactivate();
	});
});
