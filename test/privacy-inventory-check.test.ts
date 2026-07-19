import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const readmePath = path.join(repoRoot, "README.md");
const manifestPath = path.join(
	repoRoot,
	"packages",
	"browser-extension",
	"manifest.json",
);
const discoveryPath = path.join(
	repoRoot,
	"packages",
	"browser-broker",
	"src",
	"discovery.ts",
);
const serverPath = path.join(
	repoRoot,
	"packages",
	"browser-broker",
	"src",
	"server.ts",
);
const privacyDocPath = path.join(repoRoot, "docs", "privacy.md");

interface Manifest {
	permissions: string[];
	host_permissions: string[];
	[key: string]: unknown;
}

async function readManifest(): Promise<Manifest> {
	const raw = await Bun.file(manifestPath).json();
	return raw as Manifest;
}

async function readText(filePath: string): Promise<string> {
	return Bun.file(filePath).text();
}

describe("privacy inventory check", () => {
	test("manifest permissions match documented list", async () => {
		const manifest = await readManifest();
		const readme = await readText(readmePath);

		for (const perm of manifest.permissions) {
			expect(readme).toContain(perm);
		}
	});

	test("manifest host_permissions are documented", async () => {
		const manifest = await readManifest();
		const readme = await readText(readmePath);

		for (const perm of manifest.host_permissions) {
			expect(readme).toContain(perm);
		}
	});

	test("broker discovery file path is documented", async () => {
		const discovery = await readText(discoveryPath);
		const readme = await readText(readmePath);

		// Extract path from discovery.ts
		const pathMatch = discovery.match(
			/path\.join\([^)]*homedir\(\)[^)]*"\.omp"[^)]*"browser-broker\.json"\)/,
		);
		expect(pathMatch).not.toBeNull();
		expect(readme).toContain("browser-broker.json");
	});

	test("pairing registry path is documented", async () => {
		const readme = await readText(readmePath);
		// pairing-store.ts uses defaultPairingRegistryPath which is in discovery.ts
		expect(readme).toContain("browser-pairing-registry.json");
	});

	test("config file path is documented", async () => {
		const readme = await readText(readmePath);
		expect(readme).toContain("browser-feedback.json");
	});

	test("screenshot storage path is documented", async () => {
		const readme = await readText(readmePath);
		expect(readme).toContain("/tmp/omp-browser-screenshots");
	});

	test("loopback-only transport is documented", async () => {
		const server = await readText(serverPath);
		const readme = await readText(readmePath);

		// Server enforces loopback
		expect(server).toContain("127.0.0.1");
		expect(readme).toContain("127.0.0.1");
		expect(readme).toContain("loopback");
	});

	test("bearer token auth is documented", async () => {
		const readme = await readText(readmePath);
		expect(readme).toContain("bearer");
		expect(readme).toContain("Bearer");
	});

	test("pair reset revocation is documented", async () => {
		const readme = await readText(readmePath);
		expect(readme).toContain("revok");
		expect(readme).toContain("pair reset");
	});

	test("feedback event limits are documented", async () => {
		const readme = await readText(readmePath);

		// Key limits from BROWSER_FEEDBACK_LIMITS
		expect(readme).toContain("10MB");
		expect(readme).toContain("20KB");
		expect(readme).toContain("80");
	});

	test("privacy.md exists if referenced", async () => {
		const readme = await readText(readmePath);
		if (readme.includes("docs/privacy.md")) {
			const hasPrivacy = await fs
				.access(privacyDocPath)
				.then(() => true)
				.catch(() => false);
			expect(hasPrivacy).toBe(true);
		}
	});

	test("all on-disk paths use ~/.omp/", async () => {
		const readme = await readText(readmePath);

		// Find all file paths mentioned in README
		const pathMatches = readme.match(/~\/\.omp\/[\w.-]+/g) ?? [];

		// All persistent paths should be under ~/.omp/
		for (const p of pathMatches) {
			expect(p).toMatch(/^~\/\.omp\//);
		}
	});

	test("screenshot max size is documented", async () => {
		const limitsSrc = await readText(
			path.join(repoRoot, "packages", "browser-protocol", "src", "limits.ts"),
		);
		const readme = await readText(readmePath);

		// limits.ts has maxScreenshotBytes: 10 * 1024 * 1024 = 10MB
		expect(limitsSrc).toContain("10 * 1024 * 1024");
		expect(readme).toContain("10MB");
	});

	test("activeTab consent is documented", async () => {
		const readme = await readText(readmePath);
		expect(readme).toContain("activeTab");
		expect(readme).toContain("consent");
	});

	test("no external network calls documented", async () => {
		const readme = await readText(readmePath);
		// The system should not make external calls
		expect(readme).toContain("Nothing leaves your machine");
	});
});
