/**
 * Protocol v1 strict schemas.
 *
 * These match the pre-WIP v1 contract exactly: `protocolVersion` is REQUIRED
 * and MUST be `1`.  Unknown fields are rejected ("+" : "reject").
 *
 * "Treat a v1 peer as [1,1]" applies to discovery metadata — a v1 broker
 * that doesn't advertise `minProtocolVersion`/`maxProtocolVersion` in its
 * health response is inferred to support only v1.  It does NOT relax the
 * payload contract.
 */
import { type } from "arktype";

const nonEmptyString = type("string").atLeastLength(1);

export const v1SessionStatusSchema = type("'active' | 'idle' | 'disconnected'");

export const v1SessionRegistrationSchema = type({
	"+": "reject",
	protocolVersion: type.enumerated(1),
	sessionId: nonEmptyString,
	channelId: nonEmptyString,
	sessionName: nonEmptyString,
	displayName: nonEmptyString,
	cwd: nonEmptyString,
	"projectName?": "string",
	"gitBranch?": "string",
	"urlPatterns?": nonEmptyString.array(),
	status: v1SessionStatusSchema,
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

export const v1DomSelectionFeedbackSchema = type({
	"+": "reject",
	protocolVersion: type.enumerated(1),
	eventId: nonEmptyString,
	type: "'dom.selection'",
	channelId: nonEmptyString,
	createdAt: nonEmptyString,
	page: pageSchema,
	element: elementSchema,
	"note?": "string",
	"screenshot?": screenshotSchema,
});

export const v1PageScreenshotFeedbackSchema = type({
	"+": "reject",
	protocolVersion: type.enumerated(1),
	eventId: nonEmptyString,
	type: "'page.screenshot'",
	channelId: nonEmptyString,
	createdAt: nonEmptyString,
	page: pageSchema,
	"note?": "string",
	screenshot: screenshotSchema,
});

export const v1BrowserFeedbackEventSchema = v1DomSelectionFeedbackSchema.or(
	v1PageScreenshotFeedbackSchema,
);
