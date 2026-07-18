#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
/**
 * Export the browser feedback protocol contract as a JSON artifact.
 *
 * The standalone Chrome repo's `generate-protocol.ts` consumes this JSON
 * to produce a zero-dependency protocol package.  The JSON is the single
 * serialised source of truth — the Chrome drift check reruns this
 * exporter and byte-compares the output.
 *
 * Usage:
 *   bun scripts/export-chrome-contract.ts <output-path>
 */
import {
	BROWSER_BROKER_SERVICE,
	BROWSER_PROTOCOL_VERSION,
	BROWSER_PROTOCOL_VERSION_RANGE,
	ENDPOINTS,
} from "../packages/browser-protocol/src/index";

async function main(): Promise<void> {
	const outputPath = process.argv[2];
	if (!outputPath) {
		throw new Error(
			"Usage: bun scripts/export-chrome-contract.ts <output-path>",
		);
	}

	await fs.mkdir(path.dirname(outputPath), { recursive: true });

	const contract = {
		protocolVersion: BROWSER_PROTOCOL_VERSION,
		brokerService: BROWSER_BROKER_SERVICE,
		versionRange: {
			min: BROWSER_PROTOCOL_VERSION_RANGE.min,
			max: BROWSER_PROTOCOL_VERSION_RANGE.max,
		},
		endpoints: ENDPOINTS,
	};

	const json = `${JSON.stringify(contract, null, "\t")}\n`;
	await fs.writeFile(outputPath, json);
	const endpointCount = Object.keys(contract.endpoints).length;
	console.log(
		`Contract v${contract.protocolVersion} exported → ${outputPath} (${endpointCount} endpoints)`,
	);
}

if (import.meta.main) {
	await main();
}
