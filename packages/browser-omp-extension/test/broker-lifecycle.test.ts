import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type BrowserBrokerServer,
	createBrowserBrokerServer,
	writeDiscoveryFile,
} from "@oh-my-pi/browser-broker";
import { BROWSER_PROTOCOL_VERSION } from "@oh-my-pi/browser-protocol";
import {
	type EnsureBrokerRunningDeps,
	ensureBrokerRunning,
	stopActiveBroker,
} from "../src/broker-lifecycle";

// Isolate every call from ambient config file and environment variables.
const isolate: EnsureBrokerRunningDeps = {
	loadConfig: async () => ({}),
	env: {},
};

function fakeServer(port: number): BrowserBrokerServer {
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		host: "127.0.0.1",
		port,
		stop() {},
	} as unknown as BrowserBrokerServer;
}

function occupy(port = 0): Promise<net.Server & { assignedPort: number }> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("no port"));
				return;
			}
			(server as net.Server & { assignedPort: number }).assignedPort =
				address.port;
			resolve(server as net.Server & { assignedPort: number });
		});
	});
}

function closeServer(server: net.Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

describe("ensureBrokerRunning (dependency-injected)", () => {
	let dir: string;
	let discoveryPath: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-lifecycle-"));
		discoveryPath = path.join(dir, "broker.json");
	});

	afterEach(async () => {
		await stopActiveBroker();
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("reuses a compatible broker anywhere in the range, not just the discovery-file port", async () => {
		let scannedPorts: number[] | undefined;
		const result = await ensureBrokerRunning(
			{ discoveryPath, portRange: "4317-4320" },
			{
				...isolate,
				// Discovery file names 4317, but the live broker is on 4319.
				readDiscovery: async () => ({
					protocol_version: BROWSER_PROTOCOL_VERSION,
					broker_id: "local",
					host: "127.0.0.1",
					port: 4317,
					base_url: "http://127.0.0.1:4317",
					ws_url: "ws://127.0.0.1:4317",
					auth_token: "reused-token",
					pid: process.pid,
					started_at: new Date().toISOString(),
				}),
				discover: async ({ ports }) => {
					scannedPorts = ports;
					return {
						baseUrl: "http://127.0.0.1:4319",
						brokerId: "local",
						port: 4319,
					};
				},
			},
		);

		expect(result).toEqual({
			baseUrl: "http://127.0.0.1:4319",
			authToken: "reused-token",
			port: 4319,
			reused: true,
		});
		expect(scannedPorts).toEqual([4317, 4318, 4319, 4320]);
	});

	test("ignores stale discovery metadata whose pid is dead", async () => {
		let discoverCalled = false;
		const created: number[] = [];
		const result = await ensureBrokerRunning(
			{ discoveryPath, portRange: "4317-4318" },
			{
				...isolate,
				readDiscovery: async () => ({
					protocol_version: BROWSER_PROTOCOL_VERSION,
					broker_id: "local",
					host: "127.0.0.1",
					port: 4317,
					base_url: "http://127.0.0.1:4317",
					ws_url: "ws://127.0.0.1:4317",
					auth_token: "stale",
					pid: 2_147_483_646, // not a live process
					started_at: new Date().toISOString(),
				}),
				discover: async () => {
					discoverCalled = true;
					return undefined;
				},
				createServer: async ({ port }) => {
					created.push(port);
					return fakeServer(port);
				},
				writeDiscovery: async () => {},
				generateToken: () => "fresh",
			},
		);

		expect(discoverCalled).toBe(false);
		expect(result.reused).toBe(false);
		expect(result.authToken).toBe("fresh");
		expect(created[0]).toBe(4317);
	});

	test("skips unrelated occupied ports and starts on the first remaining valid port", async () => {
		const occupied = new Set([4317, 4318]);
		const attempted: number[] = [];
		const result = await ensureBrokerRunning(
			{ discoveryPath, portRange: "4317-4320" },
			{
				...isolate,
				readDiscovery: async () => undefined,
				discover: async () => undefined,
				createServer: async ({ port }) => {
					attempted.push(port);
					if (occupied.has(port)) throw new Error("EADDRINUSE");
					return fakeServer(port);
				},
				writeDiscovery: async () => {},
				generateToken: () => "tok",
			},
		);

		expect(attempted).toEqual([4317, 4318, 4319]);
		expect(result.port).toBe(4319);
		expect(result.reused).toBe(false);
	});

	test("fails on full exhaustion with the attempted range and never uses port 0", async () => {
		const attempted: number[] = [];
		await expect(
			ensureBrokerRunning(
				{ discoveryPath, portRange: "4317-4319" },
				{
					...isolate,
					readDiscovery: async () => undefined,
					discover: async () => undefined,
					createServer: async ({ port }) => {
						attempted.push(port);
						throw new Error("EADDRINUSE");
					},
					writeDiscovery: async () => {},
				},
			),
		).rejects.toThrow(/4317-4319[\s\S]*\/bf broker start --port <port>/);

		expect(attempted).toEqual([4317, 4318, 4319]);
		expect(attempted).not.toContain(0);
	});

	test("applies precedence: explicit port over env and config", async () => {
		const created: number[] = [];
		await ensureBrokerRunning(
			{ discoveryPath, port: 4500 },
			{
				loadConfig: async () => ({ portRange: "5000-5001" }),
				env: { OMP_BROWSER_BROKER_PORT_RANGE: "7000-7001" },
				readDiscovery: async () => undefined,
				discover: async () => undefined,
				createServer: async ({ port }) => {
					created.push(port);
					return fakeServer(port);
				},
				writeDiscovery: async () => {},
			},
		);
		expect(created).toEqual([4500]);
	});

	test("applies precedence: config range when no CLI or env override", async () => {
		const created: number[] = [];
		await ensureBrokerRunning(
			{ discoveryPath },
			{
				loadConfig: async () => ({ portRange: "5000-5002" }),
				env: {},
				readDiscovery: async () => undefined,
				discover: async () => undefined,
				createServer: async ({ port }) => {
					created.push(port);
					if (port !== 5000) throw new Error("EADDRINUSE");
					return fakeServer(port);
				},
				writeDiscovery: async () => {},
			},
		);
		expect(created[0]).toBe(5000);
	});
});

describe("ensureBrokerRunning (real sockets)", () => {
	let dir: string;
	let discoveryPath: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-lifecycle-real-"));
		discoveryPath = path.join(dir, "broker.json");
	});

	afterEach(async () => {
		await stopActiveBroker();
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("binds a real broker while skipping an occupied port", async () => {
		const occupied = await occupy();
		try {
			const result = await ensureBrokerRunning(
				{
					discoveryPath,
					portRange: `${occupied.assignedPort}-${occupied.assignedPort + 20}`,
				},
				isolate,
			);
			expect(result.reused).toBe(false);
			expect(result.port).not.toBe(occupied.assignedPort);
			expect(result.port).toBeGreaterThan(occupied.assignedPort);

			const health = await fetch(`${result.baseUrl}/api/health`);
			expect(health.ok).toBe(true);
		} finally {
			await closeServer(occupied);
		}
	});

	test("fails exhaustion when the only configured port is occupied", async () => {
		const occupied = await occupy();
		try {
			await expect(
				ensureBrokerRunning(
					{
						discoveryPath,
						portRange: `${occupied.assignedPort}-${occupied.assignedPort}`,
					},
					isolate,
				),
			).rejects.toThrow(
				new RegExp(
					`${occupied.assignedPort}[\\s\\S]*/bf broker start --port <port>`,
				),
			);
		} finally {
			await closeServer(occupied);
		}
	});

	test("reuses a live broker discovered on a port other than the file's port", async () => {
		const broker = await createBrowserBrokerServer({
			host: "127.0.0.1",
			port: 0,
			authToken: "real-token",
		});
		try {
			await writeDiscoveryFile(discoveryPath, {
				protocol_version: BROWSER_PROTOCOL_VERSION,
				broker_id: "local",
				host: "127.0.0.1",
				port: 59_999, // deliberately not the broker's real port
				base_url: "http://127.0.0.1:59999",
				ws_url: "ws://127.0.0.1:59999",
				auth_token: "real-token",
				pid: process.pid,
				started_at: new Date().toISOString(),
			});

			const result = await ensureBrokerRunning(
				{ discoveryPath, portRange: `${broker.port}-${broker.port}` },
				isolate,
			);
			expect(result.reused).toBe(true);
			expect(result.port).toBe(broker.port);
			expect(result.authToken).toBe("real-token");
		} finally {
			broker.stop();
		}
	});
});
