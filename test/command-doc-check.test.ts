import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const readmePath = path.join(repoRoot, "README.md");
const commandsPath = path.join(
	repoRoot,
	"packages",
	"browser-omp-extension",
	"src",
	"commands.ts",
);

/**
 * Extracts command names from the README command table.
 * Expects lines like: `| /bf <subcommand> | ...`
 */
async function extractDocumentedCommands(): Promise<Set<string>> {
	const content = await Bun.file(readmePath).text();
	const commands = new Set<string>();

	// Match table rows: | /bf <sub> ... |
	const regex = /\|\s*`?\/bf\s+(\S+)/g;
	for (const match of content.matchAll(regex)) {
		const sub = match[1];
		// Normalize: remove trailing [...] or [eventId] etc, strip backticks
		const normalized = sub
			.replace(/`/g, "")
			.replace(/\[.*\]/g, "")
			.replace(/<.*>/g, "")
			.replace(/\.\.\./g, "")
			.trim();
		if (normalized) commands.add(normalized);
	}

	return commands;
}

/**
 * Extracts command names from the commands.ts handler.
 * Looks for: `if (first === "xxx")` patterns.
 */
async function extractImplementedCommands(): Promise<Set<string>> {
	const content = await Bun.file(commandsPath).text();
	const commands = new Set<string>();

	// Match: if (first === "xxx")
	const regex = /if\s*\(\s*first\s*===\s*"([^"]+)"\s*\)/g;
	for (const match of content.matchAll(regex)) {
		commands.add(match[1]);
	}

	return commands;
}
describe("command doc check", () => {
	test("every documented command is implemented", async () => {
		const documented = await extractDocumentedCommands();
		const implemented = await extractImplementedCommands();

		const missing = [...documented].filter((cmd) => !implemented.has(cmd));
		expect(
			missing,
			`Documented commands not found in commands.ts: ${missing.join(", ")}`,
		).toEqual([]);
	});

	test("every implemented command is documented", async () => {
		const documented = await extractDocumentedCommands();
		const implemented = await extractImplementedCommands();

		const undocumented = [...implemented].filter((cmd) => !documented.has(cmd));
		expect(
			undocumented,
			`Implemented commands not documented in README: ${undocumented.join(", ")}`,
		).toEqual([]);
	});

	test("README command table exists and is non-empty", async () => {
		const documented = await extractDocumentedCommands();
		expect(documented.size).toBeGreaterThan(0);
	});

	test("commands.ts file exists", async () => {
		const content = await Bun.file(commandsPath).text();
		expect(content.length).toBeGreaterThan(0);
	});

	test("README documents error states", async () => {
		const content = await Bun.file(readmePath).text();

		// Verify key error messages are documented
		const expectedErrors = [
			"Browser broker is not connected",
			"Failed to connect",
			"No in-process browser broker running",
		];

		for (const error of expectedErrors) {
			expect(content).toContain(error);
		}
	});

	test("README documents auto-run settings", async () => {
		const content = await Bun.file(readmePath).text();
		expect(content).toContain("auto-run on");
		expect(content).toContain("auto-run off");
	});

	test("README documents pair reset", async () => {
		const content = await Bun.file(readmePath).text();
		expect(content).toContain("/bf pair reset");
	});
});
