import type { BrowserFeedbackEvent } from "@oh-my-pi/browser-protocol";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import {
	clearActiveFeedbackSubscription,
	ensureBrokerRunning,
	getInProcessBrokerStatus,
	setActiveFeedbackSubscription,
	stopActiveBroker,
} from "./broker-lifecycle";
import {
	BrowserBrokerClient,
	createBrowserBrokerClientFromDiscovery,
} from "./client";
import { readConfig, writeConfig } from "./config";
import { renderBrowserFeedbackContext } from "./renderer";

type OnFeedbackFn = (event: BrowserFeedbackEvent) => void;

export interface HandleBfCommandDependencies {
	loadClient?: () => Promise<BrowserBrokerClient | undefined>;
	ensureBrokerRunning?: typeof ensureBrokerRunning;
	createClient?: (args: {
		baseUrl: string;
		authToken: string;
	}) => BrowserBrokerClient;
	setActiveFeedbackSubscription?: typeof setActiveFeedbackSubscription;
}

function parseBrokerStartArgs(argsAfterStart: string): {
	port?: number;
	portRange?: string;
} {
	const portMatch = argsAfterStart.match(/--port(?:=|\s+)(\d+)/);
	const rangeMatch = argsAfterStart.match(/--port-range(?:=|\s+)(\d+-\d+)/);
	return {
		port: portMatch ? Number(portMatch[1]) : undefined,
		portRange: rangeMatch ? rangeMatch[1] : undefined,
	};
}

export async function handleBfCommand(
	args: string,
	ctx: ExtensionCommandContext,
	onFeedback: OnFeedbackFn,
	deps: HandleBfCommandDependencies = {},
): Promise<void> {
	const notify = (msg: string) => ctx.ui.notify(msg);
	const trimmed = args.trim();
	const [first = "help", ...rest] = trimmed.split(/\s+/);
	const remainder = rest.join(" ");
	const loadClient = deps.loadClient ?? createBrowserBrokerClientFromDiscovery;
	const ensureBroker = deps.ensureBrokerRunning ?? ensureBrokerRunning;
	const createClient =
		deps.createClient ??
		(({ baseUrl, authToken }) =>
			new BrowserBrokerClient({ baseUrl, authToken }));
	const setSubscription =
		deps.setActiveFeedbackSubscription ?? setActiveFeedbackSubscription;

	async function registerCurrentSession(
		client: BrowserBrokerClient,
		sessionId: string,
		sessionName: string,
	) {
		await client.registerSession({
			sessionId,
			sessionName,
			displayName: sessionName,
			cwd: ctx.cwd,
			status: "active",
			lastActiveAt: new Date().toISOString(),
			processId: process.pid,
		});
		const sub = client.subscribeFeedback(sessionId, onFeedback);
		setSubscription(sub);
	}

	if (first === "broker") {
		const sub = rest[0] ?? "status";
		if (sub === "start") {
			const { port, portRange } = parseBrokerStartArgs(rest.slice(1).join(" "));
			try {
				const result = await ensureBrokerRunning({ port, portRange });
				notify(
					result.reused
						? `Browser broker already running at ${result.baseUrl} (port ${result.port}).`
						: `Browser broker started at ${result.baseUrl} (port ${result.port}).`,
				);
			} catch (err) {
				notify(
					`Failed to start browser broker: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return;
		}
		if (sub === "stop") {
			const stopped = await stopActiveBroker();
			notify(
				stopped
					? "Browser broker stopped."
					: "No in-process browser broker is running.",
			);
			return;
		}
		const inProcess = getInProcessBrokerStatus();
		notify(
			inProcess.running
				? `Browser broker running at ${inProcess.baseUrl} (in-process, port ${inProcess.port}).`
				: "No in-process browser broker running. Use `/bf broker start` to start one.",
		);
		return;
	}

	if (first === "connect") {
		try {
			const result = await ensureBroker();
			const sessionId = ctx.sessionManager.getSessionId();
			const sessionName = ctx.sessionManager.getSessionName() ?? sessionId;
			const client = createClient({
				baseUrl: result.baseUrl,
				authToken: result.authToken,
			});
			await registerCurrentSession(client, sessionId, sessionName);
			notify(
				[
					`Broker: ${result.baseUrl}${result.reused ? " (already running)" : " (started)"}`,
					`Auth token: ${result.authToken}  ← paste into Chrome extension popup`,
					`Session: ${sessionName}`,
				].join("\n"),
			);
		} catch (err) {
			notify(
				`Failed to connect: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return;
	}

	if (first === "disconnect") {
		clearActiveFeedbackSubscription();
		const client = await loadClient();
		if (!client) {
			notify("Browser broker is not connected.");
			return;
		}
		try {
			await client.unregisterSession(ctx.sessionManager.getSessionId());
			notify("Session unregistered from browser broker.");
		} catch (err) {
			notify(
				`Failed to unregister: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return;
	}

	if (first === "status") {
		const inProcess = getInProcessBrokerStatus();
		const client = await loadClient();
		if (!client) {
			notify(
				inProcess.running
					? `Browser broker running at ${inProcess.baseUrl}. Session not registered — run \`/bf connect\`.`
					: "Browser broker is not running. Use `/bf broker start` then `/bf connect`.",
			);
			return;
		}
		try {
			const sessions = await client.listSessions();
			const sessionId = ctx.sessionManager.getSessionId();
			const registered = sessions.some((s) => s.sessionId === sessionId);
			const config = await readConfig();
			notify(
				[
					inProcess.running
						? `Broker: running at ${inProcess.baseUrl} (in-process)`
						: "Broker: external (discovery file)",
					`Session: ${registered ? "registered" : "not registered"} (ID: ${sessionId})`,
					`Active sessions: ${sessions.length}`,
					`Auto-run: ${config.autoRun ? "on" : "off"} (toggle with \`/bf settings auto-run on|off\`)`,
				].join("\n"),
			);
		} catch (err) {
			notify(
				`Broker reachable but status check failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return;
	}

	if (first === "settings") {
		const sub = remainder.trim().toLowerCase();
		if (sub === "auto-run on") {
			await writeConfig({ autoRun: true });
			notify(
				"browser-feedback: auto-run on — feedback will be submitted automatically",
			);
		} else if (sub === "auto-run off") {
			await writeConfig({ autoRun: false });
			notify(
				"browser-feedback: auto-run off — feedback will pre-fill the prompt box",
			);
		} else {
			const config = await readConfig();
			notify(
				[
					`auto-run: ${config.autoRun ? "on" : "off"}`,
					"  /bf settings auto-run on   — submit feedback automatically",
					"  /bf settings auto-run off  — pre-fill prompt box (default)",
				].join("\n"),
			);
		}
		return;
	}

	if (first === "rename") {
		if (!remainder) {
			notify("Usage: /bf rename <name>");
			return;
		}
		const client = await loadClient();
		if (!client) {
			notify("Browser broker is not connected. Use `/bf connect` first.");
			return;
		}
		try {
			await client.updateSession(ctx.sessionManager.getSessionId(), {
				displayName: remainder,
			});
			notify(`Session display name updated to "${remainder}".`);
		} catch (err) {
			notify(
				`Failed to rename session: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return;
	}

	const client = await loadClient();
	if (!client) {
		if (
			first === "latest" ||
			first === "list" ||
			first === "use" ||
			first === "clear" ||
			first === "pair"
		) {
			notify("Browser broker is not connected. Use `/bf connect` first.");
			return;
		}
		notify(
			"Usage: /bf connect | disconnect | status | broker [start|stop|status] | pair [reset] | latest | list | use [id] | clear | rename <name> | settings [auto-run on|off]",
		);
		return;
	}

	const sessionId = ctx.sessionManager.getSessionId();

	if (first === "pair") {
		if (rest[0] === "reset") {
			try {
				const result = await ensureBroker();
				const client = createClient({
					baseUrl: result.baseUrl,
					authToken: result.authToken,
				});
				await client.revokeAllBrowserCapabilities();
				notify("Browser pairing reset. All browsers must pair again.");
			} catch (err) {
				notify(
					`Failed to reset browser pairing: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return;
		}
		try {
			const result = await ensureBroker();
			const sessionName = ctx.sessionManager.getSessionName() ?? sessionId;
			const pairingClient = createClient({
				baseUrl: result.baseUrl,
				authToken: result.authToken,
			});
			await registerCurrentSession(pairingClient, sessionId, sessionName);
			const pair = await pairingClient.openPairingWindow(sessionId);
			notify(
				[
					`Pairing code: ${pair.code}`,
					"Open the browser extension and enter the code before it expires.",
					`Expires: ${pair.expiresAt}`,
				].join("\n"),
			);
		} catch (err) {
			notify(
				`Failed to open pairing window: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return;
	}

	if (first === "latest") {
		const latest = await client.latestFeedback?.(sessionId);
		if (!latest) {
			notify("No browser feedback received for this session.");
			return;
		}
		notify(renderBrowserFeedbackContext(latest.payload));
		return;
	}

	if (first === "list") {
		const events = (await client.listFeedback?.(sessionId)) ?? [];
		if (events.length === 0) {
			notify("No browser feedback received for this session.");
			return;
		}
		notify(
			events.map((e) => `${e.payload.eventId} ${e.payload.type}`).join("\n"),
		);
		return;
	}

	if (first === "clear") {
		const cleared = (await client.clearFeedback?.(sessionId)) ?? 0;
		notify(`Cleared ${cleared} browser feedback event(s).`);
		return;
	}

	if (first === "use") {
		const eventId = rest[0];
		const events = (await client.listFeedback?.(sessionId)) ?? [];
		const selected = eventId
			? events.find((e) => e.payload.eventId === eventId)
			: await client.latestFeedback?.(sessionId);
		if (!selected) {
			notify(
				eventId
					? `Browser feedback event ${eventId} not found.`
					: "No browser feedback received.",
			);
			return;
		}
		notify(renderBrowserFeedbackContext(selected.payload));
		return;
	}

	notify(
		"Usage: /bf connect | disconnect | status | broker [start|stop|status] | pair [reset] | latest | list | use [id] | clear | rename <name> | settings [auto-run on|off]",
	);
}
