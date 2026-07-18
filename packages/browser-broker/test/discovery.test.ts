import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	BROWSER_BROKER_SERVICE,
	BROWSER_PROTOCOL_VERSION,
} from "@oh-my-pi/browser-protocol";
import {
	type BrowserBrokerDiscovery,
	discoverCompatibleBroker,
	isProcessAlive,
	readDiscoveryFile,
	removeOwnedDiscoveryFile,
	resolveBrokerPorts,
	writeDiscoveryFile,
} from "../src/discovery";

function makeDiscovery(
	overrides: Partial<BrowserBrokerDiscovery> = {},
): BrowserBrokerDiscovery {
	return {
		protocol_version: BROWSER_PROTOCOL_VERSION,
		broker_id: "local",
		host: "127.0.0.1",
		port: 4317,
		base_url: "http://127.0.0.1:4317",
		ws_url: "ws://127.0.0.1:4317",
		auth_token: "tok",
		pid: process.pid,
		started_at: new Date().toISOString(),
		...overrides,
	};
}

describe("broker discovery", () => {
	test("reuses a compatible broker discovered in the candidate port range", async () => {
		const probes: string[] = [];
		const broker = await discoverCompatibleBroker({
			host: "127.0.0.1",
			ports: [4317, 4318],
			fetch: async (url) => {
				probes.push(String(url));
				if (String(url).includes(":4318/")) {
					return Response.json({
						service: BROWSER_BROKER_SERVICE,
						protocol_version: BROWSER_PROTOCOL_VERSION,
						broker_id: "existing",
					});
				}
				return new Response("nope", { status: 404 });
			},
		});

		expect(broker).toEqual({
			baseUrl: "http://127.0.0.1:4318",
			brokerId: "existing",
			port: 4318,
		});
		expect(probes).toEqual([
			"http://127.0.0.1:4317/api/health",
			"http://127.0.0.1:4318/api/health",
		]);
	});

	test("ignores unrelated services occupying candidate ports", async () => {
		const broker = await discoverCompatibleBroker({
			host: "127.0.0.1",
			ports: [4317, 4318],
			fetch: async (url) => {
				if (String(url).includes(":4318/")) {
					return Response.json({
						service: BROWSER_BROKER_SERVICE,
						protocol_version: BROWSER_PROTOCOL_VERSION,
						broker_id: "existing",
					});
				}
				// A different HTTP service listening on 4317.
				return Response.json({ service: "some-other-app" });
			},
		});

		expect(broker?.port).toBe(4318);
	});
});

describe("resolveBrokerPorts precedence", () => {
	test("explicit port wins over everything else", () => {
		expect(
			resolveBrokerPorts({
				port: 4500,
				portRange: "4317-4319",
				configPortRange: "5000-5001",
				env: {
					OMP_BROWSER_BROKER_PORT: "6000",
					OMP_BROWSER_BROKER_PORT_RANGE: "7000-7001",
				},
			}),
		).toEqual([4500]);
	});

	test("explicit range wins over env, config, default", () => {
		expect(
			resolveBrokerPorts({
				portRange: "4317-4319",
				configPortRange: "5000-5001",
				env: { OMP_BROWSER_BROKER_PORT_RANGE: "7000-7001" },
			}),
		).toEqual([4317, 4318, 4319]);
	});

	test("environment value wins over config and default", () => {
		expect(
			resolveBrokerPorts({
				configPortRange: "5000-5001",
				env: { OMP_BROWSER_BROKER_PORT: "6000" },
			}),
		).toEqual([6000]);
		expect(
			resolveBrokerPorts({
				configPortRange: "5000-5001",
				env: { OMP_BROWSER_BROKER_PORT_RANGE: "7000-7001" },
			}),
		).toEqual([7000, 7001]);
	});

	test("config-file value wins over default", () => {
		expect(
			resolveBrokerPorts({ configPortRange: "5000-5001", env: {} }),
		).toEqual([5000, 5001]);
	});

	test("falls back to the default range", () => {
		const ports = resolveBrokerPorts({ env: {} });
		expect(ports[0]).toBe(4317);
		expect(ports[ports.length - 1]).toBe(4337);
	});

	test("rejects an invalid environment port", () => {
		expect(() =>
			resolveBrokerPorts({ env: { OMP_BROWSER_BROKER_PORT: "not-a-port" } }),
		).toThrow(/Invalid OMP_BROWSER_BROKER_PORT/);
	});
});

describe("discovery metadata file", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-discovery-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("writes atomically with 0600 mode and leaves no temp files", async () => {
		const filePath = path.join(dir, "broker.json");
		await writeDiscoveryFile(filePath, makeDiscovery({ port: 4317 }));
		await writeDiscoveryFile(filePath, makeDiscovery({ port: 4319 }));

		const stat = await fs.stat(filePath);
		expect(stat.mode & 0o777).toBe(0o600);

		const read = await readDiscoveryFile(filePath);
		expect(read?.port).toBe(4319);

		const entries = await fs.readdir(dir);
		expect(entries).toEqual(["broker.json"]);
	});

	test("returns undefined for a missing file", async () => {
		expect(await readDiscoveryFile(path.join(dir, "absent.json"))).toBe(
			undefined,
		);
	});

	test("returns undefined for malformed JSON", async () => {
		const filePath = path.join(dir, "broker.json");
		await fs.writeFile(filePath, "{ not valid json");
		expect(await readDiscoveryFile(filePath)).toBe(undefined);
	});

	test("returns undefined for a valid JSON file missing required fields", async () => {
		const filePath = path.join(dir, "broker.json");
		await fs.writeFile(filePath, JSON.stringify({ host: "127.0.0.1" }));
		expect(await readDiscoveryFile(filePath)).toBe(undefined);
	});

	test("concurrent writers never expose partial JSON", async () => {
		const filePath = path.join(dir, "broker.json");
		await Promise.all(
			Array.from({ length: 25 }, (_, i) =>
				writeDiscoveryFile(filePath, makeDiscovery({ port: 4317 + i })),
			),
		);
		const read = await readDiscoveryFile(filePath);
		expect(read).not.toBe(undefined);
		expect(read?.broker_id).toBe("local");

		const entries = await fs.readdir(dir);
		expect(entries).toEqual(["broker.json"]);
	});

	test("removes a file owned by the caller's pid", async () => {
		const filePath = path.join(dir, "broker.json");
		await writeDiscoveryFile(filePath, makeDiscovery({ pid: process.pid }));
		expect(await removeOwnedDiscoveryFile(filePath, process.pid)).toBe(true);
		expect(await readDiscoveryFile(filePath)).toBe(undefined);
	});

	test("removes a file whose recorded pid is dead", async () => {
		const child = Bun.spawn(["sleep", "30"]);
		const deadPid = child.pid;
		child.kill();
		await child.exited;
		expect(isProcessAlive(deadPid)).toBe(false);

		const filePath = path.join(dir, "broker.json");
		await writeDiscoveryFile(filePath, makeDiscovery({ pid: deadPid }));
		expect(await removeOwnedDiscoveryFile(filePath, process.pid)).toBe(true);
		expect(await readDiscoveryFile(filePath)).toBe(undefined);
	});

	test("keeps a file owned by a live foreign pid", async () => {
		const child = Bun.spawn(["sleep", "30"]);
		try {
			expect(isProcessAlive(child.pid)).toBe(true);
			const filePath = path.join(dir, "broker.json");
			await writeDiscoveryFile(filePath, makeDiscovery({ pid: child.pid }));
			expect(await removeOwnedDiscoveryFile(filePath, process.pid)).toBe(false);
			expect(await readDiscoveryFile(filePath)).not.toBe(undefined);
		} finally {
			child.kill();
			await child.exited;
		}
	});
});
