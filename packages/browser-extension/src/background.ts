import {
	BROWSER_BROKER_SERVICE,
	BROWSER_PROTOCOL_VERSION_RANGE,
	type BrowserFeedbackEvent,
	type BrowserSessionRegistration,
	ENDPOINT_FEEDBACK_SUBMIT,
	ENDPOINT_HEALTH,
	ENDPOINT_PAIR_REDEEM,
	ENDPOINT_SESSIONS_LIST,
} from "@oh-my-pi/browser-protocol";

export interface BrokerHealth {
	service: string;
	protocol_version: number;
	minProtocolVersion?: number;
	protocolVersion?: number;
	protocol_version_range?: { min: number; max: number };
	broker_id: string;
}

export type ExtensionFetch = (
	url: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

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

export interface RedeemPairingCodeOptions {
	baseUrl: string;
	browserInstallId: string;
	code: string;
	fetch?: ExtensionFetch;
}

export interface RedeemPairingCodeResult {
	capabilityToken: string;
}

export interface SubmitFeedbackOptions {
	baseUrl: string;
	capabilityToken: string;
	event: BrowserFeedbackEvent;
	screenshot?: Blob;
	fetch?: ExtensionFetch;
}

export interface ListSessionsOptions {
	baseUrl: string;
	capabilityToken: string;
	fetch?: ExtensionFetch;
}

export interface ListSessionsResult {
	sessions: BrowserSessionRegistration[];
}

interface ErrorResponseBody {
	message?: string;
}

function isErrorResponseBody(value: unknown): value is ErrorResponseBody {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		!("message" in record) ||
		record.message === undefined ||
		typeof record.message === "string"
	);
}

async function readErrorMessage(
	response: Response,
	fallback: string,
): Promise<string> {
	try {
		const body = (await response.json()) as unknown;
		if (isErrorResponseBody(body) && typeof body.message === "string") {
			return body.message;
		}
	} catch {}
	return fallback;
}

function brokerUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export async function probeBroker(
	baseUrl: string,
	fetchImpl: ExtensionFetch = fetch,
): Promise<BrokerHealth | undefined> {
	try {
		const response = await fetchImpl(brokerUrl(baseUrl, ENDPOINT_HEALTH.path));
		if (!response.ok) return undefined;
		const health = (await response.json()) as BrokerHealth;
		if (health.service !== BROWSER_BROKER_SERVICE) return undefined;
		// Check that the extension's protocol version falls within the broker's
		// advertised range.  A v2 broker advertising [2,2] must be rejected by
		// this v1 extension.
		if (health.protocol_version_range) {
			const { min, max } = health.protocol_version_range;
			if (
				BROWSER_PROTOCOL_VERSION_RANGE.min < min ||
				BROWSER_PROTOCOL_VERSION_RANGE.min > max
			)
				return undefined;
		} else {
			// Fallback: strict equality for older brokers.
			if (BROWSER_PROTOCOL_VERSION_RANGE.min !== health.protocol_version)
				return undefined;
		}
		return health;
	} catch {
		return undefined;
	}
}

export async function discoverBroker(
	options: DiscoverBrokerOptions,
): Promise<DiscoveredBroker | undefined> {
	for (const port of options.ports) {
		const baseUrl = `http://${options.host}:${port}`;
		const health = await probeBroker(baseUrl, options.fetch);
		if (health) return { baseUrl, brokerId: health.broker_id, port };
	}
	return undefined;
}

export async function redeemPairingCode(
	options: RedeemPairingCodeOptions,
): Promise<RedeemPairingCodeResult> {
	const fetchImpl = options.fetch ?? fetch;
	const response = await fetchImpl(
		brokerUrl(options.baseUrl, ENDPOINT_PAIR_REDEEM.path),
		{
			method: ENDPOINT_PAIR_REDEEM.method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				browserInstallId: options.browserInstallId,
				code: options.code,
			}),
		},
	);
	if (!response.ok) {
		throw new Error(
			await readErrorMessage(
				response,
				`Browser pairing failed with HTTP ${response.status}`,
			),
		);
	}
	return (await response.json()) as RedeemPairingCodeResult;
}

export async function submitFeedback(
	options: SubmitFeedbackOptions,
): Promise<void> {
	const fetchImpl = options.fetch ?? fetch;
	const form = new FormData();
	form.set("event", JSON.stringify(options.event));
	if (options.screenshot) {
		form.set("screenshot", options.screenshot, "screenshot.png");
	}
	const response = await fetchImpl(
		brokerUrl(options.baseUrl, ENDPOINT_FEEDBACK_SUBMIT.path),
		{
			method: ENDPOINT_FEEDBACK_SUBMIT.method,
			headers: { Authorization: `Bearer ${options.capabilityToken}` },
			body: form,
		},
	);
	if (!response.ok) {
		throw new Error(
			`Browser feedback submission failed with HTTP ${response.status}`,
		);
	}
}

export async function listSessions(
	options: ListSessionsOptions,
): Promise<BrowserSessionRegistration[]> {
	const fetchImpl = options.fetch ?? fetch;
	const response = await fetchImpl(
		brokerUrl(options.baseUrl, ENDPOINT_SESSIONS_LIST.path),
		{
			method: ENDPOINT_SESSIONS_LIST.method,
			headers: { Authorization: `Bearer ${options.capabilityToken}` },
		},
	);
	if (!response.ok) {
		throw new Error(
			`Browser session listing failed with HTTP ${response.status}`,
		);
	}
	const body = (await response.json()) as ListSessionsResult;
	return body.sessions;
}
