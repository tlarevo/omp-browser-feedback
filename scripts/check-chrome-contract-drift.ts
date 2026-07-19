#!/usr/bin/env bun
/**
 * Check that the committed Chrome contract artifact is up to date
 * with the current OMP protocol source.
 *
 * Algorithm:
 *  1. Generate the contract to a temp file.
 *  2. Read the committed artifact.
 *  3. Byte-compare.  Fail with a diff if they differ.
 *
 * Run via `bun run check:chrome-contract` (included in root `check`).
 * Regenerate with `bun run generate:chrome-contract`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.resolve(import.meta.dir, "..");
const committedPath = path.join(repoRoot, "contracts", "chrome-contract.json");

async function main(): Promise<void> {
	// 1. Generate to a temp file.
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-contract-"));
	const tmpPath = path.join(tmpDir, "chrome-contract.json");

	try {
		await $`bun scripts/export-chrome-contract.ts ${tmpPath}`
			.cwd(repoRoot)
			.quiet();

		// 2. Read the committed artifact.
		let committed: string;
		try {
			committed = await fs.readFile(committedPath, "utf8");
		} catch {
			console.error(
				`Committed contract not found at ${committedPath}\nRun: bun run generate:chrome-contract`,
			);
			process.exit(1);
		}

		// 3. Byte-compare.
		const generated = await fs.readFile(tmpPath, "utf8");
		if (generated === committed) {
			console.log("Chrome contract artifact is up to date.");
			return;
		}

		// Compute a readable diff for the error message.
		console.error("Chrome contract drift detected.\n");
		console.error(`Committed:  ${committedPath}`);
		console.error(`Generated:  ${tmpPath}\n`);

		// Show line-level diff.
		const committedLines = committed.split("\n");
		const generatedLines = generated.split("\n");
		const maxLines = Math.max(committedLines.length, generatedLines.length);
		let diffLines = 0;
		for (let i = 0; i < maxLines; i++) {
			const c = committedLines[i];
			const g = generatedLines[i];
			if (c !== g) {
				if (diffLines < 20) {
					console.error(`  L${i + 1}: committed: ${c ?? "<missing>"}`);
					console.error(`  L${i + 1}: generated: ${g ?? "<missing>"}`);
				}
				diffLines++;
			}
		}
		if (diffLines > 20) {
			console.error(`  ... and ${diffLines - 20} more lines`);
		}

		console.error(
			`\nFix: bun run generate:chrome-contract && git add contracts/chrome-contract.json`,
		);
		process.exit(1);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	await main();
}
