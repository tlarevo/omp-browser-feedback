import { describe, expect, test } from "bun:test";
import {
	type ArrowAnnotation,
	addAnnotation,
	clearAnnotations,
	createAnnotatorState,
	type FreehandAnnotation,
	generateId,
	type RectangleAnnotation,
	redo,
	setColor,
	setTool,
	type TextAnnotation,
	undo,
} from "../src/annotator/model";

describe("createAnnotatorState", () => {
	test("initializes with empty annotations and default tool", () => {
		const s = createAnnotatorState();
		expect(s.annotations).toEqual([]);
		expect(s.undoStack).toEqual([]);
		expect(s.activeTool).toBe("arrow");
		expect(s.activeColor).toBe("#ff3b30");
	});

	test("accepts custom color", () => {
		const s = createAnnotatorState("#007aff");
		expect(s.activeColor).toBe("#007aff");
	});
});

describe("addAnnotation", () => {
	test("appends annotation and clears undo stack", () => {
		let s = createAnnotatorState();
		const arrow: ArrowAnnotation = {
			id: "a1",
			type: "arrow",
			color: "#ff3b30",
			from: { x: 0, y: 0 },
			to: { x: 1, y: 1 },
		};
		s = addAnnotation(s, arrow);
		expect(s.annotations).toHaveLength(1);
		expect(s.annotations[0]).toBe(arrow);
		expect(s.undoStack).toEqual([]);
	});

	test("multiple annotations accumulate", () => {
		let s = createAnnotatorState();
		for (let i = 0; i < 3; i++) {
			s = addAnnotation(s, {
				id: `a${i}`,
				type: "rectangle",
				color: "#ff3b30",
				from: { x: 0, y: 0 },
				to: { x: 0.5, y: 0.5 },
			});
		}
		expect(s.annotations).toHaveLength(3);
	});
});

describe("undo", () => {
	test("moves last annotation to undo stack", () => {
		let s = createAnnotatorState();
		const a: ArrowAnnotation = {
			id: "a1",
			type: "arrow",
			color: "#ff3b30",
			from: { x: 0, y: 0 },
			to: { x: 1, y: 1 },
		};
		s = addAnnotation(s, a);
		s = undo(s);
		expect(s.annotations).toHaveLength(0);
		expect(s.undoStack).toHaveLength(1);
		expect(s.undoStack[0]).toBe(a);
	});

	test("no-op on empty state", () => {
		const s = createAnnotatorState();
		const result = undo(s);
		expect(result).toBe(s);
	});
});

describe("redo", () => {
	test("restores annotation from undo stack", () => {
		let s = createAnnotatorState();
		const a: ArrowAnnotation = {
			id: "a1",
			type: "arrow",
			color: "#ff3b30",
			from: { x: 0, y: 0 },
			to: { x: 1, y: 1 },
		};
		s = addAnnotation(s, a);
		s = undo(s);
		s = redo(s);
		expect(s.annotations).toHaveLength(1);
		expect(s.annotations[0]).toBe(a);
		expect(s.undoStack).toHaveLength(0);
	});

	test("no-op on empty undo stack", () => {
		const s = createAnnotatorState();
		const result = redo(s);
		expect(result).toBe(s);
	});

	test("addAnnotation clears undo stack so redo is lost", () => {
		let s = createAnnotatorState();
		const a1: ArrowAnnotation = {
			id: "a1",
			type: "arrow",
			color: "#ff3b30",
			from: { x: 0, y: 0 },
			to: { x: 1, y: 1 },
		};
		const a2: RectangleAnnotation = {
			id: "a2",
			type: "rectangle",
			color: "#007aff",
			from: { x: 0.1, y: 0.1 },
			to: { x: 0.9, y: 0.9 },
		};
		s = addAnnotation(s, a1);
		s = undo(s);
		s = addAnnotation(s, a2);
		expect(s.undoStack).toHaveLength(0);
		s = undo(s);
		expect(s.annotations).toHaveLength(0);
		expect(s.undoStack).toHaveLength(1);
		expect(s.undoStack[0]).toBe(a2);
	});
});

describe("clearAnnotations", () => {
	test("empties both annotations and undo stack", () => {
		let s = createAnnotatorState();
		s = addAnnotation(s, {
			id: "a1",
			type: "freehand",
			color: "#ff3b30",
			points: [
				{ x: 0, y: 0 },
				{ x: 0.5, y: 0.5 },
			],
		});
		s = undo(s);
		s = clearAnnotations(s);
		expect(s.annotations).toEqual([]);
		expect(s.undoStack).toEqual([]);
	});
});

describe("setTool", () => {
	test("switches active tool", () => {
		let s = createAnnotatorState();
		s = setTool(s, "text");
		expect(s.activeTool).toBe("text");
		s = setTool(s, "freehand");
		expect(s.activeTool).toBe("freehand");
	});
});

describe("setColor", () => {
	test("switches active color", () => {
		let s = createAnnotatorState();
		s = setColor(s, "#34c759");
		expect(s.activeColor).toBe("#34c759");
	});
});

describe("generateId", () => {
	test("returns unique string ids", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateId()));
		expect(ids.size).toBe(100);
		for (const id of ids) {
			expect(id).toMatch(/^ann-\d+-\d+$/);
		}
	});
});

describe("serialize round-trip", () => {
	test("annotations survive JSON serialization", () => {
		const annotations: (
			| ArrowAnnotation
			| RectangleAnnotation
			| FreehandAnnotation
			| TextAnnotation
		)[] = [
			{
				id: "a1",
				type: "arrow",
				color: "#ff3b30",
				from: { x: 0.1, y: 0.2 },
				to: { x: 0.8, y: 0.9 },
			},
			{
				id: "a2",
				type: "rectangle",
				color: "#007aff",
				from: { x: 0.05, y: 0.05 },
				to: { x: 0.95, y: 0.95 },
			},
			{
				id: "a3",
				type: "freehand",
				color: "#34c759",
				points: [
					{ x: 0, y: 0 },
					{ x: 0.3, y: 0.4 },
					{ x: 0.6, y: 0.7 },
				],
			},
			{
				id: "a4",
				type: "text",
				color: "#ff9500",
				anchor: { x: 0.5, y: 0.5 },
				text: "Bug here",
			},
		];
		const serialized = JSON.stringify(annotations);
		const parsed = JSON.parse(serialized) as typeof annotations;

		expect(parsed).toHaveLength(4);
		const [a, b, c, d] = parsed;
		expect(a.type).toBe("arrow");
		if (a.type === "arrow") expect(a.from).toEqual({ x: 0.1, y: 0.2 });
		expect(b.type).toBe("rectangle");
		expect(c.type).toBe("freehand");
		if (c.type === "freehand") expect(c.points).toHaveLength(3);
		expect(d.type).toBe("text");
		if (d.type === "text") expect(d.text).toBe("Bug here");
	});
});
