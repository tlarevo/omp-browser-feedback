import { describe, expect, test } from "bun:test";
import {
	BROWSER_PROTOCOL_VERSION,
	type BrowserFeedbackEvent,
} from "@oh-my-pi/browser-protocol";
import { Event as LinkedomEvent, parseHTML } from "linkedom";
import {
	activatePickerAndCapture,
	buildDomSelectionFeedback,
} from "../src/content-script";

/** Build a linkedom Event with a `key` property for Escape simulation. */
function keyDown(key: string): Event {
	const e = new LinkedomEvent("keydown", { bubbles: true });
	(e as unknown as Record<string, unknown>).key = key;
	return e as unknown as Event;
}

describe("buildDomSelectionFeedback", () => {
	test("captures page, selector, attributes, bounds, and note", () => {
		const { document, window } = parseHTML(
			"<!doctype html><title>Checkout</title><button data-testid='submit' aria-label='Submit order'>Buy</button>",
		);
		document.title = "Checkout";
		Object.defineProperty(window, "location", {
			value: { href: "https://example.com/cart" },
		});
		Object.defineProperty(window, "innerWidth", { value: 1280 });
		Object.defineProperty(window, "innerHeight", { value: 720 });
		Object.defineProperty(window, "devicePixelRatio", { value: 2 });
		window.getComputedStyle = () =>
			({
				getPropertyValue: (property: string) =>
					property === "display" ? "inline-block" : "",
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
		if (event.type !== "dom.selection")
			throw new Error("Expected DOM selection feedback");
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
		const { document } = parseHTML(
			"<!doctype html><body><button id='btn'>OK</button></body>",
		);
		let result: unknown = "not-called";

		const handle = activatePickerAndCapture(
			document,
			{ channelId: "ses_1" },
			{
				onPick: (event: BrowserFeedbackEvent) => {
					result = event;
				},
				onExit: () => {},
			},
		);

		handle.deactivate();
		expect(result).toBe("not-called");
	});

	test("appends an overlay element to the body", () => {
		const { document } = parseHTML("<!doctype html><body></body>");
		const handle = activatePickerAndCapture(
			document,
			{ channelId: "ses_1" },
			{ onPick: () => {}, onExit: () => {} },
		);
		expect(document.querySelector("[data-omp-picker-overlay]")).not.toBeNull();
		handle.deactivate();
	});
});

describe("activatePickerAndCapture — stay-active mode", () => {
	test("stay-active picker fires onPick without calling onExit", () => {
		const { document, window: linkedomWindow } = parseHTML(
			"<!doctype html><body><button id='btn'>OK</button></body>",
		);
		const picks: BrowserFeedbackEvent[] = [];
		const exits: number[] = [];

		activatePickerAndCapture(
			document,
			{ channelId: "ses_1", stayActive: true, window: linkedomWindow },
			{
				onPick: (event: BrowserFeedbackEvent) => picks.push(event),
				onExit: () => exits.push(1),
			},
		);

		// Hover and click
		const btn = document.querySelector("button") as Element;
		btn.dispatchEvent(
			new LinkedomEvent("mouseover", { bubbles: true }) as unknown as Event,
		);
		document.dispatchEvent(
			new LinkedomEvent("click", { bubbles: true }) as unknown as Event,
		);
		expect(picks).toHaveLength(1);
		expect(exits).toHaveLength(0);

		// Escape to exit
		document.dispatchEvent(keyDown("Escape"));
		document.dispatchEvent(keyDown("Escape"));
		expect(exits).toHaveLength(1);
	});

	test("deactivate removes all picker DOM elements", () => {
		const { document } = parseHTML("<!doctype html><body></body>");
		const handle = activatePickerAndCapture(
			document,
			{ channelId: "ses_1", stayActive: true },
			{ onPick: () => {}, onExit: () => {} },
		);
		expect(document.querySelector("[data-omp-picker-overlay]")).not.toBeNull();
		expect(document.querySelector("[data-omp-picker-chip]")).not.toBeNull();
		handle.deactivate();
		expect(document.querySelector("[data-omp-picker-overlay]")).toBeNull();
		expect(document.querySelector("[data-omp-picker-chip]")).toBeNull();
	});
});
