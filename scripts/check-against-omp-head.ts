#!/usr/bin/env bun
/**
 * Typechecks the OMP-facing workspace package against the current upstream OMP host source.
 *
 * Algorithm:
 *  1. Shallow-clone `OMP_REPO`@`OMP_REF` (defaults: `can1357/oh-my-pi`@`main`) into a temp dir.
 *  2. Install the clone dependencies.
 *  3. Emit declarations for every publishable host package (`tsconfig.publish.json`) and rewrite
 *     each manifest's `types` / `exports[*].types` entries to point at the emitted `dist/types/**` files.
 *  4. Swap this repo's installed `@oh-my-pi/pi-coding-agent` dependency for the rewritten clone package.
 *  5. Typecheck `packages/browser-omp-extension` against that swapped host package.
 *  6. Restore the original dependency and remove temp files even if typechecking fails.
 *
 * Override the clone source for offline runs or pinned compatibility checks:
 *   OMP_REPO=https://github.com/you/oh-my-pi.git OMP_REF=v16.3.0 bun run check:omp-head
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const repo = process.env.OMP_REPO ?? "https://github.com/can1357/oh-my-pi.git";
const ref = process.env.OMP_REF ?? "main";
const repoRoot = path.resolve(import.meta.dir, "..");
const targetPackageDir = path.join(
	repoRoot,
	"packages",
	"browser-omp-extension",
);
const tmpTsconfig = path.join(targetPackageDir, "tsconfig.omp-head.json");
const swapTargets = [
	{ packageName: "@oh-my-pi/pi-coding-agent", dir: "coding-agent" },
] as const;
const hostPackages = [
	"utils",
	"ai",
	"catalog",
	"tui",
	"agent",
	"hashline",
	"mnemopi",
	"natives",
	"wire",
	"snapcompact",
	"stats",
	"coding-agent",
] as const;

type Exports = string | { [condition: string]: Exports } | Exports[];

/** Rewrite a `./src/foo.ts(x)` types path to its emitted `./dist/types/foo.d.ts`. */
export function rewriteTypesPath(value: string): string {
	return value.replace(/^\.\/src\/(.+)\.tsx?$/, "./dist/types/$1.d.ts");
}

/** Recursively rewrite every `types` condition found in a package `exports` map. */
export function rewriteExports(node: Exports): Exports {
	if (typeof node === "string") return node;
	if (Array.isArray(node)) return node.map(rewriteExports);
	const out: { [condition: string]: Exports } = {};
	for (const [key, value] of Object.entries(node)) {
		out[key] =
			key === "types" && typeof value === "string"
				? rewriteTypesPath(value)
				: rewriteExports(value);
	}
	return out;
}

async function repointManifest(pkgDir: string): Promise<void> {
	const manifestPath = path.join(pkgDir, "package.json");
	const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
	if (typeof manifest.types === "string")
		manifest.types = rewriteTypesPath(manifest.types);
	if (manifest.exports) manifest.exports = rewriteExports(manifest.exports);
	await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-head-"));
	const swapped: Array<{ live: string; backup: string }> = [];
	let tsconfigWritten = false;

	try {
		console.log(`Cloning ${repo}@${ref} …`);
		await $`git clone --depth 1 --branch ${ref} ${repo} ${tmp}`.quiet();

		console.log("Installing clone dependencies …");
		const frozen = await $`bun install --frozen-lockfile`
			.cwd(tmp)
			.nothrow()
			.quiet();
		if (frozen.exitCode !== 0) {
			console.log(
				"Frozen install failed (lockfile drift) — retrying with a plain install …",
			);
			await $`bun install`.cwd(tmp).quiet();
		}

		const tsgoBin = path.join(tmp, "node_modules", ".bin", "tsgo");
		for (const pkg of hostPackages) {
			const pkgDir = path.join(tmp, "packages", pkg);
			console.log(`Emitting declarations for ${pkg} …`);
			await $`${tsgoBin} -p tsconfig.publish.json`.cwd(pkgDir).quiet();
			await repointManifest(pkgDir);
		}

		for (const { packageName, dir } of swapTargets) {
			const live = path.join(targetPackageDir, "node_modules", packageName);
			const backup = `${live}.bak`;
			const clonePkg = path.join(tmp, "packages", dir);
			await fs.rename(live, backup);
			swapped.push({ live, backup });
			await fs.symlink(clonePkg, live, "dir");
		}

		await fs.writeFile(
			tmpTsconfig,
			`${JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { paths: {} } }, null, "\t")}\n`,
		);
		tsconfigWritten = true;

		console.log(
			`Typechecking ${path.relative(repoRoot, targetPackageDir)} against omp ${ref} …`,
		);
		const localTsgo = path.join(repoRoot, "node_modules", ".bin", "tsgo");
		const result =
			await $`${localTsgo} -p ${path.basename(tmpTsconfig)} --noEmit`
				.cwd(targetPackageDir)
				.nothrow();
		if (result.exitCode === 0) {
			console.log(`✓ browser-omp-extension typechecks against omp ${ref}`);
		} else {
			console.error(
				`✗ browser-omp-extension does NOT typecheck against omp ${ref}`,
			);
		}
		process.exitCode = result.exitCode;
	} finally {
		for (const { live, backup } of swapped) {
			if (await exists(live))
				await fs.rm(live, { force: true, recursive: true });
			if (await exists(backup)) await fs.rename(backup, live);
		}
		if (tsconfigWritten) await fs.rm(tmpTsconfig, { force: true });
		await fs.rm(tmp, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	await main();
}
