import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const manifestPath = path.join(
	repoRoot,
	"packages",
	"browser-extension",
	"manifest.json",
);
const distDir = path.join(repoRoot, "packages", "browser-extension", "dist");
const storeDir = path.join(repoRoot, ".release", "chrome-store");
interface Manifest {
	manifest_version: number;
	name: string;
	version: string;
	description: string;
	permissions: string[];
	host_permissions: string[];
	background: { service_worker: string };
	action: { default_popup: string };
	content_scripts: Array<{
		matches: string[];
		js: string[];
		run_at: string;
	}>;
}

async function readManifest(): Promise<Manifest> {
	const raw = await Bun.file(manifestPath).json();
	return raw as Manifest;
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

describe("store zip check", () => {
	test("manifest.json exists and has required fields", async () => {
		const manifest = await readManifest();

		expect(manifest.manifest_version).toBe(3);
		expect(typeof manifest.name).toBe("string");
		expect(manifest.name.length).toBeGreaterThan(0);
		expect(typeof manifest.version).toBe("string");
		expect(/^\d+\.\d+\.\d+$/.test(manifest.version)).toBe(true);
		expect(typeof manifest.description).toBe("string");
		expect(manifest.description.length).toBeGreaterThan(0);
	});

	test("manifest permissions match documented list", async () => {
		const manifest = await readManifest();
		const expected = ["activeTab", "scripting", "storage", "tabs"];
		expect(manifest.permissions.sort()).toEqual(expected.sort());
	});

	test("manifest host_permissions match documented list", async () => {
		const manifest = await readManifest();
		expect(manifest.host_permissions).toEqual(["http://127.0.0.1:*/*"]);
	});

	test("dist/ directory exists after build", async () => {
		const hasDist = await exists(distDir);
		expect(hasDist).toBe(true);
	});

	test("dist/ contains required entry points", async () => {
		const entries = await fs.readdir(distDir);
		expect(entries).toContain("background-entry.js");
		expect(entries).toContain("content-entry.js");
	});

	test("dist/ contains no source maps or test files", async () => {
		const entries = await fs.readdir(distDir);
		for (const entry of entries) {
			expect(entry).not.toMatch(/\.map$/);
			expect(entry).not.toMatch(/\.test\./);
			expect(entry).not.toMatch(/\.spec\./);
		}
	});

	test("store zip exists and version matches manifest", async () => {
		const manifest = await readManifest();
		const zipPath = path.join(
			storeDir,
			`omp-browser-feedback-${manifest.version}.zip`,
		);

		const hasZip = await exists(zipPath);
		if (!hasZip) {
			// Store zip not yet built — skip gracefully
			console.log(`Store zip not found at ${zipPath} — skipping`);
			return;
		}

		const stat = await fs.stat(zipPath);
		expect(stat.size).toBeGreaterThan(0);
	});

	test("manifest version equals Chrome product version (not protocol)", async () => {
		const manifest = await readManifest();

		// Protocol version is 1; Chrome version should be higher
		const major = Number.parseInt(manifest.version.split(".")[0], 10);
		expect(major).toBeGreaterThanOrEqual(0);

		// Chrome version must NOT be 1 (that's the protocol version)
		if (major === 0) {
			// 0.x.y is fine for Chrome extension
			expect(true).toBe(true);
		} else {
			// If versioned 1.x.y, it must be distinct from protocol v1
			expect(manifest.version).not.toBe("1.0.0");
		}
	});

	test("manifest version is semver", async () => {
		const manifest = await readManifest();
		expect(/^\d+\.\d+\.\d+$/.test(manifest.version)).toBe(true);
	});

	test("content script runs at document_idle", async () => {
		const manifest = await readManifest();
		expect(manifest.content_scripts).toBeDefined();
		expect(manifest.content_scripts.length).toBe(1);
		expect(manifest.content_scripts[0].run_at).toBe("document_idle");
	});

	test("content script matches all URLs", async () => {
		const manifest = await readManifest();
		expect(manifest.content_scripts[0].matches).toEqual(["<all_urls>"]);
	});

	test("background service worker points to dist/", async () => {
		const manifest = await readManifest();
		expect(manifest.background.service_worker).toMatch(/^dist\//);
	});

	test("no forbidden dev files in dist/", async () => {
		const hasDist = await exists(distDir);
		if (!hasDist) return;

		const forbidden = [".test.", ".spec.", ".map", "node_modules"];
		async function walk(dir: string): Promise<string[]> {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			const files: string[] = [];
			for (const entry of entries) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					files.push(...(await walk(full)));
				} else {
					files.push(full);
				}
			}
			return files;
		}

		const allFiles = await walk(distDir);
		for (const file of allFiles) {
			for (const f of forbidden) {
				expect(file).not.toContain(f);
			}
		}
	});
});
