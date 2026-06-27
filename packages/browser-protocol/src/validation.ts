import { type Type, type } from "arktype";
import { browserFeedbackEventSchema, browserSessionRegistrationSchema } from "./schemas";
import type { BrowserFeedbackEvent, BrowserSessionRegistration, BrowserValidationResult } from "./types";

function validateWithSchema<T>(schema: Type, value: unknown): BrowserValidationResult<T> {
	const parsed = schema(value);
	if (parsed instanceof type.errors) {
		return { ok: false, error: parsed.summary };
	}
	return { ok: true, value: parsed as T };
}

export function validateSessionRegistration(value: unknown): BrowserValidationResult<BrowserSessionRegistration> {
	return validateWithSchema(browserSessionRegistrationSchema, value);
}

export function validateFeedbackEvent(value: unknown): BrowserValidationResult<BrowserFeedbackEvent> {
	return validateWithSchema(browserFeedbackEventSchema, value);
}
