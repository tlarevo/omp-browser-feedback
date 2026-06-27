import type { BROWSER_PROTOCOL_VERSION } from "./version";

export type BrowserProtocolVersion = typeof BROWSER_PROTOCOL_VERSION;

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
}

export interface BrowserScreenshotRef {
	kind: "full-visible-tab" | "crop";
	ref: string;
	mimeType: "image/png" | "image/jpeg";
	width: number;
	height: number;
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
}

export type BrowserFeedbackEvent = DomSelectionFeedback | PageScreenshotFeedback;

export interface BrowserAck {
	ok: true;
	eventId?: string;
}

export interface BrowserErrorEnvelope {
	ok: false;
	code: string;
	message: string;
}

export type BrowserValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };
