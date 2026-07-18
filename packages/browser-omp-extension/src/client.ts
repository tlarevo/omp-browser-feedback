import {
	defaultDiscoveryPath,
	discoverCompatibleBroker,
	readDiscoveryFile,
} from "@oh-my-pi/browser-broker";
import {
	BROWSER_PROTOCOL_VERSION,
	type BrowserFeedbackEvent,
	type BrowserSessionRegistration,
} from "@oh-my-pi/browser-protocol";
import { logWarn } from "./logger";

export type BrowserBrokerFetch = (
	url: string | URL,
	init?: RequestInit,
) => Promise<Response>;

export interface BrowserBrokerClientOptions {
	baseUrl: string;
	authToken: string;
	discoveryPath?: string;
	fetch?: BrowserBrokerFetch;
}

export interface BrowserBrokerSessionInput {
	sessionId: string;
	sessionName: string;
	displayName: string;
	cwd: string;
	projectName?: string;
	gitBranch?: string;
	urlPatterns?: string[];
	status: BrowserSessionRegistration["status"];
	lastActiveAt: string;
	processId: number;
}

export interface BrowserPairingWindow {
	pairingId: string;
	code: string;
	expiresAt: string;
}

export interface BrowserBrokerConnectionInfo {
	baseUrl: string;
	authToken: string;
}

export interface BrowserFeedbackConnectionStatus {
	state: "connecting" | "connected" | "reconnecting" | "closed";
	reconnectAttempts: number;
	baseUrl: string;
	malformedMessages: number;
}

type BrowserBrokerTimeoutHandle = ReturnType<typeof globalThis.setTimeout>;

type BrowserBrokerTimerFn = (
	callback: () => void | Promise<void>,
	delay: number,
) => BrowserBrokerTimeoutHandle;

interface BrowserBrokerSocket {
	close(): void;
	onclose: (() => void) | null;
	onerror: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onopen: (() => void) | null;
}

type BrowserBrokerSocketFactory = (url: string) => BrowserBrokerSocket;

export interface BrowserFeedbackSubscriptionOptions {
	createWebSocket?: BrowserBrokerSocketFactory;
	reconnect?: () => Promise<BrowserBrokerConnectionInfo>;
	onStateChange?: (status: BrowserFeedbackConnectionStatus) => void;
	setTimeout?: BrowserBrokerTimerFn;
	clearTimeout?: (handle: BrowserBrokerTimeoutHandle) => void;
	/** Injected for deterministic jitter testing; defaults to Math.random. */
	random?: () => number;
}

const MAX_DEDUPED_EVENT_IDS = 1000;

export class BrowserBrokerClient {
	#baseUrl: string;
	#authToken: string;
	readonly #discoveryPath: string;
	readonly #fetch: BrowserBrokerFetch;

	constructor(options: BrowserBrokerClientOptions) {
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#authToken = options.authToken;
		this.#discoveryPath = options.discoveryPath ?? defaultDiscoveryPath();
		this.#fetch = options.fetch ?? fetch;
	}

	getConnectionInfo(): BrowserBrokerConnectionInfo {
		return {
			baseUrl: this.#baseUrl,
			authToken: this.#authToken,
		};
	}

	async registerSession(input: BrowserBrokerSessionInput): Promise<void> {
		const registration: BrowserSessionRegistration = {
			protocolVersion: BROWSER_PROTOCOL_VERSION,
			sessionId: input.sessionId,
			channelId: input.sessionId,
			sessionName: input.sessionName,
			displayName: input.displayName,
			cwd: input.cwd,
			...(input.projectName ? { projectName: input.projectName } : {}),
			...(input.gitBranch ? { gitBranch: input.gitBranch } : {}),
			...(input.urlPatterns ? { urlPatterns: input.urlPatterns } : {}),
			status: input.status,
			lastActiveAt: input.lastActiveAt,
			processId: input.processId,
		};

		const response = await this.#fetch(
			`${this.#baseUrl}/api/sessions/register`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.#authToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(registration),
			},
		);
		if (!response.ok) {
			throw new Error(
				`Browser broker registration failed with HTTP ${response.status}`,
			);
		}
	}

	async listFeedback(
		sessionId: string,
	): Promise<Array<{ payload: BrowserFeedbackEvent }>> {
		const response = await this.#fetch(
			`${this.#baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/feedback`,
			{
				headers: { Authorization: `Bearer ${this.#authToken}` },
			},
		);
		if (!response.ok)
			throw new Error(
				`Browser feedback list failed with HTTP ${response.status}`,
			);
		const body = (await response.json()) as {
			feedback?: Array<{ payload: BrowserFeedbackEvent }>;
		};
		return body.feedback ?? [];
	}

	async latestFeedback(
		sessionId: string,
	): Promise<{ payload: BrowserFeedbackEvent } | undefined> {
		const response = await this.#fetch(
			`${this.#baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/feedback/latest`,
			{ headers: { Authorization: `Bearer ${this.#authToken}` } },
		);
		if (!response.ok)
			throw new Error(
				`Browser feedback latest failed with HTTP ${response.status}`,
			);
		const body = (await response.json()) as {
			feedback?: { payload: BrowserFeedbackEvent } | null;
		};
		return body.feedback ?? undefined;
	}

	async clearFeedback(sessionId: string): Promise<number> {
		const response = await this.#fetch(
			`${this.#baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/feedback`,
			{
				method: "DELETE",
				headers: { Authorization: `Bearer ${this.#authToken}` },
			},
		);
		if (!response.ok)
			throw new Error(
				`Browser feedback clear failed with HTTP ${response.status}`,
			);
		const body = (await response.json()) as { cleared?: number };
		return body.cleared ?? 0;
	}

	async updateSession(
		sessionId: string,
		update: Record<string, unknown>,
	): Promise<void> {
		const response = await this.#fetch(
			`${this.#baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`,
			{
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${this.#authToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(update),
			},
		);
		if (!response.ok)
			throw new Error(
				`Browser session update failed with HTTP ${response.status}`,
			);
	}

	async unregisterSession(sessionId: string): Promise<void> {
		const response = await this.#fetch(
			`${this.#baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`,
			{
				method: "DELETE",
				headers: { Authorization: `Bearer ${this.#authToken}` },
			},
		);
		if (!response.ok)
			throw new Error(
				`Browser session unregister failed with HTTP ${response.status}`,
			);
	}

	async listSessions(): Promise<BrowserSessionRegistration[]> {
		const response = await this.#fetch(`${this.#baseUrl}/api/sessions`, {
			headers: { Authorization: `Bearer ${this.#authToken}` },
		});
		if (!response.ok)
			throw new Error(
				`Browser session list failed with HTTP ${response.status}`,
			);
		const body = (await response.json()) as {
			sessions?: BrowserSessionRegistration[];
		};
		return body.sessions ?? [];
	}

	async openPairingWindow(sessionId: string): Promise<BrowserPairingWindow> {
		const response = await this.#fetch(`${this.#baseUrl}/api/pair/open`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#authToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sessionId }),
		});
		if (!response.ok) {
			throw new Error(
				`Browser pairing open failed with HTTP ${response.status}`,
			);
		}
		return (await response.json()) as BrowserPairingWindow;
	}

	async revokeAllBrowserCapabilities(): Promise<void> {
		const response = await this.#fetch(`${this.#baseUrl}/api/pair/reset`, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.#authToken}` },
		});
		if (!response.ok) {
			throw new Error(
				`Browser pairing reset failed with HTTP ${response.status}`,
			);
		}
	}

	async #reconnectFromDiscovery(): Promise<BrowserBrokerConnectionInfo> {
		const discovery = await readDiscoveryFile(this.#discoveryPath);
		if (!discovery) {
			throw new Error("Browser broker discovery file not found");
		}
		const broker = await discoverCompatibleBroker({
			host: discovery.host,
			ports: [discovery.port],
		});
		if (!broker || broker.brokerId !== discovery.broker_id) {
			throw new Error("Browser broker not reachable");
		}
		return {
			baseUrl: broker.baseUrl,
			authToken: discovery.auth_token,
		};
	}

	#feedbackSocketUrl(sessionId: string): string {
		const wsBase = this.#baseUrl
			.replace(/^http:\/\//, "ws://")
			.replace(/^https:\/\//, "wss://");
		return `${wsBase}/ws/omp/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(this.#authToken)}`;
	}

	subscribeFeedback(
		sessionId: string,
		onFeedback: (event: BrowserFeedbackEvent) => void,
		options: BrowserFeedbackSubscriptionOptions = {},
	): BrowserFeedbackSubscription {
		const createWebSocket =
			options.createWebSocket ??
			((url: string) => new WebSocket(url) as unknown as BrowserBrokerSocket);
		const setReconnectTimer: BrowserBrokerTimerFn =
			options.setTimeout ??
			((callback, delay) =>
				globalThis.setTimeout(() => {
					void callback();
				}, delay));
		const clearReconnectTimer =
			options.clearTimeout ??
			((handle: BrowserBrokerTimeoutHandle) => {
				globalThis.clearTimeout(handle);
			});
		const random = options.random ?? Math.random;
		const reconnect =
			options.reconnect ?? (() => this.#reconnectFromDiscovery());

		const jitteredDelay = (attempt: number): number => {
			const base = Math.min(500 * 2 ** (attempt - 1), 30_000);
			return base * (0.75 + random() * 0.25);
		};

		let socket: BrowserBrokerSocket | undefined;
		let reconnectAttempts = 0;
		let reconnectTimer: BrowserBrokerTimeoutHandle | undefined;
		let closed = false;
		let state: BrowserFeedbackConnectionStatus["state"] = "connecting";
		let malformedMessages = 0;
		const seenEventIds = new Set<string>();

		const publishStatus = () => {
			options.onStateChange?.({
				state,
				reconnectAttempts,
				baseUrl: this.#baseUrl,
				malformedMessages,
			});
		};

		const openSocket = () => {
			if (closed) return;
			state = "connecting";
			publishStatus();

			const activeSocket = createWebSocket(this.#feedbackSocketUrl(sessionId));
			socket = activeSocket;

			activeSocket.onopen = () => {
				if (socket !== activeSocket || closed) return;
				reconnectAttempts = 0;
				state = "connected";
				publishStatus();
			};

			activeSocket.onmessage = (event) => {
				if (closed || socket !== activeSocket) return;
				try {
					const msg = JSON.parse(String(event.data)) as {
						type?: string;
						event?: BrowserFeedbackEvent;
					};
					if (msg.type !== "browser.feedback" || !msg.event) return;
					if (seenEventIds.has(msg.event.eventId)) return;
					seenEventIds.add(msg.event.eventId);
					if (seenEventIds.size > MAX_DEDUPED_EVENT_IDS) {
						const oldestEventId = seenEventIds.values().next().value;
						if (oldestEventId !== undefined) {
							seenEventIds.delete(oldestEventId);
						}
					}
					onFeedback(msg.event);
				} catch {
					malformedMessages++;
					logWarn("Malformed WS message (count:", malformedMessages, ")");
					publishStatus();
				}
			};

			const detachActiveSocket = () => {
				activeSocket.onopen = null;
				activeSocket.onmessage = null;
				activeSocket.onerror = null;
				activeSocket.onclose = null;
			};

			const scheduleReconnect = () => {
				if (closed || socket !== activeSocket || reconnectTimer) return;
				socket = undefined;
				detachActiveSocket();
				activeSocket.close();
				reconnectAttempts += 1;
				state = "reconnecting";
				publishStatus();

				const delay = jitteredDelay(reconnectAttempts);
				reconnectTimer = setReconnectTimer(async () => {
					reconnectTimer = undefined;
					if (closed) return;
					try {
						const next = await reconnect();
						if (closed) return;
						this.#baseUrl = next.baseUrl.replace(/\/+$/, "");
						this.#authToken = next.authToken;
						openSocket();
					} catch {
						if (closed) return;
						scheduleRetry();
					}
				}, delay);
			};

			const scheduleRetry = () => {
				if (closed || reconnectTimer) return;
				reconnectAttempts += 1;
				state = "reconnecting";
				publishStatus();

				const delay = jitteredDelay(reconnectAttempts);
				reconnectTimer = setReconnectTimer(async () => {
					reconnectTimer = undefined;
					if (closed) return;
					try {
						const next = await reconnect();
						if (closed) return;
						this.#baseUrl = next.baseUrl.replace(/\/+$/, "");
						this.#authToken = next.authToken;
						openSocket();
					} catch {
						scheduleRetry();
					}
				}, delay);
			};

			activeSocket.onerror = () => {
				scheduleReconnect();
			};
			activeSocket.onclose = () => {
				scheduleReconnect();
			};
		};

		const brokerClient = this;

		publishStatus();
		openSocket();

		return {
			close() {
				if (closed) return;
				closed = true;
				if (reconnectTimer) {
					clearReconnectTimer(reconnectTimer);
					reconnectTimer = undefined;
				}
				state = "closed";
				publishStatus();

				const activeSocket = socket;
				socket = undefined;
				if (activeSocket) {
					activeSocket.onopen = null;
					activeSocket.onmessage = null;
					activeSocket.onerror = null;
					activeSocket.onclose = null;
					activeSocket.close();
				}
			},
			getStatus() {
				return {
					state,
					reconnectAttempts,
					baseUrl: brokerClient.#baseUrl,
					malformedMessages,
				};
			},
		};
	}
}

export interface BrowserFeedbackSubscription {
	close(): void;
	getStatus(): BrowserFeedbackConnectionStatus;
}

export async function createBrowserBrokerClientFromDiscovery(
	discoveryPath: string = defaultDiscoveryPath(),
): Promise<BrowserBrokerClient | undefined> {
	const discovery = await readDiscoveryFile(discoveryPath);
	if (!discovery) return undefined;
	// Probe the advertised host/port to verify the broker is alive and compatible.
	const broker = await discoverCompatibleBroker({
		host: discovery.host,
		ports: [discovery.port],
	});
	if (!broker || broker.brokerId !== discovery.broker_id) return undefined;
	return new BrowserBrokerClient({
		baseUrl: broker.baseUrl,
		authToken: discovery.auth_token,
		discoveryPath,
	});
}
