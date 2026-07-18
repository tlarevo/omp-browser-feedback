import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type BrokerPortOptions,
	type BrowserBrokerServer,
	createBrowserBrokerServer,
	DEFAULT_BROWSER_BROKER_HOST,
	discoverCompatibleBroker,
	generateBrowserBrokerToken,
	readDiscoveryFile,
	resolveBrokerPorts,
	writeDiscoveryFile,
} from "@oh-my-pi/browser-broker";
import { BROWSER_PROTOCOL_VERSION } from "@oh-my-pi/browser-protocol";
import type {
	BrowserFeedbackConnectionStatus,
	BrowserFeedbackSubscription,
} from "./client";

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

export async function ensureBrokerRunning(
	options: BrokerStartOptions = {},
): Promise<BrokerStartResult> {
	const discoveryPath = options.discoveryPath ?? defaultDiscoveryPath();
	const ports = resolveBrokerPorts(options);

	if (_activeBroker && _activeAuthToken) {
		return {
			baseUrl: _activeBroker.baseUrl,
			authToken: _activeAuthToken,
			port: _activeBroker.port,
			reused: true,
		};
	}

	const discovery = await readDiscoveryFile(discoveryPath);
	if (discovery) {
		const existing = await discoverCompatibleBroker({
			host: discovery.host,
			ports: [discovery.port],
		});
		if (existing) {
			return {
				baseUrl: existing.baseUrl,
				authToken: discovery.auth_token,
				port: existing.port,
				reused: true,
			};
		}
	}

	const authToken = generateBrowserBrokerToken();
	let server: BrowserBrokerServer | undefined;

	for (const port of ports) {
		try {
			server = await createBrowserBrokerServer({
				host: DEFAULT_BROWSER_BROKER_HOST,
				port,
				authToken,
			});
			break;
		} catch {
			console.debug("[browser-feedback] Port", port, "occupied, trying next");
		}
	}

	if (!server) {
		const range = `${ports[0]}-${ports[ports.length - 1]}`;
		throw new Error(
			`All browser broker ports occupied (${range}). Stop the conflicting service or run /bf broker start --port <N>.`,
		);
	}

	_activeBroker = server;
	_activeDiscoveryPath = discoveryPath;
	_activeAuthToken = authToken;

	await writeDiscoveryFile(discoveryPath, {
		protocol_version: BROWSER_PROTOCOL_VERSION,
		broker_id: "local",
		host: DEFAULT_BROWSER_BROKER_HOST,
		port: server.port,
		base_url: server.baseUrl,
		ws_url: `ws://${DEFAULT_BROWSER_BROKER_HOST}:${server.port}`,
		auth_token: authToken,
		pid: process.pid,
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
			await fs.unlink(_activeDiscoveryPath);
		} catch {}
		_activeDiscoveryPath = undefined;
	}
	return true;
}
