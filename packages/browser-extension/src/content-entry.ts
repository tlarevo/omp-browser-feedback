import { activatePickerAndCapture, type PickerHandle } from "./content-script";

let activePickerHandle: PickerHandle | undefined;
let pendingPickerResponse: ((response: unknown) => void) | undefined;

function deactivateActivePicker(): boolean {
	if (!activePickerHandle) return false;
	activePickerHandle.deactivate();
	activePickerHandle = undefined;
	// Resolve any pending sendResponse from omp:activate-picker so the popup
	// doesn't hang when a programmatic toggle cancels an in-flight pick.
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
			const channelId =
				typeof message.channelId === "string" ? message.channelId : undefined;
			if (!channelId) {
				sendResponse({ ok: false, error: "Missing channel id" });
				return false;
			}
			const note = typeof message.note === "string" ? message.note : undefined;

			// Single-pick popup flow: cancel any existing picker, then arm once.
			deactivateActivePicker();
			let picked = false;
			pendingPickerResponse = sendResponse;
			activePickerHandle = activatePickerAndCapture(
				document,
				{ channelId, note },
				{
					onPick(event) {
						picked = true;
						chrome.runtime.sendMessage({ type: "omp:element-selected", event });
					},
					onExit() {
						activePickerHandle = undefined;
						pendingPickerResponse = undefined;
						sendResponse(
							picked ? { ok: true } : { ok: false, error: "Picker cancelled" },
						);
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
