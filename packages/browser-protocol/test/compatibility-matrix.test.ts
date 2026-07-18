import { describe, expect, test } from "bun:test";
import {
	BROWSER_PROTOCOL_VERSION,
	downgradeToV1,
	inferProtocolVersion,
	validateFeedbackEvent,
	validateSessionRegistration,
} from "../src";

function v1Registration(overrides?: Record<string, unknown>) {
	return {
		protocolVersion: 1,
		sessionId: "ses_1",
		channelId: "ses_1",
		sessionName: "Session",
		displayName: "Session",
		cwd: "/repo",
		status: "active",
		lastActiveAt: "2026-06-27T10:00:00.000Z",
		processId: 1,
		...overrides,
	};
}

function v2Registration(overrides?: Record<string, unknown>) {
	return {
		protocolVersion: BROWSER_PROTOCOL_VERSION,
		sessionId: "ses_1",
		channelId: "ses_1",
		sessionName: "Session",
		displayName: "Session",
		cwd: "/repo",
		status: "active",
		lastActiveAt: "2026-06-27T10:00:00.000Z",
		processId: 1,
		...overrides,
	};
}

function v1DomSelection(overrides?: Record<string, unknown>) {
	return {
		protocolVersion: 1,
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
		...overrides,
	};
}

function v2DomSelection(overrides?: Record<string, unknown>) {
	return {
		...v1DomSelection(overrides),
		protocolVersion: BROWSER_PROTOCOL_VERSION,
	};
}

describe("compatibility matrix: session registration", () => {
	test("v1 Chrome registration validates at v1", () => {
		const result = validateSessionRegistration(v1Registration(), 1);
		expect(result.ok).toBe(true);
	});

	test("v2 Chrome registration validates at v2", () => {
		const result = validateSessionRegistration(v2Registration(), 2);
		expect(result.ok).toBe(true);
	});

	test("v2 Chrome registration rejected at v1 (wrong version)", () => {
		const result = validateSessionRegistration(v2Registration(), 1);
		expect(result.ok).toBe(false);
	});

	test("v1 Chrome registration rejected at v2 (wrong version)", () => {
		const result = validateSessionRegistration(v1Registration(), 2);
		expect(result.ok).toBe(false);
	});

	test("rejects unknown fields in v1 schema", () => {
		const result = validateSessionRegistration(
			v1Registration({ newField: "oops" }),
			1,
		);
		expect(result.ok).toBe(false);
	});

	test("rejects unknown fields in v2 schema", () => {
		const result = validateSessionRegistration(
			v2Registration({ newField: "oops" }),
			2,
		);
		expect(result.ok).toBe(false);
	});
});

describe("compatibility matrix: feedback events", () => {
	test("v1 Chrome feedback validates at v1", () => {
		const result = validateFeedbackEvent(v1DomSelection(), 1);
		expect(result.ok).toBe(true);
	});

	test("v2 Chrome feedback validates at v2", () => {
		const result = validateFeedbackEvent(v2DomSelection(), 2);
		expect(result.ok).toBe(true);
	});

	test("v2 feedback rejected at v1 (strict schema)", () => {
		const result = validateFeedbackEvent(v2DomSelection(), 1);
		expect(result.ok).toBe(false);
	});
});

describe("compatibility matrix: v1 representability", () => {
	test("v1 event has valid v1 representation", () => {
		expect(downgradeToV1(v1DomSelection()).ok).toBe(true);
	});

	test("shared event type (dom.selection) has valid v1 representation even when declared v2", () => {
		expect(downgradeToV1(v2DomSelection()).ok).toBe(true);
	});

	test("downgradeToV1 produces valid v1 wire form from v2 payload", () => {
		const result = downgradeToV1(v2DomSelection());
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected downgrade to succeed");
		expect(result.value.protocolVersion).toBe(1);
	});

	test("downgradeToV1 rejects non-object input", () => {
		expect(downgradeToV1(null).ok).toBe(false);
		expect(downgradeToV1("string").ok).toBe(false);
	});

	test("rejects extra unknown fields (v1 strict schema)", () => {
		const result = downgradeToV1({
			...v2DomSelection(),
			futureField: "not-yet",
		});
		expect(result.ok).toBe(false);
	});
});

describe("compatibility matrix: version inference", () => {
	test("infers v1 from protocolVersion: 1", () => {
		expect(inferProtocolVersion({ protocolVersion: 1 })).toBe(1);
	});

	test("infers v2 from protocolVersion: 2", () => {
		expect(inferProtocolVersion({ protocolVersion: 2 })).toBe(2);
	});

	test("returns undefined for missing protocolVersion", () => {
		expect(inferProtocolVersion({})).toBeUndefined();
	});

	test("returns undefined for unsupported version", () => {
		expect(inferProtocolVersion({ protocolVersion: 3 })).toBeUndefined();
	});
});
