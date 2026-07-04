import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const children: Bun.Subprocess[] = [];
const SKIP = process.env.SKIP_OMP_SMOKE === "1";

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) {
			child.kill();
			await child.exited;
		}
	}
});

async function waitForReady(stdout: ReadableStream<Uint8Array>): Promise<void> {
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let output = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				throw new Error(`omp exited before reporting ready:\n${output}`);
			}

			output += decoder.decode(value, { stream: true });
			if (output.includes('"type":"ready"')) {
				return;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

describe("standalone omp package", () => {
	test("prepared artifact registers the bf command", async () => {
		if (SKIP) return;
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "standalone-omp-package-"),
		);
		const outDir = path.join(tmpDir, "browser-omp-extension");

		try {
			const prepareChild = Bun.spawn(
				[
					"bun",
					"scripts/prepare-release-package.ts",
					"packages/browser-omp-extension",
					outDir,
				],
				{
					cwd: repoRoot,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			children.push(prepareChild);

			const [prepareExitCode, prepareStdout, prepareStderr] = await Promise.all(
				[
					prepareChild.exited,
					new Response(prepareChild.stdout).text(),
					new Response(prepareChild.stderr).text(),
				],
			);

			if (prepareExitCode !== 0) {
				throw new Error(
					[
						`prepare-release-package exited with ${prepareExitCode}`,
						prepareStdout,
						prepareStderr,
					]
						.filter(Boolean)
						.join("\n"),
				);
			}

			const child = Bun.spawn(
				[
					"omp",
					"--mode",
					"rpc",
					"-e",
					path.join(outDir, "dist", "extension.js"),
				],
				{
					cwd: repoRoot,
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			children.push(child);

			const [readyStdout, responseStdout] = child.stdout.tee();
			const stderrTextPromise = new Response(child.stderr).text();
			await waitForReady(readyStdout);
			child.stdin.write('{"type":"get_available_commands"}\n');
			child.stdin.end();

			const [stdoutText, stderrText, exitCode] = await Promise.all([
				new Response(responseStdout).text(),
				stderrTextPromise,
				child.exited,
			]);

			if (exitCode !== 0) {
				throw new Error(
					[`omp exited with ${exitCode}`, stdoutText, stderrText]
						.filter(Boolean)
						.join("\n"),
				);
			}

			expect(stdoutText).toContain('"bf"');
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});
