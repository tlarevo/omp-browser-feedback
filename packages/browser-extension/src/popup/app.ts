import type { BrowserSessionRegistration } from "@oh-my-pi/browser-protocol";
import { listSessions, redeemPairingCode } from "../background";
import {
	type BasketState,
	ensureBrowserInstallId,
	type PopupActionHandlers,
	type PopupState,
	renderPopup,
} from "./main";

interface StoredState {
	browserCapabilityToken?: string;
	browserInstallId?: string;
	selectedSessionId?: string;
}

interface DiscoverBrokerResponse {
	ok: boolean;
	data: { baseUrl: string; port: number } | null;
	error?: string;
}

function readOptionalString(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const candidate = record[key];
	return typeof candidate === "string" ? candidate : undefined;
}

async function readStorage(): Promise<StoredState> {
	return new Promise((resolve) => {
		chrome.storage.local.get(
			["browserCapabilityToken", "browserInstallId", "selectedSessionId"],
			(items) => {
				resolve({
					browserCapabilityToken: readOptionalString(
						items,
						"browserCapabilityToken",
					),
					browserInstallId: readOptionalString(items, "browserInstallId"),
					selectedSessionId: readOptionalString(items, "selectedSessionId"),
				});
			},
		);
	});
}

async function writeStorage(update: Partial<StoredState>): Promise<void> {
	return new Promise((resolve) => {
		chrome.storage.local.set(update, resolve);
	});
}

async function removeStorage(keys: string[]): Promise<void> {
	return new Promise((resolve) => {
		chrome.storage.local.remove(keys, resolve);
	});
}

async function sendToBackground<T>(
	message: Record<string, unknown>,
): Promise<T> {
	return new Promise((resolve, reject) => {
		chrome.runtime.sendMessage(message, (response: T) => {
			if (chrome.runtime.lastError) {
				reject(new Error(chrome.runtime.lastError.message));
				return;
			}
			resolve(response);
		});
	});
}

const DEFAULT_PORTS: number[] = Array.from({ length: 21 }, (_, i) => 4317 + i);

function isUnauthorizedError(errorMessage: string | undefined): boolean {
	return Boolean(
		errorMessage &&
			(errorMessage.includes("401") ||
				errorMessage.toLowerCase().includes("unauthorized")),
	);
}
interface RawBasketItem {
	itemId: string;
	event: {
		element: {
			tagName: string;
			selector: string;
			text?: string;
		};
	};
	note: string;
}

interface RawBasketFromBackground {
	items: RawBasketItem[];
	batchNote: string;
	error?: string;
}

function toBasketState(raw: RawBasketFromBackground): BasketState {
	return {
		items: raw.items.map((item) => ({
			itemId: item.itemId,
			tagName: item.event.element.tagName,
			selector: item.event.element.selector,
			note: item.note,
			text: item.event.element.text,
		})),
		batchNote: raw.batchNote,
		error: raw.error,
	};
}

async function initPopup(): Promise<void> {
	const root = document.getElementById("app");
	if (!(root instanceof HTMLElement)) return;
	const appRoot = root;

	function render(state: PopupState): void {
		renderPopup(appRoot, state, handlers);
	}

	let currentBaseUrl = "";
	let currentCapabilityToken = "";
	let currentSessions: BrowserSessionRegistration[] = [];
	let currentBasket: BasketState | undefined;
	let currentSelectedId: string | undefined;

	function renderReady(): void {
		render({
			kind: "ready",
			baseUrl: currentBaseUrl,
			selectedSessionId: currentSelectedId,
			sessions: currentSessions,
			basket: currentBasket,
		});
	}
	const handlers: PopupActionHandlers = {
		async onPairWithCode(code) {
			const trimmedCode = code.trim();
			if (!currentBaseUrl) {
				await refreshFromBroker();
				return;
			}
			if (trimmedCode.length === 0) {
				render({
					kind: "pairing-error",
					baseUrl: currentBaseUrl,
					message: "Enter the pairing code from /bf pair.",
				});
				return;
			}

			try {
				const browserInstallId = await ensureBrowserInstallId();
				const pairResult = await redeemPairingCode({
					baseUrl: currentBaseUrl,
					browserInstallId,
					code: trimmedCode,
				});
				currentCapabilityToken = pairResult.capabilityToken;
				await writeStorage({
					browserCapabilityToken: pairResult.capabilityToken,
				});
				await refreshFromBroker();
			} catch (error) {
				render({
					kind: "pairing-error",
					baseUrl: currentBaseUrl,
					message:
						error instanceof Error
							? error.message
							: "Pairing failed. Request a new code from /bf pair.",
				});
			}
		},

		async onSelectSession(sessionId) {
			currentSelectedId = sessionId;
			await writeStorage({ selectedSessionId: sessionId });
			renderReady();
		},

		async onStartPicker(sessionId, note) {
			const session = currentSessions.find(
				(item) => item.sessionId === sessionId,
			);
			if (!session) return;
			await sendToBackground({
				type: "omp:start-picker",
				channelId: session.channelId,
				baseUrl: currentBaseUrl,
				...(note ? { note } : {}),
			});
			window.close();
		},

		async onStartMultiPick(sessionId) {
			const session = currentSessions.find(
				(item) => item.sessionId === sessionId,
			);
			if (!session) return;
			await sendToBackground({
				type: "omp:start-picker",
				channelId: session.channelId,
				baseUrl: currentBaseUrl,
				multiPick: true,
			});
			window.close();
		},

		async onSubmitBatch() {
			await sendToBackground({ type: "omp:submit-batch" });
			window.close();
		},

		async onRemoveBasketItem(itemId) {
			await sendToBackground({ type: "omp:remove-from-basket", itemId });
			const basketResult = await sendToBackground<{
				ok: boolean;
				data: RawBasketFromBackground;
			}>({
				type: "omp:get-basket",
			});
			if (basketResult.ok) {
				currentBasket = toBasketState(basketResult.data);
			}
			renderReady();
		},
	};

	async function refreshFromBroker(): Promise<void> {
		const brokerResult = await sendToBackground<DiscoverBrokerResponse>({
			type: "omp:discover-broker",
		});

		if (!brokerResult.ok || !brokerResult.data) {
			render({ kind: "no-broker", attemptedPorts: DEFAULT_PORTS });
			return;
		}

		currentBaseUrl = brokerResult.data.baseUrl;

		const stored = await readStorage();
		currentCapabilityToken = stored.browserCapabilityToken ?? "";
		currentSelectedId = stored.selectedSessionId;

		if (!currentCapabilityToken) {
			render({ kind: "unpaired", baseUrl: currentBaseUrl });
			return;
		}

		try {
			currentSessions = await listSessions({
				baseUrl: currentBaseUrl,
				capabilityToken: currentCapabilityToken,
			});
		} catch (error) {
			const errorMessage = String(error);
			if (isUnauthorizedError(errorMessage)) {
				currentCapabilityToken = "";
				await removeStorage(["browserCapabilityToken"]);
				render({
					kind: "pairing-error",
					baseUrl: currentBaseUrl,
					message:
						"Stored pairing expired. Enter a new pairing code from /bf pair.",
				});
				return;
			}
			render({
				kind: "error",
				message: errorMessage,
			});
			return;
		}

		if (currentSessions.length === 0) {
			render({ kind: "no-sessions", baseUrl: currentBaseUrl });
			return;
		}

		const basketResult = await sendToBackground<{
			ok: boolean;
			data: RawBasketFromBackground;
		}>({
			type: "omp:get-basket",
		});
		if (basketResult.ok) {
			currentBasket = toBasketState(basketResult.data);
		}

		renderReady();
	}

	render({ kind: "no-broker", attemptedPorts: DEFAULT_PORTS });
	await refreshFromBroker();
}

if (typeof document !== "undefined") {
	document.addEventListener("DOMContentLoaded", () => {
		initPopup().catch(console.error);
	});
}
