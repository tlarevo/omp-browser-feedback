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
