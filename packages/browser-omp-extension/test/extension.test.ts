import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import { BrowserBrokerClient } from "../src/client";
import { handleBfCommand } from "../src/commands";
import browserFeedbackExtension from "../src/extension";

interface NotifyHarness {
	notify: (message: string) => void;
	last(): string;
}

function createNotifyHarness(): NotifyHarness {
	const messages: string[] = [];
	return {
		notify(message: string) {
			messages.push(message);
		},
		last() {
			return messages.at(-1) ?? "";
		},
	};
}

function makeCommandContext(
	notify: (message: string) => void,
): ExtensionCommandContext {
	return {
		cwd: "/tmp/project",
		ui: { notify },
		sessionManager: {
			getSessionId: () => "ses_1",
			getSessionName: () => "Session One",
		},
	} as unknown as ExtensionCommandContext;
}

describe("BrowserBrokerClient", () => {
	test("openPairingWindow posts the session id and returns the broker code", async () => {
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		const client = new BrowserBrokerClient({
			baseUrl: "http://broker.test/",
			authToken: "root-token",
			fetch: async (url, init) => {
				requestUrl = String(url);
				requestInit = init;
				return new Response(
					JSON.stringify({
						pairingId: "pair_1",
						code: "A7K2Q9",
						expiresAt: "2026-07-04T00:02:00.000Z",
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			},
		});

		await expect(client.openPairingWindow("ses_1")).resolves.toEqual({
			pairingId: "pair_1",
			code: "A7K2Q9",
			expiresAt: "2026-07-04T00:02:00.000Z",
		});
		expect(requestUrl).toBe("http://broker.test/api/pair/open");
		expect(requestInit).toMatchObject({
			method: "POST",
			headers: {
				Authorization: "Bearer root-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sessionId: "ses_1" }),
		});
	});

	test("revokeAllBrowserCapabilities posts to the reset endpoint", async () => {
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		const client = new BrowserBrokerClient({
			baseUrl: "http://broker.test",
			authToken: "root-token",
			fetch: async (url, init) => {
				requestUrl = String(url);
				requestInit = init;
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		});

		await expect(
			client.revokeAllBrowserCapabilities(),
		).resolves.toBeUndefined();
		expect(requestUrl).toBe("http://broker.test/api/pair/reset");
		expect(requestInit).toMatchObject({
			method: "POST",
			headers: {
				Authorization: "Bearer root-token",
			},
		});
	});
});

describe("handleBfCommand", () => {
	test("/bf pair starts or reuses the broker, registers the session, and prints a short-lived code", async () => {
		const notify = createNotifyHarness();
		let ensured = false;
		let pairedSessionId = "";
		let registeredSessionId = "";
		let subscribedSessionId = "";

		const client = {
			registerSession: async (input: { sessionId: string }) => {
				registeredSessionId = input.sessionId;
			},
			subscribeFeedback: (sessionId: string) => {
				subscribedSessionId = sessionId;
				return { close() {} };
			},
			openPairingWindow: async (sessionId: string) => {
				pairedSessionId = sessionId;
				return {
					pairingId: "pair_1",
					code: "A7K2Q9",
					expiresAt: "2026-07-04T00:02:00.000Z",
				};
			},
		} as unknown as BrowserBrokerClient;

		await handleBfCommand(
			"pair",
			makeCommandContext(notify.notify),
			async () => {},
			{
				ensureBrokerRunning: async () => {
					ensured = true;
					return {
						baseUrl: "http://127.0.0.1:4317",
						authToken: "root-token",
						port: 4317,
						reused: true,
					};
				},
				createClient: () => client,
				setActiveFeedbackSubscription: () => {},
			},
		);

		expect(ensured).toBe(true);
		expect(registeredSessionId).toBe("ses_1");
		expect(subscribedSessionId).toBe("ses_1");
		expect(pairedSessionId).toBe("ses_1");
		expect(notify.last()).toContain("A7K2Q9");
		expect(notify.last()).toContain("Expires:");
		expect(notify.last()).toContain("enter the code before it expires");
	});

	test("/bf pair reset starts or reuses the broker and revokes browser capabilities", async () => {
		const notify = createNotifyHarness();
		let ensured = false;
		let revoked = false;

		await handleBfCommand(
			"pair reset",
			makeCommandContext(notify.notify),
			async () => {},
			{
				ensureBrokerRunning: async () => {
					ensured = true;
					return {
						baseUrl: "http://127.0.0.1:4317",
						authToken: "root-token",
						port: 4317,
						reused: true,
					};
				},
				createClient: () =>
					({
						revokeAllBrowserCapabilities: async () => {
							revoked = true;
						},
					}) as BrowserBrokerClient,
			},
		);

		expect(ensured).toBe(true);
		expect(revoked).toBe(true);
		expect(notify.last()).toContain("Browser pairing reset");
		expect(notify.last()).toContain("pair again");
	});

	test("/bf connect points users to /bf pair instead of pasting the root token", async () => {
		const notify = createNotifyHarness();
		let registeredSessionId = "";
		let subscribedSessionId = "";

		await handleBfCommand(
			"connect",
			makeCommandContext(notify.notify),
			async () => {},
			{
				ensureBrokerRunning: async () => ({
					baseUrl: "http://127.0.0.1:4317",
					authToken: "root-token",
					port: 4317,
					reused: true,
				}),
				createClient: () =>
					({
						registerSession: async (input: { sessionId: string }) => {
							registeredSessionId = input.sessionId;
						},
						subscribeFeedback: (sessionId: string) => {
							subscribedSessionId = sessionId;
							return { close() {} };
						},
					}) as BrowserBrokerClient,
				setActiveFeedbackSubscription: () => {},
			},
		);

		expect(registeredSessionId).toBe("ses_1");
		expect(subscribedSessionId).toBe("ses_1");
		expect(notify.last()).toContain("Run `/bf pair`");
		expect(notify.last()).not.toContain("paste into Chrome extension popup");
		expect(notify.last()).not.toContain("root-token");
	});
	test("/bf connect rediscovery re-registers the same session before returning new credentials", async () => {
		const notify = createNotifyHarness();
		let reconnect:
			| (() => Promise<{ baseUrl: string; authToken: string }>)
			| undefined;
		let initialRegisterCount = 0;
		let rediscoveredRegisterSessionId = "";

		await handleBfCommand(
			"connect",
			makeCommandContext(notify.notify),
			async () => {},
			{
				ensureBrokerRunning: async () => ({
					baseUrl: "http://127.0.0.1:4317",
					authToken: "root-token",
					port: 4317,
					reused: true,
				}),
				createClient: () =>
					({
						registerSession: async () => {
							initialRegisterCount += 1;
						},
						subscribeFeedback: (
							_sessionId: string,
							_onFeedback: unknown,
							options?: {
								reconnect?: () => Promise<{
									baseUrl: string;
									authToken: string;
								}>;
							},
						) => {
							reconnect = options?.reconnect;
							return {
								close() {},
								getStatus() {
									return {
										state: "connected" as const,
										reconnectAttempts: 0,
										baseUrl: "http://127.0.0.1:4317",
									};
								},
							};
						},
					}) as unknown as BrowserBrokerClient,
				loadClient: async () =>
					({
						registerSession: async (input: { sessionId: string }) => {
							rediscoveredRegisterSessionId = input.sessionId;
						},
						getConnectionInfo: () => ({
							baseUrl: "http://127.0.0.1:5522",
							authToken: "token-2",
						}),
					}) as unknown as BrowserBrokerClient,
				setActiveFeedbackSubscription: () => {},
			},
		);

		expect(initialRegisterCount).toBe(1);
		expect(reconnect).toBeDefined();
		await expect(reconnect?.()).resolves.toEqual({
			baseUrl: "http://127.0.0.1:5522",
			authToken: "token-2",
		});
		expect(rediscoveredRegisterSessionId).toBe("ses_1");
	});

	test("/bf status still reports reconnecting when broker rediscovery fails", async () => {
		const notify = createNotifyHarness();
		await handleBfCommand(
			"status",
			makeCommandContext(notify.notify),
			async () => {},
			{
				loadClient: async () => undefined,
				getInProcessBrokerStatus: () => ({
					running: false,
				}),
				getActiveConnectionStatus: () => ({
					state: "reconnecting",
					reconnectAttempts: 3,
					baseUrl: "http://127.0.0.1:4317",
				}),
			},
		);

		expect(notify.last()).toContain("Connection: reconnecting");
		expect(notify.last()).toContain("Reconnect attempts: 3");
	});

	test("/bf broker start uses the injected ensureBrokerRunning dependency", async () => {
		const notify = createNotifyHarness();
		let injectedCalls = 0;

		await handleBfCommand(
			"broker start --port 4318",
			makeCommandContext(notify.notify),
			async () => {},
			{
				ensureBrokerRunning: async ({ port, portRange }) => {
					injectedCalls += 1;
					expect(port).toBe(4318);
					expect(portRange).toBeUndefined();
					return {
						baseUrl: "http://127.0.0.1:4318",
						authToken: "root-token",
						port: 4318,
						reused: false,
					};
				},
			},
		);

		expect(injectedCalls).toBe(1);
		expect(notify.last()).toContain("http://127.0.0.1:4318");
	});
	test("/bf status reports the live reconnect state and attempt count", async () => {
		const notify = createNotifyHarness();
		await handleBfCommand(
			"status",
			makeCommandContext(notify.notify),
			async () => {},
			{
				loadClient: async () =>
					({
						listSessions: async () => [{ sessionId: "ses_1" }],
					}) as BrowserBrokerClient,
				getInProcessBrokerStatus: () => ({
					running: true,
					baseUrl: "http://127.0.0.1:4317",
					port: 4317,
				}),
				getActiveConnectionStatus: () => ({
					state: "reconnecting",
					reconnectAttempts: 2,
					baseUrl: "http://127.0.0.1:4317",
				}),
			},
		);

		expect(notify.last()).toContain("Connection: reconnecting");
		expect(notify.last()).toContain("Reconnect attempts: 2");
	});
});

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
