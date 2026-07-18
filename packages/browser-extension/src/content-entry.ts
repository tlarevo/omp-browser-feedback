import type { BrowserFeedbackEvent } from "@oh-my-pi/browser-protocol";
import { activatePickerAndCapture, type PickerHandle } from "./content-script";
import {
	createToolbar,
	type ToolbarHandle,
	createToolbarState,
	showToolbar,
	hideToolbar,
	setSessions,
	enterNoteEditing,
	confirmNote,
	buildPickedSummary,
	type ToolbarSession,
} from "./toolbar";

let activePickerHandle: PickerHandle | undefined;
let toolbarState = createToolbarState();
let toolbarHandle: ToolbarHandle | undefined;
let currentPickedEvent: BrowserFeedbackEvent | null = null;

function sendToBackground(message: Record<string, unknown>): Promise<unknown> {
	return new Promise((resolve, reject) => {
		chrome.runtime.sendMessage(message, (response: unknown) => {
			if (chrome.runtime.lastError) {
				reject(new Error(chrome.runtime.lastError.message));
				return;
			}
			resolve(response);
		});
	});
}

async function fetchSessions(): Promise<ToolbarSession[]> {
	try {
		const result = (await sendToBackground({ type: "omp:get-sessions" })) as {
			ok: boolean;
			data: {
				sessionId: string;
				channelId: string;
				sessionName: string;
				displayName: string;
				gitBranch?: string;
				status: string;
			}[];
		};
		if (!result.ok) return [];
		return result.data.map((s) => ({
			sessionId: s.sessionId,
			channelId: s.channelId,
			sessionName: s.sessionName,
			displayName: s.displayName,
			gitBranch: s.gitBranch,
			status: s.status as ToolbarSession["status"],
		}));
	} catch {
		return [];
	}
}

function deactivatePicker() {
	if (activePickerHandle) {
		activePickerHandle.deactivate();
		activePickerHandle = undefined;
	}
	toolbarState = hideToolbar(toolbarState);
	toolbarHandle?.remove();
	toolbarHandle = undefined;
	currentPickedEvent = null;
}

chrome.runtime.onMessage.addListener(
	(
		message: { type: string; [key: string]: unknown },
		_sender: chrome.runtime.MessageSender,
		sendResponse: (response: unknown) => void,
	) => {
		if (message.type === "omp:activate-picker") {
			const { channelId } = message as {
				channelId: string;
				type: string;
			};

			// Cancel any existing active picker before starting a new one
			if (activePickerHandle) {
				activePickerHandle.deactivate();
				activePickerHandle = undefined;
			}

			// Create toolbar
			toolbarState = showToolbar(createToolbarState());
			toolbarHandle = createToolbar(document, {
				onSend(note: string) {
					if (!currentPickedEvent) return;

					// Attach note if dom.selection
					let eventToSubmit = currentPickedEvent;
					if (note && eventToSubmit.type === "dom.selection") {
						eventToSubmit = { ...eventToSubmit, note };
					}

					chrome.runtime.sendMessage({
						type: "omp:element-selected",
						event: eventToSubmit,
					});

					currentPickedEvent = null;
					toolbarState = confirmNote(toolbarState);
					toolbarState = hideToolbar(toolbarState);
					toolbarHandle?.remove();
					toolbarHandle = undefined;
				},
				onCancel() {
					deactivatePicker();
				},
				onSessionSelect(sessionId: string) {
					const match = toolbarState.sessions.find(
						(s) => s.sessionId === sessionId,
					);
					if (match) {
						toolbarState = { ...toolbarState, session: match };
						// Persist selection via background
						chrome.storage.local.set({ selectedSessionId: sessionId });
					}
					toolbarHandle?.update(toolbarState);
				},
				onEscape() {
					if (toolbarState.noteEditing) {
						toolbarState = confirmNote(toolbarState);
						toolbarHandle?.update(toolbarState);
						return;
					}
					deactivatePicker();
				},
			});

			// Fetch sessions and select the target
			fetchSessions().then((sessions) => {
				toolbarState = setSessions(toolbarState, sessions);
				const match = sessions.find((s) => s.channelId === channelId);
				if (match) {
					toolbarState = { ...toolbarState, session: match };
				}
				toolbarHandle?.update(toolbarState);
			});

			// Activate picker
			activePickerHandle = activatePickerAndCapture(
				document,
				{ channelId },
				(event: BrowserFeedbackEvent | null) => {
					activePickerHandle = undefined;
					if (!event) {
						toolbarState = hideToolbar(toolbarState);
						toolbarHandle?.remove();
						toolbarHandle = undefined;
						sendResponse({ ok: false, error: "Picker cancelled" });
						return;
					}

					// Store event for toolbar Send
					currentPickedEvent = event;

					// Show post-pick note editing
					const summary =
						event.type === "dom.selection"
							? buildPickedSummary(
									event.element.tagName,
									event.element.selector,
									event.element.text ?? "",
								)
							: "Page screenshot";

					toolbarState = enterNoteEditing(toolbarState, summary);
					toolbarHandle?.update(toolbarState);
					sendResponse({ ok: true });
				},
			);
			return true;
		}
		return false;
	},
);
