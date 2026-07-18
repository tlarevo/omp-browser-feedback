import {
	BROWSER_FEEDBACK_LIMITS,
	BROWSER_PROTOCOL_VERSION,
	type BrowserAccessibilityContext,
	type BrowserElementContext,
	type BrowserFeedbackEvent,
	type BrowserPageContext,
	type ConsoleEntry,
	type PageScreenshotFeedback,
	truncateToCodePoints,
	capEntriesByPriority,
} from "@oh-my-pi/browser-protocol";
import { activatePicker, type PickerHandle } from "./picker/overlay";
import {
	activateRegionCapture,
	type RegionHandle,
	type RegionRect,
} from "./picker/region";
import { generateSelector, generateSelectorSegments, isInShadowContext } from "./picker/selectors";

const SENSITIVE_ATTR_NAMES: Record<string, true> = {
	value: true,
	placeholder: true,
	"aria-placeholder": true,
};

const SENSITIVE_INPUT_TYPES: Record<string, true> = { password: true, hidden: true };
const CC_AUTOCOMPLETE_RE = /^cc-/i;
const SECRET_LIKE_VALUE_RE =
	/^(?:[A-Za-z0-9+/]{40,}={0,2}|[0-9a-f]{32,}|[A-F0-9-]{36}|AKIA[0-9A-Z]{16}|(?:sk|pk)[_-][A-Za-z0-9]{20,})$/;

export function redactSensitiveAttributes(
	attributes: Record<string, string>,
	tagName: string,
	inputType?: string,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, val] of Object.entries(attributes)) {
		const lower = key.toLowerCase();
		if (
			lower in SENSITIVE_ATTR_NAMES &&
			(lower !== "value" ||
				tagName === "INPUT" &&
					(inputType === undefined ||
						inputType in SENSITIVE_INPUT_TYPES))
		) {
			out[key] = "[REDACTED]";
			continue;
		}
		if (
			lower === "autocomplete" &&
			CC_AUTOCOMPLETE_RE.test(val)
		) {
			out[key] = "[REDACTED]";
			continue;
		}
		if (SECRET_LIKE_VALUE_RE.test(val)) {
			out[key] = "[REDACTED]";
			continue;
		}
		out[key] = val;
	}
	return out;
}

export function redactOuterHtml(html: string): string {
	let result = html;
	result = result.replace(
		/(<input\b[^>]*?\btype\s*=\s*["']?(?:password|hidden)["']?[^>]*?)\bvalue\s*=\s*["'][^"']*["']/gi,
		"$1value=\"[REDACTED]\"",
	);
	result = result.replace(
		/(<input\b[^>]*?\bautocomplete\s*=\s*["']?)cc-[^"']*["']/gi,
		"$1[REDACTED]\"",
	);
	return result;
}
function capAttributeEntries(
	attrs: Record<string, string>,
	max: number,
): Record<string, string> {
	const keys = Object.keys(attrs);
	if (keys.length <= max) return attrs;
	const result: Record<string, string> = {};
	for (const key of keys.slice(0, max)) {
		result[key] = attrs[key];
	}
	return result;
}
export type { PickerHandle };
export { activateRegionCapture };

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
	consoleEntries?: ConsoleEntry[];
}

const DEFAULT_STYLE_PROPERTIES = [
	"display",
	"position",
	"color",
	"background-color",
	"font-size",
	"font-weight",
];

/**
 * Attribute capture priority. Attributes listed here are kept first when the
 * attribute count exceeds the declared cap; remaining attributes follow in DOM
 * order.
 */
const CAPTURE_ATTRIBUTE_PRIORITY = [
	"id",
	"data-testid",
	"data-test",
	"aria-label",
	"name",
	"type",
	"href",
	"role",
	"class",
] as const;

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
		url: win.location?.href ?? "",
		title: win.document?.title ?? "",
		viewport: {
			width: win.innerWidth ?? 0,
			height: win.innerHeight ?? 0,
			devicePixelRatio: win.devicePixelRatio ?? 1,
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
	const styleProperties = options.styleProperties ?? DEFAULT_STYLE_PROPERTIES;
	if (typeof win.getComputedStyle === "function") {
		const styles = win.getComputedStyle(element);
		for (const property of styleProperties) {
			computedStyles[property] = styles.getPropertyValue(property);
		}
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

	const redactedAttributes = capAttributeEntries(
		redactSensitiveAttributes(
			attributes,
			element.tagName,
			attributes.type,
		),
		BROWSER_FEEDBACK_LIMITS.maxAttributeCount,
	);
	return {
		selector: generateSelector(element),
		tagName: element.tagName,
		...(text ? { text } : {}),
		outerHtml: truncateToCodePoints(redactOuterHtml(element.outerHTML), BROWSER_FEEDBACK_LIMITS.maxOuterHtmlLength),
		attributes: redactedAttributes,
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
	const event: BrowserFeedbackEvent = {
		protocolVersion: BROWSER_PROTOCOL_VERSION,
		eventId: input.eventId ?? crypto.randomUUID(),
		type: "dom.selection",
		channelId: input.channelId,
		createdAt: input.createdAt ?? new Date().toISOString(),
		page: capturePageContext(win),
		element: captureElementContext(input.element, { window: win }),
		...(input.note ? { note: input.note } : {}),
	};
	if (input.consoleEntries && input.consoleEntries.length > 0) {
		event.console = input.consoleEntries;
	}
	return event;
}

export interface PickerCaptureInput {
	channelId: string;
	note?: string;
	stayActive?: boolean;
	window?: Window;
	consoleEntries?: ConsoleEntry[];
}

export interface PickerCaptureCallbacks {
	/** Fired once per committed pick. In stay-active mode this fires repeatedly. */
	onPick: (event: BrowserFeedbackEvent) => void;
	/** Fired once when the picker exits on its own (Escape / single-pick done). */
	onExit: () => void;
}

export function activatePickerAndCapture(
	document: Document,
	input: PickerCaptureInput,
	callbacks: PickerCaptureCallbacks,
): PickerHandle {
	return activatePicker(
		document,
		{
			onSelect(element) {
				const win = input.window ?? window;
				callbacks.onPick(
					buildDomSelectionFeedback({
						channelId: input.channelId,
						element,
						note: input.note,
						window: win,
					}),
				);
			},
			onExit() {
				callbacks.onExit();
			},
		},
		{ stayActive: input.stayActive },
	);
}
export interface RegionCaptureInput {
	channelId: string;
	note?: string;
	window?: Window;
	consoleEntries?: ConsoleEntry[];
}

export function buildPageScreenshotFeedback(input: {
	channelId: string;
	region: RegionRect;
	note?: string;
	eventId?: string;
	createdAt?: string;
	window?: Window;
}): PageScreenshotFeedback {
	const win = input.window ?? window;
	return {
		protocolVersion: BROWSER_PROTOCOL_VERSION,
		eventId: input.eventId ?? crypto.randomUUID(),
		type: "page.screenshot",
		channelId: input.channelId,
		createdAt: input.createdAt ?? new Date().toISOString(),
		page: capturePageContext(win),
		...(input.note ? { note: input.note } : {}),
		screenshot: {
			kind: "crop",
			ref: "pending",
			mimeType: "image/png",
			width: Math.round(input.region.width * (win.devicePixelRatio || 1)),
			height: Math.round(input.region.height * (win.devicePixelRatio || 1)),
		},
	};
}

export function activateRegionCaptureAndCapture(
	document: Document,
	input: RegionCaptureInput,
	callback: (event: PageScreenshotFeedback | null) => void,
): RegionHandle {
	return activateRegionCapture(document, {
		onRegion(region) {
			const win = input.window ?? window;
			callback(
				buildPageScreenshotFeedback({
					channelId: input.channelId,
					region,
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

// ── Fullpage capture utilities ─────────────────────────────────────────────

const FIXED_SELECTOR =
	'style, script, [style*="position: fixed"], [style*="position:fixed"], [style*="position: sticky"], [style*="position:sticky"]';

export interface PageDimensions {
	scrollHeight: number;
	viewportHeight: number;
	devicePixelRatio: number;
	scrollY: number;
}

export function measurePageDimensions(win: Window = window): PageDimensions {
	return {
		scrollHeight: win.document.documentElement.scrollHeight,
		viewportHeight: win.innerHeight,
		devicePixelRatio: win.devicePixelRatio,
		scrollY: win.scrollY,
	};
}

/**
 * Hide position:fixed and position:sticky elements to prevent them from
 * appearing in every frame of a fullpage capture. Returns a list of
 * { element, originalVisibility } pairs for restoration.
 */
export function hideFixedElements(
	doc: Document = document,
): Array<{ element: Element; original: string }> {
	const elements = doc.querySelectorAll<HTMLElement>(FIXED_SELECTOR);
	const saved: Array<{ element: Element; original: string }> = [];

	for (const el of elements) {
		const style = el.ownerDocument.defaultView?.getComputedStyle(el);
		if (!style) continue;
		const pos = style.position;
		if (pos === "fixed" || pos === "sticky") {
			saved.push({ element: el, original: el.style.visibility });
			el.style.visibility = "hidden";
		}
	}

	return saved;
}

export function showFixedElements(
	saved: Array<{ element: Element; original: string }>,
): void {
	for (const { element, original } of saved) {
		(element as HTMLElement).style.visibility = original;
	}
}

export function scrollToPosition(win: Window, y: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	win.scrollTo({ top: y, behavior: "instant" });
	// Brief yield for layout to settle
	win.requestAnimationFrame(() => win.requestAnimationFrame(() => resolve()));
	return promise;
}
