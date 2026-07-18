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
	configPortRange?: string;
	env?: Record<string, string | undefined>;
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
export function defaultDeliveryPath(): string {
	return path.join(os.homedir(), ".omp", "browser-feedback-delivery.json");
}

export function resolveBrokerPorts(options: BrokerPortOptions = {}): number[] {
	// Precedence: explicit CLI option > environment value > config-file value > default.
	if (options.port !== undefined) return [options.port];
	if (options.portRange !== undefined) {
		return portsInRange(parsePortRange(options.portRange));
	}

	const env = options.env ?? process.env;
	const envPort = env.OMP_BROWSER_BROKER_PORT;
	if (envPort !== undefined && envPort !== "") {
		const parsed = Number(envPort);
		if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
			throw new Error(`Invalid OMP_BROWSER_BROKER_PORT: ${envPort}`);
		}
		return [parsed];
	}
	const envRange = env.OMP_BROWSER_BROKER_PORT_RANGE;
	if (envRange !== undefined && envRange !== "") {
		return portsInRange(parsePortRange(envRange));
	}

	if (options.configPortRange !== undefined && options.configPortRange !== "") {
		return portsInRange(parsePortRange(options.configPortRange));
	}

	return portsInRange(parsePortRange(DEFAULT_BROWSER_BROKER_PORT_RANGE));
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
	// Write to a unique temp file then rename so concurrent readers never observe
	// partial JSON and concurrent writers never clobber each other's temp file.
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
		.toString(36)
		.slice(2)}.tmp`;
	try {
		await fs.writeFile(tmpPath, JSON.stringify(discovery, null, 2), {
			mode: 0o600,
		});
		await fs.chmod(tmpPath, 0o600);
		await fs.rename(tmpPath, filePath);
	} catch (error) {
		await fs.rm(tmpPath, { force: true });
		throw error;
	}
}

function isValidDiscovery(value: unknown): value is BrowserBrokerDiscovery {
	if (!value || typeof value !== "object") return false;
	const d = value as Record<string, unknown>;
	return (
		typeof d.protocol_version === "number" &&
		typeof d.broker_id === "string" &&
		typeof d.host === "string" &&
		typeof d.port === "number" &&
		typeof d.base_url === "string" &&
		typeof d.ws_url === "string" &&
		typeof d.auth_token === "string" &&
		typeof d.pid === "number" &&
		typeof d.started_at === "string"
	);
}

export async function readDiscoveryFile(
	filePath: string,
): Promise<BrowserBrokerDiscovery | undefined> {
	let parsed: unknown;
	try {
		parsed = await Bun.file(filePath).json();
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return undefined;
		}
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	return isValidDiscovery(parsed) ? parsed : undefined;
}

export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but we may not signal it: still alive.
		return (
			!!error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "EPERM"
		);
	}
}

/**
 * Remove a discovery file only if it is unowned/stale or owned by `ownerPid`.
 * A live broker recorded under a different PID is left untouched.
 * Returns true when the file was removed (or was already absent).
 */
export async function removeOwnedDiscoveryFile(
	filePath: string,
	ownerPid: number,
): Promise<boolean> {
	const discovery = await readDiscoveryFile(filePath);
	if (
		discovery &&
		discovery.pid !== ownerPid &&
		isProcessAlive(discovery.pid)
	) {
		return false;
	}
	await fs.rm(filePath, { force: true });
	return true;
}
