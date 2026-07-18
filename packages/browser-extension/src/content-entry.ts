import type { BrowserFeedbackEvent } from "@oh-my-pi/browser-protocol";
import {
	activatePickerAndCapture,
	hideFixedElements,
	measurePageDimensions,
	type PickerHandle,
	scrollToPosition,
	showFixedElements,
} from "./content-script";

let activePickerHandle: PickerHandle | undefined;
let fixedElementsSaved: Array<{ element: Element; original: string }> | null =
	null;

chrome.runtime.onMessage.addListener(
	(
		message: { type: string; [key: string]: unknown },
		_sender: chrome.runtime.MessageSender,
		sendResponse: (response: unknown) => void,
	) => {
		if (message.type === "omp:activate-picker") {
			const { channelId, note } = message as {
				channelId: string;
				note?: string;
				type: string;
			};

			if (activePickerHandle) {
				activePickerHandle.deactivate();
				activePickerHandle = undefined;
			}

			activePickerHandle = activatePickerAndCapture(
				document,
				{ channelId, note },
				(event: BrowserFeedbackEvent | null) => {
					activePickerHandle = undefined;
					if (!event) {
						sendResponse({ ok: false, error: "Picker cancelled" });
						return;
					}
					chrome.runtime.sendMessage({ type: "omp:element-selected", event });
					sendResponse({ ok: true });
				},
			);
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
			return true;
		}

		return false;
	},
);
