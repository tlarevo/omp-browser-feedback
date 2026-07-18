/**
 * Machine-readable browser feedback protocol contract.
 *
 * Single source of truth for:
 *  - Protocol version and supported compatibility range
 *  - Broker endpoint paths, HTTP methods, and auth requirements
 *  - Schemas and validators (re-exported for convenience)
 *  - Route matching helpers derived from endpoint templates
 *
 * Consumed by:
 *  - `browser-broker` server routing and version validation
 *  - Standalone Chrome extension protocol generation (via JSON export)
 *  - Drift-detection CI
 */
import { BROWSER_PROTOCOL_VERSION } from "./version";

// ── Version range ──────────────────────────────────────────────────────────

export const BROWSER_PROTOCOL_VERSION_RANGE = {
	min: BROWSER_PROTOCOL_VERSION,
	max: BROWSER_PROTOCOL_VERSION,
} as const;

// ── Auth kinds ─────────────────────────────────────────────────────────────

export const AUTH_NONE = "none" as const;
export const AUTH_ROOT_TOKEN = "root-token" as const;
export const AUTH_BROWSER_CAPABILITY = "browser-capability" as const;
export const AUTH_ROOT_OR_BROWSER = "root-or-browser" as const;
export const AUTH_PAIRING_CODE = "pairing-code" as const;

export type AuthKind =
	| typeof AUTH_NONE
	| typeof AUTH_ROOT_TOKEN
	| typeof AUTH_BROWSER_CAPABILITY
	| typeof AUTH_ROOT_OR_BROWSER
	| typeof AUTH_PAIRING_CODE;

// ── Endpoint definitions ───────────────────────────────────────────────────

export const ENDPOINT_HEALTH = {
	path: "/api/health",
	method: "GET",
	auth: AUTH_NONE,
} as const;

export const ENDPOINT_PAIR_REDEEM = {
	path: "/api/pair",
	method: "POST",
	auth: AUTH_PAIRING_CODE,
} as const;

export const ENDPOINT_PAIR_OPEN = {
	path: "/api/pair/open",
	method: "POST",
	auth: AUTH_ROOT_TOKEN,
} as const;

export const ENDPOINT_PAIR_RESET = {
	path: "/api/pair/reset",
	method: "POST",
	auth: AUTH_ROOT_TOKEN,
} as const;

export const ENDPOINT_SESSIONS_LIST = {
	path: "/api/sessions",
	method: "GET",
	auth: AUTH_ROOT_OR_BROWSER,
} as const;

export const ENDPOINT_SESSION_REGISTER = {
	path: "/api/sessions/register",
	method: "POST",
	auth: AUTH_ROOT_TOKEN,
} as const;

export const ENDPOINT_SESSION_UPDATE = {
	path: "/api/sessions/:sessionId",
	method: "PATCH",
	auth: AUTH_ROOT_TOKEN,
} as const;

export const ENDPOINT_SESSION_DELETE = {
	path: "/api/sessions/:sessionId",
	method: "DELETE",
	auth: AUTH_ROOT_TOKEN,
} as const;

export const ENDPOINT_SESSION_FEEDBACK_LIST = {
	path: "/api/sessions/:sessionId/feedback",
	method: "GET",
	auth: AUTH_ROOT_TOKEN,
} as const;

export const ENDPOINT_SESSION_FEEDBACK_LATEST = {
	path: "/api/sessions/:sessionId/feedback/latest",
	method: "GET",
	auth: AUTH_ROOT_TOKEN,
} as const;

export const ENDPOINT_SESSION_FEEDBACK_CLEAR = {
	path: "/api/sessions/:sessionId/feedback",
	method: "DELETE",
	auth: AUTH_ROOT_TOKEN,
} as const;

export const ENDPOINT_FEEDBACK_SUBMIT = {
	path: "/api/feedback",
	method: "POST",
	auth: AUTH_ROOT_OR_BROWSER,
} as const;

export const ENDPOINT_WS_OMP = {
	path: "/ws/omp/:sessionId",
	method: "GET",
	auth: AUTH_ROOT_TOKEN,
} as const;

/**
 * Authoritative endpoint map.  The JSON export serialises this object
 * directly — no manual name list, no drift possible.
 */
export const ENDPOINTS = {
	health: ENDPOINT_HEALTH,
	pairRedeem: ENDPOINT_PAIR_REDEEM,
	pairOpen: ENDPOINT_PAIR_OPEN,
	pairReset: ENDPOINT_PAIR_RESET,
	sessionsList: ENDPOINT_SESSIONS_LIST,
	sessionRegister: ENDPOINT_SESSION_REGISTER,
	sessionUpdate: ENDPOINT_SESSION_UPDATE,
	sessionDelete: ENDPOINT_SESSION_DELETE,
	sessionFeedbackList: ENDPOINT_SESSION_FEEDBACK_LIST,
	sessionFeedbackLatest: ENDPOINT_SESSION_FEEDBACK_LATEST,
	sessionFeedbackClear: ENDPOINT_SESSION_FEEDBACK_CLEAR,
	feedbackSubmit: ENDPOINT_FEEDBACK_SUBMIT,
	wsOmp: ENDPOINT_WS_OMP,
} as const;

// ── Route matching helpers ────────────────────────────────────────────────

/**
 * Convert an endpoint template like `/api/sessions/:sessionId` into a
 * `RegExp` that captures named parameters.
 */
export function templateToRegex(template: string): RegExp {
	const pattern = template.replace(/:([a-zA-Z]+)/g, "([^/]+)");
	return new RegExp(`^${pattern}$`);
}

/** Extract param names from a template path. */
function paramNames(template: string): string[] {
	return [...template.matchAll(/:([a-zA-Z]+)/g)].map((m) => m[1]);
}

type EndpointEntry = (typeof ENDPOINTS)[keyof typeof ENDPOINTS];

/**
 * Try every endpoint template against a pathname and method.
 * Returns `{ endpoint, params }` on match or `undefined`.
 */
export function matchEndpoint(
	pathname: string,
	method: string,
): { endpoint: EndpointEntry; params: Record<string, string> } | undefined {
	for (const [, endpoint] of Object.entries(ENDPOINTS)) {
		if (endpoint.method !== method) continue;
		if (!endpoint.path.includes(":")) {
			if (pathname === endpoint.path) return { endpoint, params: {} };
			continue;
		}
		const match = pathname.match(templateToRegex(endpoint.path));
		if (match) {
			const names = paramNames(endpoint.path);
			const params: Record<string, string> = {};
			for (let i = 0; i < names.length; i++) {
				params[names[i]] = decodeURIComponent(match[i + 1] ?? "");
			}
			return { endpoint, params };
		}
	}
	return undefined;
}

// ── Re-exports ─────────────────────────────────────────────────────────────

export { BROWSER_FEEDBACK_LIMITS } from "./limits";
export type {
	BrowserFeedbackEvent,
	BrowserSessionRegistration,
	BrowserSessionStatus,
} from "./types";
export {
	validateFeedbackEvent,
	validateSessionRegistration,
} from "./validation";
export { BROWSER_PROTOCOL_VERSION } from "./version";
