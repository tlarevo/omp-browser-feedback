import { describe, expect, test } from "bun:test";
import { calculateDownscaleFactor, calculateStitchPlan } from "../src/fullpage";

describe("calculateStitchPlan", () => {
	test("single viewport page yields one step", () => {
		const plan = calculateStitchPlan(800, 900);
		expect(plan.steps).toHaveLength(1);
		expect(plan.steps[0]).toEqual({ y: 0, frameIndex: 0, cropHeight: 800 });
		expect(plan.totalHeight).toBe(800);
	});

	test("exactly 2 viewport pages yields two steps", () => {
		const plan = calculateStitchPlan(1800, 900);
		expect(plan.steps).toHaveLength(2);
		expect(plan.steps[0]).toEqual({ y: 0, frameIndex: 0, cropHeight: 900 });
		expect(plan.steps[1]).toEqual({ y: 900, frameIndex: 1, cropHeight: 900 });
	});

	test("5-viewport-tall page: 5 steps with correct offsets and remainder", () => {
		const plan = calculateStitchPlan(4100, 900);
		expect(plan.steps).toHaveLength(5);
		expect(plan.steps[0]).toEqual({ y: 0, frameIndex: 0, cropHeight: 900 });
		expect(plan.steps[1]).toEqual({ y: 900, frameIndex: 1, cropHeight: 900 });
		expect(plan.steps[2]).toEqual({ y: 1800, frameIndex: 2, cropHeight: 900 });
		expect(plan.steps[3]).toEqual({ y: 2700, frameIndex: 3, cropHeight: 900 });
		expect(plan.steps[4]).toEqual({ y: 3600, frameIndex: 4, cropHeight: 500 });
		expect(plan.totalHeight).toBe(4100);
	});

	test("last step has correct crop height for non-aligned page", () => {
		const plan = calculateStitchPlan(2000, 900);
		expect(plan.steps).toHaveLength(3);
		expect(plan.steps[2].cropHeight).toBe(200); // 2000 - 1800
	});

	test("totalHeight equals scrollHeight", () => {
		const plan = calculateStitchPlan(5000, 900);
		expect(plan.totalHeight).toBe(5000);
	});
});

describe("calculateDownscaleFactor", () => {
	test("returns 1 when within limits", () => {
		expect(calculateDownscaleFactor(4000, 16384)).toBe(1);
	});

	test("returns 1 when exactly at limit", () => {
		expect(calculateDownscaleFactor(16384, 16384)).toBe(1);
	});

	test("returns < 1 when exceeding limits", () => {
		const factor = calculateDownscaleFactor(32768, 16384);
		expect(factor).toBe(0.5);
	});

	test("scales proportionally for large overflows", () => {
		const factor = calculateDownscaleFactor(24576, 16384);
		expect(factor).toBeCloseTo(0.6667, 3);
	});
});
