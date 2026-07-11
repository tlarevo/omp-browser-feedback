import type { BrowserFeedbackEvent } from "@oh-my-pi/browser-protocol";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import {
	ensureBrokerRunning,
	setActiveFeedbackSubscription,
	stopActiveBroker,
} from "./broker-lifecycle";
import {
	BrowserBrokerClient,
	type BrowserFeedbackConnectionStatus,
	createBrowserBrokerClientFromDiscovery,
} from "./client";
import { handleBfCommand } from "./commands";
import { readConfig } from "./config";
import { formatFeedbackAsPrompt } from "./renderer";

type OnFeedbackFn = (event: BrowserFeedbackEvent) => void;

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
				pi.sendUserMessage(prompt);
			}
		};
	}

	pi.on("session_start", async (_event, ctx) => {
		_capturedCtx = ctx;
		const onFeedback = makeOnFeedback();
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
			const updateStatus = (status: BrowserFeedbackConnectionStatus) => {
				if (ctx.hasUI) {
					ctx.ui.setStatus("browser-feedback", renderBrowserStatus(status));
				}
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
		} catch {
			// broker unavailable; user can connect manually with /bf connect
		}
	});

	pi.on("session_shutdown", async () => {
		_capturedCtx = undefined;
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
			await handleBfCommand(args, ctx, makeOnFeedback());
		},
	});
}
