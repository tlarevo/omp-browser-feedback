import { describe, expect, test } from "bun:test";
import {
	BROWSER_BROKER_SERVICE,
	BROWSER_PROTOCOL_VERSION,
	ENDPOINTS,
} from "@oh-my-pi/browser-protocol";
import {
	discoverBroker,
	listSessions,
	probeBroker,
	redeemPairingCode,
	submitFeedback,
} from "../src/background";

describe("extension broker discovery", () => {
	test("scans candidate ports until it finds a compatible broker", async () => {
		const requests: string[] = [];
		const broker = await discoverBroker({
			host: "127.0.0.1",
			ports: [4317, 4318],
			fetch: async (url) => {
				requests.push(String(url));
				if (String(url).includes(":4318/")) {
					return Response.json({
						service: BROWSER_BROKER_SERVICE,
						protocol_version: BROWSER_PROTOCOL_VERSION,
						broker_id: "broker",
					});
				}
				return new Response("not here", { status: 404 });
			},
		});

		expect(broker).toEqual({
			baseUrl: "http://127.0.0.1:4318",
			brokerId: "broker",
			port: 4318,
		});
		expect(requests).toEqual([
			"http://127.0.0.1:4317/api/health",
			"http://127.0.0.1:4318/api/health",
		]);
	});
});

describe("extension pairing", () => {
	test("redeems a pairing code for a browser capability token", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;

		const result = await redeemPairingCode({
			baseUrl: "http://127.0.0.1:4317",
			browserInstallId: "browser_install_1",
			code: "A7K2Q9",
			fetch: async (url, init) => {
				capturedUrl = String(url);
				capturedInit = init;
				return Response.json({ capabilityToken: "bcap_123" });
			},
		});

		expect(result).toEqual({ capabilityToken: "bcap_123" });
		expect(capturedUrl).toBe("http://127.0.0.1:4317/api/pair");
		expect(capturedInit?.method).toBe("POST");
		expect(capturedInit?.headers).toEqual({
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(capturedInit?.body))).toEqual({
			browserInstallId: "browser_install_1",
			code: "A7K2Q9",
		});
	});
});

describe("extension feedback submission", () => {
	test("submits event JSON and screenshot as multipart form data", async () => {
		let captured: RequestInit | undefined;
		await submitFeedback({
			baseUrl: "http://127.0.0.1:4317",
			capabilityToken: "secret",
			event: {
				protocolVersion: BROWSER_PROTOCOL_VERSION,
				eventId: "evt_1",
				type: "dom.selection",
				channelId: "ses_1",
				createdAt: "2026-06-27T10:00:00.000Z",
				page: {
					url: "https://example.com",
					title: "Example",
					viewport: { width: 1200, height: 800, devicePixelRatio: 2 },
				},
				element: {
					selector: "button",
					tagName: "BUTTON",
					outerHtml: "<button>Save</button>",
					attributes: {},
					bounds: { x: 1, y: 2, width: 3, height: 4 },
					computedStyles: { display: "block" },
				},
			},
			screenshot: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
			fetch: async (_url, init) => {
				captured = init;
				return Response.json({ ok: true, eventId: "evt_1" });
			},
		});

		expect(captured?.headers).toEqual({ Authorization: "Bearer secret" });
		expect(captured?.body).toBeInstanceOf(FormData);
		const form = captured?.body as FormData;
		expect(typeof form.get("event")).toBe("string");
		expect(form.get("screenshot")).toBeInstanceOf(Blob);
	});
});

describe("extension session listing", () => {
	test("loads sessions with browser capability auth", async () => {
		let captured: RequestInit | undefined;
		const sessions = await listSessions({
			baseUrl: "http://127.0.0.1:4317",
			capabilityToken: "secret",
			fetch: async (_url, init) => {
				captured = init;
				return Response.json({
					sessions: [
						{
							protocolVersion: BROWSER_PROTOCOL_VERSION,
							sessionId: "ses_1",
							channelId: "ses_1",
							sessionName: "OMP",
							displayName: "OMP",
							cwd: "/repo",
							status: "active",
							lastActiveAt: "2026-06-27T10:00:00.000Z",
							processId: 1,
						},
					],
				});
			},
		});

		expect(captured?.headers).toEqual({ Authorization: "Bearer secret" });
		expect(sessions.map((session) => session.sessionId)).toEqual(["ses_1"]);
	});
});

describe("extension broker version compatibility", () => {
	test("rejects a v2 broker advertising [2,2]", async () => {
		const broker = await probeBroker("http://127.0.0.1:4317", async () =>
			Response.json({
				service: BROWSER_BROKER_SERVICE,
				protocol_version: 2,
				protocol_version_range: { min: 2, max: 2 },
				broker_id: "v2-broker",
			}),
		);
		expect(broker).toBeUndefined();
	});

	test("accepts a v1 broker advertising [1,1]", async () => {
		const broker = await probeBroker("http://127.0.0.1:4317", async () =>
			Response.json({
				service: BROWSER_BROKER_SERVICE,
				protocol_version: 1,
				protocol_version_range: { min: 1, max: 1 },
				broker_id: "v1-broker",
			}),
		);
		expect(broker).not.toBeUndefined();
		expect(broker?.broker_id).toBe("v1-broker");
	});
});

describe("contract auth metadata", () => {
	test("every endpoint has a declared auth kind", () => {
		for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
			expect(
				typeof endpoint.auth,
				`ENDPOINTS.${name} must declare an auth kind`,
			).toBe("string");
			expect(
				endpoint.auth.length > 0,
				`ENDPOINTS.${name}.auth must not be empty`,
			).toBe(true);
		}
	});

	test("health endpoint requires no auth", () => {
		expect(ENDPOINTS.health.auth).toBe("none");
	});

	test("pair redeem requires pairing code auth", () => {
		expect(ENDPOINTS.pairRedeem.auth).toBe("pairing-code");
	});

	test("pair open and reset require root token", () => {
		expect(ENDPOINTS.pairOpen.auth).toBe("root-token");
		expect(ENDPOINTS.pairReset.auth).toBe("root-token");
	});

	test("sessions list and feedback submit accept root or browser token", () => {
		expect(ENDPOINTS.sessionsList.auth).toBe("root-or-browser");
		expect(ENDPOINTS.feedbackSubmit.auth).toBe("root-or-browser");
	});

	test("session register, update, delete, and feedback management require root token", () => {
		expect(ENDPOINTS.sessionRegister.auth).toBe("root-token");
		expect(ENDPOINTS.sessionUpdate.auth).toBe("root-token");
		expect(ENDPOINTS.sessionDelete.auth).toBe("root-token");
		expect(ENDPOINTS.sessionFeedbackList.auth).toBe("root-token");
		expect(ENDPOINTS.sessionFeedbackLatest.auth).toBe("root-token");
		expect(ENDPOINTS.sessionFeedbackClear.auth).toBe("root-token");
	});
});
