import { describe, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Static import check: ensures port and screenshot constants are not hardcoded
 * outside the shared protocol definition. If this test fails, a magic number
 * has been reintroduced — use the exported constant from @oh-my-pi/browser-protocol instead.
 */
describe("magic constants must come from protocol", () => {
	const root = path.resolve(import.meta.dir, "..", "..", "..");

	function assertNoHardcoded(
		file: string,
		pattern: RegExp,
		msg: string,
	) {
		const content = fs.readFileSync(file, "utf-8");
		const lines = content.split("\n");
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
			if (trimmed.includes("BROWSER_FEEDBACK_LIMITS")) continue;
			if (trimmed.includes("PREFERRED_BROWSER_BROKER_PORT")) continue;
			if (trimmed.includes("DEFAULT_BROWSER_BROKER_PORT_RANGE")) continue;
			if (trimmed.includes('from "@oh-my-pi/browser-protocol"')) continue;
			if (pattern.test(trimmed)) {
				throw new Error(
					`${path.basename(file)}: ${msg}\nOffending line: ${trimmed}`,
				);
			}
		}
	}

	test("browser-extension does not hardcode port 4317", () => {
		const files = [
			path.join(root, "packages/browser-extension/src/background-entry.ts"),
			path.join(root, "packages/browser-extension/src/popup/app.ts"),
		];
		for (const file of files) {
			assertNoHardcoded(
				file,
				/4317/,
				"hardcodes port 4317; use portsInRange(parsePortRange(DEFAULT_BROWSER_BROKER_PORT_RANGE))",
			);
		}
	});

	test("browser-extension/src/screenshot.ts does not hardcode 3 MiB blob cap", () => {
		assertNoHardcoded(
			path.join(root, "packages/browser-extension/src/screenshot.ts"),
			/3 \* 1024 \* 1024|3145728/,
			"hardcodes 3 MiB screenshot blob cap; use BROWSER_FEEDBACK_LIMITS.maxScreenshotBytes",
		);
	});

	test("browser-broker/src/cli.ts does not hardcode port 4317", () => {
		assertNoHardcoded(
			path.join(root, "packages/browser-broker/src/cli.ts"),
			/4317/,
			"hardcodes port 4317; use PREFERRED_BROWSER_BROKER_PORT",
		);
	});

	test("browser-broker does not hardcode screenshot byte cap", () => {
		const files = [
			path.join(root, "packages/browser-broker/src/server.ts"),
			path.join(root, "packages/browser-broker/src/screenshots.ts"),
		];
		for (const file of files) {
			assertNoHardcoded(
				file,
				/10 \* 1024 \* 1024|10485760/,
				"hardcodes screenshot byte cap; use BROWSER_FEEDBACK_LIMITS.maxScreenshotBytes",
			);
		}
	});
});
