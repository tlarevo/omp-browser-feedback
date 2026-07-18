import { type Type, type } from "arktype";
import { BROWSER_FEEDBACK_LIMITS, codePointLength } from "./limits";
import {
	browserFeedbackEventSchema,
	browserSessionRegistrationSchema,
} from "./schemas";
import type {
	BrowserFeedbackEvent,
	BrowserSessionRegistration,
	BrowserValidationResult,
} from "./types";

function validateWithSchema<T>(
	schema: Type,
	value: unknown,
): BrowserValidationResult<T> {
	const parsed = schema(value);
	if (parsed instanceof type.errors) {
		return { ok: false, error: parsed.summary };
	}
	return { ok: true, value: parsed as T };
}

export function validateSessionRegistration(
	value: unknown,
): BrowserValidationResult<BrowserSessionRegistration> {
	return validateWithSchema(browserSessionRegistrationSchema, value);
}

export function validateFeedbackEvent(
	value: unknown,
): BrowserValidationResult<BrowserFeedbackEvent> {
	return validateWithSchema(browserFeedbackEventSchema, value);
}

export interface BrowserFeedbackLimitViolation {
	/** Limit-specific error code, e.g. "note_too_long". */
	code: string;
	/** Dotted path to the offending field, e.g. "element.outerHtml". */
	path: string;
	/** The declared ceiling for this field. */
	limit: number;
	/** The measured size of the submitted value. */
	actual: number;
	/** Unit the limit and actual are measured in. */
	unit: "codePoints" | "count";
}

/**
 * Validate declared field limits on a feedback event. DOM-derived fields are
 * expected to be client-truncated within their caps; a client that bypasses
 * truncation still fails here so the broker never persists over-limit fields.
 */
export function checkFeedbackLimits(
	event: BrowserFeedbackEvent,
): BrowserFeedbackLimitViolation[] {
	const violations: BrowserFeedbackLimitViolation[] = [];

	if (event.note !== undefined) {
		const actual = codePointLength(event.note);
		if (actual > BROWSER_FEEDBACK_LIMITS.maxNoteLength) {
			violations.push({
				code: "note_too_long",
				path: "note",
				limit: BROWSER_FEEDBACK_LIMITS.maxNoteLength,
				actual,
				unit: "codePoints",
			});
		}
	}

	if (event.type === "dom.selection") {
		const element = event.element;
		if (element.text !== undefined) {
			const actual = codePointLength(element.text);
			if (actual > BROWSER_FEEDBACK_LIMITS.maxElementTextLength) {
				violations.push({
					code: "element_text_too_long",
					path: "element.text",
					limit: BROWSER_FEEDBACK_LIMITS.maxElementTextLength,
					actual,
					unit: "codePoints",
				});
			}
		}

		const outerHtmlLength = codePointLength(element.outerHtml);
		if (outerHtmlLength > BROWSER_FEEDBACK_LIMITS.maxOuterHtmlLength) {
			violations.push({
				code: "outer_html_too_long",
				path: "element.outerHtml",
				limit: BROWSER_FEEDBACK_LIMITS.maxOuterHtmlLength,
				actual: outerHtmlLength,
				unit: "codePoints",
			});
		}

		const attributeCount = Object.keys(element.attributes).length;
		if (attributeCount > BROWSER_FEEDBACK_LIMITS.maxAttributeCount) {
			violations.push({
				code: "attribute_count_exceeded",
				path: "element.attributes",
				limit: BROWSER_FEEDBACK_LIMITS.maxAttributeCount,
				actual: attributeCount,
				unit: "count",
			});
		}

		const styleCount = Object.keys(element.computedStyles).length;
		if (styleCount > BROWSER_FEEDBACK_LIMITS.maxComputedStyleCount) {
			violations.push({
				code: "computed_style_count_exceeded",
				path: "element.computedStyles",
				limit: BROWSER_FEEDBACK_LIMITS.maxComputedStyleCount,
				actual: styleCount,
				unit: "count",
			});
		}
	}

	return violations;
}
