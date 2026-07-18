import { describe, expect, test } from "bun:test";
import {
	buildPickedSummary,
	cancelNote,
	confirmNote,
	createToolbarState,
	enterNoteEditing,
	hideToolbar,
	selectSession,
	setSessions,
	showToolbar,
	updateNoteText,
} from "../src/toolbar/state";
import type { ToolbarSession } from "../src/toolbar/state";

function fakeSession(overrides: Partial<ToolbarSession> = {}): ToolbarSession {
	return {
		sessionId: "ses_001",
		channelId: "ch_001",
		sessionName: "Test Session",
		displayName: "Test",
		status: "active",
		...overrides,
	};
}

describe("createToolbarState", () => {
	test("returns default state with no session, zero picks, not visible", () => {
		const state = createToolbarState();
		expect(state.session).toBeNull();
		expect(state.sessions).toEqual([]);
		expect(state.pickCount).toBe(0);
		expect(state.noteEditing).toBe(false);
		expect(state.visible).toBe(false);
	});
});

describe("showToolbar / hideToolbar", () => {
	test("showToolbar sets visible true", () => {
		const state = showToolbar(createToolbarState());
		expect(state.visible).toBe(true);
	});

	test("hideToolbar resets visible, noteEditing, noteText, and lastPickedSummary", () => {
		let state = showToolbar(createToolbarState());
		state = enterNoteEditing(state, "<div> .foo \"bar\"");
		state = updateNoteText(state, "my note");
		state = hideToolbar(state);
		expect(state.visible).toBe(false);
		expect(state.noteEditing).toBe(false);
		expect(state.noteText).toBe("");
		expect(state.lastPickedSummary).toBeNull();
	});
});

describe("setSessions", () => {
	test("sets sessions and auto-selects first if none selected", () => {
		const s1 = fakeSession({ sessionId: "a" });
		const s2 = fakeSession({ sessionId: "b" });
		const state = setSessions(createToolbarState(), [s1, s2]);
		expect(state.sessions).toHaveLength(2);
		expect(state.session?.sessionId).toBe("a");
	});

	test("keeps existing selection if still in list", () => {
		const s1 = fakeSession({ sessionId: "a" });
		const s2 = fakeSession({ sessionId: "b" });
		let state = setSessions(createToolbarState(), [s1, s2]);
		state = selectSession(state, "b");
		state = setSessions(state, [s1, s2]);
		expect(state.session?.sessionId).toBe("b");
	});

	test("falls back to first if selected session removed", () => {
		const s1 = fakeSession({ sessionId: "a" });
		const s2 = fakeSession({ sessionId: "b" });
		let state = setSessions(createToolbarState(), [s1, s2]);
		state = selectSession(state, "b");
		state = setSessions(state, [s1]);
		expect(state.session?.sessionId).toBe("a");
	});
});

describe("selectSession", () => {
	test("selects a session by id", () => {
		const s1 = fakeSession({ sessionId: "a" });
		const s2 = fakeSession({ sessionId: "b" });
		let state = setSessions(createToolbarState(), [s1, s2]);
		state = selectSession(state, "b");
		expect(state.session?.sessionId).toBe("b");
	});

	test("sets session to null if id not found", () => {
		const s1 = fakeSession({ sessionId: "a" });
		let state = setSessions(createToolbarState(), [s1]);
		state = selectSession(state, "nonexistent");
		expect(state.session).toBeNull();
	});
});

describe("enterNoteEditing", () => {
	test("increments pickCount and enters note editing", () => {
		const state = enterNoteEditing(createToolbarState(), "<div> .foo \"hi\"");
		expect(state.pickCount).toBe(1);
		expect(state.noteEditing).toBe(true);
		expect(state.lastPickedSummary).toBe("<div> .foo \"hi\"");
		expect(state.noteText).toBe("");
	});

	test("increments pickCount from previous value", () => {
		let state = enterNoteEditing(createToolbarState(), "a");
		state = confirmNote(state);
		state = enterNoteEditing(state, "b");
		expect(state.pickCount).toBe(2);
	});
});

describe("confirmNote", () => {
	test("clears note editing state", () => {
		let state = enterNoteEditing(createToolbarState(), "summary");
		state = updateNoteText(state, "my note");
		state = confirmNote(state);
		expect(state.noteEditing).toBe(false);
		expect(state.noteText).toBe("");
		expect(state.lastPickedSummary).toBeNull();
	});
});

describe("cancelNote", () => {
	test("clears note editing state without further incrementing pick count", () => {
		let state = enterNoteEditing(createToolbarState(), "summary");
		// enterNoteEditing already incremented to 1
		expect(state.pickCount).toBe(1);
		state = cancelNote(state);
		expect(state.noteEditing).toBe(false);
		expect(state.pickCount).toBe(1);
	});
});

describe("buildPickedSummary", () => {
	test("formats tag, selector, and text", () => {
		expect(buildPickedSummary("BUTTON", "#save", "Save")).toBe(
			'<button> #save "Save"',
		);
	});

	test("truncates long text to 40 chars with ellipsis", () => {
		const longText = "A".repeat(60);
		const result = buildPickedSummary("DIV", ".card", longText);
		expect(result).toContain("…");
		expect(result.length).toBeLessThan(longText.length + 20);
	});
});
