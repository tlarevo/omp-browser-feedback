/**
 * Backward-compatible re-exports.
 *
 * The original single-version schemas are now the v2 schemas, which is the
 * current highest version.  Prefer importing from `./v1` or `./v2` directly
 * in new code.
 */

export {
	v1BrowserFeedbackEventSchema,
	v1DomSelectionFeedbackSchema,
	v1PageScreenshotFeedbackSchema,
	v1SessionRegistrationSchema,
} from "./v1/schemas";
export {
	v2BrowserFeedbackAckSchema,
	v2BrowserFeedbackEventSchema as browserFeedbackEventSchema,
	v2BrowserFeedbackEventSchema,
	v2DomSelectionFeedbackSchema as domSelectionFeedbackSchema,
	v2DomSelectionFeedbackSchema,
	v2PageScreenshotFeedbackSchema as pageScreenshotFeedbackSchema,
	v2PageScreenshotFeedbackSchema,
	v2SessionRegistrationSchema as browserSessionRegistrationSchema,
	v2SessionRegistrationSchema,
	v2SessionStatusSchema as browserSessionStatusSchema,
} from "./v2/schemas";
