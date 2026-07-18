import * as net from "node:net";
import {
	BROWSER_BROKER_SERVICE,
	BROWSER_FEEDBACK_LIMITS,
	BROWSER_PROTOCOL_VERSION,
	type BrowserFeedbackEvent,
	checkFeedbackLimits,
	utf8ByteLength,
	validateFeedbackEvent,
	validateSessionRegistration,
} from "@oh-my-pi/browser-protocol";
import type { Server } from "bun";
import { isAuthorizedBrowserRequest, isAuthorizedRequest } from "./auth";
import { defaultPairingRegistryPath } from "./discovery";
import { InMemoryFeedbackStore } from "./feedback-store";
import { createPairingStore } from "./pairing-store";
import { BrowserScreenshotStore } from "./screenshots";
import { BrowserSessionRegistry } from "./session-registry";
import {
	type BrowserBrokerSocketData,
	BrowserWebSocketRouter,
} from "./websocket";

export interface BrowserBrokerServerOptions {
	host: string;
	port: number;
	authToken: string;
	maxEventsPerChannel?: number;
	pairingRegistryPath?: string;
	screenshotRootDir?: string;
	maxScreenshotBytes?: number;
}

export interface BrowserBrokerServer {
	baseUrl: string;
	host: string;
	port: number;
	registry: BrowserSessionRegistry;
	feedback: InMemoryFeedbackStore;
	screenshots: BrowserScreenshotStore;
	websockets: BrowserWebSocketRouter;
	stop(): void;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return Response.json(body, init);
}

function isAllowedBrowserOrigin(origin: string): boolean {
	return (
		/^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
		/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
	);
}

async function readJson(request: Request): Promise<unknown> {
	const text = await request.text();
	return text.length > 0 ? JSON.parse(text) : {};
}

class PayloadTooLargeError extends Error {}
class InvalidFeedbackError extends Error {}

interface ParsedFeedbackRequest {
	event: unknown;
	screenshotBytes?: Uint8Array;
}

/**
 * Parse a feedback request, rejecting oversized JSON/multipart containers with
 * `PayloadTooLargeError` before any parsing or persistence. Screenshots are
 * returned as raw bytes so the caller can validate fields before writing them
 * to disk.
 */
async function parseFeedbackRequest(
	request: Request,
): Promise<ParsedFeedbackRequest> {
	const contentType = request.headers.get("content-type") ?? "";

	if (!contentType.includes("multipart/form-data")) {
		const text = await request.text();
		if (utf8ByteLength(text) > BROWSER_FEEDBACK_LIMITS.maxEventBytes) {
			throw new PayloadTooLargeError("Feedback JSON exceeds byte limit");
		}
		try {
			return { event: text.length > 0 ? JSON.parse(text) : {} };
		} catch {
			throw new InvalidFeedbackError("Malformed JSON body");
		}
	}

	const raw = await request.arrayBuffer();
	if (raw.byteLength > BROWSER_FEEDBACK_LIMITS.maxMultipartBytes) {
		throw new PayloadTooLargeError("Multipart feedback exceeds byte limit");
	}
	let form: FormData;
	try {
		form = await new Response(raw, {
			headers: { "content-type": contentType },
		}).formData();
	} catch {
		throw new InvalidFeedbackError("Malformed multipart body");
	}
	const eventPart = form.get("event");
	if (typeof eventPart !== "string") {
		throw new InvalidFeedbackError("Multipart feedback requires an event JSON part");
	}
	if (utf8ByteLength(eventPart) > BROWSER_FEEDBACK_LIMITS.maxEventBytes) {
		throw new PayloadTooLargeError("Feedback JSON exceeds byte limit");
	}
	let event: unknown;
	try {
		event = JSON.parse(eventPart);
	} catch {
		throw new InvalidFeedbackError("Malformed event JSON part");
	}
	const screenshotPart = form.get("screenshot");
	if (screenshotPart instanceof Blob) {
		const bytes = new Uint8Array(await screenshotPart.arrayBuffer());
		if (bytes.byteLength > BROWSER_FEEDBACK_LIMITS.maxScreenshotBytes) {
			throw new PayloadTooLargeError("Screenshot exceeds byte limit");
		}
		return { event, screenshotBytes: bytes };
	}
	return { event };
}

async function resolvePort(host: string, port: number): Promise<number> {
	if (port !== 0) return port;
	return await new Promise<number>((resolve, reject) => {
		const probe = net.createServer();
		probe.once("error", reject);
		probe.listen(0, host, () => {
			const address = probe.address();
			if (!address || typeof address === "string") {
				probe.close(() =>
					reject(new Error("Unable to resolve available browser broker port")),
				);
				return;
			}
			const resolvedPort = address.port;
			probe.close((error) => {
				if (error) reject(error);
				else resolve(resolvedPort);
			});
		});
	});
}

export async function createBrowserBrokerServer(
	options: BrowserBrokerServerOptions,
): Promise<BrowserBrokerServer> {
	if (options.host !== "127.0.0.1" && options.host !== "localhost") {
		throw new Error("Browser broker only supports loopback hosts by default");
	}

	const registry = new BrowserSessionRegistry();
	const feedback = new InMemoryFeedbackStore({
		maxEventsPerChannel: options.maxEventsPerChannel ?? 50,
	});
	const screenshots = new BrowserScreenshotStore({
		rootDir: options.screenshotRootDir ?? "/tmp/omp-browser-screenshots",
		maxBytes:
			options.maxScreenshotBytes ?? BROWSER_FEEDBACK_LIMITS.maxScreenshotBytes,
	});
	const websockets = new BrowserWebSocketRouter();
	const pairingStore = createPairingStore({
		registryPath: options.pairingRegistryPath ?? defaultPairingRegistryPath(),
	});
	const port = await resolvePort(options.host, options.port);

	let server: Server<BrowserBrokerSocketData>;
	server = Bun.serve<BrowserBrokerSocketData>({
		hostname: options.host,
		port,
		async fetch(request): Promise<Response | undefined> {
			const url = new URL(request.url);

			const wsOmpMatch = url.pathname.match(/^\/ws\/omp\/([^/]+)$/);
			if (wsOmpMatch) {
				const origin = request.headers.get("origin");
				if (origin !== null && !isAllowedBrowserOrigin(origin)) {
					return jsonResponse(
						{
							ok: false,
							code: "forbidden",
							message: "Cross-origin WebSocket requests are not allowed",
						},
						{ status: 403 },
					);
				}
				const token = url.searchParams.get("token");
				if (token !== options.authToken) {
					return jsonResponse(
						{
							ok: false,
							code: "unauthorized",
							message: "Missing or invalid bearer token",
						},
						{ status: 401 },
					);
				}
				const sessionId = decodeURIComponent(wsOmpMatch[1] ?? "");
				const upgraded: boolean = server.upgrade(request, {
					data: { kind: "omp", sessionId },
				});
				return upgraded
					? undefined
					: new Response("WebSocket upgrade required", { status: 426 });
			}

			if (request.method === "GET" && url.pathname === "/api/health") {
				return jsonResponse({
					service: BROWSER_BROKER_SERVICE,
					protocol_version: BROWSER_PROTOCOL_VERSION,
					broker_id: "local",
				});
			}

			if (request.method === "POST" && url.pathname === "/api/pair") {
				const origin = request.headers.get("origin");
				if (origin !== null && !isAllowedBrowserOrigin(origin)) {
					return jsonResponse(
						{
							ok: false,
							code: "forbidden",
							message: "Cross-origin pairing requests are not allowed",
						},
						{ status: 403 },
					);
				}
				const payload = (await readJson(request)) as Record<string, unknown>;
				if (
					typeof payload.browserInstallId !== "string" ||
					typeof payload.code !== "string"
				) {
					return jsonResponse(
						{
							ok: false,
							code: "invalid_pairing_request",
							message: "browserInstallId and code are required",
						},
						{ status: 400 },
					);
				}
				try {
					const result = await pairingStore.redeemPairingCode({
						browserInstallId: payload.browserInstallId,
						code: payload.code,
						...(typeof payload.label === "string"
							? { label: payload.label }
							: {}),
					});
					return jsonResponse({ capabilityToken: result.capabilityToken });
				} catch (error) {
					return jsonResponse(
						{
							ok: false,
							code: "invalid_pairing_code",
							message:
								error instanceof Error ? error.message : "Invalid pairing code",
						},
						{ status: 400 },
					);
				}
			}

			const rootAuthorized = isAuthorizedRequest(request, options.authToken);
			const isBrowserAuthorized = () =>
				isAuthorizedBrowserRequest(
					request,
					pairingStore.validateBrowserCapability,
				);

			if (request.method === "POST" && url.pathname === "/api/pair/open") {
				if (!rootAuthorized) {
					return jsonResponse(
						{
							ok: false,
							code: "unauthorized",
							message: "Missing or invalid bearer token",
						},
						{ status: 401 },
					);
				}
				const payload = (await readJson(request)) as Record<string, unknown>;
				if (
					typeof payload.sessionId !== "string" ||
					payload.sessionId.trim().length === 0
				) {
					return jsonResponse(
						{
							ok: false,
							code: "invalid_session",
							message: "sessionId is required",
						},
						{ status: 400 },
					);
				}
				const sessionId = payload.sessionId.trim();
				if (!registry.getBySessionId(sessionId)) {
					return jsonResponse(
						{ ok: false, code: "unknown_session", message: "Unknown session" },
						{ status: 404 },
					);
				}
				return jsonResponse(await pairingStore.issuePairingCode(sessionId));
			}

			if (request.method === "POST" && url.pathname === "/api/pair/reset") {
				if (!rootAuthorized) {
					return jsonResponse(
						{
							ok: false,
							code: "unauthorized",
							message: "Missing or invalid bearer token",
						},
						{ status: 401 },
					);
				}
				await pairingStore.revokeAllBrowserCapabilities();
				return jsonResponse({ ok: true });
			}

			if (request.method === "GET" && url.pathname === "/api/sessions") {
				if (!rootAuthorized && !isBrowserAuthorized()) {
					return jsonResponse(
						{
							ok: false,
							code: "unauthorized",
							message: "Missing or invalid bearer token",
						},
						{ status: 401 },
					);
				}
				return jsonResponse({ sessions: registry.list() });
			}

			const sessionFeedbackMatch = url.pathname.match(
				/^\/api\/sessions\/([^/]+)\/feedback(?:\/latest)?$/,
			);
			if (request.method === "GET" && sessionFeedbackMatch) {
				if (!rootAuthorized) {
					return jsonResponse(
						{
							ok: false,
							code: "unauthorized",
							message: "Missing or invalid bearer token",
						},
						{ status: 401 },
					);
				}
				const session = registry.getBySessionId(
					decodeURIComponent(sessionFeedbackMatch[1] ?? ""),
				);
				if (!session)
					return jsonResponse(
						{ ok: false, code: "unknown_session", message: "Unknown session" },
						{ status: 404 },
					);
				if (url.pathname.endsWith("/latest"))
					return jsonResponse({
						feedback: feedback.latest(session.channelId) ?? null,
					});
				return jsonResponse({ feedback: feedback.list(session.channelId) });
			}

			if (request.method === "POST" && url.pathname === "/api/feedback") {
				if (!rootAuthorized && !isBrowserAuthorized()) {
					return jsonResponse(
						{
							ok: false,
							code: "unauthorized",
							message: "Missing or invalid bearer token",
						},
						{ status: 401 },
					);
				}
				let parsed: ParsedFeedbackRequest;
				try {
					parsed = await parseFeedbackRequest(request);
				} catch (error) {
					if (error instanceof PayloadTooLargeError) {
						return jsonResponse(
							{
								ok: false,
								code: "payload_too_large",
								message: error.message,
							},
							{ status: 413 },
						);
					}
					return jsonResponse(
						{
							ok: false,
							code: "invalid_feedback",
							message:
								error instanceof Error ? error.message : "Invalid feedback",
						},
						{ status: 400 },
					);
				}
				const result = validateFeedbackEvent(parsed.event);
				if (!result.ok)
					return jsonResponse(
						{ ok: false, code: "invalid_feedback", message: result.error },
						{ status: 400 },
					);
				const violations = checkFeedbackLimits(result.value);
				const violation = violations[0];
				if (violation)
					return jsonResponse(
						{
							ok: false,
							code: violation.code,
							path: violation.path,
							message: `Field ${violation.path} exceeds its declared limit of ${violation.limit} ${violation.unit}`,
							violations,
						},
						{ status: 422 },
					);
				let event: BrowserFeedbackEvent = result.value;
				if (parsed.screenshotBytes && event.screenshot) {
					const saved = await screenshots.save({
						eventId: event.eventId,
						mimeType: event.screenshot.mimeType,
						bytes: parsed.screenshotBytes,
					});
					event = {
						...event,
						screenshot: { ...event.screenshot, ref: saved.ref },
					};
				}
				feedback.add({
					channelId: event.channelId,
					eventId: event.eventId,
					createdAt: event.createdAt,
					payload: event,
				});
				const session = registry.getByChannelId(event.channelId);
				if (session) websockets.sendFeedback(session.sessionId, event);
				return jsonResponse({ ok: true, eventId: event.eventId });
			}

			if (!rootAuthorized) {
				return jsonResponse(
					{
						ok: false,
						code: "unauthorized",
						message: "Missing or invalid bearer token",
					},
					{ status: 401 },
				);
			}

			if (
				request.method === "POST" &&
				url.pathname === "/api/sessions/register"
			) {
				const result = validateSessionRegistration(await readJson(request));
				if (!result.ok)
					return jsonResponse(
						{ ok: false, code: "invalid_session", message: result.error },
						{ status: 400 },
					);
				return jsonResponse({
					ok: true,
					session: registry.register(result.value),
				});
			}

			const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
			if (sessionMatch && request.method === "PATCH") {
				const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
				const update = (await readJson(request)) as Record<string, unknown>;
				const session = registry.update(sessionId, {
					...(typeof update.displayName === "string"
						? { displayName: update.displayName }
						: {}),
					...(typeof update.sessionName === "string"
						? { sessionName: update.sessionName }
						: {}),
					...(typeof update.cwd === "string" ? { cwd: update.cwd } : {}),
					...(typeof update.projectName === "string"
						? { projectName: update.projectName }
						: {}),
					...(typeof update.gitBranch === "string"
						? { gitBranch: update.gitBranch }
						: {}),
					...(Array.isArray(update.urlPatterns) &&
					update.urlPatterns.every((value) => typeof value === "string")
						? { urlPatterns: update.urlPatterns }
						: {}),
					...(update.status === "active" ||
					update.status === "idle" ||
					update.status === "disconnected"
						? { status: update.status }
						: {}),
					...(typeof update.lastActiveAt === "string"
						? { lastActiveAt: update.lastActiveAt }
						: {}),
					...(typeof update.processId === "number"
						? { processId: update.processId }
						: {}),
				});
				if (!session)
					return jsonResponse(
						{ ok: false, code: "unknown_session", message: "Unknown session" },
						{ status: 404 },
					);
				return jsonResponse({ ok: true, session });
			}

			if (sessionMatch && request.method === "DELETE") {
				const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
				return jsonResponse({
					ok: true,
					removed: registry.unregister(sessionId),
				});
			}

			if (request.method === "DELETE" && sessionFeedbackMatch) {
				const session = registry.getBySessionId(
					decodeURIComponent(sessionFeedbackMatch[1] ?? ""),
				);
				if (!session)
					return jsonResponse(
						{ ok: false, code: "unknown_session", message: "Unknown session" },
						{ status: 404 },
					);
				return jsonResponse({
					ok: true,
					cleared: feedback.clear(session.channelId),
				});
			}

			return jsonResponse(
				{ ok: false, code: "not_found", message: "Not found" },
				{ status: 404 },
			);
		},
		websocket: {
			open(socket) {
				websockets.add(socket);
				const session = registry.update(socket.data.sessionId, {
					status: "active",
					lastActiveAt: new Date().toISOString(),
				});
				if (!session) return;
				for (const event of feedback.list(session.channelId)) {
					if (event.payload)
						websockets.sendFeedbackToSocket(
							socket,
							event.payload as BrowserFeedbackEvent,
						);
				}
			},
			close(socket) {
				websockets.remove(socket);
				registry.markDisconnected(socket.data.sessionId);
			},
			message() {},
		},
	});

	return {
		baseUrl: `http://${options.host}:${port}`,
		host: options.host,
		port,
		registry,
		feedback,
		screenshots,
		websockets,
		stop() {
			server.stop(true);
		},
	};
}
