export interface PickerCallbacks {
	onSelect: (element: Element) => void;
	onCancel: () => void;
}

export interface PickerHandle {
	deactivate(): void;
}

function createOverlayElement(document: Document): HTMLElement {
	const overlay = document.createElement("div");
	overlay.setAttribute("data-omp-picker-overlay", "true");
	Object.assign(overlay.style, {
		position: "fixed",
		pointerEvents: "none",
		boxSizing: "border-box",
		border: "2px solid #0066cc",
		background: "rgba(0,102,204,0.1)",
		zIndex: "2147483647",
		display: "none",
	});
	return overlay;
}

export function activatePicker(document: Document, callbacks: PickerCallbacks): PickerHandle {
	const overlay = createOverlayElement(document);
	document.body.appendChild(overlay);
	const originalCursor = document.body.style.cursor;
	document.body.style.cursor = "crosshair";
	const controller = new AbortController();
	const { signal } = controller;
	let current: Element | null = null;

	function deactivate(): void {
		controller.abort();
		overlay.remove();
		document.body.style.cursor = originalCursor;
	}

	document.addEventListener(
		"mouseover",
		event => {
			const target = event.target;
			if (!(target instanceof Element) || target.getAttribute("data-omp-picker-overlay") === "true") return;
			current = target;
			const rect = target.getBoundingClientRect();
			Object.assign(overlay.style, {
				left: `${rect.left}px`,
				top: `${rect.top}px`,
				width: `${rect.width}px`,
				height: `${rect.height}px`,
				display: "block",
			});
		},
		{ capture: true, signal },
	);

	document.addEventListener(
		"mouseout",
		() => {
			current = null;
			overlay.style.display = "none";
		},
		{ capture: true, signal },
	);

	document.addEventListener(
		"click",
		event => {
			event.preventDefault();
			event.stopPropagation();
			const selected = current;
			deactivate();
			if (selected) {
				callbacks.onSelect(selected);
			} else {
				callbacks.onCancel();
			}
		},
		{ capture: true, signal },
	);

	document.addEventListener(
		"keydown",
		event => {
			if ("key" in event && (event as { key: string }).key === "Escape") {
				deactivate();
				callbacks.onCancel();
			}
		},
		{ capture: true, signal },
	);

	return { deactivate };
}
