export interface PickerCallbacks {
	/** A pick was committed on an element. */
	onSelect: (element: Element) => void;
	/**
	 * The picker exited on its own — via Escape, or a pick in single-pick mode.
	 * Not invoked by a programmatic `deactivate()`.
	 */
	onExit: () => void;
}

export interface PickerOptions {
	/**
	 * When true, the picker stays armed after each pick so the user can pick
	 * repeatedly. It only exits on Escape (with nothing hovered) or an explicit
	 * `deactivate()`. When false (default) the first pick exits the picker.
	 */
	stayActive?: boolean;
}

export interface PickerHandle {
	deactivate(): void;
}

/** Realm-independent element check (works in both the browser and linkedom). */
function isElement(node: EventTarget | null): node is Element {
	return node != null && "nodeType" in node && node.nodeType === 1;
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

function createChipElement(document: Document, stayActive: boolean): HTMLElement {
	const chip = document.createElement("div");
	chip.setAttribute("data-omp-picker-chip", "true");
	chip.textContent = stayActive
		? "OMP pick mode — click to pick, Esc to exit"
		: "OMP pick mode — Esc to cancel";
	Object.assign(chip.style, {
		position: "fixed",
		bottom: "16px",
		right: "16px",
		padding: "6px 10px",
		font: "12px/1.4 system-ui, -apple-system, sans-serif",
		color: "#fff",
		background: "#0066cc",
		borderRadius: "6px",
		boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
		pointerEvents: "none",
		zIndex: "2147483647",
	});
	return chip;
}

export function activatePicker(
	document: Document,
	callbacks: PickerCallbacks,
	options: PickerOptions = {},
): PickerHandle {
	const stayActive = options.stayActive === true;
	const overlay = createOverlayElement(document);
	const chip = createChipElement(document, stayActive);
	document.body.appendChild(overlay);
	document.body.appendChild(chip);
	const originalCursor = document.body.style.cursor;
	document.body.style.cursor = "crosshair";
	const controller = new AbortController();
	const { signal } = controller;
	let current: Element | null = null;

	function deactivate(): void {
		controller.abort();
		overlay.remove();
		chip.remove();
		document.body.style.cursor = originalCursor;
	}

	/** Cancel the current hover without exiting the picker. */
	function disarm(): void {
		current = null;
		overlay.style.display = "none";
	}

	function exit(): void {
		deactivate();
		callbacks.onExit();
	}

	document.addEventListener(
		"mouseover",
		(event) => {
			const target = event.target;
			if (
				!isElement(target) ||
				target.getAttribute("data-omp-picker-overlay") === "true" ||
				target.getAttribute("data-omp-picker-chip") === "true"
			)
				return;
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
			disarm();
		},
		{ capture: true, signal },
	);

	document.addEventListener(
		"click",
		(event) => {
			event.preventDefault();
			event.stopPropagation();
			const selected = current;
			if (!selected) {
				// Clicking empty space with nothing hovered exits single-pick mode;
				// in stay-active mode it is a no-op.
				if (!stayActive) exit();
				return;
			}
			if (stayActive) {
				callbacks.onSelect(selected);
				// Remain armed for the next pick.
			} else {
				deactivate();
				callbacks.onSelect(selected);
				callbacks.onExit();
			}
		},
		{ capture: true, signal },
	);

	document.addEventListener(
		"keydown",
		(event) => {
			if (!("key" in event) || event.key !== "Escape") return;
			// First Escape cancels the current hover; a second Escape (or Escape
			// with nothing armed) exits picker mode entirely.
			if (current) {
				disarm();
			} else {
				exit();
			}
		},
		{ capture: true, signal },
	);

	return { deactivate };
}
