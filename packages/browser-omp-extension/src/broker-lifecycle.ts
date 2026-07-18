import * as path from "node:path";
import {
	type BrokerPortOptions,
	type BrowserBrokerServer,
	createBrowserBrokerServer,
	DEFAULT_BROWSER_BROKER_HOST,
	discoverCompatibleBroker,
	generateBrowserBrokerToken,
	isProcessAlive,
	readDiscoveryFile,
	removeOwnedDiscoveryFile,
	resolveBrokerPorts,
	writeDiscoveryFile,
} from "@oh-my-pi/browser-broker";
import { BROWSER_PROTOCOL_VERSION } from "@oh-my-pi/browser-protocol";
import type {
	BrowserFeedbackConnectionStatus,
	BrowserFeedbackSubscription,
} from "./client";
import { readConfig } from "./config";

export type { BrokerPortOptions };

let _activeBroker: BrowserBrokerServer | undefined;
let _activeDiscoveryPath: string | undefined;
let _activeAuthToken: string | undefined;
let _activeSubscription: BrowserFeedbackSubscription | undefined;

function defaultDiscoveryPath(): string {
	return path.join(Bun.env.HOME ?? "~", ".omp", "browser-broker.json");
}

export function getInProcessBrokerStatus(): {
	running: boolean;
	baseUrl?: string;
	port?: number;
} {
	if (_activeBroker) {
		return {
			running: true,
			baseUrl: _activeBroker.baseUrl,
			port: _activeBroker.port,
		};
	}
	return { running: false };
}

export interface BrokerStartOptions extends BrokerPortOptions {
	discoveryPath?: string;
}

export interface BrokerStartResult {
	baseUrl: string;
	authToken: string;
	port: number;
	reused: boolean;
}

export interface EnsureBrokerRunningDeps {
	discover?: typeof discoverCompatibleBroker;
	createServer?: typeof createBrowserBrokerServer;
	readDiscovery?: typeof readDiscoveryFile;
	writeDiscovery?: typeof writeDiscoveryFile;
	generateToken?: typeof generateBrowserBrokerToken;
	loadConfig?: () => Promise<{ portRange?: string }>;
	env?: Record<string, string | undefined>;
	pid?: number;
}

export async function ensureBrokerRunning(
	options: BrokerStartOptions = {},
	deps: EnsureBrokerRunningDeps = {},
): Promise<BrokerStartResult> {
	const discover = deps.discover ?? discoverCompatibleBroker;
	const createServer = deps.createServer ?? createBrowserBrokerServer;
	const readDiscovery = deps.readDiscovery ?? readDiscoveryFile;
	const writeDiscovery = deps.writeDiscovery ?? writeDiscoveryFile;
	const generateToken = deps.generateToken ?? generateBrowserBrokerToken;
	const loadConfig = deps.loadConfig ?? readConfig;
	const pid = deps.pid ?? process.pid;
	const discoveryPath = options.discoveryPath ?? defaultDiscoveryPath();

	if (_activeBroker && _activeAuthToken) {
		return {
			baseUrl: _activeBroker.baseUrl,
			authToken: _activeAuthToken,
			port: _activeBroker.port,
			reused: true,
		};
	}

	const config = await loadConfig();
	const ports = resolveBrokerPorts({
		port: options.port,
		portRange: options.portRange,
		configPortRange: config.portRange,
		env: deps.env,
	});

	// Reuse a compatible broker anywhere in the configured range, not only the
	// port named by the discovery file. Only trust the recorded auth token when
	// the writer process is still alive; stale/dead-PID metadata is ignored.
	const discovery = await readDiscovery(discoveryPath);
	if (discovery && isProcessAlive(discovery.pid)) {
		const existing = await discover({ host: discovery.host, ports });
		if (existing && existing.brokerId === discovery.broker_id) {
			return {
				baseUrl: existing.baseUrl,
				authToken: discovery.auth_token,
				port: existing.port,
				reused: true,
			};
		}
	}

	const authToken = generateToken();
	let server: BrowserBrokerServer | undefined;

	for (const port of ports) {
		try {
			server = await createServer({
				host: DEFAULT_BROWSER_BROKER_HOST,
				port,
				authToken,
			});
			break;
		} catch {
			// port occupied or unusable, try the next candidate
		}
	}

	// Never fall back to an OS-assigned port: exhaustion is a hard error so the
	// broker stays within the configured, discoverable range.
	if (!server) {
		const attempted =
			ports.length === 1
				? `port ${ports[0]}`
				: `ports ${ports[0]}-${ports[ports.length - 1]}`;
		throw new Error(
			`Browser broker could not bind to any of ${attempted}. ` +
				"All candidate ports are occupied. Free a port or choose another with " +
				"`/bf broker start --port <port>`.",
		);
	}

	_activeBroker = server;
	_activeDiscoveryPath = discoveryPath;
	_activeAuthToken = authToken;

	await writeDiscovery(discoveryPath, {
		protocol_version: BROWSER_PROTOCOL_VERSION,
		broker_id: "local",
		host: DEFAULT_BROWSER_BROKER_HOST,
		port: server.port,
		base_url: server.baseUrl,
		ws_url: `ws://${DEFAULT_BROWSER_BROKER_HOST}:${server.port}`,
		auth_token: authToken,
		pid,
		started_at: new Date().toISOString(),
	});

	return {
		baseUrl: server.baseUrl,
		authToken,
		port: server.port,
		reused: false,
	};
}

export function setActiveFeedbackSubscription(
	sub: BrowserFeedbackSubscription,
): void {
	_activeSubscription?.close();
	_activeSubscription = sub;
}

export function clearActiveFeedbackSubscription(): void {
	_activeSubscription?.close();
	_activeSubscription = undefined;
}
export function getActiveFeedbackConnectionStatus():
	| BrowserFeedbackConnectionStatus
	| undefined {
	return _activeSubscription?.getStatus();
}

export async function stopActiveBroker(): Promise<boolean> {
	clearActiveFeedbackSubscription();
	if (!_activeBroker) return false;
	_activeBroker.stop();
	_activeBroker = undefined;
	_activeAuthToken = undefined;
	if (_activeDiscoveryPath) {
		try {
			await removeOwnedDiscoveryFile(_activeDiscoveryPath, process.pid);
		} catch {}
		_activeDiscoveryPath = undefined;
	}
	return true;
}
