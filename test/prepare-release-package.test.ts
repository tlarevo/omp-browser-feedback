import { describe, expect, test } from "bun:test";
import { rewriteWorkspaceProtocolRanges } from "../scripts/prepare-release-package";

describe("rewriteWorkspaceProtocolRanges", () => {
	test("rewrites workspace protocol dependencies to concrete versions", () => {
		const manifest = {
			dependencies: {
				"@oh-my-pi/browser-protocol": "workspace:*",
				"@oh-my-pi/browser-broker": "workspace:^",
				linkedom: "^0.18.12",
			},
			peerDependencies: {
				"@oh-my-pi/pi-coding-agent": "*",
				"@oh-my-pi/browser-protocol": "workspace:~",
			},
		};

		const rewritten = rewriteWorkspaceProtocolRanges(manifest, {
			"@oh-my-pi/browser-protocol": "16.1.23",
			"@oh-my-pi/browser-broker": "16.1.23",
		});

		expect(rewritten).toEqual({
			dependencies: {
				"@oh-my-pi/browser-protocol": "16.1.23",
				"@oh-my-pi/browser-broker": "^16.1.23",
				linkedom: "^0.18.12",
			},
			peerDependencies: {
				"@oh-my-pi/pi-coding-agent": "*",
				"@oh-my-pi/browser-protocol": "~16.1.23",
			},
		});
	});

	test("throws when a workspace dependency has no local version mapping", () => {
		expect(() =>
			rewriteWorkspaceProtocolRanges(
				{ dependencies: { "@oh-my-pi/missing": "workspace:*" } },
				{},
			),
		).toThrow(/@oh-my-pi\/missing/);
	});
});
