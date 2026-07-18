import {
	generateSelector,
	isInShadowContext,
	isShadowRoot,
} from "./selectors";
import {
	createTooltipElement,
	extractTooltipState,
	hideTooltip,
	updateTooltip,
	type TooltipState,
} from "./tooltip";

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

function moveOverlay(
	overlay: HTMLElement,
	element: Element,
): void {
	const rect = element.getBoundingClientRect();
	Object.assign(overlay.style, {
		left: `${rect.left}px`,
		top: `${rect.top}px`,
		width: `${rect.width}px`,
		height: `${rect.height}px`,
		display: "block",
	});
}

/**
 * Get the walkable parent of an element.  For elements inside shadow roots,
 * the host element is the walkable parent.  For top-level elements, walks
 * to parentElement.  Returns null at document root.
 */
export function walkableParent(element: Element): Element | null {
	const root = element.getRootNode();
	if (isShadowRoot(root)) return root.host;
	return element.parentElement;
}

/**
 * Get the walkable first-child of an element (first Element child, or the
 * shadow root's first element child if it has an open shadow root).
 */
export function walkableChild(element: Element): Element | null {
	// Check for open shadow root first
	if (element.shadowRoot) {
		return element.shadowRoot.firstElementChild;
	}
	return element.firstElementChild;
}

/**
 * Determine unsupported-state info for an element that can't be fully selected.
 */
function unsupportedReason(element: Element): string | undefined {
	const root = element.getRootNode();
	if (isShadowRoot(root) && root.mode === "closed") {
		return "closed shadow root — not accessible";
	}
	// Check for cross-origin iframe context
	let ancestor: Node | null = element;
	while (ancestor) {
		if (ancestor instanceof Document) {
			try {
				void ancestor.location.href;
			} catch {
				return "cross-origin iframe — not accessible";
			}
		}
		ancestor =
			ancestor.parentNode ??
			(isShadowRoot(ancestor) ? ancestor.host : null);
	}
	return undefined;
}

export function activatePicker(
	document: Document,
	callbacks: PickerCallbacks,
): PickerHandle {
	const overlay = createOverlayElement(document);
	const tooltip = createTooltipElement(document);
	document.body.appendChild(overlay);
	document.body.appendChild(tooltip);
	const originalCursor = document.body.style.cursor;
	document.body.style.cursor = "crosshair";
	const controller = new AbortController();
	const { signal } = controller;
	let current: Element | null = null;

	function deactivate(): void {
		controller.abort();
		overlay.remove();
		tooltip.remove();
		document.body.style.cursor = originalCursor;
	}

	function showTooltipFor(element: Element): void {
		const selector = generateSelector(element);
		const shadowCtx = isInShadowContext(element);
		const unsupported = unsupportedReason(element);
		const state: TooltipState = extractTooltipState(element, selector, {
			shadowContext: shadowCtx,
			unsupported,
		});
		updateTooltip(tooltip, state, element.getBoundingClientRect());
	}

	function handlePointerTarget(target: Element): void {
		// Resolve through open shadow roots
		const resolved = resolveTargetFromEvent(target);
		current = resolved;
		moveOverlay(overlay, resolved);
		showTooltipFor(resolved);
	}

	document.addEventListener(
		"mouseover",
		(event) => {
			const target = event.target;
			if (
				!(target instanceof Element) ||
				target.getAttribute("data-omp-picker-overlay") === "true" ||
				target.getAttribute("data-omp-picker-tooltip") === "true"
			)
				return;
			// If we're in walk mode (have a walked element), don't override on hover
			if (walkTarget) return;
			handlePointerTarget(target);
		},
		{ capture: true, signal },
	);

	document.addEventListener(
		"mouseout",
		() => {
			if (walkTarget) return;
			current = null;
			overlay.style.display = "none";
			hideTooltip(tooltip);
		},
		{ capture: true, signal },
	);

	document.addEventListener(
		"click",
		(event) => {
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

	// ── DOM-tree walking ──────────────────────────────────────────────────
	let walkTarget: Element | null = null;

	document.addEventListener(
		"keydown",
		(event) => {
			if (!("key" in event)) return;
			const key = event.key;
			if (key === "Escape") {
				deactivate();
				callbacks.onCancel();
				return;
			}
			// Enter commits the current element
			if (key === "Enter") {
				const selected = current;
				deactivate();
				if (selected) callbacks.onSelect(selected);
				else callbacks.onCancel();
				return;
			}
			// Arrow keys walk the DOM tree
			if (key === "ArrowUp" || key === "ArrowDown") {
				event.preventDefault();
				const base = walkTarget ?? current;
				if (!base) return;
				const next =
					key === "ArrowUp"
						? walkableParent(base)
						: walkableChild(base);
				if (next) {
					walkTarget = next;
					current = next;
					moveOverlay(overlay, next);
					showTooltipFor(next);
				}
			}
		},
		{ capture: true, signal },
	);

	// ── Scroll-wheel walking ──────────────────────────────────────────────
	document.addEventListener(
		"wheel",
		(event) => {
			const base = walkTarget ?? current;
			if (!base) return;
			event.preventDefault();
			const direction = event.deltaY > 0 ? "down" : "up";
			const next =
				direction === "down"
					? walkableChild(base)
					: walkableParent(base);
			if (next) {
				walkTarget = next;
				current = next;
				moveOverlay(overlay, next);
				showTooltipFor(next);
			}
		},
		{ capture: true, signal },
	);

	return { deactivate };
}

/**
 * Resolve the effective target from a DOM element, walking through open
 * shadow roots.  For shadow DOM elements, returns the innermost element.
 * For closed shadow roots, returns the host element.
 */
function resolveTargetFromEvent(element: Element): Element {
	const root = element.getRootNode();
	if (isShadowRoot(root)) {
		// If this element IS the shadow root's host, walk into it
		if (element.shadowRoot) {
			const child = element.shadowRoot.firstElementChild;
			if (child) return resolveTargetFromEvent(child);
		}
	}
	return element;
}
