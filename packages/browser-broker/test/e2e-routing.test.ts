import { afterEach, describe, expect, test } from "bun:test";
import { BROWSER_PROTOCOL_VERSION } from "@oh-my-pi/browser-protocol";
import { createBrowserBrokerServer } from "../src/server";

const servers: Array<{ stop: () => void }> = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop();
});

const authHeaders = {
	Authorization: "Bearer secret",
	"Content-Type": "application/json",
};

function session(sessionId: string, cwd: string) {
	return {
		protocolVersion: BROWSER_PROTOCOL_VERSION,
		sessionId,
		channelId: sessionId,
		sessionName: "same",
		displayName: "same",
		cwd,
		status: "active",
		lastActiveAt: "2026-06-27T10:00:00.000Z",
		processId: sessionId === "a" ? 1 : 2,
	};
}

function feedback(channelId: string, eventId: string) {
	return {
		protocolVersion: BROWSER_PROTOCOL_VERSION,
		eventId,
		type: "dom.selection",
		channelId,
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
	};
}

describe("browser broker e2e routing", () => {
	test("routes duplicate-name session feedback by stable session id", async () => {
		const server = await createBrowserBrokerServer({ host: "127.0.0.1", port: 0, authToken: "secret" });
		servers.push(server);

		await fetch(`${server.baseUrl}/api/sessions/register`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify(session("a", "/repo/a")),
		});
		await fetch(`${server.baseUrl}/api/sessions/register`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify(session("b", "/repo/b")),
		});
		await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify(feedback("a", "evt-a")),
		});
		await fetch(`${server.baseUrl}/api/feedback`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify(feedback("b", "evt-b")),
		});

		const latestA = (await (
			await fetch(`${server.baseUrl}/api/sessions/a/feedback/latest`, { headers: authHeaders })
		).json()) as {
			feedback: { eventId: string };
		};
		const latestB = (await (
			await fetch(`${server.baseUrl}/api/sessions/b/feedback/latest`, { headers: authHeaders })
		).json()) as {
			feedback: { eventId: string };
		};

		expect(latestA.feedback.eventId).toBe("evt-a");
		expect(latestB.feedback.eventId).toBe("evt-b");
	});
});
