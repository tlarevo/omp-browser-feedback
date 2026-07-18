import { type Type, type } from "arktype";
import type {
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
