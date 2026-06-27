import {
	BROWSER_BROKER_SERVICE,
	BROWSER_PROTOCOL_VERSION,
	type BrowserFeedbackEvent,
	type BrowserSessionRegistration,
} from "@oh-my-pi/browser-protocol";

export interface BrokerHealth {
	service: string;
	protocol_version: number;
	broker_id: string;
}

export type ExtensionFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DiscoveredBroker {
	baseUrl: string;
	brokerId: string;
	port: number;
}

export interface DiscoverBrokerOptions {
	host: string;
	ports: number[];
	fetch?: ExtensionFetch;
}

export interface SubmitFeedbackOptions {
	baseUrl: string;
	authToken: string;
	event: BrowserFeedbackEvent;
	screenshot?: Blob;
	fetch?: ExtensionFetch;
}

export interface ListSessionsOptions {
	baseUrl: string;
	authToken: string;
	fetch?: ExtensionFetch;
}

export interface ListSessionsResult {
	sessions: BrowserSessionRegistration[];
}

export async function probeBroker(
	baseUrl: string,
	fetchImpl: ExtensionFetch = fetch,
): Promise<BrokerHealth | undefined> {
	try {
		const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/api/health`);
		if (!response.ok) return undefined;
		const health = (await response.json()) as BrokerHealth;
		if (health.service !== BROWSER_BROKER_SERVICE) return undefined;
		if (health.protocol_version !== BROWSER_PROTOCOL_VERSION) return undefined;
		return health;
	} catch {
		return undefined;
	}
}

export async function discoverBroker(options: DiscoverBrokerOptions): Promise<DiscoveredBroker | undefined> {
	for (const port of options.ports) {
		const baseUrl = `http://${options.host}:${port}`;
		const health = await probeBroker(baseUrl, options.fetch);
		if (health) return { baseUrl, brokerId: health.broker_id, port };
	}
	return undefined;
}

export async function submitFeedback(options: SubmitFeedbackOptions): Promise<void> {
	const fetchImpl = options.fetch ?? fetch;
	const form = new FormData();
	form.set("event", JSON.stringify(options.event));
	if (options.screenshot) {
		form.set("screenshot", options.screenshot, "screenshot.png");
	}
	const response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, "")}/api/feedback`, {
		method: "POST",
		headers: { Authorization: `Bearer ${options.authToken}` },
		body: form,
	});
	if (!response.ok) {
		throw new Error(`Browser feedback submission failed with HTTP ${response.status}`);
	}
}

export async function listSessions(options: ListSessionsOptions): Promise<BrowserSessionRegistration[]> {
	const fetchImpl = options.fetch ?? fetch;
	const response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, "")}/api/sessions`, {
		headers: { Authorization: `Bearer ${options.authToken}` },
	});
	if (!response.ok) {
		throw new Error(`Browser session listing failed with HTTP ${response.status}`);
	}
	const body = (await response.json()) as ListSessionsResult;
	return body.sessions;
}
