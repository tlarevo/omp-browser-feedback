import { describe, expect, test } from "bun:test";
import { BROWSER_PROTOCOL_VERSION } from "@oh-my-pi/browser-protocol";
import { parseHTML } from "linkedom";
import {
	activatePickerAndCapture,
	buildDomSelectionFeedback,
	captureElementContext,
	redactOuterHtml,
	redactSensitiveAttributes,
} from "../src/content-script";

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
			}) as unknown as CSSStyleDeclaration;
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

describe("redactSensitiveAttributes", () => {
	test("redacts password input value", () => {
		const result = redactSensitiveAttributes(
			{ type: "password", value: "s3cret" },
			"INPUT",
			"password",
		);
		expect(result.value).toBe("[REDACTED]");
		expect(result.type).toBe("password");
	});

	test("redacts hidden input value", () => {
		const result = redactSensitiveAttributes(
			{ type: "hidden", value: "csrf_token_abc" },
			"INPUT",
			"hidden",
		);
		expect(result.value).toBe("[REDACTED]");
	});

	test("redacts placeholder on any element", () => {
		const result = redactSensitiveAttributes(
			{ placeholder: "Enter SSN" },
			"INPUT",
			"text",
		);
		expect(result.placeholder).toBe("[REDACTED]");
	});

	test("redacts cc-* autocomplete values", () => {
		const result = redactSensitiveAttributes(
			{ autocomplete: "cc-number" },
			"INPUT",
			"text",
		);
		expect(result.autocomplete).toBe("[REDACTED]");
	});

	test("preserves non-cc autocomplete values", () => {
		const result = redactSensitiveAttributes(
			{ autocomplete: "name" },
			"INPUT",
			"text",
		);
		expect(result.autocomplete).toBe("name");
	});

	test("redacts secret-like hex values", () => {
		const result = redactSensitiveAttributes(
			{ "data-token": "abcdef0123456789abcdef0123456789" },
			"DIV",
		);
		expect(result["data-token"]).toBe("[REDACTED]");
	});

	test("preserves normal attribute values", () => {
		const result = redactSensitiveAttributes(
			{ class: "btn", id: "submit" },
			"BUTTON",
		);
		expect(result.class).toBe("btn");
		expect(result.id).toBe("submit");
	});
});

describe("redactOuterHtml", () => {
	test("redacts password input values in outer HTML", () => {
		const html = '<input type="password" value="mysecret">';
		expect(redactOuterHtml(html)).toContain('value="[REDACTED]"');
		expect(redactOuterHtml(html)).not.toContain("mysecret");
	});

	test("redacts hidden input values in outer HTML", () => {
		const html = '<input type="hidden" value="csrf_token">';
		expect(redactOuterHtml(html)).toContain('value="[REDACTED]"');
	});

	test("redacts cc-* autocomplete in outer HTML", () => {
		const html = '<input autocomplete="cc-number">';
		expect(redactOuterHtml(html)).toContain("[REDACTED]");
	});

	test("preserves non-sensitive outer HTML", () => {
		const html = '<button class="btn">Click</button>';
		expect(redactOuterHtml(html)).toBe(html);
	});
});

describe("captureElementContext redaction", () => {
	test("redacts password input value and outerHtml", () => {
		const { document, window } = parseHTML(
			'<!doctype html><input type="password" value="hunter2">',
		);
		Object.defineProperty(window, "location", {
			value: { href: "https://example.com/login" },
		});
		Object.defineProperty(window, "innerWidth", { value: 1280 });
		Object.defineProperty(window, "innerHeight", { value: 720 });
		Object.defineProperty(window, "devicePixelRatio", { value: 1 });
		window.getComputedStyle = () =>
			({ getPropertyValue: () => "" }) as unknown as CSSStyleDeclaration;
		const input = document.querySelector("input");
		if (!input) throw new Error("Missing input");
		input.getBoundingClientRect = () =>
			({ x: 0, y: 0, width: 100, height: 30 }) as DOMRect;

		const ctx = captureElementContext(input, { window });
		expect(ctx.attributes.value).toBe("[REDACTED]");
		expect(ctx.outerHtml).not.toContain("hunter2");
		expect(ctx.outerHtml).toContain("[REDACTED]");
	});
});
