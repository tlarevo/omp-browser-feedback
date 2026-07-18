import type {
	BatchFeedback,
	BrowserFeedbackEvent,
	ConsoleEntry,
	DomSelectionFeedback,
} from "@oh-my-pi/browser-protocol";

function renderElementRef(el: DomSelectionFeedback["element"]): string {
	const tag = el.tagName.toLowerCase();
	const id = el.attributes.id ? `#${el.attributes.id}` : "";
	const cls = el.attributes.class
		? `.${el.attributes.class.trim().split(/\s+/).slice(0, 2).join(".")}`
		: "";
	return `<${tag}${id}${cls}> (${el.selector})`;
}

export function formatFeedbackAsPrompt(event: BrowserFeedbackEvent): string {
	if (event.type === "dom.selection") {
		const elementRef = renderElementRef(event.element);
		const lines = [
			`Browser feedback from Chrome extension:`,
			`Page: ${event.page.url}`,
			`Element: ${elementRef}`,
		];
		if (event.element.component) {
			const c = event.element.component;
			const chain = c.ancestors.map((a) => a.name).join(" › ");
			const source = c.ancestors[0]?.source
				? ` — in ${chain} (${c.ancestors[0].source})`
				: ` — in ${chain}`;
			lines.push(`Component: ${c.framework}${source}`);
		}
		if (event.note) lines.push(`Note: "${event.note}"`);
		lines.push("", "Please apply this change.");
		return lines.join("\n");
	}
	if (event.type === "batch.feedback") {
		return formatBatchAsPrompt(event);
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

function formatBatchAsPrompt(batch: BatchFeedback): string {
	const lines: string[] = [
		`Browser batch feedback from Chrome extension (${batch.items.length} items):`,
		``,
	];
	for (let i = 0; i < batch.items.length; i++) {
		const item = batch.items[i];
		const elementRef = renderElementRef(item.element);
		lines.push(`${i + 1}. ${elementRef}`);
		if (item.note) lines.push(`   Note: "${item.note}"`);
	}
	if (batch.batchNote) {
		lines.push(``, `Batch note: "${batch.batchNote}"`);
	}
	lines.push(``, `Please apply all changes.`);
	return lines.join("\n");
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

function renderAccessibility(
	accessibility: DomSelectionFeedback["element"]["accessibility"],
): string {
	if (!accessibility) return "";
	const parts: string[] = [];
	if (accessibility.role) parts.push(accessibility.role);
	if (accessibility.name) parts.push(`"${accessibility.name}"`);
	if (accessibility.description) parts.push(`(${accessibility.description})`);
	if (parts.length === 0) return "";
	return `- Accessible: ${parts.join(" ")}`;
}
function renderConsoleSection(entries: ConsoleEntry[]): string {
	const lines = ["Recent console errors:"];
	for (const entry of entries) {
		const stackLine = entry.stack
			? `\n  ${entry.stack.split("\n").slice(0, 3).join("\n  ")}`
			: "";
		lines.push(`- [${entry.level.toUpperCase()}] ${entry.message}${stackLine}`);
	}
	return lines.join("\n");
}

function renderDomSelection(event: DomSelectionFeedback): string {
	const screenshot = event.screenshot
		? `- Local reference: ${event.screenshot.ref}`
		: "- None";
	const accessibility = event.element.accessibility
		? JSON.stringify(event.element.accessibility, null, 2)
		: "{}";
	const component = event.element.component
		? event.element.component.ancestors
				.map((a) => (a.source ? `${a.name} (${a.source})` : a.name))
				.join(" › ")
		: "";

	const lines = [
		`The user selected a browser element and provided implementation feedback.`,
		"",
		`Feedback`,
		`- Event ID: ${event.eventId}`,
		`- Created at: ${event.createdAt}`,
		"",
		`Page`,
		`- URL: ${event.page.url}`,
		`- Title: ${event.page.title}`,
		`- Viewport: ${event.page.viewport.width}x${event.page.viewport.height}`,
		"",
		`Selected element`,
		`- Selector: ${event.element.selector}`,
		...(event.element.xpath ? [`- XPath: ${event.element.xpath}`] : []),
		`- Tag: ${event.element.tagName}`,
		...(event.element.text ? [`- Text: ${truncate(event.element.text, MAX_TEXT)}`] : []),
		`- Bounds: ${event.element.bounds.x}, ${event.element.bounds.y}, ${event.element.bounds.width}, ${event.element.bounds.height}`,
		"",
		`HTML`,
		truncate(event.element.outerHtml, MAX_HTML),
		"",
		`Relevant computed styles`,
		renderRecord(event.element.computedStyles),
	];
	const consoleBlock =
		event.console && event.console.length > 0
			? `\n\n${renderConsoleSection(event.console)}`
			: "";
	return [
		...lines,
		"",
		`Accessibility`,
		accessibility,
		"",
		`Screenshot`,
		screenshot,
		"",
		`User note`,
		truncate(event.note, MAX_TEXT),
		"",
		`Locate the owning source/component in the current project and address the user's request. Treat selector and HTML data as runtime evidence; verify the source implementation before editing.`,
		consoleBlock,
	].join("\n");
}

export function renderBrowserFeedbackContext(
	event: BrowserFeedbackEvent,
): string {
	if (event.type === "dom.selection") return renderDomSelection(event);

	if (event.type === "batch.feedback") {
		const items = event.items
			.map(
				(item, i) =>
					`${i + 1}. ${renderElementRef(item.element)}${item.note ? ` — "${item.note}"` : ""}`,
			)
			.join("\n");
		const note = event.batchNote ? `\nBatch note: "${event.batchNote}"\n` : "";
		return `The user provided batch browser feedback (${event.items.length} items):

Feedback
- Event ID: ${event.eventId}
- Created at: ${event.createdAt}${note}
Items
${items}

Locate the owning source/components in the current project and address each item. Treat selector and HTML data as runtime evidence; verify each source implementation before editing.`;
	}

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
