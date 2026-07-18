#!/usr/bin/env bun
/**
 * Builds a deterministic Chrome Web Store zip from a clean checkout.
 *
 * The manifest `version` in the output zip equals the Chrome product release
 * version — NOT the protocol version or OMP package version.
 *
 * Usage:
 *   bun scripts/build-store-zip.ts [output-dir]
 *
 * Default output: .release/chrome-store/
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.resolve(import.meta.dir, "..");
const extensionDir = path.join(repoRoot, "packages", "browser-extension");
const manifestPath = path.join(extensionDir, "manifest.json");
const distDir = path.join(extensionDir, "dist");
const defaultOutputDir = path.join(repoRoot, ".release", "chrome-store");

// Files/dirs to exclude from the zip (even if present in dist/)
const FORBIDDEN_PATTERNS = [
	/\.map$/,
	/\.test\./,
	/\.spec\./,
	/__tests__/,
	/\.d\.ts$/,
	/node_modules/,
];

interface Manifest {
	manifest_version: number;
	name: string;
	version: string;
	description: string;
	[key: string]: unknown;
}

async function readManifest(): Promise<Manifest> {
	const raw = await Bun.file(manifestPath).json();
	return raw as Manifest;
}

async function collectFiles(dir: string, base: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const fullPath = path.join(dir, entry.name);
		const relativePath = path.join(base, entry.name);

		if (entry.isDirectory()) {
			const nested = await collectFiles(fullPath, relativePath);
			files.push(...nested);
		} else if (entry.isFile()) {
			if (!FORBIDDEN_PATTERNS.some((p) => p.test(entry.name))) {
				files.push(relativePath);
			}
		}
	}

	return files;
}

async function main(): Promise<void> {
	const outputDir = process.argv[2]
		? path.resolve(process.argv[2])
		: defaultOutputDir;

	const manifest = await readManifest();

	if (!manifest.version) {
		throw new Error("manifest.json missing 'version' field");
	}

	if (manifest.manifest_version !== 3) {
		throw new Error(
			`Expected manifest_version 3, got ${manifest.manifest_version}`,
		);
	}

	// Verify dist/ exists (extension must be built first)
	try {
		await fs.access(distDir);
	} catch {
		throw new Error(
			`dist/ not found at ${distDir}. Run 'bun run build:extension' first.`,
		);
	}

	// Collect files from dist/
	const distFiles = await collectFiles(distDir, "dist");

	// Create output directory
	await fs.mkdir(outputDir, { recursive: true });

	const zipName = `omp-browser-feedback-${manifest.version}.zip`;
	const zipPath = path.join(outputDir, zipName);

	// Remove old zip if it exists
	await fs.rm(zipPath, { force: true });

	// Build zip using the system zip command for deterministic output
	// -j: junk directory paths (store flat)
	// -X: no extra file attributes (deterministic)
	await $`cd ${extensionDir} && zip -j -X ${zipPath} manifest.json ${distFiles.join(" ")}`.quiet();

	// Write manifest copy for verification
	await Bun.write(
		path.join(outputDir, "manifest.json"),
		await Bun.file(manifestPath).text(),
	);

	console.log(`Chrome Web Store zip: ${zipPath}`);
	console.log(`Version: ${manifest.version}`);
	console.log(`Entries: ${distFiles.length + 1} files`);
	console.log(`Files: manifest.json, ${distFiles.join(", ")}`);
}

if (import.meta.main) {
	await main();
}
