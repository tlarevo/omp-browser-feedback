import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	createPairingStore,
	type PairingStoreClock,
} from "../src/pairing-store";

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function createRegistryPath(): Promise<string> {
	const dir = await fs.mkdtemp(path.join("/tmp", "omp-browser-pairing-"));
	dirs.push(dir);
	return path.join(dir, "registry.json");
}

describe("pairing store", () => {
	test("redeems a short-lived code exactly once", async () => {
		const registryPath = await createRegistryPath();
		const now = new Date("2026-07-04T00:00:00.000Z");
		const clock: PairingStoreClock = { now: () => new Date(now) };
		const store = createPairingStore({ clock, registryPath });

		const issued = await store.issuePairingCode("ses_1");
		const first = await store.redeemPairingCode({
			browserInstallId: "browser_a",
			code: issued.code,
		});

		expect(first.capabilityToken.length).toBeGreaterThan(20);
		await expect(
			store.redeemPairingCode({
				browserInstallId: "browser_a",
				code: issued.code,
			}),
		).rejects.toThrow(/single-use/i);
	});

	test("rejects an expired code", async () => {
		const registryPath = await createRegistryPath();
		const now = new Date("2026-07-04T00:00:00.000Z");
		const clock: PairingStoreClock = { now: () => new Date(now) };
		const store = createPairingStore({ clock, registryPath });
		const issued = await store.issuePairingCode("ses_1");

		now.setMinutes(now.getMinutes() + 3);

		await expect(
			store.redeemPairingCode({
				browserInstallId: "browser_a",
				code: issued.code,
			}),
		).rejects.toThrow(/expired/i);
	});

	test("persists browser capabilities across store recreation", async () => {
		const registryPath = await createRegistryPath();
		const store = createPairingStore({ registryPath });
		const issued = await store.issuePairingCode("ses_1");
		const redeemed = await store.redeemPairingCode({
			browserInstallId: "browser_a",
			code: issued.code,
			label: "Primary Browser",
		});

		const restarted = createPairingStore({ registryPath });

		expect(restarted.validateBrowserCapability(redeemed.capabilityToken)).toBe(
			true,
		);
	});

	test("recovers from an invalid registry file by quarantining it", async () => {
		const registryPath = await createRegistryPath();
		await fs.writeFile(
			registryPath,
			'{"version":999,"browserCapabilities":"bad"}',
		);

		const store = createPairingStore({ registryPath });
		const issued = await store.issuePairingCode("ses_1");
		const redeemed = await store.redeemPairingCode({
			browserInstallId: "browser_a",
			code: issued.code,
		});

		expect(store.validateBrowserCapability(redeemed.capabilityToken)).toBe(
			true,
		);

		const dirEntries = await fs.readdir(path.dirname(registryPath));
		expect(dirEntries).toContain("registry.json");
		expect(
			dirEntries.some(
				(entry) =>
					entry.startsWith("registry.json.invalid-") && entry.endsWith(".json"),
			),
		).toBe(true);
	});

	test("recovers from malformed capability records", async () => {
		const registryPath = await createRegistryPath();
		await fs.writeFile(
			registryPath,
			JSON.stringify({
				version: 1,
				browserCapabilities: [
					{
						browserInstallId: "browser_a",
						capabilityTokenHash: "hash_1",
						createdAt: "not-a-date",
					},
				],
			}),
		);

		const store = createPairingStore({ registryPath });
		const issued = await store.issuePairingCode("ses_1");
		const redeemed = await store.redeemPairingCode({
			browserInstallId: "browser_a",
			code: issued.code,
		});

		expect(store.validateBrowserCapability(redeemed.capabilityToken)).toBe(
			true,
		);

		const dirEntries = await fs.readdir(path.dirname(registryPath));
		expect(
			dirEntries.some(
				(entry) =>
					entry.startsWith("registry.json.invalid-") && entry.endsWith(".json"),
			),
		).toBe(true);
	});

	test("persists capability usage after repeated validations cross the throttle window", async () => {
		const registryPath = await createRegistryPath();
		const now = new Date("2026-07-04T00:00:00.000Z");
		const clock: PairingStoreClock = { now: () => new Date(now) };
		const store = createPairingStore({ clock, registryPath });
		const issued = await store.issuePairingCode("ses_1");
		const redeemed = await store.redeemPairingCode({
			browserInstallId: "browser_a",
			code: issued.code,
		});

		const beforeValidate = await fs.readFile(registryPath, "utf8");

		for (let minute = 1; minute <= 4; minute += 1) {
			now.setMinutes(minute);
			expect(store.validateBrowserCapability(redeemed.capabilityToken)).toBe(
				true,
			);
			expect(await fs.readFile(registryPath, "utf8")).toBe(beforeValidate);
		}

		now.setMinutes(6);
		expect(store.validateBrowserCapability(redeemed.capabilityToken)).toBe(
			true,
		);

		const afterThrottleWindow = await fs.readFile(registryPath, "utf8");
		expect(afterThrottleWindow).toContain(
			'"lastUsedAt": "2026-07-04T00:06:00.000Z"',
		);

		const dirEntries = await fs.readdir(path.dirname(registryPath));
		expect(dirEntries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
	});

	test("revokes persisted capabilities", async () => {
		const registryPath = await createRegistryPath();
		const store = createPairingStore({ registryPath });
		const issued = await store.issuePairingCode("ses_1");
		const redeemed = await store.redeemPairingCode({
			browserInstallId: "browser_a",
			code: issued.code,
		});

		await store.revokeAllBrowserCapabilities();

		expect(store.validateBrowserCapability(redeemed.capabilityToken)).toBe(
			false,
		);
		expect(
			createPairingStore({ registryPath }).validateBrowserCapability(
				redeemed.capabilityToken,
			),
		).toBe(false);
	});

	test("limits incorrect code attempts", async () => {
		const registryPath = await createRegistryPath();
		const store = createPairingStore({ registryPath });
		const issued = await store.issuePairingCode("ses_1");

		for (let attempt = 0; attempt < 4; attempt += 1) {
			await expect(
				store.redeemPairingCode({
					browserInstallId: "browser_a",
					code: "WRONG1",
				}),
			).rejects.toThrow(/invalid pairing code/i);
		}

		await expect(
			store.redeemPairingCode({
				browserInstallId: "browser_a",
				code: "WRONG1",
			}),
		).rejects.toThrow(/attempt limit/i);
		await expect(
			store.redeemPairingCode({
				browserInstallId: "browser_a",
				code: issued.code,
			}),
		).rejects.toThrow(/single-use|attempt limit/i);
	});
});

test("reset revokes capabilities and closes the active pairing window", async () => {
	const registryPath = await createRegistryPath();
	const store = createPairingStore({ registryPath });
	const issued = await store.issuePairingCode("ses_1");
	const redeemed = await store.redeemPairingCode({
		browserInstallId: "browser_a",
		code: issued.code,
	});

	await store.revokeAllBrowserCapabilities();

	expect(store.validateBrowserCapability(redeemed.capabilityToken)).toBe(false);
	const nextIssued = await store.issuePairingCode("ses_1");
	await store.revokeAllBrowserCapabilities();
	await expect(
		store.redeemPairingCode({
			browserInstallId: "browser_b",
			code: nextIssued.code,
		}),
	).rejects.toThrow(/no active pairing window/i);
});
