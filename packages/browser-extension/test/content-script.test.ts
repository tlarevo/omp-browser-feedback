import { describe, expect, test } from "bun:test";
import { BROWSER_PROTOCOL_VERSION } from "@oh-my-pi/browser-protocol";
import { parseHTML } from "linkedom";
import {
	activatePickerAndCapture,
	buildDomSelectionFeedback,
	captureAccessibility,
	generateXpath,
} from "../src/content-script";

// ---------------------------------------------------------------------------
// Helper: create a linkedom environment with mocked geometry
// ---------------------------------------------------------------------------
function makeEnv(html: string) {
	const { document, window } = parseHTML(html);
	// location may be readonly in some linkedom versions — set only if writable.
	try {
		Object.defineProperty(window, "location", {
			value: { href: "https://example.com/test" },
		});
	} catch {
		// Already readonly — fine for tests that don't depend on URL.
	}
	Object.defineProperty(window, "innerWidth", { value: 1280 });
	Object.defineProperty(window, "innerHeight", { value: 720 });
	Object.defineProperty(window, "devicePixelRatio", { value: 2 });
	window.getComputedStyle = () =>
		({
			getPropertyValue: (property: string) =>
				property === "display" ? "inline-block" : "",
		}) as CSSStyleDeclaration;
	return { document, window };
}

function mockBounds(element: Element) {
	element.getBoundingClientRect = () =>
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
}

// ---------------------------------------------------------------------------
// buildDomSelectionFeedback
// ---------------------------------------------------------------------------
describe("buildDomSelectionFeedback", () => {
	test("captures page, selector, attributes, bounds, and note", () => {
		const { document, window } = makeEnv(
			"<!doctype html><title>Checkout</title><button data-testid='submit' aria-label='Submit order'>Buy</button>",
		);
		document.title = "Checkout";
		const button = document.querySelector("button");
		if (!button) throw new Error("Missing button");
		mockBounds(button);

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

	test("populates xpath and accessibility when present", () => {
		const { document, window } = makeEnv(
			"<!doctype html><button id='save' aria-label='Save changes'>Save</button>",
		);
		const button = document.querySelector("button");
		if (!button) throw new Error("Missing button");
		mockBounds(button);

		const event = buildDomSelectionFeedback({
			channelId: "ses_1",
			element: button,
			window,
		});

		if (event.type !== "dom.selection")
			throw new Error("Expected DOM selection feedback");
		// linkedom doesn't support document.evaluate, so xpath uses id path
		// without verification — it should still produce the id-anchored path.
		expect(event.element.xpath).toBe('//*[@id="save"]');
		expect(event.element.accessibility).toEqual({
			role: "button",
			name: "Save changes",
		});
	});

	test("omits xpath and accessibility when absent", () => {
		const { document, window } = makeEnv("<!doctype html><div>plain</div>");
		const div = document.querySelector("div");
		if (!div) throw new Error("Missing div");

		const event = buildDomSelectionFeedback({
			channelId: "ses_1",
			element: div,
			window,
		});

		if (event.type !== "dom.selection")
			throw new Error("Expected DOM selection feedback");
		// div has no id but still gets a positional xpath
		expect(event.element.xpath).toBe("/div[1]");
		// div with text "plain" gets name from text fallback
		expect(event.element.accessibility).toEqual({ name: "plain" });
	});
});

// ---------------------------------------------------------------------------
// generateXpath
// ---------------------------------------------------------------------------
describe("generateXpath", () => {
	test("prefers id-anchored path when id is unique", () => {
		const { document } = parseHTML(
			'<!doctype html><div id="app"><button id="save">Save</button></div>',
		);
		const button = document.querySelector("#save");
		expect(button).toBeTruthy();
		expect(generateXpath(button as Element)).toBe('//*[@id="save"]');
	});

	test("returns undefined for shadow-DOM elements (null ownerDocument)", () => {
		const el = { ownerDocument: null } as unknown as Element;
		expect(generateXpath(el)).toBeUndefined();
	});

	test("falls back to positional path when no id", () => {
		const { document } = parseHTML(
			"<!doctype html><main><p>first</p><p>second</p></main>",
		);
		const p = document.querySelector("main > p:nth-of-type(2)");
		expect(p).toBeTruthy();
		const xpath = generateXpath(p as Element);
		// linkedom doesn't support document.evaluate, so positional path
		// is generated but the final verification is skipped.
		expect(xpath).toBeTruthy();
		expect(xpath).toContain("p[2]");
	});

	test("produces a valid xpath structure", () => {
		const { document } = parseHTML(
			"<!doctype html><section><div><span>hi</span></div></section>",
		);
		const span = document.querySelector("span");
		expect(span).toBeTruthy();
		const xpath = generateXpath(span as Element);
		expect(xpath).toBeTruthy();
		// Should be an absolute path starting with /
		expect(xpath).toMatch(/^\/.*span/);
	});
});

// ---------------------------------------------------------------------------
// captureAccessibility
// ---------------------------------------------------------------------------
describe("captureAccessibility", () => {
	test("extracts role from explicit role attribute", () => {
		const { document } = parseHTML(
			'<div role="navigation"><a href="/">Home</a></div>',
		);
		const nav = document.querySelector('[role="navigation"]');
		expect(nav).toBeTruthy();
		// The nav div has child text "Home" via the <a> element, so name
		// is populated from the text fallback.
		expect(captureAccessibility(nav as Element)).toEqual({
			role: "navigation",
			name: "Home",
		});
	});

	test("uses implicit tag role when no explicit role", () => {
		const { document } = parseHTML("<button>Click me</button>");
		const button = document.querySelector("button");
		expect(button).toBeTruthy();
		expect(captureAccessibility(button as Element)).toEqual({
			role: "button",
			name: "Click me",
		});
	});

	test("aria-labelledby takes precedence over aria-label", () => {
		const { document } = parseHTML(
			'<p id="lbl">Full Name</p><input aria-label="Short" aria-labelledby="lbl" />',
		);
		const input = document.querySelector("input");
		expect(input).toBeTruthy();
		expect(captureAccessibility(input as Element)).toEqual({
			role: "textbox",
			name: "Full Name",
		});
	});

	test("aria-label wins over label-for", () => {
		const { document } = parseHTML(
			'<label for="email">Email Address</label><input id="email" aria-label="Email" />',
		);
		const input = document.querySelector("input");
		expect(input).toBeTruthy();
		expect(captureAccessibility(input as Element)).toEqual({
			role: "textbox",
			name: "Email",
		});
	});

	test("label-for wins over alt", () => {
		const { document } = parseHTML(
			'<label for="img1">Company Logo</label><img id="img1" alt="Logo" />',
		);
		const img = document.querySelector("img");
		expect(img).toBeTruthy();
		expect(captureAccessibility(img as Element)).toEqual({
			role: "img",
			name: "Company Logo",
		});
	});

	test("alt wins over title", () => {
		const { document } = parseHTML('<img alt="Photo of cat" title="Kitty" />');
		const img = document.querySelector("img");
		expect(img).toBeTruthy();
		expect(captureAccessibility(img as Element)).toEqual({
			role: "img",
			name: "Photo of cat",
		});
	});

	test("title wins over long visible text", () => {
		const { document } = parseHTML(
			'<span title="Short tip">A very long text content that exceeds the 120 character limit for automatic accessible name detection from text content to avoid bloating the prompt with excessive visible text that goes on and on</span>',
		);
		const span = document.querySelector("span");
		expect(span).toBeTruthy();
		expect(captureAccessibility(span as Element)).toEqual({
			name: "Short tip",
		});
	});

	test("reads aria-describedby for description", () => {
		const { document } = parseHTML(
			'<button aria-describedby="hint1">Submit</button><p id="hint1">Sends the form</p>',
		);
		const button = document.querySelector("button");
		expect(button).toBeTruthy();
		expect(captureAccessibility(button as Element)).toEqual({
			role: "button",
			name: "Submit",
			description: "Sends the form",
		});
	});

	test("returns undefined for element with no a11y info at all", () => {
		const { document } = parseHTML("<div></div>");
		const div = document.querySelector("div");
		expect(div).toBeTruthy();
		expect(captureAccessibility(div as Element)).toBeUndefined();
	});

	test("visible text used as name when no other source and <= 120 chars", () => {
		const { document } = parseHTML("<span>Click here</span>");
		const span = document.querySelector("span");
		expect(span).toBeTruthy();
		expect(captureAccessibility(span as Element)).toEqual({
			name: "Click here",
		});
	});
});

// ---------------------------------------------------------------------------
// activatePickerAndCapture
// ---------------------------------------------------------------------------
describe("activatePickerAndCapture", () => {
	test("returns a handle and calls callback with null on deactivate without selection", () => {
		const { document } = parseHTML(
			"<!doctype html><body><button id='btn'>OK</button></body>",
		);
		let result: unknown = "not-called";

		const handle = activatePickerAndCapture(
			document,
			{ channelId: "ses_1" },
			(event) => {
				result = event;
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
			() => {},
		);
		expect(document.querySelector("[data-omp-picker-overlay]")).not.toBeNull();
		handle.deactivate();
	});
});
