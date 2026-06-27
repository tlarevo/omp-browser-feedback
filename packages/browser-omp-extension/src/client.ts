import { defaultDiscoveryPath, readDiscoveryFile } from "@oh-my-pi/browser-broker";
import {
	BROWSER_PROTOCOL_VERSION,
	type BrowserFeedbackEvent,
	type BrowserSessionRegistration,
} from "@oh-my-pi/browser-protocol";

export type BrowserBrokerFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface BrowserBrokerClientOptions {
	baseUrl: string;
	authToken: string;
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

export class BrowserBrokerClient {
	readonly #baseUrl: string;
	readonly #authToken: string;
	readonly #fetch: BrowserBrokerFetch;

	constructor(options: BrowserBrokerClientOptions) {
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#authToken = options.authToken;
		this.#fetch = options.fetch ?? fetch;
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

		const response = await this.#fetch(`${this.#baseUrl}/api/sessions/register`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#authToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(registration),
		});
		if (!response.ok) {
			throw new Error(`Browser broker registration failed with HTTP ${response.status}`);
		}
	}

	async listFeedback(sessionId: string): Promise<Array<{ payload: BrowserFeedbackEvent }>> {
		const response = await this.#fetch(`${this.#baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/feedback`, {
			headers: { Authorization: `Bearer ${this.#authToken}` },
		});
		if (!response.ok) throw new Error(`Browser feedback list failed with HTTP ${response.status}`);
		const body = (await response.json()) as { feedback?: Array<{ payload: BrowserFeedbackEvent }> };
		return body.feedback ?? [];
	}

	async latestFeedback(sessionId: string): Promise<{ payload: BrowserFeedbackEvent } | undefined> {
		const response = await this.#fetch(
			`${this.#baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/feedback/latest`,
			{ headers: { Authorization: `Bearer ${this.#authToken}` } },
		);
		if (!response.ok) throw new Error(`Browser feedback latest failed with HTTP ${response.status}`);
		const body = (await response.json()) as { feedback?: { payload: BrowserFeedbackEvent } | null };
		return body.feedback ?? undefined;
	}

	async clearFeedback(sessionId: string): Promise<number> {
		const response = await this.#fetch(`${this.#baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/feedback`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${this.#authToken}` },
		});
		if (!response.ok) throw new Error(`Browser feedback clear failed with HTTP ${response.status}`);
		const body = (await response.json()) as { cleared?: number };
		return body.cleared ?? 0;
	}

	async updateSession(sessionId: string, update: Record<string, unknown>): Promise<void> {
		const response = await this.#fetch(`${this.#baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
			method: "PATCH",
			headers: { Authorization: `Bearer ${this.#authToken}`, "Content-Type": "application/json" },
			body: JSON.stringify(update),
		});
		if (!response.ok) throw new Error(`Browser session update failed with HTTP ${response.status}`);
	}

	async unregisterSession(sessionId: string): Promise<void> {
		const response = await this.#fetch(`${this.#baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${this.#authToken}` },
		});
		if (!response.ok) throw new Error(`Browser session unregister failed with HTTP ${response.status}`);
	}

	async listSessions(): Promise<BrowserSessionRegistration[]> {
		const response = await this.#fetch(`${this.#baseUrl}/api/sessions`, {
			headers: { Authorization: `Bearer ${this.#authToken}` },
		});
		if (!response.ok) throw new Error(`Browser session list failed with HTTP ${response.status}`);
		const body = (await response.json()) as { sessions?: BrowserSessionRegistration[] };
		return body.sessions ?? [];
	}

	subscribeFeedback(sessionId: string, onFeedback: (event: BrowserFeedbackEvent) => void): BrowserFeedbackSubscription {
		const wsBase = this.#baseUrl.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://");
		const wsUrl = `${wsBase}/ws/omp/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(this.#authToken)}`;
		let ws: WebSocket | undefined = new WebSocket(wsUrl);
		let closed = false;

		ws.onmessage = event => {
			try {
				const msg = JSON.parse(String(event.data)) as { type?: string; event?: BrowserFeedbackEvent };
				if (msg.type === "browser.feedback" && msg.event) onFeedback(msg.event);
			} catch {}
		};
		ws.onerror = () => {};

		return {
			close() {
				if (!closed) {
					closed = true;
					ws?.close();
					ws = undefined;
				}
			},
		};
	}
}

export interface BrowserFeedbackSubscription {
	close(): void;
}

export async function createBrowserBrokerClientFromDiscovery(
	discoveryPath: string = defaultDiscoveryPath(),
): Promise<BrowserBrokerClient | undefined> {
	const discovery = await readDiscoveryFile(discoveryPath);
	if (!discovery) return undefined;
	return new BrowserBrokerClient({
		baseUrl: discovery.base_url,
		authToken: discovery.auth_token,
	});
}
