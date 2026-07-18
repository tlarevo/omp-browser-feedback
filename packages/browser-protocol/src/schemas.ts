/**
 * Backward-compatible re-exports.
 *
 * The original single-version schemas are now the v2 schemas, which is the
 * current highest version.  Prefer importing from `./v1` or `./v2` directly
 * in new code.
 */

const nonEmptyString = type("string").atLeastLength(1);

export const browserSessionStatusSchema = type(
	"'active' | 'idle' | 'disconnected'",
);

export const browserSessionRegistrationSchema = type({
	"+": "reject",
	protocolVersion: type.enumerated(BROWSER_PROTOCOL_VERSION),
	sessionId: nonEmptyString,
	channelId: nonEmptyString,
	sessionName: nonEmptyString,
	displayName: nonEmptyString,
	cwd: nonEmptyString,
	"projectName?": "string",
	"gitBranch?": "string",
	"urlPatterns?": nonEmptyString.array(),
	status: browserSessionStatusSchema,
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
	kind: "'full-visible-tab' | 'crop' | 'full-page'",
	ref: nonEmptyString,
	mimeType: "'image/png' | 'image/jpeg'",
	width: "number",
	height: "number",
	"downscaled?": "boolean",
});
const consoleEntrySchema = type({
	"+": "reject",
	timestamp: nonEmptyString,
	level: "'error' | 'warn'",
	message: "string",
	"stack?": "string",
});

const consoleSectionSchema = consoleEntrySchema.array();

export const domSelectionFeedbackSchema = type({
	"+": "reject",
	protocolVersion: type.enumerated(BROWSER_PROTOCOL_VERSION),
	eventId: nonEmptyString,
	type: "'dom.selection'",
	channelId: nonEmptyString,
	createdAt: nonEmptyString,
	page: pageSchema,
	element: elementSchema,
	"note?": "string",
	"screenshot?": screenshotSchema,
	"console?": consoleSectionSchema,
});

export const pageScreenshotFeedbackSchema = type({
	"+": "reject",
	protocolVersion: type.enumerated(BROWSER_PROTOCOL_VERSION),
	eventId: nonEmptyString,
	type: "'page.screenshot'",
	channelId: nonEmptyString,
	createdAt: nonEmptyString,
	page: pageSchema,
	"note?": "string",
	screenshot: screenshotSchema,
	"console?": consoleSectionSchema,
});

export const batchFeedbackSchema = type({
	"+": "reject",
	protocolVersion: type.enumerated(BROWSER_PROTOCOL_VERSION),
	eventId: nonEmptyString,
	type: "'batch.feedback'",
	channelId: nonEmptyString,
	createdAt: nonEmptyString,
	items: domSelectionFeedbackSchema.array(),
	"batchNote?": "string",
});

export const browserFeedbackEventSchema = domSelectionFeedbackSchema
	.or(pageScreenshotFeedbackSchema)
	.or(batchFeedbackSchema);
