import { describe, expect, test } from "bun:test";
import { negotiateProtocolVersion, versionsOverlap } from "../src/negotiation";

describe("negotiateProtocolVersion", () => {
	test("picks the highest shared version", () => {
		expect(
			negotiateProtocolVersion({ min: 1, max: 2 }, { min: 1, max: 2 }),
		).toBe(2);
	});

	test("picks v1 when only v1 overlaps", () => {
		expect(
			negotiateProtocolVersion({ min: 1, max: 1 }, { min: 1, max: 2 }),
		).toBe(1);
	});

	test("returns undefined when no version overlaps", () => {
		expect(
			negotiateProtocolVersion({ min: 2, max: 2 }, { min: 1, max: 1 }),
		).toBeUndefined();
	});

	test("returns undefined when ranges are disjoint", () => {
		expect(
			negotiateProtocolVersion({ min: 3, max: 5 }, { min: 1, max: 2 }),
		).toBeUndefined();
	});

	test("picks the floor when ranges partially overlap", () => {
		expect(
			negotiateProtocolVersion({ min: 2, max: 4 }, { min: 1, max: 3 }),
		).toBe(3);
	});
});

describe("versionsOverlap", () => {
	test("overlapping ranges return true", () => {
		expect(versionsOverlap({ min: 1, max: 2 }, { min: 1, max: 2 })).toBe(true);
		expect(versionsOverlap({ min: 1, max: 1 }, { min: 1, max: 3 })).toBe(true);
	});

	test("disjoint ranges return false", () => {
		expect(versionsOverlap({ min: 2, max: 2 }, { min: 1, max: 1 })).toBe(false);
		expect(versionsOverlap({ min: 3, max: 5 }, { min: 1, max: 2 })).toBe(false);
	});
});
