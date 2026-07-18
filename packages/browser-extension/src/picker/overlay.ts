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

function createChipElement(
	document: Document,
	stayActive: boolean,
): HTMLElement {
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
		if (ancestor.nodeType === 9) {
			try {
				void (ancestor as Document).location.href;
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

function resolveTargetFromEvent(element: Element): Element {
	// If the element is inside a shadow root, resolve to the host
	const root = element.getRootNode();
	if (isShadowRoot(root)) {
		const host = root.host;
		if (host) {
			// Try to find the child inside the shadow root that matches
			for (const child of Array.from(host.children)) {
				if (child === element) return element;
				const resolved = resolveTargetFromEvent(child);
				if (resolved !== child) return resolved;
			}
			return host;
		}
	}
	return element;
}

export function activatePicker(
	document: Document,
	callbacks: PickerCallbacks,
	options: PickerOptions = {},
): PickerHandle {
	const stayActive = options.stayActive === true;
	const overlay = createOverlayElement(document);
	const chip = createChipElement(document, stayActive);
	const tooltip = createTooltipElement(document);
	document.body.appendChild(overlay);
	document.body.appendChild(chip);
	document.body.appendChild(tooltip);
	const originalCursor = document.body.style.cursor;
	document.body.style.cursor = "crosshair";
	const controller = new AbortController();
	const { signal } = controller;
	let current: Element | null = null;

	function deactivate(): void {
		controller.abort();
		overlay.remove();
		chip.remove();
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
				!isElement(target) ||
				target.getAttribute("data-omp-picker-overlay") === "true" ||
				target.getAttribute("data-omp-picker-chip") === "true" ||
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
			if (!selected) {
				// Clicking empty space with nothing hovered exits single-pick mode;
				// in stay-active mode it is a no-op.
				if (!stayActive) {
					deactivate();
					callbacks.onExit();
				}
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

	// ── DOM-tree walking ──────────────────────────────────────────────────
	let walkTarget: Element | null = null;

	document.addEventListener(
		"keydown",
		(event) => {
			if (!("key" in event)) return;
			const key = event.key;
			if (key === "Escape") {
				if (stayActive && current) {
					// First Escape: disarm hover, stay active
					current = null;
					overlay.style.display = "none";
					hideTooltip(tooltip);
					return;
				}
				deactivate();
				callbacks.onExit();
				return;
			}
			// Enter commits the current element
			if (key === "Enter") {
				const selected = current;
				deactivate();
				if (selected) callbacks.onSelect(selected);
				else callbacks.onExit();
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
