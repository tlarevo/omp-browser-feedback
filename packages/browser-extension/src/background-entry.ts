import type {
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
): Promise<void> {
	await chrome.tabs.sendMessage(tabId, {
		type: "omp:activate-picker",
		channelId,
		note,
	});
}

interface AnnotatorImageMessage {
	imageDataUrl: string;
	imageWidth: number;
	imageHeight: number;
	event: BrowserFeedbackEvent;
}

interface AnnotatorConfirmedMessage {
	type: "omp:annotator-confirmed";
	annotatedImageDataUrl: string | null;
	annotations: unknown[];
}

function blobToDataUrl(blob: Blob): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const reader = new FileReader();
	reader.onloadend = () => resolve(reader.result as string);
	reader.onerror = () => reject(reader.error);
	reader.readAsDataURL(blob);
	return promise;
}

function showAnnotatorInTab(
	tabId: number,
	message: AnnotatorImageMessage,
): Promise<{ annotatedBlob: Blob; annotations: unknown[] } | null> {
	const { promise, resolve } = Promise.withResolvers<{
		annotatedBlob: Blob;
		annotations: unknown[];
	} | null>();

	function onAnnotatorConfirmed(response: unknown) {
		chrome.runtime.onMessage.removeListener(onAnnotatorConfirmed);
		const msg = response as AnnotatorConfirmedMessage | undefined;
		if (msg?.type !== "omp:annotator-confirmed") {
			resolve(null);
			return;
		}
		if (!msg.annotatedImageDataUrl) {
			resolve(null);
			return;
		}
		// Convert annotated data URL back to Blob
		fetch(msg.annotatedImageDataUrl)
			.then((r) => r.blob())
			.then((blob) =>
				resolve({ annotatedBlob: blob, annotations: msg.annotations }),
			)
			.catch(() => resolve(null));
	}

	chrome.runtime.onMessage.addListener(onAnnotatorConfirmed);
	chrome.tabs.sendMessage(tabId, { type: "omp:show-annotator", ...message });
	return promise;
}

async function handleElementSelected(
	event: BrowserFeedbackEvent,
	windowId: number | undefined,
	tabId: number,
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

		// Show annotation canvas if we have a screenshot and a target tab
		if (screenshot && tabId >= 0) {
			const dataUrl = await blobToDataUrl(screenshot);
			const width =
				eventToSubmit.type === "dom.selection"
					? (eventToSubmit.screenshot?.width ?? 0)
					: eventToSubmit.screenshot.width;
			const height =
				eventToSubmit.type === "dom.selection"
					? (eventToSubmit.screenshot?.height ?? 0)
					: eventToSubmit.screenshot.height;

			const annotatorResult = await showAnnotatorInTab(tabId, {
				imageDataUrl: dataUrl,
				imageWidth: width,
				imageHeight: height,
				event: eventToSubmit,
			});

			// If user annotated, use the flattened image
			if (annotatorResult) {
				screenshot = annotatorResult.annotatedBlob;
			}
			// If annotatorResult is null, user sent without annotations — use original
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
						.then(() => handleStartPicker(channelId, note, activeTabId))
						.then(() => sendResponse({ ok: true, data: undefined }))
						.catch((error) =>
							sendResponse({ ok: false, error: String(error) }),
						);
				});
				return true;
			}
			setStorage({ brokerBaseUrl: baseUrl })
				.then(() => handleStartPicker(channelId, note, tabId))
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
			const tabId = sender.tab?.id ?? -1;
			handleElementSelected(
				event as BrowserFeedbackEvent,
				windowId,
				tabId,
			).then(sendResponse);
			return true;
		}

		return false;
	},
);
