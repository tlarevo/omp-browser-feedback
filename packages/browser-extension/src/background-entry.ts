import type {
	BatchFeedback,
	BrowserFeedbackEvent,
	BrowserSessionRegistration,
	DomSelectionFeedback,
} from "@oh-my-pi/browser-protocol";
import {
	discoverBroker,
	listSessions,
	probeBroker,
	submitFeedback,
} from "./background";
import {
	addItemToBasket,
	type Basket,
	createEmptyBasket,
	removeItemFromBasket,
} from "./basket";
import { captureAndCrop } from "./screenshot";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORTS: number[] = Array.from({ length: 21 }, (_, i) => 4317 + i);

type MessageResponse<T> = { ok: true; data: T } | { ok: false; error: string };

async function setStorage(update: Record<string, unknown>): Promise<void> {
	return new Promise((resolve) => {
		chrome.storage.local.set(update, resolve);
	});
}

function portFromBaseUrl(baseUrl: string): number | undefined {
	try {
		const { port, protocol } = new URL(baseUrl);
		if (port.length > 0) {
			const parsedPort = Number(port);
			return Number.isInteger(parsedPort) ? parsedPort : undefined;
		}
		return protocol === "https:" ? 443 : 80;
	} catch {
		return undefined;
	}
}

async function handleDiscoverBroker(): Promise<
	MessageResponse<{ baseUrl: string; port: number } | null>
> {
	try {
		const stored = await chrome.storage.local.get(["brokerBaseUrl"]);
		const storedBaseUrl =
			typeof stored.brokerBaseUrl === "string"
				? stored.brokerBaseUrl
				: undefined;
		if (storedBaseUrl) {
			const health = await probeBroker(storedBaseUrl);
			const port = portFromBaseUrl(storedBaseUrl);
			if (health && port !== undefined) {
				return { ok: true, data: { baseUrl: storedBaseUrl, port } };
			}
		}

		const broker = await discoverBroker({
			host: DEFAULT_HOST,
			ports: DEFAULT_PORTS,
		});
		return {
			ok: true,
			data: broker ? { baseUrl: broker.baseUrl, port: broker.port } : null,
		};
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

async function handleListSessions(
	baseUrl: string,
	capabilityToken: string,
): Promise<MessageResponse<BrowserSessionRegistration[]>> {
	try {
		const sessions = await listSessions({ baseUrl, capabilityToken });
		return { ok: true, data: sessions };
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

async function handleStartPicker(
	channelId: string,
	note: string | undefined,
	tabId: number,
	multiPick?: boolean,
): Promise<void> {
	await chrome.tabs.sendMessage(tabId, {
		type: "omp:activate-picker",
		channelId,
		note,
		multiPick,
	});
}

async function handleElementSelected(
	event: BrowserFeedbackEvent,
	windowId: number | undefined,
): Promise<MessageResponse<void>> {
	try {
		const stored = await chrome.storage.local.get([
			"brokerBaseUrl",
			"browserCapabilityToken",
		]);
		const baseUrl =
			typeof stored.brokerBaseUrl === "string"
				? stored.brokerBaseUrl
				: undefined;
		const capabilityToken =
			typeof stored.browserCapabilityToken === "string"
				? stored.browserCapabilityToken
				: undefined;
		if (!baseUrl || !capabilityToken) {
			return { ok: false, error: "Browser is not paired" };
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

		await submitFeedback({
			baseUrl,
			capabilityToken,
			event: eventToSubmit,
			screenshot,
		});
		return { ok: true, data: undefined };
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}
function readBasketFromStorage(stored: Record<string, unknown>): Basket {
	const raw = stored.basket;
	if (
		typeof raw === "object" &&
		raw !== null &&
		"items" in raw &&
		Array.isArray(raw.items)
	) {
		return raw as Basket;
	}
	return createEmptyBasket();
}

async function addToBasket(
	event: DomSelectionFeedback,
	note: string,
): Promise<MessageResponse<Basket>> {
	try {
		const stored = await chrome.storage.local.get(["basket"]);
		const basket = readBasketFromStorage(stored);
		const updated = addItemToBasket(basket, event, note);
		await setStorage({ basket: updated });
		return { ok: true, data: updated };
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

async function getBasket(): Promise<MessageResponse<Basket>> {
	try {
		const stored = await chrome.storage.local.get(["basket"]);
		const basket = readBasketFromStorage(stored);
		return { ok: true, data: basket };
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

async function removeFromBasket(
	itemId: string,
): Promise<MessageResponse<Basket>> {
	try {
		const stored = await chrome.storage.local.get(["basket"]);
		const basket = readBasketFromStorage(stored);
		const updated = removeItemFromBasket(basket, itemId);
		await setStorage({ basket: updated });
		return { ok: true, data: updated };
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

async function clearBasket(): Promise<MessageResponse<Basket>> {
	try {
		const updated = createEmptyBasket();
		await setStorage({ basket: updated });
		return { ok: true, data: updated };
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

async function submitBatch(
	windowId: number | undefined,
): Promise<MessageResponse<void>> {
	try {
		const stored = await chrome.storage.local.get([
			"brokerBaseUrl",
			"browserCapabilityToken",
			"basket",
		]);
		const baseUrl =
			typeof stored.brokerBaseUrl === "string"
				? stored.brokerBaseUrl
				: undefined;
		const capabilityToken =
			typeof stored.browserCapabilityToken === "string"
				? stored.browserCapabilityToken
				: undefined;
		const basket = readBasketFromStorage(stored);
		if (!baseUrl || !capabilityToken) {
			return { ok: false, error: "Browser is not paired" };
		}
		if (basket.items.length === 0) {
			return { ok: false, error: "Basket is empty" };
		}

		const items = [...basket.items];
		const screenshots: Array<{ index: number; blob: Blob }> = [];
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (windowId !== undefined) {
				const captured = await captureAndCrop(
					windowId,
					item.event.element.bounds,
					item.event.page.viewport.devicePixelRatio,
				).catch(() => undefined);
				if (captured) {
					screenshots.push({ index: i, blob: captured.blob });
					items[i] = {
						...item,
						event: {
							...item.event,
							screenshot: {
								kind: captured.kind,
								ref: `pending_${i}`,
								mimeType: "image/png",
								width: captured.width,
								height: captured.height,
							},
						},
					};
				}
			}
		}

		const batchEvent: BatchFeedback = {
			protocolVersion: 1,
			eventId: crypto.randomUUID(),
			type: "batch.feedback",
			channelId: items[0].event.channelId,
			createdAt: new Date().toISOString(),
			items: items.map((item) => item.event),
			...(basket.batchNote ? { batchNote: basket.batchNote } : {}),
		};

		if (screenshots.length > 0) {
			const formData = new FormData();
			formData.append("event", JSON.stringify(batchEvent));
			for (const { index, blob } of screenshots) {
				formData.append(`screenshot_${index}`, blob);
			}
			const response = await fetch(`${baseUrl}/api/feedback`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${capabilityToken}`,
				},
				body: formData,
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				let errMsg = `HTTP ${response.status}`;
				if (typeof body === "object" && body !== null && "message" in body) {
					const msg = body.message;
					if (typeof msg === "string") errMsg = msg;
				}
				return { ok: false, error: errMsg };
			}
		} else {
			await submitFeedback({
				baseUrl,
				capabilityToken,
				event: batchEvent as BrowserFeedbackEvent,
			});
		}

		await setStorage({ basket: createEmptyBasket() });
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
			const baseUrl =
				typeof message.baseUrl === "string" ? message.baseUrl : undefined;
			const capabilityToken =
				typeof message.capabilityToken === "string"
					? message.capabilityToken
					: undefined;
			if (!baseUrl || !capabilityToken) {
				sendResponse({
					ok: false,
					error: "Browser capability token is required",
				});
				return false;
			}
			handleListSessions(baseUrl, capabilityToken).then(sendResponse);
			return true;
		}

		if (message.type === "omp:start-picker") {
			const channelId =
				typeof message.channelId === "string" ? message.channelId : undefined;
			const baseUrl =
				typeof message.baseUrl === "string" ? message.baseUrl : undefined;
			const note = typeof message.note === "string" ? message.note : undefined;
			const multiPick = message.multiPick === true;
			if (!channelId || !baseUrl) {
				sendResponse({ ok: false, error: "Missing picker context" });
				return false;
			}
			const tabId = sender.tab?.id ?? -1;
			if (tabId === -1) {
				chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
					const activeTabId = tabs[0]?.id;
					if (!activeTabId) {
						sendResponse({ ok: false, error: "No active tab" });
						return;
					}
					setStorage({ brokerBaseUrl: baseUrl })
						.then(() =>
							handleStartPicker(channelId, note, activeTabId, multiPick),
						)
						.then(() => sendResponse({ ok: true, data: undefined }))
						.catch((error) =>
							sendResponse({ ok: false, error: String(error) }),
						);
				});
				return true;
			}
			setStorage({ brokerBaseUrl: baseUrl })
				.then(() => handleStartPicker(channelId, note, tabId, multiPick))
				.then(() => sendResponse({ ok: true, data: undefined }))
				.catch((error) => sendResponse({ ok: false, error: String(error) }));
			return true;
		}

		if (message.type === "omp:element-selected") {
			const event = message.event;
			if (!event) {
				sendResponse({ ok: false, error: "Missing feedback event" });
				return false;
			}
			const windowId = sender.tab?.windowId;
			handleElementSelected(event as BrowserFeedbackEvent, windowId).then(
				sendResponse,
			);
			return true;
		}
		if (message.type === "omp:add-to-basket") {
			const event = message.event as DomSelectionFeedback | undefined;
			const note = typeof message.note === "string" ? message.note : "";
			if (!event) {
				sendResponse({ ok: false, error: "Missing feedback event" });
				return false;
			}
			addToBasket(event, note).then(sendResponse);
			return true;
		}

		if (message.type === "omp:get-basket") {
			getBasket().then(sendResponse);
			return true;
		}

		if (message.type === "omp:remove-from-basket") {
			const itemId = typeof message.itemId === "string" ? message.itemId : "";
			removeFromBasket(itemId).then(sendResponse);
			return true;
		}

		if (message.type === "omp:clear-basket") {
			clearBasket().then(sendResponse);
			return true;
		}

		if (message.type === "omp:submit-batch") {
			const windowId = sender.tab?.windowId;
			submitBatch(windowId).then(sendResponse);
			return true;
		}

		return false;
	},
);
