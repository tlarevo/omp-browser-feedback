#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";

type DependencySection =
	| "dependencies"
	| "devDependencies"
	| "peerDependencies"
	| "optionalDependencies";
type Manifest = Record<string, unknown> &
	Partial<Record<DependencySection, Record<string, string>>>;

const dependencySections: DependencySection[] = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];

export function rewriteWorkspaceProtocolRanges(
	manifest: Manifest,
	versionsByName: Record<string, string>,
): Manifest {
	const rewritten = structuredClone(manifest);
	for (const section of dependencySections) {
		const deps = rewritten[section];
		if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
		for (const [name, specifier] of Object.entries(deps)) {
			if (!specifier.startsWith("workspace:")) continue;
			const version = versionsByName[name];
			if (!version)
				throw new Error(
					`Missing local version mapping for workspace dependency ${name}`,
				);
			const workspaceRange = specifier.slice("workspace:".length);
			if (!workspaceRange || workspaceRange === "*") {
				deps[name] = version;
				continue;
			}
			if (workspaceRange === "^" || workspaceRange === "~") {
				deps[name] = `${workspaceRange}${version}`;
				continue;
			}
			deps[name] = workspaceRange;
		}
	}
	return rewritten;
}

async function collectWorkspaceVersions(
	repoRoot: string,
): Promise<Record<string, string>> {
	const packagesDir = path.join(repoRoot, "packages");
	const entries = await fs.readdir(packagesDir, { withFileTypes: true });
	const versionsByName: Record<string, string> = {};
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const manifestPath = path.join(packagesDir, entry.name, "package.json");
		const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
			name?: string;
			version?: string;
		};
		if (
			typeof manifest.name === "string" &&
			typeof manifest.version === "string"
		) {
			versionsByName[manifest.name] = manifest.version;
		}
	}
	return versionsByName;
}

async function main(): Promise<void> {
	const [packageDirArg, outDirArg] = process.argv.slice(2);
	if (!packageDirArg || !outDirArg) {
		throw new Error(
			"Usage: bun scripts/prepare-release-package.ts <package-dir> <out-dir>",
		);
	}

	const repoRoot = path.resolve(import.meta.dir, "..");
	const packageDir = path.resolve(repoRoot, packageDirArg);
	const outDir = path.resolve(repoRoot, outDirArg);
	const versionsByName = await collectWorkspaceVersions(repoRoot);

	await fs.rm(outDir, { recursive: true, force: true });
	await fs.mkdir(path.dirname(outDir), { recursive: true });
	await fs.cp(packageDir, outDir, {
		recursive: true,
		filter: (source) =>
			!source.endsWith("node_modules") && !source.endsWith(".tgz"),
	});

	const manifestPath = path.join(outDir, "package.json");
	const manifest = JSON.parse(
		await fs.readFile(manifestPath, "utf8"),
	) as Manifest;
	const rewritten = rewriteWorkspaceProtocolRanges(manifest, versionsByName);
	await fs.writeFile(
		manifestPath,
		`${JSON.stringify(rewritten, null, "\t")}\n`,
	);
	console.log(path.relative(repoRoot, outDir));
}

if (import.meta.main) {
	await main();
}
