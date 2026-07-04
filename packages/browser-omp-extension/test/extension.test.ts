import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import browserFeedbackExtension from "../src/extension";

describe("browserFeedbackExtension", () => {
	test("registers the label, lifecycle hooks, and bf command", () => {
		let label = "";
		const handlers = new Map<string, unknown>();
		let commandName = "";
		let commandConfig:
			| {
					description: string;
					getArgumentCompletions: (
						prefix: string,
					) => Array<{ label: string; value: string }>;
			  }
			| undefined;

		const api = {
			setLabel(value: string) {
				label = value;
			},
			on(event: string, handler: unknown) {
				handlers.set(event, handler);
			},
			registerCommand(name: string, config: NonNullable<typeof commandConfig>) {
				commandName = name;
				commandConfig = config;
			},
			sendUserMessage() {
				throw new Error(
					"sendUserMessage should not be called during registration",
				);
			},
		} as unknown as ExtensionAPI;

		browserFeedbackExtension(api);

		expect(label).toBe("Browser Feedback");
		expect([...handlers.keys()].sort()).toEqual([
			"session_shutdown",
			"session_start",
		]);
		expect(commandName).toBe("bf");
		expect(commandConfig?.description).toContain("browser DOM feedback");
		expect(
			commandConfig?.getArgumentCompletions("s").map((option) => option.value),
		).toEqual(["status", "settings"]);
	});
});
