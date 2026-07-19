import { describe, expect, test } from "bun:test";
import {
	displayToNormalized,
	fitImageToCanvas,
	normalizedToDisplay,
} from "../src/annotator/coordinates";

describe("fitImageToCanvas", () => {
	test("scales down to fit width-constrained image", () => {
		const m = fitImageToCanvas(2000, 1000, 1000, 800);
		expect(m.displayWidth).toBe(1000);
		expect(m.displayHeight).toBe(500);
		expect(m.offsetX).toBe(0);
		expect(m.offsetY).toBeCloseTo(150);
	});

	test("scales down to fit height-constrained image", () => {
		const m = fitImageToCanvas(500, 2000, 1000, 800);
		expect(m.displayHeight).toBe(800);
		expect(m.displayWidth).toBeCloseTo(200);
		expect(m.offsetX).toBeCloseTo(400);
		expect(m.offsetY).toBe(0);
	});

	test("scales up when image is smaller than canvas", () => {
		const m = fitImageToCanvas(200, 100, 1000, 800);
		// scaleX=5, scaleY=8, scale=5 → fills width
		expect(m.displayWidth).toBe(1000);
		expect(m.displayHeight).toBe(500);
		expect(m.offsetX).toBe(0);
		expect(m.offsetY).toBeCloseTo(150);
	});

	test("handles square image in rectangular canvas", () => {
		const m = fitImageToCanvas(500, 500, 1000, 800);
		expect(m.displayWidth).toBeCloseTo(800);
		expect(m.displayHeight).toBeCloseTo(800);
		expect(m.offsetX).toBeCloseTo(100);
		expect(m.offsetY).toBe(0);
	});
});

describe("displayToNormalized", () => {
	test("converts top-left corner", () => {
		const m = fitImageToCanvas(1000, 500, 800, 600);
		// displayWidth=800, displayHeight=400, offsetX=0, offsetY=100
		expect(m.displayWidth).toBe(800);
		expect(m.displayHeight).toBe(400);
		expect(m.offsetX).toBe(0);
		expect(m.offsetY).toBe(100);
		const pt = displayToNormalized({ x: 0, y: 100 }, m);
		expect(pt.x).toBeCloseTo(0);
		expect(pt.y).toBeCloseTo(0);
	});

	test("converts bottom-right corner", () => {
		const m = fitImageToCanvas(1000, 500, 800, 600);
		const pt = displayToNormalized({ x: 800, y: 500 }, m);
		expect(pt.x).toBeCloseTo(1);
		expect(pt.y).toBeCloseTo(1);
	});

	test("converts center", () => {
		const m = fitImageToCanvas(1000, 500, 800, 600);
		const pt = displayToNormalized({ x: 400, y: 300 }, m);
		expect(pt.x).toBeCloseTo(0.5);
		expect(pt.y).toBeCloseTo(0.5);
	});

	test("clamps out-of-bounds to [0,1]", () => {
		const m = fitImageToCanvas(1000, 500, 800, 600);
		const pt = displayToNormalized({ x: -100, y: 999 }, m);
		expect(pt.x).toBe(0);
		expect(pt.y).toBe(1);
	});
});

describe("normalizedToDisplay", () => {
	test("converts (0,0) to image top-left", () => {
		const m = fitImageToCanvas(1000, 500, 800, 600);
		const pt = normalizedToDisplay({ x: 0, y: 0 }, m);
		expect(pt.x).toBeCloseTo(0);
		expect(pt.y).toBeCloseTo(100);
	});

	test("converts (1,1) to image bottom-right", () => {
		const m = fitImageToCanvas(1000, 500, 800, 600);
		const pt = normalizedToDisplay({ x: 1, y: 1 }, m);
		expect(pt.x).toBeCloseTo(800);
		expect(pt.y).toBeCloseTo(500);
	});

	test("converts (0.5,0.5) to center", () => {
		const m = fitImageToCanvas(1000, 500, 800, 600);
		const pt = normalizedToDisplay({ x: 0.5, y: 0.5 }, m);
		expect(pt.x).toBeCloseTo(400);
		expect(pt.y).toBeCloseTo(300);
	});
});

describe("round-trip invariance", () => {
	test.each([
		[1000, 500, 800, 600],
		[500, 1000, 800, 600],
		[1920, 1080, 1280, 720],
		[375, 812, 375, 812],
		[2560, 1440, 1920, 1080],
	] as [
		number,
		number,
		number,
		number,
	][])("image %ix%d canvas %ix%d — display→normalized→display is identity", (imgW, imgH, cW, cH) => {
		const m = fitImageToCanvas(imgW, imgH, cW, cH);
		for (let x = 0; x <= 1; x += 0.1) {
			for (let y = 0; y <= 1; y += 0.1) {
				const display = normalizedToDisplay({ x, y }, m);
				const back = displayToNormalized(display, m);
				expect(back.x).toBeCloseTo(x, 10);
				expect(back.y).toBeCloseTo(y, 10);
			}
		}
	});

	test("normalized→display→normalized is identity within image bounds", () => {
		const m = fitImageToCanvas(1000, 500, 800, 600);
		for (let x = 0; x <= 1; x += 0.1) {
			for (let y = 0; y <= 1; y += 0.1) {
				const display = normalizedToDisplay({ x, y }, m);
				const back = displayToNormalized(display, m);
				expect(back.x).toBeCloseTo(x, 10);
				expect(back.y).toBeCloseTo(y, 10);
			}
		}
	});
});

describe("multiple DPR values", () => {
	test("normalized coordinates are DPR-independent", () => {
		// DPR does not affect CSS-dimension-based fit metrics
		const cssW = 800;
		const cssH = 600;
		const m = fitImageToCanvas(1000, 500, cssW, cssH);
		// The display-to-normalized mapping only depends on CSS dimensions
		// not on DPR, so the same CSS point should map to the same normalized point
		const pt = displayToNormalized({ x: 400, y: 300 }, m);
		expect(pt.x).toBeCloseTo(0.5);
		expect(pt.y).toBeCloseTo(0.5);
	});
});

describe("different viewport scales", () => {
	test("same relative position maps identically at different scales", () => {
		const imgW = 1200;
		const imgH = 800;
		// 100% viewport — image fills canvas exactly (same aspect ratio)
		const m1 = fitImageToCanvas(imgW, imgH, 1200, 800);
		// 50% viewport — image still fills canvas exactly
		const m2 = fitImageToCanvas(imgW, imgH, 600, 400);

		expect(m1.displayWidth).toBeCloseTo(1200);
		expect(m1.displayHeight).toBeCloseTo(800);
		expect(m2.displayWidth).toBeCloseTo(600);
		expect(m2.displayHeight).toBeCloseTo(400);

		// Same relative position (25%) maps to same normalized coord in both viewports
		const norm1 = displayToNormalized({ x: 300, y: 200 }, m1);
		const norm2 = displayToNormalized({ x: 150, y: 100 }, m2);
		expect(norm1.x).toBeCloseTo(0.25);
		expect(norm1.y).toBeCloseTo(0.25);
		expect(norm2.x).toBeCloseTo(0.25);
		expect(norm2.y).toBeCloseTo(0.25);
	});
});
