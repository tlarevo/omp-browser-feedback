/**
 * Pure toolbar state model — no DOM, no chrome APIs.
 * Separates rendering from business logic for testability.
 */

export type CaptureMode = "element";

export interface ToolbarSession {
	sessionId: string;
	channelId: string;
	sessionName: string;
	displayName: string;
	gitBranch?: string;
	status: "active" | "idle" | "disconnected";
}

export interface ToolbarState {
	/** Current target session. */
	session: ToolbarSession | null;
	/** All available sessions for the switcher. */
	sessions: ToolbarSession[];
	/** Number of elements picked since toolbar opened. */
	pickCount: number;
	/** Whether we're in post-pick note editing mode. */
	noteEditing: boolean;
	/** The text of the note being composed. */
	noteText: string;
	/** Summary of the last picked element (tag + selector + snippet). */
	lastPickedSummary: string | null;
	/** Capture mode (element for MVP; region/full-page in M3). */
	captureMode: CaptureMode;
	/** Whether the toolbar is visible (false = hidden/dismissed). */
	visible: boolean;
}

export function createToolbarState(): ToolbarState {
	return {
		session: null,
		sessions: [],
		pickCount: 0,
		noteEditing: false,
		noteText: "",
		lastPickedSummary: null,
		captureMode: "element",
		visible: false,
	};
}

export function showToolbar(state: ToolbarState): ToolbarState {
	return { ...state, visible: true };
}

export function hideToolbar(state: ToolbarState): ToolbarState {
	return { ...state, visible: false, noteEditing: false, noteText: "", lastPickedSummary: null };
}

export function setSessions(
	state: ToolbarState,
	sessions: ToolbarSession[],
): ToolbarState {
	// Keep selection only if still in the list; otherwise auto-select first
	const session =
		state.session && sessions.some((s) => s.sessionId === state.session!.sessionId)
			? state.session
			: sessions.length > 0
				? sessions[0]
				: null;
	return { ...state, sessions, session };
}

export function selectSession(
	state: ToolbarState,
	sessionId: string,
): ToolbarState {
	const session = state.sessions.find((s) => s.sessionId === sessionId) ?? null;
	return { ...state, session };
}

export function enterNoteEditing(
	state: ToolbarState,
	pickedSummary: string,
): ToolbarState {
	return {
		...state,
		noteEditing: true,
		noteText: "",
		lastPickedSummary: pickedSummary,
		pickCount: state.pickCount + 1,
	};
}

export function updateNoteText(
	state: ToolbarState,
	text: string,
): ToolbarState {
	return { ...state, noteText: text };
}

export function confirmNote(state: ToolbarState): ToolbarState {
	return { ...state, noteEditing: false, noteText: "", lastPickedSummary: null };
}

export function cancelNote(state: ToolbarState): ToolbarState {
	return { ...state, noteEditing: false, noteText: "", lastPickedSummary: null };
}

/** Build a short summary string from a picked element's tag, selector, and text. */
export function buildPickedSummary(
	tag: string,
	selector: string,
	textSnippet: string,
): string {
	const tagLower = tag.toLowerCase();
	const text = textSnippet.length > 40 ? `${textSnippet.slice(0, 37)}…` : textSnippet;
	return `<${tagLower}> ${selector} "${text}"`;
}
