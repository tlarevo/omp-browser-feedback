import { type Type, type } from "arktype";
import { BATCH_FEEDBACK_LIMITS, BROWSER_FEEDBACK_LIMITS, codePointLength } from "./limits";
import {
	batchFeedbackSchema,
	browserFeedbackEventSchema,
	browserSessionRegistrationSchema,
} from "./schemas";
import type {
	BatchFeedback,
	BrowserFeedbackAck,
	BrowserFeedbackEvent,
	BrowserProtocolVersion,
	BrowserSessionRegistration,
	BrowserValidationResult,
} from "./types";
import {
	v1BrowserFeedbackEventSchema,
	v1SessionRegistrationSchema,
} from "./v1/schemas";
import {
	v2BrowserFeedbackAckSchema,
	v2BrowserFeedbackEventSchema,
	v2SessionRegistrationSchema,
} from "./v2/schemas";

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

/** Dispatch to the strict schema for the declared protocol version. */
export function validateSessionRegistration(
	value: unknown,
	version: BrowserProtocolVersion,
): BrowserValidationResult<BrowserSessionRegistration> {
	const schema =
		version === 1 ? v1SessionRegistrationSchema : v2SessionRegistrationSchema;
	return validateWithSchema(schema, value);
}

/** Dispatch to the strict schema for the declared protocol version. */
export function validateFeedbackEvent(
	value: unknown,
	version: BrowserProtocolVersion,
): BrowserValidationResult<BrowserFeedbackEvent> {
	const schema =
		version === 1 ? v1BrowserFeedbackEventSchema : v2BrowserFeedbackEventSchema;
	return validateWithSchema(schema, value);
}

/** v2-only: validate an OMP→broker ack message. */
export function validateFeedbackAck(
	value: unknown,
): BrowserValidationResult<BrowserFeedbackAck> {
	return validateWithSchema(v2BrowserFeedbackAckSchema, value);
}

/**
 * Infer the protocol version from a raw payload without full validation.
 * Returns `undefined` when the field is missing or not a supported integer.
 * Used to select the correct strict schema before full validation.
 */
export function inferProtocolVersion(
	value: unknown,
): BrowserProtocolVersion | undefined {
	if (
		typeof value === "object" &&
		value !== null &&
		"protocolVersion" in value
	) {
		const v = (value as Record<string, unknown>).protocolVersion;
		if (v === 1 || v === 2) return v;
	}
	return undefined;
}

/**
 * Attempt to produce a valid v1 wire form of a feedback event.
 *
 * Rewrites `protocolVersion` to `1` and validates against the strict v1
 * schema.  Returns the validated v1 payload on success — the broker MUST
 * send this object (not the original v2 payload) to v1 OMP subscribers,
 * which would reject a `protocolVersion: 2` object.
 *
 * Returns a validation error when the payload contains v2-only fields or
 * event types that have no valid v1 representation.
 */
export function downgradeToV1(
	event: unknown,
): BrowserValidationResult<BrowserFeedbackEvent> {
	if (typeof event !== "object" || event === null) {
		return { ok: false, error: "Event must be an object" };
	}
	const v1Form = { ...event, protocolVersion: 1 };
	return validateFeedbackEvent(v1Form, 1);
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
	/** Human-readable message. */
	message?: string;
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

	if ("note" in event && event.note !== undefined) {
		const actual = codePointLength(event.note as string);
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

export function validateBatchFeedback(
	value: unknown,
): BrowserValidationResult<BatchFeedback> {
	const schemaResult = validateWithSchema<BatchFeedback>(
		batchFeedbackSchema,
		value,
	);
	if (!schemaResult.ok) return schemaResult;
	const batch = schemaResult.value;
	if (batch.items.length === 0) {
		return { ok: false, error: "Batch must contain at least one item" };
	}
	return { ok: true, value: batch };
}
