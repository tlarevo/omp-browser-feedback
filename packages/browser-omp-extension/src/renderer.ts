import type {
	BrowserFeedbackEvent,
	DomSelectionFeedback,
} from "@oh-my-pi/browser-protocol";

export function formatFeedbackAsPrompt(event: BrowserFeedbackEvent): string {
	if (event.type === "dom.selection") {
		const el = event.element;
		const tag = el.tagName.toLowerCase();
		const id = el.attributes.id ? `#${el.attributes.id}` : "";
		const cls = el.attributes.class
			? `.${el.attributes.class.trim().split(/\s+/).slice(0, 2).join(".")}`
			: "";
		const elementRef = `<${tag}${id}${cls}> (${el.selector})`;
		const lines = [
			`Browser feedback from Chrome extension:`,
			`Page: ${event.page.url}`,
			`Element: ${elementRef}`,
		];
		if (event.note) lines.push(`Note: "${event.note}"`);
		lines.push("", "Please apply this change.");
		return lines.join("\n");
	}
	if (event.type === "page.screenshot") {
		const lines = [
			`Browser screenshot feedback from Chrome extension:`,
			`Page: ${event.page.url}`,
		];
		if (event.note) lines.push(`Note: "${event.note}"`);
		lines.push("", "Please review and apply changes.");
		return lines.join("\n");
	}
	return "Browser feedback received from Chrome extension. Please review and apply changes.";
}

const MAX_TEXT = 2_000;
const MAX_HTML = 4_000;

function truncate(value: string | undefined, maxLength: number): string {
	if (!value) return "";
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength)}...`;
}

function renderRecord(record: Record<string, string>): string {
	const entries = Object.entries(record);
	if (entries.length === 0) return "{}";
	return JSON.stringify(Object.fromEntries(entries.slice(0, 40)), null, 2);
}

function renderDomSelection(event: DomSelectionFeedback): string {
	const screenshot = event.screenshot
		? `- Local reference: ${event.screenshot.ref}`
		: "- None";
	const accessibility = event.element.accessibility
		? JSON.stringify(event.element.accessibility, null, 2)
		: "{}";

	return `The user selected a browser element and provided implementation feedback.

Feedback
- Event ID: ${event.eventId}
- Created at: ${event.createdAt}

Page
- URL: ${event.page.url}
- Title: ${event.page.title}
- Viewport: ${event.page.viewport.width}x${event.page.viewport.height}

Selected element
- Selector: ${event.element.selector}
- XPath: ${event.element.xpath ?? ""}
- Tag: ${event.element.tagName}
- Text: ${truncate(event.element.text, MAX_TEXT)}
- Bounds: ${event.element.bounds.x}, ${event.element.bounds.y}, ${event.element.bounds.width}, ${event.element.bounds.height}

HTML
${truncate(event.element.outerHtml, MAX_HTML)}

Relevant computed styles
${renderRecord(event.element.computedStyles)}

Accessibility
${accessibility}

Screenshot
${screenshot}

User note
${truncate(event.note, MAX_TEXT)}

Locate the owning source/component in the current project and address the user's request. Treat selector and HTML data as runtime evidence; verify the source implementation before editing.`;
}

export function renderBrowserFeedbackContext(
	event: BrowserFeedbackEvent,
): string {
	if (event.type === "dom.selection") return renderDomSelection(event);

	return `The user captured a browser screenshot and provided implementation feedback.

Feedback
- Event ID: ${event.eventId}
- Created at: ${event.createdAt}

Page
- URL: ${event.page.url}
- Title: ${event.page.title}
- Viewport: ${event.page.viewport.width}x${event.page.viewport.height}

Screenshot
- Local reference: ${event.screenshot.ref}

User note
${truncate(event.note, MAX_TEXT)}

Locate the owning source/component in the current project and address the user's request. Treat browser payloads as runtime evidence; verify the source implementation before editing.`;
}
