import type { BROWSER_PROTOCOL_VERSIONS } from "./version";

/** Every protocol version this build can speak. */
export type BrowserProtocolVersion = (typeof BROWSER_PROTOCOL_VERSIONS)[number];

/** Declared version range for a peer. */
export interface BrowserProtocolVersionRange {
	min: BrowserProtocolVersion;
	max: BrowserProtocolVersion;
}

export type BrowserSessionStatus = "active" | "idle" | "disconnected";

export interface BrowserSessionRegistration {
	protocolVersion: BrowserProtocolVersion;
	sessionId: string;
	channelId: string;
	sessionName: string;
	displayName: string;
	cwd: string;
	projectName?: string;
	gitBranch?: string;
	urlPatterns?: string[];
	status: BrowserSessionStatus;
	lastActiveAt: string;
	processId: number;
}

export interface BrowserViewport {
	width: number;
	height: number;
	devicePixelRatio: number;
}

export interface BrowserPageContext {
	url: string;
	title: string;
	viewport: BrowserViewport;
}

export interface BrowserElementBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface BrowserAccessibilityContext {
	role?: string;
	name?: string;
	description?: string;
}

export interface SelectorSegment {
	selector: string;
	shadowRoot: boolean;
}

export interface BrowserComponentAncestor {
	name: string;
	source?: string;
}

export interface BrowserComponentContext {
	framework: string;
	ancestors: BrowserComponentAncestor[];
}

export interface BrowserElementContext {
	selector: string;
	xpath?: string;
	tagName: string;
	text?: string;
	outerHtml: string;
	attributes: Record<string, string>;
	bounds: BrowserElementBounds;
	computedStyles: Record<string, string>;
	accessibility?: BrowserAccessibilityContext;
	selectorSegments?: SelectorSegment[];
	shadowRoot?: boolean;
	component?: BrowserComponentContext;
}

export interface BrowserScreenshotRef {
	kind: "full-visible-tab" | "crop" | "full-page";
	ref: string;
	mimeType: "image/png" | "image/jpeg";
	width: number;
	height: number;
	downscaled?: boolean;
}
export type ConsoleEntryLevel = "error" | "warn";

export interface ConsoleEntry {
	timestamp: string;
	level: ConsoleEntryLevel;
	message: string;
	stack?: string;
}

export interface DomSelectionFeedback {
	protocolVersion: BrowserProtocolVersion;
	eventId: string;
	type: "dom.selection";
	channelId: string;
	createdAt: string;
	page: BrowserPageContext;
	element: BrowserElementContext;
	note?: string;
	screenshot?: BrowserScreenshotRef;
	console?: ConsoleEntry[];
}
export interface PageScreenshotFeedback {
	protocolVersion: BrowserProtocolVersion;
	eventId: string;
	type: "page.screenshot";
	channelId: string;
	createdAt: string;
	page: BrowserPageContext;
	note?: string;
	screenshot: BrowserScreenshotRef;
	console?: ConsoleEntry[];
}

export interface BatchFeedback {
	protocolVersion: BrowserProtocolVersion;
	eventId: string;
	type: "batch.feedback";
	channelId: string;
	createdAt: string;
	items: DomSelectionFeedback[];
	batchNote?: string;
}

export type BrowserFeedbackEvent =
	| DomSelectionFeedback
	| PageScreenshotFeedback
	| BatchFeedback;

/** v2-only: OMP→broker acknowledgement after feedback injection. */
export interface BrowserFeedbackAck {
	type: "browser.feedback.ack";
	eventId: string;
}

export interface BrowserAck {
	ok: true;
	eventId?: string;
}

export interface BrowserErrorEnvelope {
	ok: false;
	code: string;
	message: string;
}

export type BrowserValidationResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };
