import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { generateSelector, generateSelectorSegments } from "../src/picker/selectors";

describe("generateSelectorSegments", () => {
	test("returns a single segment for a plain light-DOM element", () => {
		const { document } = parseHTML(
			"<html><body><div id='root'><span class='label'>Hello</span></div></body></html>",
		);
		const span = document.querySelector("span.label");
		expect(span).toBeTruthy();
		const segments = generateSelectorSegments(span as Element);
		expect(segments.length).toBe(1);
		expect(segments[0].shadowRoot).toBe(false);
		expect(segments[0].selector).toBeTruthy();
	});

	test("generates a valid selector for each segment", () => {
		const { document } = parseHTML(
			"<html><body><div id='host'><div id='host2'></div></div></body></html>",
		);
		const host = document.querySelector("#host") as Element;
		const shadowRoot = host.attachShadow({ mode: "open" });
		const inner = document.createElement("p");
		inner.id = "deep";
		shadowRoot.appendChild(inner);

		const segments = generateSelectorSegments(inner);
		for (const segment of segments) {
			expect(segment.selector).toBeTruthy();
			expect(typeof segment.selector).toBe("string");
		}
	});
});

describe("generateSelector (existing behavior)", () => {
	test("prefers a unique data-testid", () => {
		const { document } = parseHTML(
			'<button data-testid="save">Save</button><button>Cancel</button>',
		);
		const element = document.querySelector("button[data-testid='save']");
		expect(element).toBeTruthy();
		expect(generateSelector(element as Element)).toBe(
			'[data-testid="save"]',
		);
	});

	test("falls back to nth-of-type path when stable attributes are unavailable", () => {
		const { document } = parseHTML(
			"<main><section><button>Save</button><button>Cancel</button></section><section><button>Save</button><button>Cancel</button></section></main>",
		);
		const element = document.querySelector(
			"section:nth-of-type(2) > button:nth-of-type(2)",
		);
		expect(element).toBeTruthy();
		expect(generateSelector(element as Element)).toBe(
			"section:nth-of-type(2) > button:nth-of-type(2)",
		);
	});
});
