import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	computeTooltipPosition,
	extractTooltipState,
	renderTooltipLines,
} from "../src/picker/tooltip";

function fakeDOMRect(
	x: number,
	y: number,
	width: number,
	height: number,
): DOMRect {
	return {
		x,
		y,
		width,
		height,
		top: y,
		left: x,
		bottom: y + height,
		right: x + width,
		toJSON: () => {},
	} as DOMRect;
}

describe("computeTooltipPosition", () => {
	test("positions below target when space is available", () => {
		const { document } = parseHTML("<html><body></body></html>");
		const tooltip = document.createElement("div");
		Object.defineProperty(tooltip, "offsetWidth", { value: 100 });
		Object.defineProperty(tooltip, "offsetHeight", { value: 30 });

		const targetRect = fakeDOMRect(100, 300, 200, 40);
		const pos = computeTooltipPosition(tooltip, targetRect, {
			width: 1280,
			height: 720,
		});

		// Should be below target (y > 300 + 40 = 340)
		expect(pos.top).toBeGreaterThan(340);
		expect(pos.left).toBe(100);
	});

	test("flips above target when below overflows viewport", () => {
		const { document } = parseHTML("<html><body></body></html>");
		const tooltip = document.createElement("div");
		Object.defineProperty(tooltip, "offsetWidth", { value: 100 });
		Object.defineProperty(tooltip, "offsetHeight", { value: 30 });

		// Target near bottom of viewport
		const targetRect = fakeDOMRect(100, 360, 200, 30);
		const pos = computeTooltipPosition(tooltip, targetRect, {
			width: 1280,
			height: 400,
		});

		// Should be above target (y < 360)
		expect(pos.top).toBeLessThan(360);
	});

	test("clamps horizontally to viewport edges", () => {
		const { document } = parseHTML("<html><body></body></html>");
		const tooltip = document.createElement("div");
		Object.defineProperty(tooltip, "offsetWidth", { value: 200 });
		Object.defineProperty(tooltip, "offsetHeight", { value: 30 });

		// Target near right edge
		const targetRect = fakeDOMRect(400, 100, 80, 30);
		const pos = computeTooltipPosition(tooltip, targetRect, {
			width: 500,
			height: 720,
		});

		// Tooltip should not overflow right edge (400 + 200 = 600 > 500)
		expect(pos.left + 200).toBeLessThanOrEqual(500);
	});

	test("clamps to left edge when tooltip would be negative", () => {
		const { document } = parseHTML("<html><body></body></html>");
		const tooltip = document.createElement("div");
		Object.defineProperty(tooltip, "offsetWidth", { value: 200 });
		Object.defineProperty(tooltip, "offsetHeight", { value: 30 });

		// Target at left edge
		const targetRect = fakeDOMRect(0, 100, 80, 30);
		const pos = computeTooltipPosition(tooltip, targetRect, {
			width: 1280,
			height: 720,
		});

		expect(pos.left).toBeGreaterThanOrEqual(0);
	});
});

describe("renderTooltipLines", () => {
	test("renders tag, dimensions, and selector", () => {
		const lines = renderTooltipLines({
			tag: "div",
			id: "main",
			classes: ["container", "active"],
			width: 200,
			height: 100,
			selectorPreview: "#main",
		});
		expect(lines[0]).toContain("div");
		expect(lines[0]).toContain("#main");
		expect(lines[0]).toContain("200×100");
		expect(lines[1]).toBe("#main");
	});

	test("shows shadow context indicator", () => {
		const lines = renderTooltipLines({
			tag: "span",
			id: null,
			classes: [],
			width: 50,
			height: 20,
			selectorPreview: "span",
			shadowContext: true,
		});
		expect(lines[0]).toContain("(shadow)");
	});

	test("shows unsupported message", () => {
		const lines = renderTooltipLines({
			tag: "div",
			id: null,
			classes: [],
			width: 100,
			height: 50,
			selectorPreview: "div",
			unsupported: "closed shadow root — not accessible",
		});
		expect(lines[0]).toContain("⚠");
		expect(lines[0]).toContain("closed shadow root");
	});
});

describe("extractTooltipState", () => {
	test("extracts tag, id, classes, and dimensions from element", () => {
		const { document } = parseHTML(
			"<html><body><div id='test' class='foo bar' style='width:100px;height:50px'></div></body></html>",
		);
		const el = document.querySelector("#test") as Element;
		el.getBoundingClientRect = () =>
			({
				x: 10,
				y: 20,
				width: 100,
				height: 50,
			}) as DOMRect;

		const state = extractTooltipState(el, "#test");
		expect(state.tag).toBe("div");
		expect(state.id).toBe("test");
		expect(state.classes).toEqual(["foo", "bar"]);
		expect(state.width).toBe(100);
		expect(state.height).toBe(50);
		expect(state.selectorPreview).toBe("#test");
	});
});
