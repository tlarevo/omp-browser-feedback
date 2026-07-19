import { describe, expect, test } from "bun:test";
import {
	BROWSER_FEEDBACK_LIMITS,
	BROWSER_FEEDBACK_TRUNCATION_MARKER,
	BROWSER_PROTOCOL_VERSION,
	type BrowserFeedbackEvent,
	type BrowserPageContext,
	capEntriesByPriority,
	checkFeedbackLimits,
	codePointLength,
	truncateToCodePoints,
	utf8ByteLength,
} from "../src";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Repeat `ch` for exactly `n` Unicode code points. */
const repeatCodePoints = (ch: string, n: number) => ch.repeat(n);

/** A 4-byte UTF-8 character (U+1F600 😀) — 1 code point, 4 bytes. */
const EMOJI = "\u{1F600}";

/** A 3-byte UTF-8 character (U+20AC €) — 1 code point, 3 bytes. */
const EURO_SIGN = "\u20AC";

/** Minimal valid page context. */
const PAGE: BrowserPageContext = {
	url: "https://example.com",
	title: "Test",
	viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
};

/** Build a dom.selection event with controlled field sizes. */
function makeEvent(
	overrides: {
		note?: string;
		text?: string;
		outerHtml?: string;
		attributes?: Record<string, string>;
		computedStyles?: Record<string, string>;
	} = {},
): BrowserFeedbackEvent {
	return {
		protocolVersion: BROWSER_PROTOCOL_VERSION,
		eventId: "evt_1",
		type: "dom.selection",
		channelId: "ses_1",
		createdAt: "2026-07-18T00:00:00.000Z",
		page: PAGE,
		element: {
			selector: "div",
			tagName: "DIV",
			outerHtml: overrides.outerHtml ?? "<div>x</div>",
			attributes: overrides.attributes ?? {},
			bounds: { x: 0, y: 0, width: 10, height: 10 },
			computedStyles: overrides.computedStyles ?? {},
			...(overrides.text !== undefined ? { text: overrides.text } : {}),
		},
		...(overrides.note !== undefined ? { note: overrides.note } : {}),
	};
}

// ── codePointLength ────────────────────────────────────────────────────────

describe("codePointLength", () => {
	test("ASCII string length matches string.length", () => {
		expect(codePointLength("hello")).toBe(5);
	});

	test("multibyte characters count as 1 code point each", () => {
		expect(codePointLength(`${EMOJI}${EMOJI}${EMOJI}`)).toBe(3);
	});

	test("empty string", () => {
		expect(codePointLength("")).toBe(0);
	});
});

// ── utf8ByteLength ─────────────────────────────────────────────────────────

describe("utf8ByteLength", () => {
	test("ASCII byte length matches string length", () => {
		expect(utf8ByteLength("hello")).toBe(5);
	});

	test("4-byte emoji counts as 4 bytes", () => {
		expect(utf8ByteLength(EMOJI)).toBe(4);
	});

	test("3-byte euro sign counts as 3 bytes", () => {
		expect(utf8ByteLength(EURO_SIGN)).toBe(3);
	});

	test("mixed content", () => {
		expect(utf8ByteLength(`a${EMOJI}b`)).toBe(6);
	});
});

// ── truncateToCodePoints ───────────────────────────────────────────────────

describe("truncateToCodePoints", () => {
	const marker = BROWSER_FEEDBACK_TRUNCATION_MARKER;
	const markerLen = codePointLength(marker);

	test("returns same string when under limit", () => {
		expect(truncateToCodePoints("short text", 100)).toBe("short text");
	});

	test("returns same string when exactly at limit", () => {
		const input = repeatCodePoints("x", 50);
		expect(truncateToCodePoints(input, 50)).toBe(input);
	});

	test("truncates and appends marker when over limit by 1", () => {
		const input = repeatCodePoints("x", 51);
		const result = truncateToCodePoints(input, 50);
		expect(codePointLength(result)).toBe(50);
		expect(result.endsWith(marker)).toBe(true);
	});

	test("result never exceeds maxCodePoints", () => {
		const result = truncateToCodePoints(repeatCodePoints("x", 1000), 100);
		expect(codePointLength(result)).toBe(100);
	});

	test("marker counts toward the cap", () => {
		const max = markerLen + 1;
		const result = truncateToCodePoints(repeatCodePoints("x", 500), max);
		expect(codePointLength(result)).toBe(max);
		expect(result.endsWith(marker)).toBe(true);
		expect(result.slice(0, result.length - marker.length)).toBe("x");
	});

	test("maxCodePoints smaller than marker length slices the marker", () => {
		const max = markerLen - 1;
		const result = truncateToCodePoints(repeatCodePoints("x", 500), max);
		expect(codePointLength(result)).toBe(max);
		expect(result).toBe(Array.from(marker).slice(0, max).join(""));
	});

	test("multibyte string truncates correctly", () => {
		const input = EMOJI.repeat(20);
		const result = truncateToCodePoints(input, markerLen + 2);
		expect(codePointLength(result)).toBe(markerLen + 2);
		expect(result).toContain(EMOJI);
		expect(result.endsWith(BROWSER_FEEDBACK_TRUNCATION_MARKER)).toBe(true);
	});
});

// ── capEntriesByPriority ───────────────────────────────────────────────────

describe("capEntriesByPriority", () => {
	const priority = ["id", "class", "data-testid", "aria-label"];

	test("returns same object when under max", () => {
		const entries = { id: "a", class: "b" };
		expect(capEntriesByPriority(entries, priority, 10)).toBe(entries);
	});

	test("returns same object when exactly at max", () => {
		const entries = { id: "a", class: "b" };
		expect(capEntriesByPriority(entries, priority, 2)).toBe(entries);
	});

	test("keeps priority keys first when over max", () => {
		const entries = {
			"data-x": "x",
			id: "a",
			class: "b",
			"data-testid": "t",
			"data-y": "y",
		};
		const result = capEntriesByPriority(entries, priority, 3);
		const keys = Object.keys(result);
		expect(keys).toHaveLength(3);
		expect(keys[0]).toBe("id");
		expect(keys[1]).toBe("class");
		expect(keys[2]).toBe("data-testid");
	});

	test("drops non-priority keys when priority fills the cap", () => {
		const entries = {
			id: "a",
			class: "b",
			"data-testid": "t",
			"aria-label": "lbl",
			"data-extra": "x",
		};
		const result = capEntriesByPriority(entries, priority, 4);
		expect(Object.keys(result)).toHaveLength(4);
		expect(result["data-extra"]).toBeUndefined();
	});

	test("preserves insertion order of priority keys in result", () => {
		const entries = {
			class: "b",
			"data-extra": "x",
			id: "a",
			"data-testid": "t",
		};
		const result = capEntriesByPriority(entries, priority, 3);
		expect(Object.keys(result)).toEqual(["id", "class", "data-testid"]);
	});
});

// ── checkFeedbackLimits enforcement ────────────────────────────────────────

describe("checkFeedbackLimits", () => {
	// ── note ──────────────────────────────────────────────────────────────

	test("note at exact maxNoteLength passes", () => {
		const event = makeEvent({
			note: repeatCodePoints("n", BROWSER_FEEDBACK_LIMITS.maxNoteLength),
		});
		expect(checkFeedbackLimits(event)).toHaveLength(0);
	});

	test("note at maxNoteLength+1 is rejected", () => {
		const event = makeEvent({
			note: repeatCodePoints("n", BROWSER_FEEDBACK_LIMITS.maxNoteLength + 1),
		});
		const v = checkFeedbackLimits(event);
		expect(v).toHaveLength(1);
		expect(v[0].code).toBe("note_too_long");
		expect(v[0].actual).toBe(BROWSER_FEEDBACK_LIMITS.maxNoteLength + 1);
	});

	test("emoji note at maxNoteLength passes", () => {
		const event = makeEvent({
			note: EMOJI.repeat(BROWSER_FEEDBACK_LIMITS.maxNoteLength),
		});
		expect(checkFeedbackLimits(event)).toHaveLength(0);
	});

	test("emoji note at maxNoteLength+1 is rejected", () => {
		const event = makeEvent({
			note: EMOJI.repeat(BROWSER_FEEDBACK_LIMITS.maxNoteLength + 1),
		});
		const v = checkFeedbackLimits(event);
		expect(v).toHaveLength(1);
		expect(v[0].code).toBe("note_too_long");
	});

	// ── element.text ──────────────────────────────────────────────────────

	test("text at exact maxElementTextLength passes", () => {
		const event = makeEvent({
			text: repeatCodePoints("t", BROWSER_FEEDBACK_LIMITS.maxElementTextLength),
		});
		expect(checkFeedbackLimits(event)).toHaveLength(0);
	});

	test("text at maxElementTextLength+1 is rejected", () => {
		const event = makeEvent({
			text: repeatCodePoints(
				"t",
				BROWSER_FEEDBACK_LIMITS.maxElementTextLength + 1,
			),
		});
		const v = checkFeedbackLimits(event);
		expect(v).toHaveLength(1);
		expect(v[0].code).toBe("element_text_too_long");
		expect(v[0].actual).toBe(BROWSER_FEEDBACK_LIMITS.maxElementTextLength + 1);
	});

	test("emoji text at maxElementTextLength+1 is rejected", () => {
		const event = makeEvent({
			text: EMOJI.repeat(BROWSER_FEEDBACK_LIMITS.maxElementTextLength + 1),
		});
		const v = checkFeedbackLimits(event);
		expect(v).toHaveLength(1);
		expect(v[0].code).toBe("element_text_too_long");
	});

	// ── element.outerHtml ─────────────────────────────────────────────────

	test("outerHtml at exact maxOuterHtmlLength passes", () => {
		const event = makeEvent({
			outerHtml: repeatCodePoints(
				"<",
				BROWSER_FEEDBACK_LIMITS.maxOuterHtmlLength,
			),
		});
		expect(checkFeedbackLimits(event)).toHaveLength(0);
	});

	test("outerHtml at maxOuterHtmlLength+1 is rejected", () => {
		const event = makeEvent({
			outerHtml: repeatCodePoints(
				"<",
				BROWSER_FEEDBACK_LIMITS.maxOuterHtmlLength + 1,
			),
		});
		const v = checkFeedbackLimits(event);
		expect(v).toHaveLength(1);
		expect(v[0].code).toBe("outer_html_too_long");
		expect(v[0].actual).toBe(BROWSER_FEEDBACK_LIMITS.maxOuterHtmlLength + 1);
	});

	test("emoji outerHtml at maxOuterHtmlLength+1 is rejected", () => {
		const event = makeEvent({
			outerHtml: EMOJI.repeat(BROWSER_FEEDBACK_LIMITS.maxOuterHtmlLength + 1),
		});
		const v = checkFeedbackLimits(event);
		expect(v).toHaveLength(1);
		expect(v[0].code).toBe("outer_html_too_long");
	});

	// ── attributes ────────────────────────────────────────────────────────

	test("attribute count at exact maxAttributeCount passes", () => {
		const attrs: Record<string, string> = {};
		for (let i = 0; i < BROWSER_FEEDBACK_LIMITS.maxAttributeCount; i++)
			attrs[`a${i}`] = "v";
		const event = makeEvent({ attributes: attrs });
		expect(checkFeedbackLimits(event)).toHaveLength(0);
	});

	test("attribute count at maxAttributeCount+1 is rejected", () => {
		const attrs: Record<string, string> = {};
		for (let i = 0; i < BROWSER_FEEDBACK_LIMITS.maxAttributeCount + 1; i++)
			attrs[`a${i}`] = "v";
		const event = makeEvent({ attributes: attrs });
		const v = checkFeedbackLimits(event);
		expect(v).toHaveLength(1);
		expect(v[0].code).toBe("attribute_count_exceeded");
		expect(v[0].actual).toBe(BROWSER_FEEDBACK_LIMITS.maxAttributeCount + 1);
	});

	// ── computedStyles ────────────────────────────────────────────────────

	test("style count at exact maxComputedStyleCount passes", () => {
		const styles: Record<string, string> = {};
		for (let i = 0; i < BROWSER_FEEDBACK_LIMITS.maxComputedStyleCount; i++)
			styles[`p${i}`] = "v";
		const event = makeEvent({ computedStyles: styles });
		expect(checkFeedbackLimits(event)).toHaveLength(0);
	});

	test("style count at maxComputedStyleCount+1 is rejected", () => {
		const styles: Record<string, string> = {};
		for (let i = 0; i < BROWSER_FEEDBACK_LIMITS.maxComputedStyleCount + 1; i++)
			styles[`p${i}`] = "v";
		const event = makeEvent({ computedStyles: styles });
		const v = checkFeedbackLimits(event);
		expect(v).toHaveLength(1);
		expect(v[0].code).toBe("computed_style_count_exceeded");
		expect(v[0].actual).toBe(BROWSER_FEEDBACK_LIMITS.maxComputedStyleCount + 1);
	});

	// ── multiple violations ───────────────────────────────────────────────

	test("multiple fields over limit produce multiple violations", () => {
		const attrs: Record<string, string> = {};
		for (let i = 0; i < BROWSER_FEEDBACK_LIMITS.maxAttributeCount + 1; i++)
			attrs[`a${i}`] = "v";
		const event = makeEvent({
			note: repeatCodePoints("n", BROWSER_FEEDBACK_LIMITS.maxNoteLength + 1),
			outerHtml: repeatCodePoints(
				"<",
				BROWSER_FEEDBACK_LIMITS.maxOuterHtmlLength + 1,
			),
			attributes: attrs,
		});
		const v = checkFeedbackLimits(event);
		const codes = v.map((x) => x.code);
		expect(codes).toContain("note_too_long");
		expect(codes).toContain("outer_html_too_long");
		expect(codes).toContain("attribute_count_exceeded");
	});

	// ── no violations for well-formed event ───────────────────────────────

	test("well-formed event within all limits passes", () => {
		const event = makeEvent({
			note: "Looks good",
			text: "Button text",
			outerHtml: "<button>Click</button>",
			attributes: { id: "btn", class: "primary" },
			computedStyles: { display: "block", color: "red" },
		});
		expect(checkFeedbackLimits(event)).toHaveLength(0);
	});
});
