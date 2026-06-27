import type { BrowserFeedbackEvent, DomSelectionFeedback } from "@oh-my-pi/browser-protocol";
import { discoverBroker, listSessions, submitFeedback } from "./background";
import { captureAndCrop } from "./screenshot";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORTS: number[] = Array.from({ length: 21 }, (_, i) => 4317 + i);

type MessageResponse<T> = { ok: true; data: T } | { ok: false; error: string };

async function handleDiscoverBroker(): Promise<MessageResponse<{ baseUrl: string; port: number } | null>> {
	try {
		const broker = await discoverBroker({ host: DEFAULT_HOST, ports: DEFAULT_PORTS });
		return { ok: true, data: broker ? { baseUrl: broker.baseUrl, port: broker.port } : null };
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

async function handleListSessions(
	baseUrl: string,
	authToken: string,
): Promise<MessageResponse<ReturnType<typeof listSessions> extends Promise<infer T> ? T : never>> {
	try {
		const sessions = await listSessions({ baseUrl, authToken });
		return { ok: true, data: sessions };
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

async function handleStartPicker(channelId: string, note: string | undefined, tabId: number): Promise<void> {
	await chrome.tabs.sendMessage(tabId, { type: "omp:activate-picker", channelId, note });
}

async function handleElementSelected(
	event: BrowserFeedbackEvent,
	windowId: number | undefined,
): Promise<MessageResponse<void>> {
	try {
		const stored = await chrome.storage.local.get(["brokerBaseUrl", "brokerAuthToken"]);
		const baseUrl = stored.brokerBaseUrl as string | undefined;
		const authToken = stored.brokerAuthToken as string | undefined;
		if (!baseUrl || !authToken) {
			return { ok: false, error: "No active broker session stored" };
		}

		let eventToSubmit: BrowserFeedbackEvent = event;
		let screenshot: Blob | undefined;

		if (windowId !== undefined && event.type === "dom.selection") {
			const domEvent = event as DomSelectionFeedback;
			const captured = await captureAndCrop(
				windowId,
				domEvent.element.bounds,
				domEvent.page.viewport.devicePixelRatio,
			).catch(() => undefined);

			if (captured) {
				screenshot = captured.blob;
				eventToSubmit = {
					...domEvent,
					screenshot: {
						kind: captured.kind,
						ref: "pending",
						mimeType: "image/png",
						width: captured.width,
						height: captured.height,
					},
				};
			}
		}

		await submitFeedback({ baseUrl, authToken, event: eventToSubmit, screenshot });
		return { ok: true, data: undefined };
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

chrome.runtime.onMessage.addListener(
	(
		message: { type: string; [key: string]: unknown },
		sender: chrome.runtime.MessageSender,
		sendResponse: (response: unknown) => void,
	) => {
		if (message.type === "omp:discover-broker") {
			handleDiscoverBroker().then(sendResponse);
			return true;
		}

		if (message.type === "omp:list-sessions") {
			const { baseUrl, authToken } = message as { baseUrl: string; authToken: string; type: string };
			handleListSessions(baseUrl, authToken).then(sendResponse);
			return true;
		}

		if (message.type === "omp:start-picker") {
			const { channelId, note, baseUrl, authToken } = message as {
				channelId: string;
				note?: string;
				baseUrl: string;
				authToken: string;
				type: string;
			};
			const tabId = sender.tab?.id ?? -1;
			if (tabId === -1) {
				// Message from popup — get the active tab instead
				chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
					const activeTabId = tabs[0]?.id;
					if (!activeTabId) {
						sendResponse({ ok: false, error: "No active tab" });
						return;
					}
					// Store credentials for when element is selected
					chrome.storage.local.set({ brokerBaseUrl: baseUrl, brokerAuthToken: authToken }, () => {
						handleStartPicker(channelId, note, activeTabId)
							.then(() => sendResponse({ ok: true, data: undefined }))
							.catch(err => sendResponse({ ok: false, error: String(err) }));
					});
				});
				return true;
			}
			handleStartPicker(channelId, note, tabId)
				.then(() => sendResponse({ ok: true, data: undefined }))
				.catch(err => sendResponse({ ok: false, error: String(err) }));
			return true;
		}

		if (message.type === "omp:element-selected") {
			const { event } = message as { event: BrowserFeedbackEvent; type: string };
			const windowId = sender.tab?.windowId;
			handleElementSelected(event, windowId).then(sendResponse);
			return true;
		}

		return false;
	},
);
