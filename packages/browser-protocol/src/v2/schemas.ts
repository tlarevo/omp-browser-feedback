/**
 * Protocol v2 strict schemas.
 *
 * `protocolVersion` is REQUIRED and MUST be `2`.  Unknown fields are
 * rejected ("+" : "reject").  v2 adds the `browser.feedback.ack` message
 * type that v1 does not support.
 */
import { type } from "arktype";

const nonEmptyString = type("string").atLeastLength(1);

export const v2SessionStatusSchema = type("'active' | 'idle' | 'disconnected'");

export const v2SessionRegistrationSchema = type({
	"+": "reject",
	protocolVersion: type.enumerated(2),
	sessionId: nonEmptyString,
	channelId: nonEmptyString,
	sessionName: nonEmptyString,
	displayName: nonEmptyString,
	cwd: nonEmptyString,
	"projectName?": "string",
	"gitBranch?": "string",
	"urlPatterns?": nonEmptyString.array(),
	status: v2SessionStatusSchema,
	lastActiveAt: nonEmptyString,
	processId: "number.integer",
});

const viewportSchema = type({
	"+": "reject",
	width: "number",
	height: "number",
	devicePixelRatio: "number",
});

const pageSchema = type({
	"+": "reject",
	url: nonEmptyString,
	title: "string",
	viewport: viewportSchema,
});

const boundsSchema = type({
	"+": "reject",
	x: "number",
	y: "number",
	width: "number",
	height: "number",
});

const accessibilitySchema = type({
	"+": "reject",
	"role?": "string",
	"name?": "string",
	"description?": "string",
});

const stringRecordSchema = type({ "[string]": "string" });

const elementSchema = type({
	"+": "reject",
	selector: nonEmptyString,
	"xpath?": "string",
	tagName: nonEmptyString,
	"text?": "string",
	outerHtml: "string",
	attributes: stringRecordSchema,
	bounds: boundsSchema,
	computedStyles: stringRecordSchema,
	"accessibility?": accessibilitySchema,
});

const screenshotSchema = type({
	"+": "reject",
	kind: "'full-visible-tab' | 'crop'",
	ref: nonEmptyString,
	mimeType: "'image/png' | 'image/jpeg'",
	width: "number",
	height: "number",
});

export const v2DomSelectionFeedbackSchema = type({
	"+": "reject",
	protocolVersion: type.enumerated(2),
	eventId: nonEmptyString,
	type: "'dom.selection'",
	channelId: nonEmptyString,
	createdAt: nonEmptyString,
	page: pageSchema,
	element: elementSchema,
	"note?": "string",
	"screenshot?": screenshotSchema,
});

export const v2PageScreenshotFeedbackSchema = type({
	"+": "reject",
	protocolVersion: type.enumerated(2),
	eventId: nonEmptyString,
	type: "'page.screenshot'",
	channelId: nonEmptyString,
	createdAt: nonEmptyString,
	page: pageSchema,
	"note?": "string",
	screenshot: screenshotSchema,
});

export const v2BrowserFeedbackEventSchema = v2DomSelectionFeedbackSchema.or(
	v2PageScreenshotFeedbackSchema,
);

/** v2-only: OMP→broker ack message received over WebSocket. */
export const v2BrowserFeedbackAckSchema = type({
	"+": "reject",
	type: "'browser.feedback.ack'",
	eventId: nonEmptyString,
});
