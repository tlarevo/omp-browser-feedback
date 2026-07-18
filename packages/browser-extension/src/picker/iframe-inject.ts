/**
 * Same-origin iframe picker injection.
 *
 * Detects same-origin iframes on the page, injects the picker into them,
 * and translates inner-iframe element bounds into top-level viewport
 * coordinates.
 */

/**
 * Find all same-origin iframes in the document. Returns an array of
 * { iframe, rect } where rect is the iframe's bounding box in the
 * top-level viewport.
 */
export function findSameOriginIframes(
	doc: Document,
): Array<{ iframe: HTMLIFrameElement; rect: DOMRect }> {
	const iframes = Array.from(doc.querySelectorAll("iframe"));
	const results: Array<{ iframe: HTMLIFrameElement; rect: DOMRect }> = [];
	for (const iframe of iframes) {
		try {
			// Accessing contentWindow.location.href throws for cross-origin
			const win = iframe.contentWindow;
			if (!win) continue;
			void win.location.href;
			results.push({ iframe, rect: iframe.getBoundingClientRect() });
		} catch {
			// Cross-origin — skip
		}
	}
	return results;
}

/**
 * Translate an element's bounding rect from an iframe's viewport into the
 * parent document's viewport coordinates.
 */
export function translateRectToParent(
	childRect: DOMRect,
	iframeRect: DOMRect,
): DOMRect {
	return new DOMRect(
		childRect.x + iframeRect.x,
		childRect.y + iframeRect.y,
		childRect.width,
		childRect.height,
	);
}

/**
 * Translate an element's bounding rect from a nested iframe all the way up
 * to the top-level viewport.  Walks up through parent iframes, accumulating
 * offsets.
 */
export function translateRectToTopLevel(
	childRect: DOMRect,
	doc: Document,
): DOMRect {
	let accumulatedX = 0;
	let accumulatedY = 0;
	let currentWin: Window | null = doc.defaultView;

	while (currentWin) {
		const frameElement = currentWin.frameElement;
		if (!(frameElement instanceof HTMLIFrameElement)) break;
		const frameRect = frameElement.getBoundingClientRect();
		accumulatedX += frameRect.x;
		accumulatedY += frameRect.y;
		currentWin = frameElement.ownerDocument.defaultView;
	}

	return new DOMRect(
		childRect.x + accumulatedX,
		childRect.y + accumulatedY,
		childRect.width,
		childRect.height,
	);
}
