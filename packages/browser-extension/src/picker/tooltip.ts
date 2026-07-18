/**
 * Picker tooltip — shows tag, stable ID/classes, dimensions, and selector
 * preview while hovering. Flips position to avoid covering the target or
 * viewport edges.
 */

export interface TooltipState {
	tag: string;
	id: string | null;
	classes: string[];
	width: number;
	height: number;
	selectorPreview: string;
	shadowContext?: boolean;
	unsupported?: string;
}

function formatClasses(classes: string[]): string {
	if (classes.length === 0) return "";
	const shown = classes.slice(0, 3).join(".");
	return classes.length > 3 ? `.${shown}…` : `.${shown}`;
}

function describeElement(state: TooltipState): string {
	const parts: string[] = [`<${state.tag}>`];
	if (state.id) parts.push(`#${state.id}`);
	const cls = formatClasses(state.classes);
	if (cls) parts.push(cls);
	parts.push(`${state.width}×${state.height}`);
	if (state.shadowContext) parts.push("(shadow)");
	if (state.unsupported) parts.push(`⚠ ${state.unsupported}`);
	return parts.join(" ");
}

function describeSelector(state: TooltipState): string {
	return state.selectorPreview || "—";
}

/**
 * Create the tooltip element.
 */
export function createTooltipElement(doc: Document): HTMLElement {
	const el = doc.createElement("div");
	el.setAttribute("data-omp-picker-tooltip", "true");
	Object.assign(el.style, {
		position: "fixed",
		pointerEvents: "none",
		boxSizing: "border-box",
		padding: "4px 8px",
		fontFamily: "monospace",
		fontSize: "11px",
		lineHeight: "1.4",
		color: "#fff",
		background: "rgba(30,30,30,0.92)",
		borderRadius: "4px",
		zIndex: "2147483647",
		maxWidth: "360px",
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis",
		display: "none",
		boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
	});
	return el;
}

/**
 * Build the two-line tooltip text content from state.
 */
export function renderTooltipLines(state: TooltipState): [string, string] {
	return [describeElement(state), describeSelector(state)];
}

/**
 * Position the tooltip relative to the target's bounding rect, flipping to
 * avoid covering the target or falling outside the viewport.
 *
 * Returns the final {left, top} in fixed viewport coords.
 */
export function computeTooltipPosition(
	tooltip: HTMLElement,
	targetRect: DOMRect,
	viewport?: { width: number; height: number },
): { left: number; top: number } {
	const tW = tooltip.offsetWidth;
	const tH = tooltip.offsetHeight;
	const vpW = viewport?.width ?? window.innerWidth;
	const vpH = viewport?.height ?? window.innerHeight;
	const margin = 6;

	// Try below target first, then above, then fallback to below
	let top = targetRect.bottom + margin;
	let left = targetRect.left;

	// Horizontal clamping
	if (left + tW > vpW - margin) left = vpW - tW - margin;
	if (left < margin) left = margin;

	// If below overflows viewport bottom, try above
	if (top + tH > vpH - margin) {
		top = targetRect.top - tH - margin;
	}

	// If above overflows viewport top, clamp to top
	if (top < margin) top = margin;

	return { left, top };
}

/**
 * Update the tooltip display with new state and position.
 */
export function updateTooltip(
	tooltip: HTMLElement,
	state: TooltipState,
	targetRect: DOMRect,
): void {
	const [line1, line2] = renderTooltipLines(state);
	tooltip.textContent = "";
	const span1 = tooltip.ownerDocument.createElement("div");
	span1.textContent = line1;
	const span2 = tooltip.ownerDocument.createElement("div");
	span2.textContent = line2;
	span2.style.opacity = "0.7";
	tooltip.appendChild(span1);
	tooltip.appendChild(span2);

	const { left, top } = computeTooltipPosition(tooltip, targetRect);
	Object.assign(tooltip.style, {
		left: `${left}px`,
		top: `${top}px`,
		display: "block",
	});
}

/**
 * Hide the tooltip.
 */
export function hideTooltip(tooltip: HTMLElement): void {
	tooltip.style.display = "none";
}

/**
 * Extract tooltip state from an element.
 */
export function extractTooltipState(
	element: Element,
	selectorPreview: string,
	options?: { shadowContext?: boolean; unsupported?: string },
): TooltipState {
	const id = element.id || null;
	const classList = Array.from(element.classList);
	const rect = element.getBoundingClientRect();
	return {
		tag: element.tagName.toLowerCase(),
		id,
		classes: classList,
		width: Math.round(rect.width),
		height: Math.round(rect.height),
		selectorPreview,
		shadowContext: options?.shadowContext,
		unsupported: options?.unsupported,
	};
}
