import { describe, expect, test } from "bun:test";
import { BROWSER_BROKER_SERVICE, BROWSER_PROTOCOL_VERSION } from "@oh-my-pi/browser-protocol";
import { discoverBroker, listSessions, submitFeedback } from "../src/background";

describe("extension broker discovery", () => {
	test("scans candidate ports until it finds a compatible broker", async () => {
		const requests: string[] = [];
		const broker = await discoverBroker({
			host: "127.0.0.1",
			ports: [4317, 4318],
			fetch: async url => {
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

		expect(broker).toEqual({ baseUrl: "http://127.0.0.1:4318", brokerId: "broker", port: 4318 });
		expect(requests).toEqual(["http://127.0.0.1:4317/api/health", "http://127.0.0.1:4318/api/health"]);
	});
});

describe("extension feedback submission", () => {
	test("submits event JSON and screenshot as multipart form data", async () => {
		let captured: RequestInit | undefined;
		await submitFeedback({
			baseUrl: "http://127.0.0.1:4317",
			authToken: "secret",
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
	test("loads sessions with bearer auth", async () => {
		let captured: RequestInit | undefined;
		const sessions = await listSessions({
			baseUrl: "http://127.0.0.1:4317",
			authToken: "secret",
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
		expect(sessions.map(session => session.sessionId)).toEqual(["ses_1"]);
	});
});
