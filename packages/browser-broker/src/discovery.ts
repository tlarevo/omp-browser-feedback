import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	BROWSER_BROKER_SERVICE,
	BROWSER_PROTOCOL_VERSION,
	type BrowserProtocolVersion,
} from "@oh-my-pi/browser-protocol";
import {
	DEFAULT_BROWSER_BROKER_PORT_RANGE,
	parsePortRange,
	portsInRange,
} from "./ports";

export interface BrowserBrokerDiscovery {
	protocol_version: BrowserProtocolVersion;
	broker_id: string;
	host: string;
	port: number;
	base_url: string;
	ws_url: string;
	auth_token: string;
	pid: number;
	started_at: string;
}

export interface BrokerPortOptions {
	port?: number;
	portRange?: string;
}

export type BrokerDiscoveryFetch = (
	url: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export interface DiscoverCompatibleBrokerOptions {
	host: string;
	ports: number[];
	fetch?: BrokerDiscoveryFetch;
}

export interface CompatibleBroker {
	baseUrl: string;
	brokerId: string;
	port: number;
}

export function defaultDiscoveryPath(): string {
	return path.join(os.homedir(), ".omp", "browser-broker.json");
}

export function defaultPairingRegistryPath(): string {
	return path.join(os.homedir(), ".omp", "browser-pairing-registry.json");
}

export function resolveBrokerPorts(options: BrokerPortOptions = {}): number[] {
	if (options.port !== undefined) return [options.port];
	return portsInRange(
		parsePortRange(options.portRange ?? DEFAULT_BROWSER_BROKER_PORT_RANGE),
	);
}

export async function discoverCompatibleBroker(
	options: DiscoverCompatibleBrokerOptions,
): Promise<CompatibleBroker | undefined> {
	const fetchImpl = options.fetch ?? fetch;
	for (const port of options.ports) {
		const baseUrl = `http://${options.host}:${port}`;
		try {
			const response = await fetchImpl(`${baseUrl}/api/health`, {
				signal: AbortSignal.timeout(250),
			});
			if (!response.ok) continue;
			const body = (await response.json()) as {
				service?: string;
				protocol_version?: number;
				broker_id?: string;
			};
			if (body.service !== BROWSER_BROKER_SERVICE) continue;
			if (body.protocol_version !== BROWSER_PROTOCOL_VERSION) continue;
			if (!body.broker_id) continue;
			return { baseUrl, brokerId: body.broker_id, port };
		} catch {
			console.debug("[browser-broker] Probe failed on port", port);
		}
	}
	return undefined;
}

export async function writeDiscoveryFile(
	filePath: string,
	discovery: BrowserBrokerDiscovery,
): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	await Bun.write(filePath, JSON.stringify(discovery, null, 2));
	await fs.chmod(filePath, 0o600);
}

export async function readDiscoveryFile(
	filePath: string,
): Promise<BrowserBrokerDiscovery | undefined> {
	try {
		return (await Bun.file(filePath).json()) as BrowserBrokerDiscovery;
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		)
			return undefined;
		throw error;
	}
}
