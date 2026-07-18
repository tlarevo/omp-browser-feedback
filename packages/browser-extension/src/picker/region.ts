const MIN_DRAG_PX = 8;

export interface RegionRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface RegionCallbacks {
	onRegion: (rect: RegionRect) => void;
	onCancel: () => void;
}

export interface RegionHandle {
	deactivate(): void;
}

/**
 * Normalise a drag from any corner to a positive-width/height rect.
 * `normalizeRegionRect({x:300,y:200},{x:100,y:50})` → `{x:100,y:50,width:200,height:150}`
 */
export function normalizeRegionRect(
	a: { x: number; y: number },
	b: { x: number; y: number },
): RegionRect {
	return {
		x: Math.min(a.x, b.x),
		y: Math.min(a.y, b.y),
		width: Math.abs(b.x - a.x),
		height: Math.abs(b.y - a.y),
	};
}

function createMarqueeElement(document: Document): HTMLElement {
	const marquee = document.createElement("div");
	marquee.setAttribute("data-omp-region-marquee", "true");
	Object.assign(marquee.style, {
		position: "fixed",
		pointerEvents: "none",
		boxSizing: "border-box",
		border: "2px dashed #ff6600",
		background: "rgba(255,102,0,0.08)",
		zIndex: "2147483647",
		display: "none",
	});
	return marquee;
}

function createDimensionsLabel(document: Document): HTMLElement {
	const label = document.createElement("div");
	label.setAttribute("data-omp-region-label", "true");
	Object.assign(label.style, {
		position: "fixed",
		pointerEvents: "none",
		boxSizing: "border-box",
		padding: "2px 6px",
		borderRadius: "3px",
		background: "rgba(0,0,0,0.75)",
		color: "#fff",
		font: "12px monospace",
		zIndex: "2147483647",
		display: "none",
		whiteSpace: "nowrap",
	});
	return label;
}

export function activateRegionCapture(
	doc: Document,
	callbacks: RegionCallbacks,
): RegionHandle {
	const marquee = createMarqueeElement(doc);
	const label = createDimensionsLabel(doc);
	doc.body.appendChild(marquee);
	doc.body.appendChild(label);

	const originalCursor = doc.body.style.cursor;
	doc.body.style.cursor = "crosshair";

	const controller = new AbortController();
	const { signal } = controller;

	let dragging = false;
	let origin = { x: 0, y: 0 };

	function deactivate(): void {
		controller.abort();
		marquee.remove();
		label.remove();
		doc.body.style.cursor = originalCursor;
	}

	doc.addEventListener(
		"mousedown",
		(event) => {
			event.preventDefault();
			event.stopPropagation();
			dragging = true;
			origin = { x: event.clientX, y: event.clientY };
		},
		{ capture: true, signal },
	);

	doc.addEventListener(
		"mousemove",
		(event) => {
			if (!dragging) return;
			event.preventDefault();
			event.stopPropagation();
			const rect = normalizeRegionRect(origin, {
				x: event.clientX,
				y: event.clientY,
			});
			Object.assign(marquee.style, {
				left: `${rect.x}px`,
				top: `${rect.y}px`,
				width: `${rect.width}px`,
				height: `${rect.height}px`,
				display: "block",
			});
			Object.assign(label.style, {
				left: `${rect.x}px`,
				top: `${rect.y + rect.height + 4}px`,
				display: "block",
			});
			label.textContent = `${Math.round(rect.width)}×${Math.round(rect.height)}`;
		},
		{ capture: true, signal },
	);

	doc.addEventListener(
		"mouseup",
		(event) => {
			if (!dragging) return;
			event.preventDefault();
			event.stopPropagation();
			dragging = false;
			const rect = normalizeRegionRect(origin, {
				x: event.clientX,
				y: event.clientY,
			});
			deactivate();
			if (rect.width >= MIN_DRAG_PX && rect.height >= MIN_DRAG_PX) {
				callbacks.onRegion(rect);
			} else {
				callbacks.onCancel();
			}
		},
		{ capture: true, signal },
	);

	doc.addEventListener(
		"keydown",
		(event) => {
			if ("key" in event && (event as { key: string }).key === "Escape") {
				dragging = false;
				deactivate();
				callbacks.onCancel();
			}
		},
		{ capture: true, signal },
	);

	return { deactivate };
}
