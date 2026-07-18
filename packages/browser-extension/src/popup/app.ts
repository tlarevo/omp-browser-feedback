import {
	DEFAULT_BROWSER_BROKER_PORT_RANGE,
	parsePortRange,
	portsInRange,
	type BrowserSessionRegistration,
} from "@oh-my-pi/browser-protocol";
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
	basketCount?: number;
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

function readOptionalNumber(value: unknown, key: string): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const candidate = record[key];
	return typeof candidate === "number" ? candidate : undefined;
}

async function readStorage(): Promise<StoredState> {
	return new Promise((resolve) => {
		chrome.storage.local.get(
			[
				"browserCapabilityToken",
				"browserInstallId",
				"selectedSessionId",
				"basketCount",
			],
			(items) => {
				resolve({
					browserCapabilityToken: readOptionalString(
						items,
						"browserCapabilityToken",
					),
					browserInstallId: readOptionalString(items, "browserInstallId"),
					selectedSessionId: readOptionalString(items, "selectedSessionId"),
					basketCount: readOptionalNumber(items, "basketCount"),
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

const DEFAULT_PORTS: number[] = portsInRange(parsePortRange(DEFAULT_BROWSER_BROKER_PORT_RANGE));
async function setBadgeText(text: string): Promise<void> {
	return new Promise((resolve) => {
		chrome.action.setBadgeText({ text }, resolve);
	});
}

async function setBadgeBackgroundColor(color: string): Promise<void> {
	return new Promise((resolve) => {
		chrome.action.setBadgeBackgroundColor({ color }, resolve);
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

	let consumedHint: string | undefined;
	function render(state: PopupState): void {
		renderPopup(appRoot, state, handlers);
		if (consumedHint) {
			const banner = appRoot.ownerDocument.createElement("p");
			banner.textContent = consumedHint;
			banner.style.cssText =
				"margin:0 0 8px;padding:6px 8px;background:#fff3cd;border:1px solid #ffc107;border-radius:4px;font-size:13px;";
			appRoot.prepend(banner);
		}
	}

	let currentBaseUrl = "";
	let currentCapabilityToken = "";
	let currentSessions: BrowserSessionRegistration[] = [];
	let currentBasket: BasketState | undefined;
	let currentSelectedId: string | undefined;
	let currentConsoleCapture = false;
	let currentBasketCount = 0;

	async function syncBadge(): Promise<void> {
		const text = currentBasketCount > 0 ? String(currentBasketCount) : "";
		await setBadgeText(text);
		if (currentBasketCount > 0) {
			await setBadgeBackgroundColor("#ff9800");
		}
	}

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
			render({
				kind: "ready",
				baseUrl: currentBaseUrl,
				selectedSessionId: currentSelectedId,
				sessions: currentSessions,
				consoleCaptureEnabled: currentConsoleCapture,
			});
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
		async onStartFullpageCapture(sessionId) {
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
		async onToggleConsoleCapture(enabled) {
			currentConsoleCapture = enabled;
			// Query active tab for its origin, then set consent
			const tabs = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			});
			const tab = tabs[0];
			if (tab?.url) {
				try {
					const origin = new URL(tab.url).origin;
					await sendToBackground({
						type: "omp:set-console-consent",
						origin,
						enabled,
					});
				} catch {
					// invalid URL, ignore
				}
			}

		async onRefresh() {
			await refreshFromBroker();
		},

		async onForget() {
			await removeStorage(["browserCapabilityToken", "selectedSessionId"]);
			currentCapabilityToken = "";
			currentSelectedId = undefined;
			currentSessions = [];
			render({ kind: "unpaired", baseUrl: currentBaseUrl });
		},
	};
	// If background wrote a pickerHint (e.g. shortcut fired with no session),
	// consume it and clear the key so subsequent opens are clean. The banner
	// is re-prepended on every render() call since renderPopup clears root.
	const hintKey = "pickerHint";
	const hintRaw = await chrome.storage.local.get([hintKey]);
	const hintMessage =
		typeof hintRaw[hintKey] === "string" ? hintRaw[hintKey] : undefined;
	if (hintMessage) {
		await chrome.storage.local.remove([hintKey]);
		consumedHint = hintMessage;
				type: "omp:start-fullpage-capture",
				channelId: session.channelId,
				baseUrl: currentBaseUrl,
				capabilityToken: currentCapabilityToken,
			});
			render({
				kind: "capturing",
				baseUrl: currentBaseUrl,
				selectedSessionId: currentSelectedId,
				sessions: currentSessions,
				current: 0,
				total: 0,
			});
			pollCaptureStatus();
		},

		async onCancelCapture() {
			await sendToBackground({ type: "omp:cancel-fullpage-capture" });
			await refreshFromBroker();
		},
	};
	async function pollCaptureStatus(): Promise<void> {
		const status = await sendToBackground<{
			ok: boolean;
			data: { capturing: boolean; current: number; total: number } | null;
		}>({ type: "omp:get-capture-status" });

		if (!status?.ok || !status.data) {
			await refreshFromBroker();
			return;
		}

		if (!status.data.capturing) {
			await refreshFromBroker();
			return;
		}

		render({
			kind: "capturing",
			baseUrl: currentBaseUrl,
			selectedSessionId: currentSelectedId,
			sessions: currentSessions,
			current: status.data.current,
			total: status.data.total,
		});

		// Poll again in 500ms
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 500);
		await promise;
		pollCaptureStatus();
	}

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
		currentBasketCount = stored.basketCount ?? 0;
		await syncBadge();

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

		render({
			kind: "ready",
			baseUrl: currentBaseUrl,
			selectedSessionId: currentSelectedId,
			sessions: currentSessions,
			consoleCaptureEnabled: currentConsoleCapture,
		});
		if (basketResult.ok) {
			currentBasket = toBasketState(basketResult.data);
		}

		renderReady();
	}

	// Live update: re-render when storage changes (e.g. basketCount updated by background)
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local") return;
		if (changes.basketCount) {
			currentBasketCount = (changes.basketCount.newValue as number) ?? 0;
			syncBadge();
		}
	});

	render({ kind: "loading" });
	await refreshFromBroker();
}

if (typeof document !== "undefined") {
	document.addEventListener("DOMContentLoaded", () => {
		initPopup().catch(console.error);
	});
}
