import type {
	BrowserFeedbackEvent,
	DomSelectionFeedback,
} from "@oh-my-pi/browser-protocol";
import { activatePickerAndCapture, type PickerHandle } from "./content-script";

let activePickerHandle: PickerHandle | undefined;
let basketMode = false;

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
