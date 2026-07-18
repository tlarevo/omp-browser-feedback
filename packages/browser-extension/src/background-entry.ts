import {
	BROWSER_PROTOCOL_VERSION,
	type BrowserFeedbackEvent,
	type BrowserPageContext,
	type BrowserSessionRegistration,
	type DomSelectionFeedback,
	type PageScreenshotFeedback,
} from "@oh-my-pi/browser-protocol";
import {
	discoverBroker,
	listSessions,
	probeBroker,
	submitFeedback,
} from "./background";
import {
	CAPTURE_INTERVAL_MS,
	calculateStitchPlan,
	cancelActiveCapture,
	type FullpageCaptureContext,
	getActiveCapture,
	SETTLE_DELAY_MS,
	setActiveCapture,
	stitchFrames,
} from "./fullpage";
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
// ── Fullpage capture orchestration ─────────────────────────────────────────
async function handleStartFullpageCapture(
	tabId: number,
	windowId: number,
	channelId: string,
	baseUrl: string,
	capabilityToken: string,
	note?: string,
): Promise<MessageResponse<void>> {
	const originalScrollY = 0;
	try {
		// Measure page dimensions
		const dims = await chrome.tabs.sendMessage(tabId, {
			type: "omp:fullpage-measure",
		});
		if (!dims?.ok || !dims.data) {
			return { ok: false, error: "Failed to measure page" };
		}
		const {
			scrollHeight,
			viewportHeight,
			devicePixelRatio: dpr,
			scrollY: originalScrollY,
		} = dims.data;
		const plan = calculateStitchPlan(scrollHeight, viewportHeight);

		if (plan.steps.length === 0) {
			return { ok: false, error: "Nothing to capture" };
		}

		const ctx: FullpageCaptureContext = {
			tabId,
			windowId,
			channelId,
			originalScrollY: scrollY,
			scrollHeight,
			viewportHeight,
			dpr,
			plan,
			frames: [],
			cancelled: false,
		};
		setActiveCapture(ctx);

		// Show initial progress
		await chrome.action.setBadgeText({ text: `0/${plan.steps.length}`, tabId });
		await chrome.action.setBadgeBackgroundColor({ color: "#2196F3", tabId });

		// Hide fixed elements after first frame (frame 0 captures them)
		let fixedHidden = false;

		for (let i = 0; i < plan.steps.length; i++) {
			if (ctx.cancelled) break;

			const step = plan.steps[i];

			// Scroll to position
			await chrome.tabs.sendMessage(tabId, {
				type: "omp:fullpage-scroll-to",
				y: step.y,
			});

			// Settle delay for lazy content
			{
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, SETTLE_DELAY_MS);
				await promise;
			}

			if (ctx.cancelled) break;

			// Hide fixed elements after first frame
			if (i === 1 && !fixedHidden) {
				await chrome.tabs.sendMessage(tabId, {
					type: "omp:fullpage-hide-fixed",
				});
				fixedHidden = true;
			}

			// Capture visible tab
			let dataUrl: string;
			try {
				dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
					format: "png",
				});
			} catch {
				// Rate-limited or other error — skip this frame
				continue;
			}

			const res = await fetch(dataUrl);
			const blob = await res.blob();
			const bitmap = await createImageBitmap(blob);
			ctx.frames.push(bitmap);

			// Update progress badge
			await chrome.action.setBadgeText({
				text: `${i + 1}/${plan.steps.length}`,
				tabId,
			});

			if (i < plan.steps.length - 1) {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, CAPTURE_INTERVAL_MS - SETTLE_DELAY_MS);
				await promise;
			}
		}

		// Restore scroll and fixed elements
		await chrome.tabs.sendMessage(tabId, {
			type: "omp:fullpage-restore",
			y: ctx.originalScrollY,
		});

		// Clear badge
		await chrome.action.setBadgeText({ text: "", tabId });

		if (ctx.cancelled || ctx.frames.length === 0) {
			// Clean up frames
			for (const f of ctx.frames) f.close();
			setActiveCapture(null);
			return ctx.cancelled
				? { ok: false, error: "Capture cancelled" }
				: { ok: false, error: "No frames captured" };
		}

		// Stitch frames
		const result = await stitchFrames(ctx.frames, plan, dpr);
		for (const f of ctx.frames) f.close();
		setActiveCapture(null);

		// Build page context for feedback event
		const pageContext: BrowserPageContext = await chrome.tabs
			.sendMessage(tabId, { type: "omp:fullpage-measure" })
			.then(
				(d) =>
					({
						url: "", // will be filled below
						title: "",
						viewport: {
							width: 0,
							height: d.data.viewportHeight,
							devicePixelRatio: d.data.devicePixelRatio,
						},
					}) as BrowserPageContext,
			);

		// Get actual page URL and title from tab
		const tab = await chrome.tabs.get(tabId);
		pageContext.url = tab.url ?? "";
		pageContext.title = tab.title ?? "";
		pageContext.viewport.width = tab.width ?? 0;

		const eventId = crypto.randomUUID();
		const event: PageScreenshotFeedback = {
			protocolVersion: BROWSER_PROTOCOL_VERSION,
			eventId,
			type: "page.screenshot",
			channelId,
			createdAt: new Date().toISOString(),
			page: pageContext,
			...(note ? { note } : {}),
			screenshot: {
				kind: "full-page",
				ref: "pending",
				mimeType: "image/png",
				width: result.width,
				height: result.height,
				...(result.downscaled ? { downscaled: true } : {}),
			},
		};

		await submitFeedback({
			baseUrl,
			capabilityToken,
			event,
			screenshot: result.blob,
		});

		return { ok: true, data: undefined };
	} catch (error) {
		// Always restore on error
		try {
			await chrome.tabs.sendMessage(tabId, {
				type: "omp:fullpage-restore",
				y: originalScrollY,
			});
		} catch {}
		await chrome.action.setBadgeText({ text: "", tabId });
		for (const f of getActiveCapture()?.frames ?? []) f.close();
		setActiveCapture(null);
		return { ok: false, error: String(error) };
	}
}

async function handleGetCaptureStatus(): Promise<
	MessageResponse<{ capturing: boolean; current: number; total: number } | null>
> {
	const capture = getActiveCapture();
	if (!capture) {
		return { ok: true, data: null };
	}
	return {
		ok: true,
		data: {
			capturing: !capture.cancelled,
			current: capture.frames.length,
			total: capture.plan.steps.length,
		},
	};
}

function handleCancelCapture(): void {
	cancelActiveCapture();
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
			handleElementSelected(event as BrowserFeedbackEvent, windowId).then(
				sendResponse,
			);
			return true;
		}
		if (message.type === "omp:start-fullpage-capture") {
			const channelId =
				typeof message.channelId === "string" ? message.channelId : undefined;
			const baseUrl =
				typeof message.baseUrl === "string" ? message.baseUrl : undefined;
			const capabilityToken =
				typeof message.capabilityToken === "string"
					? message.capabilityToken
					: undefined;
			const note = typeof message.note === "string" ? message.note : undefined;
			if (!channelId || !baseUrl || !capabilityToken) {
				sendResponse({ ok: false, error: "Missing fullpage capture context" });
				return false;
			}
			const tabId = sender.tab?.id ?? -1;
			const windowId = sender.tab?.windowId;
			if (tabId === -1 || !windowId) {
				chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
					const activeTab = tabs[0];
					if (!activeTab?.id || !activeTab.windowId) {
						sendResponse({ ok: false, error: "No active tab" });
						return;
					}
					setStorage({ brokerBaseUrl: baseUrl })
						.then(() =>
							handleStartFullpageCapture(
								activeTab.id!,
								activeTab.windowId!,
								channelId,
								baseUrl,
								capabilityToken,
								note,
							),
						)
						.then(sendResponse)
						.catch((error) =>
							sendResponse({ ok: false, error: String(error) }),
						);
				});
				return true;
			}
			setStorage({ brokerBaseUrl: baseUrl })
				.then(() =>
					handleStartFullpageCapture(
						tabId,
						windowId,
						channelId,
						baseUrl,
						capabilityToken,
						note,
					),
				)
				.then(sendResponse)
				.catch((error) => sendResponse({ ok: false, error: String(error) }));
			return true;
		}

		if (message.type === "omp:get-capture-status") {
			handleGetCaptureStatus().then(sendResponse);
			return true;
		}

		if (message.type === "omp:cancel-fullpage-capture") {
			handleCancelCapture();
			sendResponse({ ok: true });
			return false;
		}

		return false;
	},
);
