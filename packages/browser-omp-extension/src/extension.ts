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

export default function browserFeedbackExtension(pi: ExtensionAPI): void {
	pi.setLabel("Browser Feedback");

	let _capturedCtx: Pick<ExtensionCommandContext, "ui"> | undefined;
	const _pendingFeedback: string[] = [];

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

	function makeOnFeedback(): OnFeedbackFn {
		return async (event: BrowserFeedbackEvent) => {
			const prompt = formatFeedbackAsPrompt(event);
			const config = await readConfig();
			if (config.autoRun) {
				pi.sendUserMessage(prompt);
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

	pi.on("session_start", async (_event, ctx) => {
		_capturedCtx = ctx.hasUI ? ctx : undefined;
		drainPendingFeedback();
		const onFeedback = makeOnFeedback();
		const updateStatus = (status: BrowserFeedbackConnectionStatus) => {
			if (ctx.hasUI) {
				ctx.ui.setStatus("browser-feedback", renderBrowserStatus(status));
			}
		};
		setStatusChangeCallback(updateStatus);
		try {
			const result = await ensureBrokerRunning();
			const sessionId = ctx.sessionManager.getSessionId();
			const sessionName = ctx.sessionManager.getSessionName() ?? sessionId;
			const registerWith = async (client: BrowserBrokerClient) => {
				await client.registerSession({
					sessionId,
					sessionName,
					displayName: sessionName,
					cwd: ctx.cwd,
					status: "active",
					lastActiveAt: new Date().toISOString(),
					processId: process.pid,
				});
			};
			const client = new BrowserBrokerClient({
				baseUrl: result.baseUrl,
				authToken: result.authToken,
			});
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
			await handleBfCommand(args, ctx, makeOnFeedback());
		},
	});
}
