export const BROWSER_FEEDBACK_LIMITS = {
	/** Max user note length, measured in Unicode code points. */
	maxNoteLength: 8_000,
	/** Max DOM-derived element text length, measured in Unicode code points. */
	maxElementTextLength: 4_000,
	/** Max element outer-HTML length, measured in Unicode code points. */
	maxOuterHtmlLength: 20_000,
	/** Max number of captured attribute entries. */
	maxAttributeCount: 80,
	/** Max number of captured computed-style entries. */
	maxComputedStyleCount: 80,
	/** Max screenshot binary size, measured in UTF-8/raw bytes. */
	maxScreenshotBytes: 10 * 1024 * 1024,
	maxConsoleEntries: 20,
	maxConsoleEntryBytes: 8 * 1024,
	maxConsoleSectionBytes: 64 * 1024,
} as const;

export const BATCH_FEEDBACK_LIMITS = {
	maxItems: 20,
} as const;

/** Marker appended to client-truncated DOM-derived fields; counts toward the cap. */
export const BROWSER_FEEDBACK_TRUNCATION_MARKER = "…[truncated]";

/** Length of a string in Unicode code points (not UTF-16 code units). */
export function codePointLength(value: string): number {
	let count = 0;
	for (const _ of value) count += 1;
	return count;
}

/** Byte length of a string when encoded as UTF-8, without relying on TextEncoder. */
export function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x7f) bytes += 1;
		else if (code <= 0x7ff) bytes += 2;
		else if (code <= 0xffff) bytes += 3;
		else bytes += 4;
	}
	return bytes;
}

/**
 * Truncate `value` to at most `maxCodePoints` Unicode code points, appending the
 * truncation marker when content is dropped. The marker counts toward the cap,
 * so the result never exceeds `maxCodePoints` code points.
 */
export function truncateToCodePoints(
	value: string,
	maxCodePoints: number,
): string {
	const points = Array.from(value);
	if (points.length <= maxCodePoints) return value;
	const markerLength = codePointLength(BROWSER_FEEDBACK_TRUNCATION_MARKER);
	const keep = Math.max(0, maxCodePoints - markerLength);
	const marker =
		markerLength <= maxCodePoints
			? BROWSER_FEEDBACK_TRUNCATION_MARKER
			: Array.from(BROWSER_FEEDBACK_TRUNCATION_MARKER)
					.slice(0, maxCodePoints)
					.join("");
	return points.slice(0, keep).join("") + marker;
}

/**
 * Deterministically cap a record to `max` entries. Keys listed in `priority`
 * (in order) are kept first, then remaining keys in their existing insertion
 * order. Insertion order of the result follows the same priority order.
 */
export function capEntriesByPriority(
	entries: Record<string, string>,
	priority: readonly string[],
	max: number,
): Record<string, string> {
	const keys = Object.keys(entries);
	if (keys.length <= max) return entries;
	const prioritySet = new Set(priority);
	const ordered = [
		...priority.filter((key) => key in entries),
		...keys.filter((key) => !prioritySet.has(key)),
	];
	const result: Record<string, string> = {};
	for (const key of ordered.slice(0, max)) {
		result[key] = entries[key] as string;
	}
	return result;
}
