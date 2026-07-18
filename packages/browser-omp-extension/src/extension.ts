import type { BrowserFeedbackEvent } from "@oh-my-pi/browser-protocol";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import {
	clearStatusChangeCallback,
	ensureBrokerRunning,
	setActiveFeedbackSubscription,
	setStatusChangeCallback,
	stopActiveBroker,
} from "./broker-lifecycle";
import {
	BrowserBrokerClient,
	type BrowserFeedbackConnectionStatus,
	createBrowserBrokerClientFromDiscovery,
} from "./client";
import { handleBfCommand } from "./commands";
import { readConfig } from "./config";
import { logError, logInfo } from "./logger";
import { formatFeedbackAsPrompt } from "./renderer";

type OnFeedbackFn = (event: BrowserFeedbackEvent) => Promise<void>;

interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

function renderBrowserStatus(status: BrowserFeedbackConnectionStatus): string {
	if (status.state === "connected") {
		try {
			const port = new URL(status.baseUrl).port;
			return `Browser: connected${port ? ` (:${port})` : ""}`;
		} catch {
			return `Browser: connected (${status.baseUrl})`;
		}
	}
	if (status.state === "reconnecting") {
		return "Browser: reconnecting…";
	}
	if (status.state === "connecting") {
		return "Browser: connecting…";
	}
	return "Browser: offline";
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		const byte = bytes[i];
		if (byte === undefined) break;
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

const MAX_IMAGE_DIMENSION = 1568;

export async function downscaleImage(
	bytes: Uint8Array,
	mimeType: string,
): Promise<Uint8Array> {
	const img = new Bun.Image(bytes);
	const meta = await img.metadata();
	const w = meta.width ?? 0;
	const h = meta.height ?? 0;
	if (w <= MAX_IMAGE_DIMENSION && h <= MAX_IMAGE_DIMENSION) return bytes;
	const rw =
		w >= h ? MAX_IMAGE_DIMENSION : Math.round((w * MAX_IMAGE_DIMENSION) / h);
	const rh =
		h > w ? MAX_IMAGE_DIMENSION : Math.round((h * MAX_IMAGE_DIMENSION) / w);
	const resized = img.resize(rw, rh);
	if (mimeType === "image/jpeg")
		return new Uint8Array(await resized.jpeg().bytes());
	return new Uint8Array(await resized.png().bytes());
}

async function fetchScreenshotContent(
	client: BrowserBrokerClient,
	event: BrowserFeedbackEvent,
): Promise<ImageContent | null> {
	if (!("screenshot" in event) || !event.screenshot) return null;
	try {
		const image = await client.fetchScreenshot(event.eventId);
		if (!image) return null;
		let bytes = image.bytes;
		try {
			bytes = await downscaleImage(bytes, image.mimeType);
		} catch {
			// downscale failed; attach original
		}
		return {
			type: "image",
			data: toBase64(bytes),
			mimeType: image.mimeType,
		};
	} catch {
		return null;
	}
}

export default function browserFeedbackExtension(pi: ExtensionAPI): void {
	pi.setLabel("Browser Feedback");

	let _capturedCtx: Pick<ExtensionCommandContext, "ui"> | undefined;
	const _pendingFeedback: string[] = [];
	let _pendingImage: ImageContent | null = null;

	function drainPendingFeedback(): void {
		if (!_capturedCtx || _pendingFeedback.length === 0) return;
		for (const prompt of _pendingFeedback) {
			_capturedCtx.ui.setEditorText(prompt);
		}
		_pendingFeedback.length = 0;
		_capturedCtx.ui.notify(
			"Browser feedback ready — review and press Enter",
			"info",
		);
	}

	function makeOnFeedback(client?: BrowserBrokerClient): OnFeedbackFn {
		return async (event: BrowserFeedbackEvent) => {
			const prompt = formatFeedbackAsPrompt(event);
			const image = client ? await fetchScreenshotContent(client, event) : null;
			const config = await readConfig();
			if (config.autoRun) {
				const content = image
					? [{ type: "text" as const, text: prompt }, image]
					: `${prompt}\n\n[ screenshot unavailable ]`;
				pi.sendUserMessage(content);
			} else if (_capturedCtx && image) {
				// Queue image for the next interactive submission
				_pendingImage = image;
				_capturedCtx.ui.setEditorText(prompt);
				_capturedCtx.ui.notify(
					"Browser feedback ready (with screenshot) — review and press Enter",
					"info",
				);
			} else if (_capturedCtx) {
				_capturedCtx.ui.setEditorText(prompt);
				_capturedCtx.ui.notify(
					"Browser feedback ready — review and press Enter",
					"info",
				);
			} else {
				// Queue until ctx is captured — never auto-send when autoRun is off
				_pendingFeedback.push(prompt);
				logInfo("Feedback queued (TUI not ready yet)");
			}
		};
	}

	pi.on("input", (event) => {
		if (event.source !== "interactive" || !_pendingImage) return;
		const image = _pendingImage;
		_pendingImage = null;
		return { images: [image] };
	});

	pi.on("session_start", async (_event, ctx) => {
		_capturedCtx = ctx.hasUI ? ctx : undefined;
		drainPendingFeedback();
		try {
			const result = await ensureBrokerRunning();
			const sessionId = ctx.sessionManager.getSessionId();
			const sessionName = ctx.sessionManager.getSessionName() ?? sessionId;
			const client = new BrowserBrokerClient({
				baseUrl: result.baseUrl,
				authToken: result.authToken,
			});
			const onFeedback = makeOnFeedback(client);
			const registerWith = async (activeClient: BrowserBrokerClient) => {
				await activeClient.registerSession({
					sessionId,
					sessionName,
					displayName: sessionName,
					cwd: ctx.cwd,
					status: "active",
					lastActiveAt: new Date().toISOString(),
					processId: process.pid,
				});
			};
			const updateStatus = (status: BrowserFeedbackConnectionStatus) => {
				if (ctx.hasUI) {
					ctx.ui.setStatus("browser-feedback", renderBrowserStatus(status));
				}
			};
			setStatusChangeCallback(updateStatus);
			await registerWith(client);
			const sub = client.subscribeFeedback(sessionId, onFeedback, {
				onStateChange: updateStatus,
				reconnect: async () => {
					const rediscovered = await createBrowserBrokerClientFromDiscovery();
					if (!rediscovered) {
						throw new Error("Browser broker discovery unavailable");
					}
					await registerWith(rediscovered);
					return rediscovered.getConnectionInfo();
				},
			});
			setActiveFeedbackSubscription(sub);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			const hint = reason.includes("/bf broker")
				? ""
				: " Try /bf broker start.";
			logError("Broker startup failed:", reason);
			if (ctx.hasUI) {
				ctx.ui.notify(`Browser broker unavailable: ${reason}${hint}`, "error");
			}
		}
	});

	pi.on("session_shutdown", async () => {
		_capturedCtx = undefined;
		_pendingFeedback.length = 0;
		_pendingImage = null;
		clearStatusChangeCallback();
		await stopActiveBroker();
	});

	pi.registerCommand("bf", {
		description: "Manage browser DOM feedback from the Chrome extension",
		getArgumentCompletions: (prefix) => {
			const subs = [
				"connect",
				"disconnect",
				"status",
				"broker",
				"latest",
				"list",
				"use",
				"clear",
				"rename",
				"settings",
			];
			if (!prefix) return subs.map((s) => ({ label: s, value: s }));
			return subs
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ label: s, value: s }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			_capturedCtx = ctx;
			drainPendingFeedback();
			const client = await createBrowserBrokerClientFromDiscovery();
			await handleBfCommand(args, ctx, makeOnFeedback(client ?? undefined), {
				client: client ?? undefined,
				submitFeedback: (text, images) => {
					pi.sendUserMessage(
						images && images.length > 0
							? ([{ type: "text" as const, text }, ...images] as [
									{ type: "text"; text: string },
									...Array<{
										type: "image";
										data: string;
										mimeType: string;
									}>,
								])
							: text,
					);
				},
			});
		},
	});
}
