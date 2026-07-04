import type { BrowserFeedbackEvent } from "@oh-my-pi/browser-protocol";
import { activatePickerAndCapture, type PickerHandle } from "./content-script";

let activePickerHandle: PickerHandle | undefined;

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

			// Cancel any existing active picker before starting a new one
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
		return false;
	},
);
