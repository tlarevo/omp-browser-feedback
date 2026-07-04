import type { BrowserSessionRegistration } from "@oh-my-pi/browser-protocol";
import { type PopupActionHandlers, type PopupState, renderPopup } from "./main";

interface StoredState {
	authToken?: string;
	selectedSessionId?: string;
}

async function readStorage(): Promise<StoredState> {
	return new Promise((resolve) => {
		chrome.storage.local.get(["authToken", "selectedSessionId"], (items) => {
			resolve(items as StoredState);
		});
	});
}

async function writeStorage(update: Partial<StoredState>): Promise<void> {
	return new Promise((resolve) => {
		chrome.storage.local.set(update, resolve);
	});
}

async function sendToBackground<T>(
	message: Record<string, unknown>,
): Promise<T> {
	return new Promise((resolve, reject) => {
		chrome.runtime.sendMessage(message, (response: T) => {
			if (chrome.runtime.lastError) {
				reject(new Error(chrome.runtime.lastError.message));
			} else {
				resolve(response);
			}
		});
	});
}

const DEFAULT_PORTS: number[] = Array.from({ length: 21 }, (_, i) => 4317 + i);

async function initPopup(): Promise<void> {
	const root = document.getElementById("app");
	if (!root) return;

	function render(state: PopupState): void {
		renderPopup(root as HTMLElement, state, handlers);
	}

	let currentBaseUrl = "";
	let currentAuthToken = "";
	let currentSessions: BrowserSessionRegistration[] = [];
	let currentSelectedId: string | undefined;

	const handlers: PopupActionHandlers = {
		async onSaveToken(token) {
			await writeStorage({ authToken: token });
			currentAuthToken = token;
			await refreshFromBroker();
		},

		async onSelectSession(sessionId) {
			currentSelectedId = sessionId;
			await writeStorage({ selectedSessionId: sessionId });
			render({
				kind: "ready",
				baseUrl: currentBaseUrl,
				selectedSessionId: currentSelectedId,
				sessions: currentSessions,
			});
		},

		async onStartPicker(sessionId, note) {
			const session = currentSessions.find((s) => s.sessionId === sessionId);
			if (!session) return;
			await sendToBackground({
				type: "omp:start-picker",
				channelId: session.channelId,
				baseUrl: currentBaseUrl,
				authToken: currentAuthToken,
				...(note ? { note } : {}),
			});
			window.close();
		},
	};

	async function refreshFromBroker(): Promise<void> {
		const stored = await readStorage();
		currentAuthToken = stored.authToken ?? "";
		currentSelectedId = stored.selectedSessionId;

		if (!currentAuthToken) {
			render({ kind: "missing-auth", baseUrl: "" });
			return;
		}

		const brokerResult = await sendToBackground<{
			ok: boolean;
			data: { baseUrl: string; port: number } | null;
		}>({ type: "omp:discover-broker" });

		if (!brokerResult.ok || !brokerResult.data) {
			render({ kind: "no-broker", attemptedPorts: DEFAULT_PORTS });
			return;
		}

		currentBaseUrl = brokerResult.data.baseUrl;

		const sessionsResult = await sendToBackground<{
			ok: boolean;
			data?: BrowserSessionRegistration[];
			error?: string;
		}>({
			type: "omp:list-sessions",
			baseUrl: currentBaseUrl,
			authToken: currentAuthToken,
		});

		if (!sessionsResult.ok) {
			if (
				sessionsResult.error?.includes("401") ||
				sessionsResult.error?.includes("unauthorized")
			) {
				render({ kind: "missing-auth", baseUrl: currentBaseUrl });
				return;
			}
			render({
				kind: "error",
				message: sessionsResult.error ?? "Unknown error",
			});
			return;
		}

		currentSessions = sessionsResult.data ?? [];

		if (currentSessions.length === 0) {
			render({ kind: "no-sessions", baseUrl: currentBaseUrl });
			return;
		}

		render({
			kind: "ready",
			baseUrl: currentBaseUrl,
			selectedSessionId: currentSelectedId,
			sessions: currentSessions,
		});
	}

	render({ kind: "no-broker", attemptedPorts: DEFAULT_PORTS });
	await refreshFromBroker();
}

document.addEventListener("DOMContentLoaded", () => {
	initPopup().catch(console.error);
});
