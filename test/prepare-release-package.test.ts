import { describe, expect, test } from "bun:test";
import {
	pruneStandaloneBrowserFeedbackDeps,
	rewriteExports,
	rewriteTypesPath,
	rewriteWorkspaceProtocolRanges,
} from "../scripts/prepare-release-package";

describe("rewriteTypesPath", () => {
	test("rewrites src ts and tsx paths to emitted d.ts files", () => {
		expect(rewriteTypesPath("./src/index.ts")).toBe("./dist/types/index.d.ts");
		expect(rewriteTypesPath("./src/config/model-roles.tsx")).toBe(
			"./dist/types/config/model-roles.d.ts",
		);
	});
});

describe("rewriteExports", () => {
	test("rewrites nested types conditions without disturbing non-types branches", () => {
		const rewritten = rewriteExports({
			".": {
				types: "./src/index.ts",
				import: "./src/index.ts",
			},
			"./config/model-roles": {
				types: "./src/config/model-roles.ts",
				default: "./src/config/model-roles.ts",
			},
			"./array": [
				{
					types: "./src/array.ts",
					import: "./src/array.ts",
				},
			],
		});

		expect(rewritten).toEqual({
			".": {
				types: "./dist/types/index.d.ts",
				import: "./src/index.ts",
			},
			"./config/model-roles": {
				types: "./dist/types/config/model-roles.d.ts",
				default: "./src/config/model-roles.ts",
			},
			"./array": [
				{
					types: "./dist/types/array.d.ts",
					import: "./src/array.ts",
				},
			],
		});
	});
});

describe("pruneStandaloneBrowserFeedbackDeps", () => {
	test("removes internal runtime packages while preserving peer deps and rewriting types metadata", () => {
		const manifest = {
			dependencies: {
				"@oh-my-pi/browser-broker": "^16.1.23",
				linkedom: "^0.18.12",
			},
			devDependencies: {
				"@oh-my-pi/browser-protocol": "^16.1.23",
				typescript: "^5.9.0",
			},
			peerDependencies: {
				"@oh-my-pi/pi-coding-agent": "*",
			},
			types: "./src/index.ts",
			exports: {
				".": {
					types: "./src/index.ts",
					import: "./dist/index.js",
				},
				"./config/model-roles": {
					types: "./src/config/model-roles.tsx",
					default: "./dist/config/model-roles.js",
				},
			},
		};

		expect(pruneStandaloneBrowserFeedbackDeps(manifest)).toEqual({
			dependencies: {
				linkedom: "^0.18.12",
			},
			devDependencies: {
				typescript: "^5.9.0",
			},
			peerDependencies: {
				"@oh-my-pi/pi-coding-agent": "*",
			},
			types: "./dist/types/index.d.ts",
			exports: {
				".": {
					types: "./dist/types/index.d.ts",
					import: "./dist/index.js",
				},
				"./config/model-roles": {
					types: "./dist/types/config/model-roles.d.ts",
					default: "./dist/config/model-roles.js",
				},
			},
		});
	});
});

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
