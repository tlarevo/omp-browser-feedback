import { type Type, type } from "arktype";
import { BATCH_FEEDBACK_LIMITS } from "./limits";
import {
	batchFeedbackSchema,
	browserFeedbackEventSchema,
	browserSessionRegistrationSchema,
} from "./schemas";
import type {
	BatchFeedback,
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
	if (batch.items.length > BATCH_FEEDBACK_LIMITS.maxItems) {
		return {
			ok: false,
			error: `Batch exceeds maximum of ${BATCH_FEEDBACK_LIMITS.maxItems} items`,
		};
	}
	return { ok: true, value: batch };
}
