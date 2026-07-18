import type { BrowserFeedbackEvent } from "@oh-my-pi/browser-protocol";
import { showAnnotator } from "./annotator/canvas";
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
