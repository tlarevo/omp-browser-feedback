import type { BrowserFeedbackEvent } from "@oh-my-pi/browser-protocol";
import { getConsoleCapture } from "./console-capture";
import { activatePickerAndCapture, type PickerHandle } from "./content-script";

const capture = getConsoleCapture();

function consentKey(): string {
	return `consoleCapture:${window.location.origin}`;
}

async function isConsented(): Promise<boolean> {
	try {
		const result = await chrome.storage.local.get(consentKey());
		return result[consentKey()] === true;
	} catch {
		return false;
	}
}

// Initialize capture on load if consented
isConsented().then((consented) => {
	if (consented) capture.start();
});

// React to consent changes
chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== "local") return;
	const key = consentKey();
	if (!(key in changes)) return;
	if (changes[key]?.newValue === true) {
		capture.start();
	} else {
		capture.stop();
	}
});

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

			if (activePickerHandle) {
				activePickerHandle.deactivate();
				activePickerHandle = undefined;
			}

			const consoleEntries = capture.active ? capture.drain() : [];

			activePickerHandle = activatePickerAndCapture(
				document,
				{ channelId, note, consoleEntries },
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
