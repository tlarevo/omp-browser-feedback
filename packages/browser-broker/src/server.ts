import * as net from "node:net";
import {
	BROWSER_BROKER_SERVICE,
	BROWSER_FEEDBACK_LIMITS,
	BROWSER_PROTOCOL_VERSION,
	BROWSER_PROTOCOL_VERSIONS,
	type BrowserFeedbackEvent,
	type BrowserProtocolVersion,
	checkFeedbackLimits,
	downgradeToV1,
	inferProtocolVersion,
	negotiateProtocolVersion,
	utf8ByteLength,
	validateFeedbackAck,
	validateFeedbackEvent,
	validateSessionRegistration,
} from "@oh-my-pi/browser-protocol";
import type { Server } from "bun";
import { isAuthorizedBrowserRequest, isAuthorizedRequest } from "./auth";
import { defaultFeedbackDataDir, defaultPairingRegistryPath } from "./discovery";
import { InMemoryFeedbackStore } from "./feedback-store";
import { JournalStore } from "./journal";
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
	/** Directory for journal persistence and screenshot storage. */
	dataDir?: string;
	heartbeatIntervalMs?: number;
	heartbeatTimeoutMs?: number;
	idleAfterMs?: number;
	graceMs?: number;
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
	const form = await new Response(raw, {
		headers: { "content-type": contentType },
	})
		.formData()
		.catch(() => {
			throw new InvalidFeedbackError("Malformed multipart body");
		});
	const eventPart = form.get("event");
	if (typeof eventPart !== "string") {
		throw new InvalidFeedbackError(
			"Multipart feedback requires an event JSON part",
		);
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

const LOCAL_VERSION_RANGE = {
	min: BROWSER_PROTOCOL_VERSIONS[0],
	max: BROWSER_PROTOCOL_VERSIONS[BROWSER_PROTOCOL_VERSIONS.length - 1],
} as const;

export async function createBrowserBrokerServer(
	options: BrowserBrokerServerOptions,
): Promise<BrowserBrokerServer> {
	if (options.host !== "127.0.0.1" && options.host !== "localhost") {
		throw new Error("Browser broker only supports loopback hosts by default");
	}

	const registry = new BrowserSessionRegistry({
		...(options.heartbeatTimeoutMs !== undefined
			? { heartbeatTimeoutMs: options.heartbeatTimeoutMs }
			: {}),
		...(options.idleAfterMs !== undefined
			? { idleAfterMs: options.idleAfterMs }
			: {}),
		...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
	});
	const dataDir = options.dataDir ?? defaultFeedbackDataDir();
	const journal = new JournalStore(dataDir, {
		maxEventsPerChannel: options.maxEventsPerChannel ?? 200,
		maxTotalBytes: 50 * 1024 * 1024,
		maxAgeMs: 7 * 24 * 60 * 60 * 1000,
	});
	journal.load();
	const screenshotDir = options.screenshotRootDir ?? `${dataDir}/screenshots`;
	const feedback = new InMemoryFeedbackStore({
		journal,
		screenshotRootDir: screenshotDir,
	});
	const screenshots = new BrowserScreenshotStore({
		rootDir: screenshotDir,
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
			registry.prune();

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
					minProtocolVersion: BROWSER_PROTOCOL_VERSIONS[0],
					protocolVersion:
						BROWSER_PROTOCOL_VERSIONS[BROWSER_PROTOCOL_VERSIONS.length - 1],
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
				const raw = parsed.event;
				const declaredVersion = inferProtocolVersion(raw);
				if (declaredVersion === undefined) {
					return jsonResponse(
						{
							ok: false,
							code: "invalid_feedback",
							message: "Missing or unsupported protocolVersion",
						},
						{ status: 400 },
					);
				}
				// Step 1: Validate the Chrome payload at its declared version.
				const result = validateFeedbackEvent(raw, declaredVersion);
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
				// Step 2: Look up the target OMP session and gate delivery.
				const session = registry.getByChannelId(result.value.channelId);
				let wirePayload: BrowserFeedbackEvent = result.value;
				if (session && session.negotiatedProtocolVersion < 2) {
					// v1 OMP: attempt to produce a valid v1 wire form.
					// Shared event types (dom.selection, page.screenshot) downgrade
					// cleanly.  Truly v2-only payloads/fields fail here.
					const v1Result = downgradeToV1(result.value);
					if (!v1Result.ok) {
						return jsonResponse(
							{
								ok: false,
								code: "omp_upgrade_required",
								message: `Target OMP session negotiates protocol ${session.negotiatedProtocolVersion}; event has no v1 representation: ${v1Result.error}. Upgrade OMP to receive this event.`,
							},
							{ status: 400 },
						);
					}
					wirePayload = v1Result.value;
				}
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
					if (wirePayload.screenshot) {
						wirePayload = {
							...wirePayload,
							screenshot: { ...wirePayload.screenshot, ref: saved.ref },
						};
					}
				}
				// Store the original event (tracks eventId for ACK matching).
				await feedback.add({
					channelId: event.channelId,
					eventId: event.eventId,
					createdAt: event.createdAt,
					payload: event,
				});
				if (!session) return jsonResponse({ ok: true, eventId: event.eventId });
				const presence = registry.presenceOf(session.sessionId);
				// Send the wire-appropriate payload to the OMP subscriber.
				// v1 OMP receives the validated v1-downgraded form.
				// v2 OMP receives the original v2 payload.
				if (presence !== "disconnected") {
					websockets.sendFeedback(session.sessionId, wirePayload);
					// v1 legacy: mark-on-send (not crash-safe).
					// v2: remains pending until ACK from OMP.
					if (session.negotiatedProtocolVersion === 1) {
						await feedback.markDelivered(session.channelId, event.eventId);
					}
				}
				return jsonResponse({
					ok: true,
					eventId: event.eventId,
					queued: presence === "disconnected",
					presence,
				});
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
				const raw = await readJson(request);
				const declaredVersion = inferProtocolVersion(raw);
				if (declaredVersion === undefined) {
					return jsonResponse(
						{
							ok: false,
							code: "invalid_session",
							message: "Missing or unsupported protocolVersion",
						},
						{ status: 400 },
					);
				}
				const negotiated = negotiateProtocolVersion(LOCAL_VERSION_RANGE, {
					min: declaredVersion,
					max: declaredVersion,
				});
				if (negotiated === undefined) {
					return jsonResponse(
						{
							ok: false,
							code: "protocol_version_unsupported",
							message: `No overlapping protocol version (local [${LOCAL_VERSION_RANGE.min}, ${LOCAL_VERSION_RANGE.max}], remote [${declaredVersion}, ${declaredVersion}])`,
						},
						{ status: 400 },
					);
				}
				const result = validateSessionRegistration(
					raw,
					negotiated as BrowserProtocolVersion,
				);
				if (!result.ok)
					return jsonResponse(
						{ ok: false, code: "invalid_session", message: result.error },
						{ status: 400 },
					);
				return jsonResponse({
					ok: true,
					session: registry.register(
						result.value,
						negotiated as BrowserProtocolVersion,
					),
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
			sendPings: false,
			open(socket) {
				websockets.add(socket);
				const session = registry.markConnected(socket.data.sessionId);
				if (!session) return;
				const pending = feedback.pendingByChannel(session.channelId);
				for (const stored of pending) {
					if (!stored.payload) continue;
					const original = stored.payload as BrowserFeedbackEvent;
					let wirePayload: BrowserFeedbackEvent = original;
					if (session.negotiatedProtocolVersion < 2) {
						// v1 OMP: downgrade to validated v1 wire form.
						const v1Result = downgradeToV1(original);
						if (!v1Result.ok) continue;
						wirePayload = v1Result.value;
					}
					websockets.sendFeedbackToSocket(socket, wirePayload);
					// v1 legacy: mark-on-send (not crash-safe).
					// v2: stays pending until ACK.
					if (session.negotiatedProtocolVersion === 1) {
						void feedback.markDelivered(session.channelId, stored.eventId);
					}
				}
			},
			close(socket) {
				websockets.remove(socket);
				if (!websockets.hasSession(socket.data.sessionId))
					registry.markDisconnected(socket.data.sessionId);
			},
			pong(socket) {
				registry.recordPong(socket.data.sessionId);
			},
			message(socket, data) {
				let msg: unknown;
				try {
					msg = JSON.parse(String(data));
				} catch {
					return;
				}
				const ack = validateFeedbackAck(msg);
				if (!ack.ok) return;
				const session = registry.getBySessionId(socket.data.sessionId);
				if (!session) return;
				// Only v2 sessions send ACKs; ignore from v1.
				if (session.negotiatedProtocolVersion < 2) return;
				void feedback.markDelivered(session.channelId, ack.value.eventId);
			},
		},
	});

	const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
	const heartbeat = setInterval(() => {
		websockets.pingAll();
		registry.prune();
	}, heartbeatIntervalMs);
	heartbeat.unref?.();

	return {
		baseUrl: `http://${options.host}:${port}`,
		host: options.host,
		port,
		registry,
		feedback,
		screenshots,
		websockets,
		stop() {
			clearInterval(heartbeat);
			server.stop(true);
		},
	};
}
