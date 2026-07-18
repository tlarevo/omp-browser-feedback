// Annotation data model and reducer — normalized [0,1] coordinates, top-left origin.

export type AnnotationTool = "arrow" | "rectangle" | "freehand" | "text";

export interface Point {
	x: number;
	y: number;
}

export interface BaseAnnotation {
	id: string;
	color: string;
}

export interface ArrowAnnotation extends BaseAnnotation {
	type: "arrow";
	from: Point;
	to: Point;
}

export interface RectangleAnnotation extends BaseAnnotation {
	type: "rectangle";
	from: Point;
	to: Point;
}

export interface FreehandAnnotation extends BaseAnnotation {
	type: "freehand";
	points: Point[];
}

export interface TextAnnotation extends BaseAnnotation {
	type: "text";
	anchor: Point;
	text: string;
}

export type Annotation =
	| ArrowAnnotation
	| RectangleAnnotation
	| FreehandAnnotation
	| TextAnnotation;

export interface AnnotatorState {
	annotations: Annotation[];
	undoStack: Annotation[];
	activeTool: AnnotationTool;
	activeColor: string;
}

let idCounter = 0;

export function createAnnotatorState(color = "#ff3b30"): AnnotatorState {
	return {
		annotations: [],
		undoStack: [],
		activeTool: "arrow",
		activeColor: color,
	};
}

export function addAnnotation(
	state: AnnotatorState,
	annotation: Annotation,
): AnnotatorState {
	return {
		...state,
		annotations: [...state.annotations, annotation],
		undoStack: [],
	};
}

export function undo(state: AnnotatorState): AnnotatorState {
	if (state.annotations.length === 0) return state;
	const last = state.annotations[state.annotations.length - 1];
	return {
		...state,
		annotations: state.annotations.slice(0, -1),
		undoStack: [...state.undoStack, last],
	};
}

export function redo(state: AnnotatorState): AnnotatorState {
	if (state.undoStack.length === 0) return state;
	const last = state.undoStack[state.undoStack.length - 1];
	return {
		...state,
		annotations: [...state.annotations, last],
		undoStack: state.undoStack.slice(0, -1),
	};
}

export function clearAnnotations(state: AnnotatorState): AnnotatorState {
	return { ...state, annotations: [], undoStack: [] };
}

export function setTool(
	state: AnnotatorState,
	tool: AnnotationTool,
): AnnotatorState {
	return { ...state, activeTool: tool };
}

export function setColor(state: AnnotatorState, color: string): AnnotatorState {
	return { ...state, activeColor: color };
}

export function generateId(): string {
	return `ann-${Date.now()}-${++idCounter}`;
}
