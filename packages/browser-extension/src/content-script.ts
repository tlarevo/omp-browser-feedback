import {
	BROWSER_PROTOCOL_VERSION,
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

	const text = element.textContent?.trim();
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
		computedStyles,
		selectorSegments: generateSelectorSegments(element),
		shadowRoot: isInShadowContext(element),
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
