// Annotation canvas — Shadow-DOM-isolated, fit-to-viewport annotation surface.
// Handles pointer input, tool switching, undo/redo, and image flattening.

import {
	displayToNormalized,
	type FitMetrics,
	fitImageToCanvas,
	normalizedToDisplay,
} from "./coordinates";
import type { Annotation, AnnotationTool, Point } from "./model";
import {
	addAnnotation,
	clearAnnotations,
	createAnnotatorState,
	generateId,
	redo,
	setColor,
	setTool,
	undo,
} from "./model";

export interface AnnotatorResult {
	annotatedBlob: Blob;
	annotations: Annotation[];
}

export interface AnnotatorOptions {
	imageDataUrl: string;
	imageWidth: number;
	imageHeight: number;
}

const ACCENT = "#ff3b30";
const STROKE_WIDTH = 3;
const HANDLE_RADIUS = 5;
const TEXT_FONT_RATIO = 0.035;

const CSS = `
.omp-ann-root{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;background:#1a1a1e;font-family:system-ui,-apple-system,sans-serif;color:#fff;user-select:none}
.omp-ann-canvas-wrap{flex:1;position:relative;overflow:hidden;background:#000}
.omp-ann-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.omp-ann-tb{display:flex;align-items:center;gap:6px;padding:8px 12px;background:#2a2a2e;border-top:1px solid #444;flex-wrap:wrap}
.omp-ann-btn{padding:6px 14px;border:1px solid #555;border-radius:6px;background:#3a3a3e;color:#eee;cursor:pointer;font-size:13px;line-height:1;white-space:nowrap}
.omp-ann-btn:hover{background:#4a4a4e}
.omp-ann-btn[aria-pressed="true"]{background:#505054;border-color:#888}
.omp-ann-sep{width:1px;height:20px;background:#555;flex-shrink:0}
.omp-ann-clr{width:24px;height:24px;border-radius:50%;border:2px solid #666;cursor:pointer;flex-shrink:0;padding:0}
.omp-ann-clr[aria-pressed="true"]{border-color:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.4)}
.omp-ann-send{background:#0a84ff;border-color:#0a84ff;color:#fff;font-weight:600}
.omp-ann-send:hover{background:#0070e0}
.omp-ann-cancel{background:transparent;color:#ff453a}
.omp-ann-cancel:hover{background:rgba(255,69,58,.15)}
`;

const COLORS = [
	"#ff3b30",
	"#ff9500",
	"#ffcc00",
	"#34c759",
	"#007aff",
	"#af52de",
];

function contrastOutline(fill: string): string {
	const hex = fill.replace("#", "");
	const r = Number.parseInt(hex.slice(0, 2), 16);
	const g = Number.parseInt(hex.slice(2, 4), 16);
	const b = Number.parseInt(hex.slice(4, 6), 16);
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#000" : "#fff";
}

// ── Rendering ──────────────────────────────────────────────────────────

function drawAnnotations(
	ctx: CanvasRenderingContext2D,
	annotations: Annotation[],
	metrics: FitMetrics,
	fontPx: number,
) {
	for (const a of annotations) {
		const outline = contrastOutline(a.color);
		ctx.save();
		switch (a.type) {
			case "arrow": {
				const f = normalizedToDisplay(a.from, metrics);
				const t = normalizedToDisplay(a.to, metrics);
				drawArrow(ctx, f, t, a.color, outline, fontPx);
				break;
			}
			case "rectangle": {
				const f = normalizedToDisplay(a.from, metrics);
				const t = normalizedToDisplay(a.to, metrics);
				drawRect(ctx, f, t, a.color, outline);
				break;
			}
			case "freehand": {
				drawFreehand(ctx, a.points, metrics, a.color, outline);
				break;
			}
			case "text": {
				drawText(ctx, a.anchor, a.text, a.color, outline, metrics, fontPx);
				break;
			}
		}
		ctx.restore();
	}
}

function drawArrow(
	ctx: CanvasRenderingContext2D,
	from: Point,
	to: Point,
	color: string,
	outline: string,
	fontPx: number,
) {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const len = Math.hypot(dx, dy);
	if (len < 1) return;

	const headLen = Math.min(fontPx * 1.2, len * 0.4);
	const angle = Math.atan2(dy, dx);

	// outline
	ctx.strokeStyle = outline;
	ctx.lineWidth = STROKE_WIDTH + 2;
	ctx.lineCap = "round";
	ctx.beginPath();
	ctx.moveTo(from.x, from.y);
	ctx.lineTo(to.x, to.y);
	ctx.stroke();

	// fill
	ctx.strokeStyle = color;
	ctx.lineWidth = STROKE_WIDTH;
	ctx.beginPath();
	ctx.moveTo(from.x, from.y);
	ctx.lineTo(to.x, to.y);
	ctx.stroke();

	// arrowhead outline
	ctx.fillStyle = outline;
	ctx.beginPath();
	ctx.moveTo(to.x, to.y);
	ctx.lineTo(
		to.x - headLen * Math.cos(angle - Math.PI / 6),
		to.y - headLen * Math.sin(angle - Math.PI / 6),
	);
	ctx.lineTo(
		to.x - headLen * Math.cos(angle + Math.PI / 6),
		to.y - headLen * Math.sin(angle + Math.PI / 6),
	);
	ctx.closePath();
	ctx.fill();

	// arrowhead fill
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.moveTo(to.x, to.y);
	ctx.lineTo(
		to.x - (headLen - 1.5) * Math.cos(angle - Math.PI / 6),
		to.y - (headLen - 1.5) * Math.sin(angle - Math.PI / 6),
	);
	ctx.lineTo(
		to.x - (headLen - 1.5) * Math.cos(angle + Math.PI / 6),
		to.y - (headLen - 1.5) * Math.sin(angle + Math.PI / 6),
	);
	ctx.closePath();
	ctx.fill();

	// endpoint handle
	drawHandle(ctx, to, color);
}

function drawRect(
	ctx: CanvasRenderingContext2D,
	from: Point,
	to: Point,
	color: string,
	outline: string,
) {
	const x = Math.min(from.x, to.x);
	const y = Math.min(from.y, to.y);
	const w = Math.abs(to.x - from.x);
	const h = Math.abs(to.y - from.y);
	if (w < 1 && h < 1) return;

	ctx.strokeStyle = outline;
	ctx.lineWidth = STROKE_WIDTH + 2;
	ctx.strokeRect(x, y, w, h);
	ctx.strokeStyle = color;
	ctx.lineWidth = STROKE_WIDTH;
	ctx.strokeRect(x, y, w, h);

	drawHandle(ctx, from, color);
	drawHandle(ctx, to, color);
}

function drawFreehand(
	ctx: CanvasRenderingContext2D,
	points: Point[],
	metrics: FitMetrics,
	color: string,
	outline: string,
) {
	if (points.length < 2) return;
	const dp = points.map((p) => normalizedToDisplay(p, metrics));

	ctx.strokeStyle = outline;
	ctx.lineWidth = STROKE_WIDTH + 2;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.beginPath();
	ctx.moveTo(dp[0].x, dp[0].y);
	for (let i = 1; i < dp.length; i++) ctx.lineTo(dp[i].x, dp[i].y);
	ctx.stroke();

	ctx.strokeStyle = color;
	ctx.lineWidth = STROKE_WIDTH;
	ctx.beginPath();
	ctx.moveTo(dp[0].x, dp[0].y);
	for (let i = 1; i < dp.length; i++) ctx.lineTo(dp[i].x, dp[i].y);
	ctx.stroke();
}

function drawText(
	ctx: CanvasRenderingContext2D,
	anchor: Point,
	text: string,
	color: string,
	outline: string,
	metrics: FitMetrics,
	fontPx: number,
) {
	if (!text) return;
	const d = normalizedToDisplay(anchor, metrics);
	const fs = Math.round(fontPx);

	ctx.font = `bold ${fs}px system-ui,-apple-system,sans-serif`;
	ctx.textAlign = "left";
	ctx.textBaseline = "top";

	// outline
	ctx.strokeStyle = outline;
	ctx.lineWidth = fs / 5;
	ctx.lineJoin = "round";
	ctx.strokeText(text, d.x, d.y);

	// fill
	ctx.fillStyle = color;
	ctx.fillText(text, d.x, d.y);
}

function drawHandle(ctx: CanvasRenderingContext2D, p: Point, color: string) {
	ctx.beginPath();
	ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
	ctx.fillStyle = "#fff";
	ctx.fill();
	ctx.strokeStyle = color;
	ctx.lineWidth = 2;
	ctx.stroke();
}

// ── Flattening ─────────────────────────────────────────────────────────

/** Async version of flattenAnnotations that returns a proper Blob. */
export async function flattenAnnotationsAsync(
	image: HTMLImageElement | CanvasImageSource,
	annotations: Annotation[],
	imageWidth: number,
	imageHeight: number,
): Promise<Blob> {
	const canvas = document.createElement("canvas");
	canvas.width = imageWidth;
	canvas.height = imageHeight;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Cannot get 2D context");

	ctx.drawImage(image, 0, 0, imageWidth, imageHeight);

	const metrics: FitMetrics = {
		offsetX: 0,
		offsetY: 0,
		displayWidth: imageWidth,
		displayHeight: imageHeight,
	};
	const fontPx = imageWidth * TEXT_FONT_RATIO;
	drawAnnotations(ctx, annotations, metrics, fontPx);

	const { promise, resolve, reject } = Promise.withResolvers<Blob>();
	canvas.toBlob((blob) => {
		if (blob) resolve(blob);
		else reject(new Error("toBlob returned null"));
	}, "image/png");
	return promise;
}

// ── Canvas lifecycle ───────────────────────────────────────────────────

export function showAnnotator(
	doc: Document,
	options: AnnotatorOptions,
): Promise<AnnotatorResult | null> {
	const { promise, resolve } = Promise.withResolvers<AnnotatorResult | null>();
	const img = new Image();
	img.crossOrigin = "anonymous";
	img.onload = () => {
		buildOverlay(doc, img, options, resolve);
	};
	img.onerror = () => resolve(null);
	img.src = options.imageDataUrl;
	return promise;
}

function buildOverlay(
	doc: Document,
	img: HTMLImageElement,
	options: AnnotatorOptions,
	resolve: (result: AnnotatorResult | null) => void,
): void {
	const root = doc.createElement("div");
	root.className = "omp-ann-root";
	root.setAttribute("data-omp-annotator", "true");

	const style = doc.createElement("style");
	style.textContent = CSS;
	root.appendChild(style);

	// Canvas wrap
	const wrap = doc.createElement("div");
	wrap.className = "omp-ann-canvas-wrap";
	root.appendChild(wrap);

	// Canvas
	const cvs = doc.createElement("canvas");
	cvs.className = "omp-ann-canvas";
	wrap.appendChild(cvs);

	const dpr = window.devicePixelRatio || 1;

	function resize() {
		const w = wrap.clientWidth;
		const h = wrap.clientHeight;
		cvs.width = Math.round(w * dpr);
		cvs.height = Math.round(h * dpr);
		cvs.style.width = `${w}px`;
		cvs.style.height = `${h}px`;
	}

	resize();

	// Toolbar
	const tb = doc.createElement("div");
	tb.className = "omp-ann-tb";
	root.appendChild(tb);

	let state = createAnnotatorState(ACCENT);
	let pointerStart: Point | null = null;
	let currentPos: Point | null = null;
	let freehandPoints: Point[] = [];
	let textInputActive = false;

	function metrics(): FitMetrics {
		return fitImageToCanvas(
			options.imageWidth,
			options.imageHeight,
			wrap.clientWidth,
			wrap.clientHeight,
		);
	}

	function fontPx(): number {
		return wrap.clientWidth * TEXT_FONT_RATIO;
	}

	function render() {
		const ctx = cvs.getContext("2d");
		if (!ctx) return;
		const m = metrics();

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, cvs.width / dpr, cvs.height / dpr);

		// Draw image
		const imgDx = m.offsetX;
		const imgDy = m.offsetY;
		ctx.drawImage(img, imgDx, imgDy, m.displayWidth, m.displayHeight);

		// Committed annotations
		drawAnnotations(ctx, state.annotations, m, fontPx());

		// In-progress shape
		if (pointerStart && currentPos && state.activeTool !== "text") {
			ctx.globalAlpha = 0.7;
			const preview: Annotation = {
				id: "preview",
				color: state.activeColor,
				...(state.activeTool === "arrow" && {
					type: "arrow",
					from: pointerStart,
					to: currentPos,
				}),
				...(state.activeTool === "rectangle" && {
					type: "rectangle",
					from: pointerStart,
					to: currentPos,
				}),
				...(state.activeTool === "freehand" && {
					type: "freehand",
					points: [...freehandPoints, currentPos],
				}),
			} as Annotation;
			drawAnnotations(ctx, [preview], m, fontPx());
			ctx.globalAlpha = 1;
		}
	}

	// Tool buttons
	const toolDefs: { tool: AnnotationTool; label: string }[] = [
		{ tool: "arrow", label: "Arrow" },
		{ tool: "rectangle", label: "Rect" },
		{ tool: "freehand", label: "Draw" },
		{ tool: "text", label: "Text" },
	];
	const toolButtons: HTMLButtonElement[] = [];

	for (const def of toolDefs) {
		const btn = doc.createElement("button");
		btn.className = "omp-ann-btn";
		btn.textContent = def.label;
		btn.setAttribute("aria-pressed", String(def.tool === state.activeTool));
		btn.addEventListener("click", () => {
			state = setTool(state, def.tool);
			toolButtons.forEach((b) => {
				b.setAttribute("aria-pressed", String(b === btn));
			});
			cvs.style.cursor = def.tool === "text" ? "text" : "crosshair";
		});
		toolButtons.push(btn);
		tb.appendChild(btn);
	}

	// Separator
	const sep1 = doc.createElement("div");
	sep1.className = "omp-ann-sep";
	tb.appendChild(sep1);

	// Color buttons
	const colorButtons: HTMLButtonElement[] = [];
	for (const c of COLORS) {
		const btn = doc.createElement("button");
		btn.className = "omp-ann-clr";
		btn.style.background = c;
		btn.setAttribute("aria-pressed", String(c === state.activeColor));
		btn.setAttribute("aria-label", `Color ${c}`);
		btn.addEventListener("click", () => {
			state = setColor(state, c);
			colorButtons.forEach((b) => {
				b.setAttribute("aria-pressed", String(b === btn));
			});
		});
		colorButtons.push(btn);
		tb.appendChild(btn);
	}

	// Separator
	const sep2 = doc.createElement("div");
	sep2.className = "omp-ann-sep";
	tb.appendChild(sep2);

	// Undo / Clear
	const undoBtn = doc.createElement("button");
	undoBtn.className = "omp-ann-btn";
	undoBtn.textContent = "Undo";
	undoBtn.addEventListener("click", () => {
		state = undo(state);
		render();
	});
	tb.appendChild(undoBtn);

	const clearBtn = doc.createElement("button");
	clearBtn.className = "omp-ann-btn";
	clearBtn.textContent = "Clear";
	clearBtn.addEventListener("click", () => {
		state = clearAnnotations(state);
		render();
	});
	tb.appendChild(clearBtn);

	// Separator
	const sep3 = doc.createElement("div");
	sep3.className = "omp-ann-sep";
	tb.appendChild(sep3);

	// Send (confirm)
	const sendBtn = doc.createElement("button");
	sendBtn.className = "omp-ann-btn omp-ann-send";
	sendBtn.textContent = "Send";
	sendBtn.addEventListener("click", async () => {
		cleanup();
		if (state.annotations.length === 0) {
			resolve(null);
			return;
		}
		const blob = await flattenAnnotationsAsync(
			img,
			state.annotations,
			options.imageWidth,
			options.imageHeight,
		);
		resolve({ annotatedBlob: blob, annotations: state.annotations });
	});
	tb.appendChild(sendBtn);

	// Cancel
	const cancelBtn = doc.createElement("button");
	cancelBtn.className = "omp-ann-btn omp-ann-cancel";
	cancelBtn.textContent = "Cancel";
	cancelBtn.addEventListener("click", () => {
		cleanup();
		resolve(null);
	});
	tb.appendChild(cancelBtn);

	// Pointer events on the wrap (canvas has pointer-events:none)
	wrap.addEventListener("pointerdown", (e) => {
		if (textInputActive) return;
		e.preventDefault();
		const rect = cvs.getBoundingClientRect();
		const displayPt: Point = {
			x: e.clientX - rect.left,
			y: e.clientY - rect.top,
		};
		const normPt = displayToNormalized(displayPt, metrics());

		if (state.activeTool === "text") {
			textInputActive = true;
			const text = window.prompt("Enter annotation text:");
			textInputActive = false;
			if (text) {
				state = addAnnotation(state, {
					id: generateId(),
					type: "text",
					color: state.activeColor,
					anchor: normPt,
					text,
				});
				render();
			}
			return;
		}

		pointerStart = normPt;
		currentPos = normPt;
		if (state.activeTool === "freehand") {
			freehandPoints = [normPt];
		}
		cvs.setPointerCapture(e.pointerId);
	});

	wrap.addEventListener("pointermove", (e) => {
		if (!pointerStart) return;
		const rect = cvs.getBoundingClientRect();
		const displayPt: Point = {
			x: e.clientX - rect.left,
			y: e.clientY - rect.top,
		};
		currentPos = displayToNormalized(displayPt, metrics());
		if (state.activeTool === "freehand") {
			freehandPoints.push(currentPos);
		}
		render();
	});

	wrap.addEventListener("pointerup", () => {
		if (!pointerStart || !currentPos) return;

		if (state.activeTool === "freehand" && freehandPoints.length >= 2) {
			state = addAnnotation(state, {
				id: generateId(),
				type: "freehand",
				color: state.activeColor,
				points: freehandPoints,
			});
		} else if (
			(state.activeTool === "arrow" || state.activeTool === "rectangle") &&
			(Math.abs(currentPos.x - pointerStart.x) > 0.005 ||
				Math.abs(currentPos.y - pointerStart.y) > 0.005)
		) {
			state = addAnnotation(state, {
				id: generateId(),
				type: state.activeTool,
				color: state.activeColor,
				from: pointerStart,
				to: currentPos,
			});
		}

		pointerStart = null;
		currentPos = null;
		freehandPoints = [];
		render();
	});

	// Keyboard shortcuts
	function onKey(e: KeyboardEvent) {
		if (textInputActive) return;
		if (e.key === "Escape") {
			e.preventDefault();
			cleanup();
			resolve(null);
			return;
		}
		if (e.key === "z" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
			e.preventDefault();
			state = undo(state);
			render();
			return;
		}
		if (
			(e.key === "z" && (e.metaKey || e.ctrlKey) && e.shiftKey) ||
			(e.key === "y" && (e.metaKey || e.ctrlKey))
		) {
			e.preventDefault();
			state = redo(state);
			render();
			return;
		}
		const toolMap: Record<string, AnnotationTool> = {
			"1": "arrow",
			"2": "rectangle",
			"3": "freehand",
			"4": "text",
		};
		if (toolMap[e.key]) {
			const tool = toolMap[e.key];
			state = setTool(state, tool);
			toolButtons.forEach((b, i) => {
				b.setAttribute("aria-pressed", String(toolDefs[i].tool === tool));
			});
			cvs.style.cursor = tool === "text" ? "text" : "crosshair";
		}
	}

	doc.addEventListener("keydown", onKey);
	doc.body.appendChild(root);

	// Re-render on resize
	const onResize = () => {
		resize();
		render();
	};
	window.addEventListener("resize", onResize);

	function cleanup() {
		doc.removeEventListener("keydown", onKey);
		window.removeEventListener("resize", onResize);
		root.remove();
	}

	// Initial render
	render();
}
