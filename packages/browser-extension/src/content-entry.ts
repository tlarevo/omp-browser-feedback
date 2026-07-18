<<<<<<< HEAD
import type { BrowserFeedbackEvent } from "@oh-my-pi/browser-protocol";

=======
import type {
	BrowserFeedbackEvent,
	DomSelectionFeedback,
} from "@oh-my-pi/browser-protocol";
>>>>>>> tharinduabeydeera/tha-30-extension-batch-feedback-composer-collect-multiple-picks-and
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
<<<<<<< HEAD
let pendingPickerResponse: ((response: unknown) => void) | undefined;
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

function deactivateActivePicker(): boolean {
	if (!activePickerHandle) return false;
	activePickerHandle.deactivate();
	activePickerHandle = undefined;
	if (pendingPickerResponse) {
		pendingPickerResponse({ ok: false, error: "Picker deactivated" });
		pendingPickerResponse = undefined;
	}
	return true;
}
=======
let basketMode = false;
>>>>>>> tharinduabeydeera/tha-30-extension-batch-feedback-composer-collect-multiple-picks-and

chrome.runtime.onMessage.addListener(
	(
		message: { type: string; [key: string]: unknown },
		_sender: chrome.runtime.MessageSender,
		sendResponse: (response: unknown) => void,
	) => {
		if (message.type === "omp:activate-picker") {
<<<<<<< HEAD
			const channelId =
				typeof message.channelId === "string" ? message.channelId : undefined;
			if (!channelId) {
				sendResponse({ ok: false, error: "Missing channel id" });
				return false;
			}
=======
			const { channelId, note, multiPick } = message as {
				channelId: string;
				note?: string;
				multiPick?: boolean;
				type: string;
			};
>>>>>>> tharinduabeydeera/tha-30-extension-batch-feedback-composer-collect-multiple-picks-and

			basketMode = !!multiPick;

			if (activePickerHandle) {
				activePickerHandle.deactivate();
				activePickerHandle = undefined;
			}

<<<<<<< HEAD
			const note = typeof message.note === "string" ? message.note : undefined;

			// Create toolbar
			toolbarState = showToolbar(createToolbarState());
			toolbarHandle = createToolbar(document, {
				onSend(noteText: string) {
					if (!currentPickedEvent) return;

					// Attach note if dom.selection
					let eventToSubmit = currentPickedEvent;
					if (noteText && eventToSubmit.type === "dom.selection") {
						eventToSubmit = { ...eventToSubmit, note: noteText };
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
					if (pendingPickerResponse) {
						pendingPickerResponse({ ok: false, error: "Picker cancelled" });
						pendingPickerResponse = undefined;
					}
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
=======
			activePickerHandle = activatePickerAndCapture(
				document,
				{ channelId, note },
				(event: BrowserFeedbackEvent | null) => {
					if (basketMode) {
						if (event && event.type === "dom.selection") {
							chrome.runtime.sendMessage({
								type: "omp:add-to-basket",
								event: event as DomSelectionFeedback,
								note: note ?? "",
							});
						}
						// Keep picker active for multi-pick mode
						chrome.runtime.sendMessage({ type: "omp:picker-ready" });
						return;
					}
					activePickerHandle = undefined;
					if (!event) {
						sendResponse({ ok: false, error: "Picker cancelled" });
>>>>>>> tharinduabeydeera/tha-30-extension-batch-feedback-composer-collect-multiple-picks-and
						return;
					}
					deactivatePicker();
					if (pendingPickerResponse) {
						pendingPickerResponse({ ok: false, error: "Picker cancelled" });
						pendingPickerResponse = undefined;
					}
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
			pendingPickerResponse = sendResponse;
		activePickerHandle = activatePickerAndCapture(
			document,
			{ channelId, note },
			{
				onPick(event: BrowserFeedbackEvent) {
					activePickerHandle = undefined;
					if (!event) return;

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
					if (pendingPickerResponse) {
						pendingPickerResponse({ ok: true });
						pendingPickerResponse = undefined;
					}
				},
				onExit() {
					activePickerHandle = undefined;
					toolbarState = hideToolbar(toolbarState);
					toolbarHandle?.remove();
					toolbarHandle = undefined;
					if (pendingPickerResponse) {
						pendingPickerResponse({ ok: false, error: "Picker cancelled" });
						pendingPickerResponse = undefined;
					}
				},
			},
		);
			return true;
		}

		if (message.type === "omp:toggle-picker") {
			// Toggle: a live picker turns off; otherwise arm in stay-active mode.
			if (deactivateActivePicker()) {
				sendResponse({ ok: true, active: false });
				return false;
			}
			const channelId =
				typeof message.channelId === "string" ? message.channelId : undefined;
			if (!channelId) {
				sendResponse({ ok: false, error: "Missing channel id" });
				return false;
			}
			const note = typeof message.note === "string" ? message.note : undefined;

			activePickerHandle = activatePickerAndCapture(
				document,
				{ channelId, note, stayActive: true },
				{
					onPick(event) {
						chrome.runtime.sendMessage({ type: "omp:element-selected", event });
					},
					onExit() {
						activePickerHandle = undefined;
					},
				},
			);
			sendResponse({ ok: true, active: true });
			return false;
		}

		return false;
	},
);
