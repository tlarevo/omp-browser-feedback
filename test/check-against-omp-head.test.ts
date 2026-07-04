import { describe, expect, test } from "bun:test";
import {
	rewriteExports,
	rewriteTypesPath,
} from "../scripts/check-against-omp-head";

describe("rewriteTypesPath", () => {
	test("rewrites src ts and tsx paths to emitted d.ts files", () => {
		expect(rewriteTypesPath("./src/index.ts")).toBe("./dist/types/index.d.ts");
		expect(rewriteTypesPath("./src/config/model-roles.tsx")).toBe(
			"./dist/types/config/model-roles.d.ts",
		);
	});

	test("leaves non-src paths unchanged", () => {
		expect(rewriteTypesPath("./dist/index.js")).toBe("./dist/index.js");
	});
});

describe("rewriteExports", () => {
	test("rewrites nested types conditions without disturbing import branches", () => {
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
