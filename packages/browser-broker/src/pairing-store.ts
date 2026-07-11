import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 6;
const PAIRING_TTL_MS = 2 * 60 * 1000;
const PAIRING_ATTEMPT_LIMIT = 5;
const CAPABILITY_LAST_USED_PERSIST_INTERVAL_MS = 5 * 60 * 1000;
const PAIRING_REGISTRY_VERSION = 1;

export interface PairingStoreClock {
	now(): Date;
}

export interface BrowserCapabilityRecord {
	browserInstallId: string;
	capabilityTokenHash: string;
	label?: string;
	createdAt: string;
	lastUsedAt?: string;
	revokedAt?: string;
}

export interface PairingWindowRecord {
	pairingId: string;
	codeHash: string;
	createdBySessionId: string;
	expiresAt: string;
	attemptsRemaining: number;
	consumedAt?: string;
}

interface PairingRegistryFile {
	version: number;
	browserCapabilities: BrowserCapabilityRecord[];
}

interface PairingStoreOptions {
	clock?: PairingStoreClock;
	registryPath: string;
}

function createEmptyRegistryFile(): PairingRegistryFile {
	return {
		version: PAIRING_REGISTRY_VERSION,
		browserCapabilities: [],
	};
}

function isValidDateString(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isOptionalDateString(value: unknown): value is string | undefined {
	return value === undefined || isValidDateString(value);
}

function isBrowserCapabilityRecord(
	value: unknown,
): value is BrowserCapabilityRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.browserInstallId === "string" &&
		typeof record.capabilityTokenHash === "string" &&
		(record.label === undefined || typeof record.label === "string") &&
		isValidDateString(record.createdAt) &&
		isOptionalDateString(record.lastUsedAt) &&
		isOptionalDateString(record.revokedAt)
	);
}

function quarantineInvalidRegistryFile(registryPath: string): void {
	const invalidPath = `${registryPath}.invalid-${Date.now()}.json`;
	try {
		fs.renameSync(registryPath, invalidPath);
	} catch {}
}

function randomHex(bytes: number): string {
	const values = new Uint8Array(bytes);
	crypto.getRandomValues(values);
	return Array.from(values, (value) =>
		value.toString(16).padStart(2, "0"),
	).join("");
}

function hashValue(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function sanitizeLabel(label: string | undefined): string | undefined {
	if (typeof label !== "string") return undefined;
	const trimmed = label.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function createPairingCode(): string {
	const values = new Uint8Array(PAIRING_CODE_LENGTH);
	crypto.getRandomValues(values);
	return Array.from(
		values,
		(value) => PAIRING_CODE_ALPHABET[value % PAIRING_CODE_ALPHABET.length],
	).join("");
}

function loadRegistryFile(registryPath: string): PairingRegistryFile {
	if (!fs.existsSync(registryPath)) {
		return createEmptyRegistryFile();
	}

	try {
		const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
			version?: unknown;
			browserCapabilities?: unknown;
		};
		if (
			parsed.version !== PAIRING_REGISTRY_VERSION ||
			!Array.isArray(parsed.browserCapabilities) ||
			!parsed.browserCapabilities.every((record) =>
				isBrowserCapabilityRecord(record),
			)
		) {
			throw new Error("Invalid pairing registry file");
		}

		return {
			version: PAIRING_REGISTRY_VERSION,
			browserCapabilities: parsed.browserCapabilities,
		};
	} catch {
		quarantineInvalidRegistryFile(registryPath);
		return createEmptyRegistryFile();
	}
}

function persistRegistryFile(
	registryPath: string,
	registry: PairingRegistryFile,
): void {
	fs.mkdirSync(path.dirname(registryPath), { recursive: true, mode: 0o700 });
	const tmpPath = `${registryPath}.${process.pid}.tmp`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, {
		mode: 0o600,
	});
	fs.chmodSync(tmpPath, 0o600);
	fs.renameSync(tmpPath, registryPath);
	fs.chmodSync(registryPath, 0o600);
}

export function createPairingStore(options: PairingStoreOptions) {
	const clock = options.clock ?? { now: () => new Date() };
	const registryPath = options.registryPath;
	let registry = loadRegistryFile(registryPath);
	const lastPersistedUsageAtByHash = new Map(
		registry.browserCapabilities.map((record) => [
			record.capabilityTokenHash,
			record.lastUsedAt ?? record.createdAt,
		]),
	);
	let activePairing: PairingWindowRecord | undefined;

	return {
		async issuePairingCode(createdBySessionId: string) {
			const issuedAt = clock.now();
			const code = createPairingCode();
			activePairing = {
				pairingId: `pair_${randomHex(8)}`,
				codeHash: hashValue(code),
				createdBySessionId,
				expiresAt: new Date(issuedAt.getTime() + PAIRING_TTL_MS).toISOString(),
				attemptsRemaining: PAIRING_ATTEMPT_LIMIT,
			};
			return {
				pairingId: activePairing.pairingId,
				code,
				expiresAt: activePairing.expiresAt,
			};
		},

		async redeemPairingCode(input: {
			browserInstallId: string;
			code: string;
			label?: string;
		}) {
			const browserInstallId = input.browserInstallId.trim();
			if (browserInstallId.length === 0) {
				throw new Error("browserInstallId is required");
			}
			if (input.code.trim().length === 0) {
				throw new Error("Pairing code is required");
			}
			if (!activePairing) {
				throw new Error("No active pairing window");
			}

			const currentTime = clock.now().toISOString();
			if (activePairing.consumedAt) {
				throw new Error("Pairing code is single-use");
			}
			if (currentTime > activePairing.expiresAt) {
				activePairing.consumedAt = currentTime;
				throw new Error("Pairing code expired");
			}
			if (activePairing.attemptsRemaining <= 0) {
				activePairing.consumedAt = currentTime;
				throw new Error("Pairing code attempt limit reached");
			}

			if (
				hashValue(input.code.trim().toUpperCase()) !== activePairing.codeHash
			) {
				activePairing.attemptsRemaining -= 1;
				if (activePairing.attemptsRemaining <= 0) {
					activePairing.consumedAt = currentTime;
					throw new Error("Pairing code attempt limit reached");
				}
				throw new Error("Invalid pairing code");
			}

			activePairing.consumedAt = currentTime;
			const capabilityToken = `bcap_${randomHex(24)}`;
			const label = sanitizeLabel(input.label);
			registry = {
				...registry,
				browserCapabilities: [
					...registry.browserCapabilities.map((record) =>
						record.browserInstallId === browserInstallId && !record.revokedAt
							? {
									...record,
									revokedAt: currentTime,
								}
							: record,
					),
					{
						browserInstallId,
						capabilityTokenHash: hashValue(capabilityToken),
						...(label ? { label } : {}),
						createdAt: currentTime,
					},
				],
			};
			persistRegistryFile(registryPath, registry);
			lastPersistedUsageAtByHash.set(hashValue(capabilityToken), currentTime);
			return { capabilityToken };
		},
		async revokeAllBrowserCapabilities() {
			activePairing = undefined;
			const revokedAt = clock.now().toISOString();
			let changed = false;
			registry = {
				...registry,
				browserCapabilities: registry.browserCapabilities.map((record) => {
					if (record.revokedAt) return record;
					changed = true;
					return { ...record, revokedAt };
				}),
			};
			if (changed) persistRegistryFile(registryPath, registry);
		},

		validateBrowserCapability(capabilityToken: string): boolean {
			const normalizedToken = capabilityToken.trim();
			if (normalizedToken.length === 0) return false;
			const capabilityTokenHash = hashValue(normalizedToken);
			const matched = registry.browserCapabilities.find(
				(record) =>
					record.capabilityTokenHash === capabilityTokenHash &&
					!record.revokedAt,
			);
			if (!matched) return false;
			const currentTime = clock.now();
			const lastUsedAt = currentTime.toISOString();
			const persistedReference =
				lastPersistedUsageAtByHash.get(matched.capabilityTokenHash) ??
				matched.createdAt ??
				lastUsedAt;
			const persistedReferenceMs = Date.parse(persistedReference);
			const shouldPersistUsage =
				Number.isNaN(persistedReferenceMs) ||
				currentTime.getTime() - persistedReferenceMs >=
					CAPABILITY_LAST_USED_PERSIST_INTERVAL_MS;
			registry = {
				...registry,
				browserCapabilities: registry.browserCapabilities.map((record) =>
					record === matched ? { ...record, lastUsedAt } : record,
				),
			};
			if (shouldPersistUsage) {
				persistRegistryFile(registryPath, registry);
				lastPersistedUsageAtByHash.set(matched.capabilityTokenHash, lastUsedAt);
			}
			return true;
		},
	};
}
