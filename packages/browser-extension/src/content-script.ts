import {
	BROWSER_PROTOCOL_VERSION,
	type BrowserAccessibilityContext,
	type BrowserElementContext,
	type BrowserFeedbackEvent,
	type BrowserPageContext,
} from "@oh-my-pi/browser-protocol";
import { activatePicker, type PickerHandle } from "./picker/overlay";
import { generateSelector, generateSelectorSegments, isInShadowContext } from "./picker/selectors";

export type { PickerHandle };

export interface PickedElementSummary {
	selector: string;
	tagName: string;
	text?: string;
}

export interface ElementCaptureOptions {
	window?: Window;
	styleProperties?: string[];
}

export interface DomSelectionFeedbackInput {
	channelId: string;
	element: Element;
	note?: string;
	eventId?: string;
	createdAt?: string;
	window?: Window;
}

const DEFAULT_STYLE_PROPERTIES = [
	"display",
	"position",
	"color",
	"background-color",
	"font-size",
	"font-weight",
];

export function summarizePickedElement(element: Element): PickedElementSummary {
	const text = element.textContent?.trim();
	return {
		selector: generateSelector(element),
		tagName: element.tagName,
		...(text ? { text } : {}),
	};
}

export function capturePageContext(win: Window = window): BrowserPageContext {
	return {
		url: win.location.href,
		title: win.document.title,
		viewport: {
			width: win.innerWidth,
			height: win.innerHeight,
			devicePixelRatio: win.devicePixelRatio,
		},
	};
}

// ---------------------------------------------------------------------------
// XPath generation
// ---------------------------------------------------------------------------

/**
 * Build an XPath for `element`. Prefers id-anchored paths when the id is
 * present and produces a unique expression. Falls back to positional axes.
 *
 * Returns `undefined` for shadow-DOM elements (ownerDocument differs from the
 * top-level document) since XPath cannot pierce shadow boundaries.
 */
export function generateXpath(element: Element): string | undefined {
	const doc = element.ownerDocument;
	// Shadow-DOM elements have a null or detached ownerDocument relative to
	// the main document — XPath cannot traverse shadow boundaries.
	if (!doc) return undefined;

	const parts: string[] = [];
	let current: Element | null = element;

	do {
		const tag = current.tagName.toLowerCase();

		// Prefer id-anchored path when id is present and unique.
		const id = current.id;
		if (id && !/[:\s]/.test(id)) {
			const xpathId = `//*[@id="${id}"]`;
			// Verify it resolves to exactly this element when evaluate is available.
			if (typeof doc.evaluate === "function") {
				try {
					const result = doc.evaluate(
						xpathId,
						doc,
						null,
						XPathResult.FIRST_ORDERED_NODE_TYPE,
						null,
					);
					if (result.singleNodeValue === current) {
						parts.unshift(`//*[@id="${id}"]`);
						break;
					}
				} catch {
					// Invalid id expression — fall through to positional.
				}
			} else {
				// No evaluate available (e.g. linkedom) — trust the id path.
				parts.unshift(`//*[@id="${id}"]`);
				break;
			}
		}

		// Positional axis: count preceding siblings of the same tag.
		let index = 1;
		let sibling = current.previousElementSibling;
		while (sibling) {
			if (sibling.tagName === current.tagName) index++;
			sibling = sibling.previousElementSibling;
		}
		parts.unshift(`${tag}[${index}]`);
		current = current.parentElement;
	} while (current && current !== doc.documentElement);

	if (parts.length === 0) return undefined;

	// Build an absolute path. Id-anchored paths (starting with //) are already absolute.
	const xpath = parts[0]?.startsWith("//") ? parts[0] : `/${parts.join("/")}`;

	// Verify the generated XPath resolves to exactly the picked element.
	if (typeof doc.evaluate === "function") {
		try {
			const result = doc.evaluate(
				xpath,
				doc,
				null,
				XPathResult.FIRST_ORDERED_NODE_TYPE,
				null,
			);
			if (result.singleNodeValue === element) return xpath;
		} catch {
			// XPath expression failed evaluation.
		}
		return undefined;
	}

	return xpath;
}

// ---------------------------------------------------------------------------
// Accessibility context (lightweight, no library)
// ---------------------------------------------------------------------------

/** Implicit ARIA roles for common HTML elements. */
const TAG_IMPLICIT_ROLE: Record<string, string> = {
	A: "link",
	BUTTON: "button",
	INPUT: "textbox",
	IMG: "img",
	NAV: "navigation",
	HEADER: "banner",
	FOOTER: "contentinfo",
	MAIN: "main",
	ASIDE: "complementary",
	SECTION: "region",
	ARTICLE: "article",
	FORM: "form",
	TABLE: "table",
	UL: "list",
	OL: "list",
	LI: "listitem",
	SELECT: "listbox",
	TEXTAREA: "textbox",
	DIALOG: "dialog",
	MENU: "menu",
	DETAILS: "group",
	FIELDSET: "group",
	H1: "heading",
	H2: "heading",
	H3: "heading",
	H4: "heading",
	H5: "heading",
	H6: "heading",
};

/**
 * Compute a lightweight accessibility context for an element.
 *
 * Resolution order per the practical accname subset:
 * 1. `aria-labelledby` → text of the first referenced element
 * 2. `aria-label`
 * 3. Associated `<label>` (for form controls)
 * 4. `alt` attribute
 * 5. `title` attribute
 * 6. Visible text content (first 120 chars)
 *
 * Returns `undefined` when no meaningful a11y info is found (avoids noise
 * like `role: generic`).
 */
export function captureAccessibility(
	element: Element,
): BrowserAccessibilityContext | undefined {
	const role =
		element.getAttribute("role") ||
		TAG_IMPLICIT_ROLE[element.tagName] ||
		undefined;

	// Resolve accessible name via the precedence chain.
	let name: string | undefined;

	// 1. aria-labelledby
	const labelledBy = element.getAttribute("aria-labelledby");
	if (labelledBy) {
		const doc = element.ownerDocument;
		if (doc) {
			for (const id of labelledBy.split(/\s+/)) {
				if (!id) continue;
				const ref = doc.getElementById(id);
				if (ref) {
					const text = ref.textContent?.trim();
					if (text) {
						name = text;
						break;
					}
				}
			}
		}
	}

	// 2. aria-label
	if (!name) {
		const ariaLabel = element.getAttribute("aria-label");
		if (ariaLabel) name = ariaLabel;
	}

	// 3. Associated <label> (for input/select/textarea with id)
	if (!name && "id" in element) {
		const id = element.id;
		if (id) {
			const doc = element.ownerDocument;
			if (doc) {
				const label = doc.querySelector(`label[for="${id}"]`);
				if (label) {
					const text = label.textContent?.trim();
					if (text) name = text;
				}
			}
		}
	}

	// 4. alt attribute
	if (!name) {
		const alt = element.getAttribute("alt");
		if (alt) name = alt;
	}

	// 5. title attribute
	if (!name) {
		const title = element.getAttribute("title");
		if (title) name = title;
	}

	// 6. Visible text content (truncated to avoid bloating the prompt)
	if (!name) {
		const text = element.textContent?.trim();
		if (text && text.length <= 120) name = text;
	}

	// Description from aria-describedby
	let description: string | undefined;
	const describedBy = element.getAttribute("aria-describedby");
	if (describedBy) {
		const doc = element.ownerDocument;
		if (doc) {
			for (const id of describedBy.split(/\s+/)) {
				if (!id) continue;
				const ref = doc.getElementById(id);
				if (ref) {
					const text = ref.textContent?.trim();
					if (text) {
						description = text;
						break;
					}
				}
			}
		}
	}

	// Omit entirely when there's no meaningful info (no role: generic noise).
	if (!role && !name && !description) return undefined;

	return {
		...(role ? { role } : {}),
		...(name ? { name } : {}),
		...(description ? { description } : {}),
	};
}

// ---------------------------------------------------------------------------
// Element context capture
// ---------------------------------------------------------------------------

export function captureElementContext(
	element: Element,
	options: ElementCaptureOptions = {},
): BrowserElementContext {
	const win = options.window ?? window;
	const bounds = element.getBoundingClientRect();
	const attributes: Record<string, string> = {};
	for (const attribute of Array.from(element.attributes)) {
		attributes[attribute.name] = attribute.value;
	}

	const computedStyles: Record<string, string> = {};
	const styles = win.getComputedStyle(element);
	for (const property of options.styleProperties ?? DEFAULT_STYLE_PROPERTIES) {
		computedStyles[property] = styles.getPropertyValue(property);
	}

	const rawText = element.textContent?.trim();
	const text =
		rawText !== undefined && rawText.length > 0
			? truncateToCodePoints(
					rawText,
					BROWSER_FEEDBACK_LIMITS.maxElementTextLength,
				)
			: undefined;
	const xpath = generateXpath(element);
	const accessibility = captureAccessibility(element);

	return {
		selector: generateSelector(element),
		tagName: element.tagName,
		...(text ? { text } : {}),
		outerHtml: element.outerHTML,
		attributes,
		bounds: {
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
		},
		computedStyles: capEntriesByPriority(
			computedStyles,
			styleProperties,
			BROWSER_FEEDBACK_LIMITS.maxComputedStyleCount,
		),
		selectorSegments: generateSelectorSegments(element),
		shadowRoot: isInShadowContext(element),
		...(xpath ? { xpath } : {}),
		...(accessibility ? { accessibility } : {}),
	};
}

export function buildDomSelectionFeedback(
	input: DomSelectionFeedbackInput,
): BrowserFeedbackEvent {
	const win = input.window ?? window;
	return {
		protocolVersion: BROWSER_PROTOCOL_VERSION,
		eventId: input.eventId ?? crypto.randomUUID(),
		type: "dom.selection",
		channelId: input.channelId,
		createdAt: input.createdAt ?? new Date().toISOString(),
		page: capturePageContext(win),
		element: captureElementContext(input.element, { window: win }),
		...(input.note ? { note: input.note } : {}),
	};
}

export interface PickerCaptureInput {
	channelId: string;
	note?: string;
	window?: Window;
}

export type PickerCaptureCallback = (
	event: BrowserFeedbackEvent | null,
) => void;

export function activatePickerAndCapture(
	document: Document,
	input: PickerCaptureInput,
	callback: PickerCaptureCallback,
): PickerHandle {
	return activatePicker(document, {
		onSelect(element) {
			const win = input.window ?? window;
			callback(
				buildDomSelectionFeedback({
					channelId: input.channelId,
					element,
					note: input.note,
					window: win,
				}),
			);
		},
		onCancel() {
			callback(null);
		},
	});
}
