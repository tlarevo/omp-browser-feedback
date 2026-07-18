import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	hideFixedElements,
	measurePageDimensions,
	showFixedElements,
} from "../src/content-script";

describe("measurePageDimensions", () => {
	test("returns scrollHeight, viewportHeight, dpr, scrollY from window", () => {
		const { window } = parseHTML(
			"<!doctype html><body style='height:5000px'></body>",
		);
		// linkedom windows have readonly props — build a partial mock instead
		const mockWin = {
			document: window.document,
			innerHeight: 900,
			devicePixelRatio: 2,
			scrollY: 450,
		} as unknown as Window;
		Object.defineProperty(mockWin.document.documentElement, "scrollHeight", {
			value: 5000,
			configurable: true,
		});

		const dims = measurePageDimensions(mockWin);
		expect(dims).toEqual({
			scrollHeight: 5000,
			viewportHeight: 900,
			devicePixelRatio: 2,
			scrollY: 450,
		});
	});
});

describe("hideFixedElements", () => {
	test("hides elements with computed position:fixed", () => {
		const { document, window } = parseHTML(
			`<!doctype html><body>
				<header id="nav" style="position:fixed;top:0">Nav</header>
				<main>Content</main>
			</body>`,
		);

		const nav = document.getElementById("nav")!;
		window.getComputedStyle = (el: Element) =>
			({
				position: el.id === "nav" ? "fixed" : "static",
			}) as CSSStyleDeclaration;

		const saved = hideFixedElements(document);
		expect(saved).toHaveLength(1);
		expect(saved[0].element).toBe(nav);
		expect(nav.style.visibility).toBe("hidden");
	});

	test("returns empty array when no fixed elements exist", () => {
		const { document, window } = parseHTML(
			"<!doctype html><body><main>Content</main></body>",
		);
		window.getComputedStyle = () =>
			({ position: "static" }) as CSSStyleDeclaration;

		const saved = hideFixedElements(document);
		expect(saved).toHaveLength(0);
	});
});

describe("showFixedElements", () => {
	test("restores original visibility", () => {
		const { document, window } = parseHTML(
			`<!doctype html><body>
				<header id="nav" style="position:fixed;visibility:hidden">Nav</header>
			</body>`,
		);

		const nav = document.getElementById("nav")!;
		window.getComputedStyle = () =>
			({ position: "fixed" }) as CSSStyleDeclaration;

		const saved = hideFixedElements(document);
		expect(nav.style.visibility).toBe("hidden");

		saved[0].original = "visible";
		showFixedElements(saved);
		expect(nav.style.visibility).toBe("visible");
	});
});
