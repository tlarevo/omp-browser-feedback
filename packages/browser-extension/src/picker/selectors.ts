// Selector priority (highest first):
//   1. test attributes        (data-testid, data-test, ...)
//   2. stable unique id        (#id, duplicate ids rejected via uniqueness)
//   3. accessible attributes   (aria-label, alt)
//   4. stable semantic attrs   (name, type, href) and semantic classes
//   5. ancestor qualification  (tag/class path)
//   6. positional fallback     (nth-of-type path)
// Every accepted selector is verified unique against the element's root.

/** Safe check — ShadowRoot may not exist in test environments like linkedom. */
export function isShadowRoot(
	node: Node | null | undefined,
): node is ShadowRoot {
	return typeof ShadowRoot !== "undefined" && node instanceof ShadowRoot;
}

const PREFERRED_ATTRIBUTES = [
	"data-testid",
	"data-test",
	"data-test-id",
	"data-qa",
	"data-cy",
] as const;

const ACCESSIBLE_ATTRIBUTES = ["aria-label", "alt"] as const;

const SEMANTIC_ATTRIBUTES = ["name", "type", "href"] as const;

// Deterministic bounds so pathological markup can never blow up a selector.
const MAX_ANCESTOR_DEPTH = 8;
const MAX_SELECTOR_LENGTH = 512;

// Standard CSS.escape algorithm, used when the platform does not expose CSS.escape
// (e.g. under linkedom in tests). Escaping an identifier (id/class), not a string.
function escapeIdentifier(value: string): string {
	let result = "";
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code === 0) {
			result += "\uFFFD";
		} else if (
			(code >= 0x1 && code <= 0x1f) ||
			code === 0x7f ||
			(i === 0 && code >= 0x30 && code <= 0x39) ||
			(i === 1 && code >= 0x30 && code <= 0x39 && value.charCodeAt(0) === 0x2d)
		) {
			result += `\\${code.toString(16)} `;
		} else if (i === 0 && code === 0x2d && value.length === 1) {
			result += `\\${value[i]}`;
		} else if (
			code >= 0x80 ||
			code === 0x2d ||
			code === 0x5f ||
			(code >= 0x30 && code <= 0x39) ||
			(code >= 0x41 && code <= 0x5a) ||
			(code >= 0x61 && code <= 0x7a)
		) {
			result += value[i];
		} else {
			result += `\\${value[i]}`;
		}
	}
	return result;
}

function cssEscape(value: string): string {
	if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
	return escapeIdentifier(value);
}

function isControlChar(code: number): boolean {
	// All chars < 0x20 except tab (0x09), plus DEL (0x7F).
	return (code < 0x20 && code !== 0x09) || code === 0x7f;
}

function quotedAttributeSelector(name: string, value: string): string {
	// Escape backslashes and quotes first, then control characters (LF, CR,
	// form-feed, etc.) as CSS hex sequences — they are illegal inside CSS
	// quoted strings and would break querySelectorAll.
	let result = "";
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		const code = value.charCodeAt(i);
		if (ch === '"' || ch === "\\") {
			result += `\\${ch}`;
		} else if (isControlChar(code)) {
			result += `\\${code.toString(16)} `;
		} else {
			result += ch;
		}
	}
	return `[${name}="${result}"]`;
}

// Uniqueness is verified against the element's own root (document or shadow root),
// so shadow-scoped selectors are validated inside their shadow tree.
function searchRoot(element: Element): Document | ShadowRoot | undefined {
	const root = element.getRootNode?.();
	if (root && (root as ShadowRoot).host) return root as ShadowRoot;
	return element.ownerDocument ?? globalThis.document;
}

function isUnique(element: Element, selector: string): boolean {
	const root = searchRoot(element);
	if (!root) return false;
	try {
		const matches = root.querySelectorAll(selector);
		return matches.length === 1 && matches[0] === element;
	} catch {
		return false;
	}
}

// Hash-like / framework-generated class names carry no stable meaning.
function isGeneratedClass(cls: string): boolean {
	// CSS-in-JS: emotion (css-1a2b3c), styled-components (sc-bdVaJa), styled-jsx.
	if (/^(css|sc|jsx|emotion)-[0-9a-z]+$/i.test(cls)) return true;
	// CSS Modules hash suffix: Button__3xY9z, styles_container__a1b2c.
	// Requires a digit in the suffix to avoid false-positiving on BEM names like card__header.
	if (/__[a-z0-9]*\d[a-z0-9]*$/i.test(cls)) return true;
	// Pure hex/hash token.
	if (/^[0-9a-f]{6,}$/i.test(cls)) return true;
	// Mixed alnum single run that looks random (letters + digits, long, digit run).
	if (
		cls.length >= 7 &&
		/^[a-z0-9_]+$/i.test(cls) &&
		/[a-z]/i.test(cls) &&
		/\d{2,}/.test(cls) &&
		/(?:\d[a-z]|[a-z]\d)/i.test(cls)
	) {
		return true;
	}
	return false;
}

// Utility/atomic classes (Tailwind, Bootstrap spacing, etc.) are presentational noise.
function isUtilityClass(cls: string): boolean {
	if (
		/^(flex|grid|block|inline|inline-block|hidden|container|row|clearfix|sr-only)$/.test(
			cls,
		)
	) {
		return true;
	}
	// Spacing/sizing/color atoms: px-4, mt-2, m-0, w-1, gap-2, text-sm, bg-blue-500.
	if (
		/^(p|m|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|w|h|min-w|min-h|max-w|max-h|gap|space|text|bg|border|rounded|shadow|font|leading|tracking|z|top|left|right|bottom|inset|order|basis|grow|shrink|col|columns|opacity|cursor|overflow|justify|items|content|self|place)-[a-z0-9/-]+$/.test(
			cls,
		)
	) {
		return true;
	}
	// Responsive/state variants: md:flex, hover:bg-blue-500, dark:text-white.
	if (
		/^(sm|md|lg|xl|2xl|hover|focus|active|dark|group|first|last):/.test(cls)
	) {
		return true;
	}
	return false;
}

function classList(element: Element): string[] {
	const list = element.classList;
	if (list) return Array.from(list);
	// SVG className is an SVGAnimatedString, not a string — read the attribute.
	const raw = element.getAttribute("class");
	return raw ? raw.trim().split(/\s+/) : [];
}

function stableClasses(element: Element): string[] {
	return classList(element).filter(
		(cls) => cls && !isGeneratedClass(cls) && !isUtilityClass(cls),
	);
}

// Last-resort candidates: generated and utility classes that are filtered out
// by standaloneCandidates but may be the only unique anchor in edge cases.
// Each candidate is verified unique and within length bounds.
function* lastResortCandidates(element: Element): Generator<string> {
	for (const cls of classList(element)) {
		if (!cls) continue;
		if (!isGeneratedClass(cls) && !isUtilityClass(cls)) continue;
		const s = `.${cssEscape(cls)}`;
		if (s.length <= MAX_SELECTOR_LENGTH) yield s;
	}
}

function tagName(element: Element): string {
	// localName preserves case for SVG (e.g. linearGradient) unlike tagName.
	return element.localName;
}

// Ordered standalone candidates for an element, highest priority first.
// Candidates exceeding MAX_SELECTOR_LENGTH are skipped — they can never be
// verified unique within the configured bounds.
function* standaloneCandidates(element: Element): Generator<string> {
	for (const attribute of PREFERRED_ATTRIBUTES) {
		const value = element.getAttribute(attribute);
		if (value) {
			const s = quotedAttributeSelector(attribute, value);
			if (s.length <= MAX_SELECTOR_LENGTH) yield s;
		}
	}

	const id = element.id;
	if (id && !/\s/.test(id) && !isGeneratedClass(id)) {
		const s = `#${cssEscape(id)}`;
		if (s.length <= MAX_SELECTOR_LENGTH) yield s;
	}

	for (const attribute of ACCESSIBLE_ATTRIBUTES) {
		const value = element.getAttribute(attribute);
		if (value) {
			const s = quotedAttributeSelector(attribute, value);
			if (s.length <= MAX_SELECTOR_LENGTH) yield s;
		}
	}

	for (const attribute of SEMANTIC_ATTRIBUTES) {
		const value = element.getAttribute(attribute);
		if (value) {
			const s = quotedAttributeSelector(attribute, value);
			if (s.length <= MAX_SELECTOR_LENGTH) yield s;
		}
	}

	for (const cls of stableClasses(element)) {
		const s = `.${cssEscape(cls)}`;
		if (s.length <= MAX_SELECTOR_LENGTH) yield s;
	}
}

// Best non-positional descriptor for a node inside a path: tag qualified by one
// stable class when available, otherwise the bare tag.
function localPart(element: Element): string {
	const [cls] = stableClasses(element);
	const tag = tagName(element);
	return cls ? `${tag}.${cssEscape(cls)}` : tag;
}

function nthOfType(element: Element): string {
	const tag = tagName(element);
	let index = 1;
	let siblingsOfType = 1;
	let sibling = element.previousElementSibling;
	while (sibling) {
		if (sibling.localName === element.localName) index++;
		sibling = sibling.previousElementSibling;
	}
	siblingsOfType = index;
	let after = element.nextElementSibling;
	while (after) {
		if (after.localName === element.localName) siblingsOfType++;
		after = after.nextElementSibling;
	}
	// A bare tag only disambiguates when this element is the sole one of its type.
	return siblingsOfType === 1 ? tag : `${tag}:nth-of-type(${index})`;
}

// Walk ancestors combining `part(node)` per level, returning the first unique
// path within MAX_ANCESTOR_DEPTH and MAX_SELECTOR_LENGTH.
// Returns undefined when no unique path is found within bounds.
function buildPath(
	element: Element,
	part: (node: Element) => string,
): string | undefined {
	const parts: string[] = [];
	let current: Element | null = element;
	let depth = 0;
	while (current && tagName(current) !== "html" && depth < MAX_ANCESTOR_DEPTH) {
		parts.unshift(part(current));
		const selector = parts.join(" > ");
		if (selector.length > MAX_SELECTOR_LENGTH) {
			return undefined;
		}
		if (isUnique(element, selector)) return selector;
		current = current.parentElement;
		depth++;
	}
	return undefined;
}

export function generateSelector(element: Element): string {
	for (const candidate of standaloneCandidates(element)) {
		if (isUnique(element, candidate)) return candidate;
	}

	// Ancestor qualification with stable descriptors.
	const semanticPath = buildPath(element, localPart);
	if (semanticPath && isUnique(element, semanticPath)) return semanticPath;

	// Positional fallback — verify before returning.
	const positionalPath = buildPath(element, nthOfType);
	if (positionalPath && isUnique(element, positionalPath))
		return positionalPath;

	// Last resort: generated/utility classes, verified unique.
	for (const candidate of lastResortCandidates(element)) {
		if (isUnique(element, candidate)) return candidate;
	}

	throw new Error("No unique selector found within configured bounds");
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
	let siblingsOfType = index;
	let after = element.nextElementSibling;
	while (after) {
		if (after.tagName === element.tagName) siblingsOfType++;
		after = after.nextElementSibling;
	}
	return siblingsOfType === 1 ? tag : `${tag}:nth-of-type(${index})`;
}

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
		if (parentNode.tagName.toLowerCase() === "html") {
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
export function generateSelectorSegments(element: Element): SelectorSegment[] {
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
