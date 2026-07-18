import * as net from "node:net";
import {
	BROWSER_BROKER_SERVICE,
	BROWSER_FEEDBACK_LIMITS,
	BROWSER_PROTOCOL_VERSION,
	BROWSER_PROTOCOL_VERSIONS,
	type BrowserFeedbackEvent,
	type BrowserProtocolVersion,
	downgradeToV1,
	inferProtocolVersion,
	negotiateProtocolVersion,
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

async function readFeedbackRequest(
	request: Request,
	screenshots: BrowserScreenshotStore,
): Promise<unknown> {
	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.includes("multipart/form-data"))
		return await readJson(request);

	const form = await request.formData();
	const eventPart = form.get("event");
	if (typeof eventPart !== "string") {
		throw new Error("Multipart feedback requires an event JSON part");
	}
	const event = JSON.parse(eventPart) as BrowserFeedbackEvent;
	const screenshotPart = form.get("screenshot");
	if (screenshotPart instanceof Blob && event.screenshot) {
		const saved = await screenshots.save({
			eventId: event.eventId,
			mimeType: event.screenshot.mimeType,
			bytes: new Uint8Array(await screenshotPart.arrayBuffer()),
		});
		return {
			...event,
			screenshot: {
				...event.screenshot,
				ref: saved.ref,
			},
		};
	}
	return event;
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

	const registry = new BrowserSessionRegistry();
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
				const raw = await readFeedbackRequest(request, screenshots);
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
				// Store the original event (tracks eventId for ACK matching).
				await feedback.add({
					channelId: result.value.channelId,
					eventId: result.value.eventId,
					createdAt: result.value.createdAt,
					payload: result.value,
				});
				if (session) {
					// Send the wire-appropriate payload to the OMP subscriber.
					// v1 OMP receives the validated v1-downgraded form.
					// v2 OMP receives the original v2 payload.
					websockets.sendFeedback(session.sessionId, wirePayload);
					// v1 legacy: mark-on-send (not crash-safe).
					// v2: remains pending until ACK from OMP.
					if (session.negotiatedProtocolVersion === 1) {
						await feedback.markDelivered(session.channelId, result.value.eventId);
					}
				}
				return jsonResponse({ ok: true, eventId: result.value.eventId });
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
			open(socket) {
				websockets.add(socket);
				const session = registry.update(socket.data.sessionId, {
					status: "active",
					lastActiveAt: new Date().toISOString(),
				});
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
				registry.markDisconnected(socket.data.sessionId);
			},
			async message(socket, data) {
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
				await feedback.markDelivered(session.channelId, ack.value.eventId);
			},
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
