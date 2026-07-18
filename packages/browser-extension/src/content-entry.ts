import type {
	BatchFeedback,
	BrowserFeedbackEvent,
	DomSelectionFeedback,
	PageScreenshotFeedback,
} from "@oh-my-pi/browser-protocol";
import {
	activatePickerAndCapture,
	activateRegionCapture,
	buildPageScreenshotFeedback,
	hideFixedElements,
	measurePageDimensions,
	type PickerHandle,
	scrollToPosition,
	showFixedElements,
} from "./content-script";
import { type RegionHandle } from "./picker/region";
import {
	createToolbar,
	type ToolbarHandle,
	type ToolbarState,
	createToolbarState,
	showToolbar,
	hideToolbar,
	setSessions,
	enterNoteEditing,
	confirmNote,
	buildPickedSummary,
	type ToolbarSession,
} from "./toolbar";
import { showAnnotator } from "./annotator/canvas";

let toolbarState: ToolbarState = createToolbarState();
let fixedElementsSaved: Array<{ element: Element; original: string }> | null = null;

let activePickerHandle: PickerHandle | RegionHandle | undefined;
let pendingPickerResponse: ((response: unknown) => void) | undefined;
let basketMode = false;
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

chrome.runtime.onMessage.addListener(
	(
		message: { type: string; [key: string]: unknown },
		_sender: chrome.runtime.MessageSender,
		sendResponse: (response: unknown) => void,
	) => {
		if (message.type === "omp:activate-picker") {
			const { channelId, note, multiPick } = message as {
				channelId: string;
				note?: string;
				multiPick?: boolean;
				type: string;
			};

			basketMode = !!multiPick;

			if (activePickerHandle) {
				activePickerHandle.deactivate();
				activePickerHandle = undefined;
			}

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

		if (message.type === "omp:activate-region-capture") {
			const { channelId, note } = message as {
				channelId: string;
				note?: string;
				type: string;
			};

			if (activePickerHandle) {
				activePickerHandle.deactivate();
				activePickerHandle = undefined;
			}

			activePickerHandle = activateRegionCapture(document, {
				onRegion(region) {
					activePickerHandle = undefined;
					const event = buildPageScreenshotFeedback({
						channelId,
						region,
						note,
					});
					chrome.runtime.sendMessage({
						type: "omp:region-selected",
						event,
						region,
					});
					sendResponse({ ok: true });
				},
				onCancel() {
					activePickerHandle = undefined;
					sendResponse({ ok: false, error: "Region capture cancelled" });
				},
			});
			return true;
		}

		if (message.type === "omp:fullpage-measure") {
			const dims = measurePageDimensions(window);
			sendResponse({ ok: true, data: dims });
			return false;
		}

		if (message.type === "omp:fullpage-scroll-to") {
			const y = typeof message.y === "number" ? message.y : 0;
			scrollToPosition(window, y).then(() => {
				sendResponse({ ok: true, data: { y } });
			});
			return true;
		}

		if (message.type === "omp:fullpage-hide-fixed") {
			fixedElementsSaved = hideFixedElements(document);
			sendResponse({ ok: true });
			return false;
		}

		if (message.type === "omp:fullpage-restore") {
			const y = typeof message.y === "number" ? message.y : 0;
			scrollToPosition(window, y).then(() => {
				if (fixedElementsSaved) {
					showFixedElements(fixedElementsSaved);
					fixedElementsSaved = null;
				}
				sendResponse({ ok: true });
			});
		}
		if (message.type === "omp:show-annotator") {
			const imageDataUrl = message.imageDataUrl as string;
			const imageWidth = message.imageWidth as number;
			const imageHeight = message.imageHeight as number;
			const _event = message.event as BrowserFeedbackEvent;

			if (!imageDataUrl || !imageWidth || !imageHeight) {
				sendResponse({ ok: false, error: "Missing annotator data" });
				return false;
			}

			showAnnotator(document, { imageDataUrl, imageWidth, imageHeight }).then(
				(result) => {
					if (!result) {
						// User sent without annotations or cancelled
						chrome.runtime.sendMessage({
							type: "omp:annotator-confirmed",
							annotatedImageDataUrl: null,
							annotations: [],
						});
					} else {
						// Convert annotated blob to data URL for message passing
						const reader = new FileReader();
						reader.onloadend = () => {
							chrome.runtime.sendMessage({
								type: "omp:annotator-confirmed",
								annotatedImageDataUrl: reader.result,
								annotations: result.annotations,
							});
						};
						reader.readAsDataURL(result.annotatedBlob);
					}
				},
			);
			sendResponse({ ok: true });
			return true;
		}

		return false;
	},
);
