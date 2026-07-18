// Selector priority (highest first):
//   1. test attributes        (data-testid, data-test, ...)
//   2. stable unique id        (#id, duplicate ids rejected via uniqueness)
//   3. accessible attributes   (aria-label, alt)
//   4. stable semantic attrs   (name, type, href) and semantic classes
//   5. ancestor qualification  (tag/class path)
//   6. positional fallback     (nth-of-type path)
// Every accepted selector is verified unique against the element's root.

const TEST_ATTRIBUTES = [
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
	for (const attribute of TEST_ATTRIBUTES) {
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
