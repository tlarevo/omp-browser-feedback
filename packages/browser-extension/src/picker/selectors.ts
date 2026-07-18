/** Safe check — ShadowRoot may not exist in test environments like linkedom. */
export function isShadowRoot(node: Node | null | undefined): node is ShadowRoot {
	return (
		typeof ShadowRoot !== "undefined" && node instanceof ShadowRoot
	);
}

const PREFERRED_ATTRIBUTES = [
	"data-testid",
	"data-test",
	"aria-label",
	"name",
	"type",
	"href",
] as const;

function cssEscape(value: string): string {
	if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
	return value.replace(/["\\]/g, "\\$&");
}

function quotedAttributeSelector(name: string, value: string): string {
	return `[${name}="${cssEscape(value)}"]`;
}

function ownerDocument(element: Element): Document | undefined {
	return element.ownerDocument ?? globalThis.document;
}

function isUnique(element: Element, selector: string): boolean {
	const document = ownerDocument(element);
	if (!document) return false;
	try {
		const matches = document.querySelectorAll(selector);
		return matches.length === 1 && matches[0] === element;
	} catch {
		return false;
	}
}

function stableAttributeSelector(element: Element): string | undefined {
	for (const attribute of PREFERRED_ATTRIBUTES) {
		const value = element.getAttribute(attribute);
		if (!value) continue;
		const selector = quotedAttributeSelector(attribute, value);
		if (isUnique(element, selector)) return selector;
	}
	return undefined;
}

function stableIdSelector(element: Element): string | undefined {
	const id = element.id;
	if (!id || /[:\s]/.test(id)) return undefined;
	const selector = `#${cssEscape(id)}`;
	return isUnique(element, selector) ? selector : undefined;
}

function nthOfTypeSelector(element: Element): string {
	const tag = element.tagName.toLowerCase();
	let index = 1;
	let sibling = element.previousElementSibling;
	while (sibling) {
		if (sibling.tagName === element.tagName) index++;
		sibling = sibling.previousElementSibling;
	}
	return index === 1 ? tag : `${tag}:nth-of-type(${index})`;
}

export function generateSelector(element: Element): string {
	const stableAttribute = stableAttributeSelector(element);
	if (stableAttribute) return stableAttribute;

	const idSelector = stableIdSelector(element);
	if (idSelector) return idSelector;

	const parts: string[] = [];
	let current: Element | null = element;
	while (current && current.tagName.toLowerCase() !== "html") {
		parts.unshift(nthOfTypeSelector(current));
		const selector = parts.join(" > ");
		if (isUnique(element, selector)) return selector;
		current = current.parentElement;
	}
	return parts.join(" > ");
}

// ── Shadow DOM support ──────────────────────────────────────────────────────

/** A single segment: one selector scoped to one document or shadow root. */
export interface SelectorSegment {
	selector: string;
	shadowRoot: boolean;
}

/**
 * Resolve the deepest element reachable through open shadow roots from an
 * event's composedPath.  Returns null for elements outside any shadow context.
 */
export function resolveComposedTarget(event: Event): Element | null {
	const path = event.composedPath();
	// Walk backward to find the deepest open-shadow element
	for (let i = path.length - 1; i >= 0; i--) {
		const node = path[i];
		if (node instanceof Element) return node;
	}
	return null;
}

/**
 * Check whether an element lives inside a shadow root.
 */
function isInsideShadowRoot(element: Element): boolean {
	let current: Node | null = element;
	while (current) {
		if (isShadowRoot(current)) return true;
		current = current.parentNode;
	}
	return false;
}

/**
 * Generate a unique selector for an element within its own document/shadow root
 * (scoped to that root's querySelector).
 */
function generateRootScopedSelector(element: Element): string {
	const stableAttribute = stableAttributeSelector(element);
	if (stableAttribute) return stableAttribute;

	const idSelector = stableIdSelector(element);
	if (idSelector) return idSelector;

	// Walk up within the same root
	const root = element.getRootNode() as Document | ShadowRoot;
	const parts: string[] = [];
	let current: Element | null = element;
	while (current) {
		parts.unshift(nthOfTypeSelector(current));
		const selector = parts.join(" > ");
		try {
			const matches = root.querySelectorAll(selector);
			if (matches.length === 1 && matches[0] === element) return selector;
		} catch {
			return parts.join(" > ");
		}
		// Stop at shadow root boundary or document
		const parentNode: Element | null =
			current.parentElement ??
			(isShadowRoot(current.getRootNode())
				? (current.getRootNode() as ShadowRoot).host
				: null);
		if (!parentNode) break;
		if (
			parentNode.tagName.toLowerCase() === "html"
		) {
			parts.unshift("html");
			return parts.join(" > ");
		}
		current = parentNode;
	}
	return parts.join(" > ");
}

/**
 * Build ordered selectorSegments from document to the target element, one
 * segment per document/shadow-root boundary.
 *
 * Each segment contains a unique selector and a `shadowRoot` flag indicating
 * whether it crosses into a shadow root.
 */
export function generateSelectorSegments(
	element: Element,
): SelectorSegment[] {
	const segments: SelectorSegment[] = [];
	// Walk from element up to document, collecting shadow boundaries
	const chain: Element[] = [];
	let current: Element | null = element;
	while (current) {
		chain.unshift(current);
		const root = current.getRootNode();
		if (isShadowRoot(root)) {
			current = root.host;
		} else if (current.parentElement) {
			current = current.parentElement;
		} else {
			break;
		}
	}

	// Generate one selector per root boundary
	let prevRoot: Node | null = null;
	for (const el of chain) {
		const elRoot = el.getRootNode();
		if (elRoot !== prevRoot) {
			// New root boundary — generate selector within this root
			segments.push({
				selector: generateRootScopedSelector(el),
				shadowRoot: isShadowRoot(elRoot),
			});
			prevRoot = elRoot;
		}
	}
	return segments;
}

/**
 * Return true if the element is inside a shadow root (closed or open).
 */
export function isInShadowContext(element: Element): boolean {
	return isInsideShadowRoot(element);
}

/**
 * Resolve the "effective target" — the deepest element reachable through
 * open shadow roots from a mouse/pointer event.  For events that cross
 * shadow boundaries, composedPath() reveals the real target.
 *
 * Returns the deepest Element from composedPath(), or falls back to
 * event.target if composedPath is unavailable.
 */
export function resolveEventTarget(event: Event): Element {
	// Prefer composedPath for shadow DOM traversal
	if (typeof event.composedPath === "function") {
		const resolved = resolveComposedTarget(event);
		if (resolved) return resolved;
	}
	// Fallback to direct target
	if (event.target instanceof Element) return event.target;
	// Last resort: document body
	return document.body;
}
