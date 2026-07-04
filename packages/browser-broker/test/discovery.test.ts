import { describe, expect, test } from "bun:test";
import {
	BROWSER_BROKER_SERVICE,
	BROWSER_PROTOCOL_VERSION,
} from "@oh-my-pi/browser-protocol";
import { discoverCompatibleBroker, resolveBrokerPorts } from "../src/discovery";

describe("broker discovery", () => {
	test("reuses a compatible broker discovered in the candidate port range", async () => {
		const probes: string[] = [];
		const broker = await discoverCompatibleBroker({
			host: "127.0.0.1",
			ports: [4317, 4318],
			fetch: async (url) => {
				probes.push(String(url));
				if (String(url).includes(":4318/")) {
					return Response.json({
						service: BROWSER_BROKER_SERVICE,
						protocol_version: BROWSER_PROTOCOL_VERSION,
						broker_id: "existing",
					});
				}
				return new Response("nope", { status: 404 });
			},
		});

		expect(broker).toEqual({
			baseUrl: "http://127.0.0.1:4318",
			brokerId: "existing",
			port: 4318,
		});
		expect(probes).toEqual([
			"http://127.0.0.1:4317/api/health",
			"http://127.0.0.1:4318/api/health",
		]);
	});

	test("resolves an explicit port before the default range", () => {
		expect(resolveBrokerPorts({ port: 4500, portRange: "4317-4319" })).toEqual([
			4500,
		]);
		expect(resolveBrokerPorts({ portRange: "4317-4319" })).toEqual([
			4317, 4318, 4319,
		]);
	});
});
