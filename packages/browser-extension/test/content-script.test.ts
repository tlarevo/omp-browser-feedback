import { describe, expect, test } from "bun:test";
import {
	BROWSER_FEEDBACK_LIMITS,
	BROWSER_FEEDBACK_TRUNCATION_MARKER,
	BROWSER_PROTOCOL_VERSION,
	type BrowserFeedbackEvent,
	codePointLength,
} from "@oh-my-pi/browser-protocol";
import { Event as LinkedomEvent, parseHTML } from "linkedom";
import {
	activatePickerAndCapture,
	buildDomSelectionFeedback,
	captureAccessibility,
	captureElementContext,
	generateXpath,
} from "../src/content-script";

// ── Helpers ────────────────────────────────────────────────────────────────

function buildHugeDomFixture(opts: {
	textLen?: number;
	htmlLen?: number;
	attributeCount?: number;
	styleCount?: number;
}) {
	const textLen = opts.textLen ?? 0;
	const htmlLen = opts.htmlLen ?? 0;
	const attributeCount = opts.attributeCount ?? 0;
	const styleCount = opts.styleCount ?? 0;

	const attrs = Array.from(
		{ length: attributeCount },
		(_, i) => `data-a${i}="v${i}"`,
	).join(" ");
	const textContent = "x".repeat(textLen);
	const outerHtmlContent = "y".repeat(htmlLen);

	const html = `<div ${attrs}>${textContent}</div>`;
	const { document, window } = parseHTML(html);

	Object.defineProperty(window, "innerWidth", { value: 1280 });
	Object.defineProperty(window, "innerHeight", { value: 720 });
	Object.defineProperty(window, "devicePixelRatio", { value: 2 });

	const div = document.querySelector("div");
	if (!div) throw new Error("Missing div");
	if (htmlLen > 0) {
		Object.defineProperty(div, "outerHTML", {
			value: "<div>" + outerHtmlContent + "</div>",
			configurable: true,
		});
	}
	if (textLen > 0) {
		Object.defineProperty(div, "textContent", {
			value: textContent,
			configurable: true,
		});
	}

	const styleProps = Array.from({ length: styleCount }, (_, i) => `prop-${i}`);
	window.getComputedStyle = () =>
		({
			getPropertyValue: (property: string) => {
				const idx = styleProps.indexOf(property);
				return idx >= 0 ? `val-${idx}` : "";
			},
		}) as CSSStyleDeclaration;

	div.getBoundingClientRect = () =>
		({
			x: 0,
			y: 0,
			width: 100,
			height: 50,
			top: 0,
			right: 100,
			bottom: 50,
			left: 0,
			toJSON: () => ({}),
		}) as DOMRect;

	return { document, window, div };
}

function makeEnv(html: string) {
	const { document, window } = parseHTML(html);
	try {
		Object.defineProperty(window, "location", {
			value: { href: "https://example.com/test" },
		});
	} catch {
		// Already readonly
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

/** Build a linkedom Event with a `key` property for Escape simulation. */
function keyDown(key: string): Event {
	const e = new LinkedomEvent("keydown", { bubbles: true });
	(e as unknown as Record<string, unknown>).key = key;
	return e as unknown as Event;
}

// ── Tests ──────────────────────────────────────────────────────────────────

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
			eventId: "evt_xpath",
			createdAt: "2026-07-18T00:00:00.000Z",
			window,
		});

		if (event.type !== "dom.selection")
			throw new Error("Expected DOM selection feedback");
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
		mockBounds(div);

		const event = buildDomSelectionFeedback({
			channelId: "ses_1",
			element: div,
			eventId: "evt_plain",
			createdAt: "2026-07-18T00:00:00.000Z",
			window,
		});

		if (event.type !== "dom.selection")
			throw new Error("Expected DOM selection feedback");
		expect(event.element.xpath).toBe("/div[1]");
		expect(event.element.accessibility).toEqual({ name: "plain" });
	});

	test("truncates huge outer HTML with marker", () => {
		const hugeHtmlLen = 600 * 1024;
		const { window, div } = buildHugeDomFixture({
			htmlLen: hugeHtmlLen,
			textLen: 10,
			attributeCount: 1,
		});

		const event = buildDomSelectionFeedback({
			channelId: "ses_1",
			element: div,
			eventId: "evt_huge_html",
			createdAt: "2026-07-18T00:00:00.000Z",
			window,
		});

		if (event.type !== "dom.selection")
			throw new Error("Expected DOM selection");
		expect(codePointLength(event.element.outerHtml)).toBe(
			BROWSER_FEEDBACK_LIMITS.maxOuterHtmlLength,
		);
		expect(event.element.outerHtml).toContain(
			BROWSER_FEEDBACK_TRUNCATION_MARKER,
		);
	});

	test("truncates huge element text with marker", () => {
		const hugeTextLen = BROWSER_FEEDBACK_LIMITS.maxElementTextLength + 500;
		const { window, div } = buildHugeDomFixture({
			textLen: hugeTextLen,
			htmlLen: 100,
			attributeCount: 1,
		});

		const event = buildDomSelectionFeedback({
			channelId: "ses_1",
			element: div,
			eventId: "evt_huge_text",
			createdAt: "2026-07-18T00:00:00.000Z",
			window,
		});

		if (event.type !== "dom.selection")
			throw new Error("Expected DOM selection");
		expect(event.element.text).toBeDefined();
		expect(codePointLength(event.element.text!)).toBe(
			BROWSER_FEEDBACK_LIMITS.maxElementTextLength,
		);
		expect(event.element.text).toContain(BROWSER_FEEDBACK_TRUNCATION_MARKER);
	});

	test("caps 200 attributes to maxAttributeCount (80)", () => {
		const { window, div } = buildHugeDomFixture({
			attributeCount: 200,
			htmlLen: 50,
		});

		const event = buildDomSelectionFeedback({
			channelId: "ses_1",
			element: div,
			eventId: "evt_200_attrs",
			createdAt: "2026-07-18T00:00:00.000Z",
			window,
		});

		if (event.type !== "dom.selection")
			throw new Error("Expected DOM selection");
		const attrCount = Object.keys(event.element.attributes).length;
		expect(attrCount).toBe(BROWSER_FEEDBACK_LIMITS.maxAttributeCount);
		expect(attrCount).toBeLessThan(200);
	});

	test("caps 200 computed styles to maxComputedStyleCount (80)", () => {
		const styleProps = Array.from({ length: 200 }, (_, i) => `prop-${i}`);
		const { window, div } = buildHugeDomFixture({
			styleCount: 200,
			htmlLen: 50,
		});

		const elementCtx = captureElementContext(div, {
			window,
			styleProperties: styleProps,
		});

		const styleCount = Object.keys(elementCtx.computedStyles).length;
		expect(styleCount).toBe(BROWSER_FEEDBACK_LIMITS.maxComputedStyleCount);
		expect(styleCount).toBeLessThan(200);
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
