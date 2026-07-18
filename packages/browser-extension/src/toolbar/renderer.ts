/**
 * Toolbar renderer — Shadow DOM isolated, draggable, keyboard accessible.
 * Pure DOM rendering; no chrome APIs, no extension messaging.
 */
import type { ToolbarSession, ToolbarState } from "./state";

const TOOLBAR_ATTR = "data-omp-toolbar";
const Z_INDEX = "2147483647";

// ─── Styles (scoped inside Shadow DOM) ───────────────────────────────────────

const STYLES = `
:host { all: initial; font-family: system-ui, -apple-system, sans-serif; font-size: 13px; }

.toolbar {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: ${Z_INDEX};
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #1a1a2e;
  color: #e0e0e0;
  border-radius: 10px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.4);
  cursor: grab;
  user-select: none;
  white-space: nowrap;
}
.toolbar.dragging { cursor: grabbing; }

.session-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: #16213e;
  border-radius: 6px;
  cursor: pointer;
  position: relative;
  max-width: 200px;
  overflow: hidden;
}
.session-pill .label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-pill .branch {
  color: #7aa2f7;
  font-size: 11px;
}
.session-pill .status-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-active { background: #9ece6a; }
.status-idle { background: #e0af68; }
.status-disconnected { background: #f7768e; }

/* Session dropdown */
.session-dropdown {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 220px;
  max-height: 260px;
  overflow-y: auto;
  background: #1a1a2e;
  border: 1px solid #333;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  z-index: ${Z_INDEX};
  display: none;
}
.session-dropdown.open { display: block; }
.session-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  border: none;
  background: none;
  color: #e0e0e0;
  width: 100%;
  text-align: left;
  font: inherit;
}
.session-option:hover, .session-option:focus-visible {
  background: #16213e;
  outline: none;
}
.session-option.selected {
  background: #16213e;
}
.session-option .opt-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-option .opt-branch { color: #7aa2f7; font-size: 11px; }

.pick-count {
  padding: 4px 8px;
  background: #16213e;
  border-radius: 6px;
  font-size: 11px;
  color: #a0a0b0;
}

.mode-pill {
  padding: 4px 8px;
  background: #16213e;
  border-radius: 6px;
  font-size: 11px;
  color: #7aa2f7;
}

.btn {
  border: none;
  border-radius: 6px;
  padding: 5px 12px;
  font: inherit;
  cursor: pointer;
  color: #fff;
}
.btn:focus-visible {
  outline: 2px solid #7aa2f7;
  outline-offset: 1px;
}
.btn-send { background: #9ece6a; color: #1a1a2e; font-weight: 600; }
.btn-send:hover { background: #a9d86e; }
.btn-cancel { background: #f7768e; color: #1a1a2e; }
.btn-cancel:hover { background: #ff8a9e; }

/* Post-pick note area */
.note-area {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  min-width: 280px;
  max-width: 400px;
  background: #1a1a2e;
  border: 1px solid #333;
  border-radius: 8px;
  padding: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  display: none;
}
.note-area.visible { display: block; }
.note-preview {
  font-size: 11px;
  color: #7aa2f7;
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-input {
  width: 100%;
  box-sizing: border-box;
  background: #16213e;
  border: 1px solid #333;
  border-radius: 4px;
  color: #e0e0e0;
  padding: 6px 8px;
  font: inherit;
  resize: vertical;
  min-height: 36px;
}
.note-input:focus {
  outline: 1px solid #7aa2f7;
}
.note-hint {
  font-size: 10px;
  color: #666;
  margin-top: 4px;
}
`;

// ─── Renderer ────────────────────────────────────────────────────────────────

export interface ToolbarActions {
	onSend(note: string): void;
	onCancel(): void;
	onSessionSelect(sessionId: string): void;
	onEscape(): void;
}

export interface ToolbarHandle {
	update(state: ToolbarState): void;
	remove(): void;
	getElement(): HTMLElement;
}

function statusClass(status: ToolbarSession["status"]): string {
	switch (status) {
		case "active": return "status-active";
		case "idle": return "status-idle";
		case "disconnected": return "status-disconnected";
	}
}

function renderSessionPill(
	doc: Document,
	session: ToolbarSession | null,
	dropdownOpen: boolean,
	sessions: ToolbarSession[],
	selectedId: string | undefined,
	actions: ToolbarActions,
): HTMLElement {
	const pill = doc.createElement("div");
	pill.className = "session-pill";
	pill.setAttribute("role", "button");
	pill.setAttribute("tabindex", "0");
	pill.setAttribute("aria-label", `Session: ${session?.sessionName ?? "none"}. Click to switch.`);

	// Status dot
	const dot = doc.createElement("span");
	dot.className = `status-dot ${session ? statusClass(session.status) : ""}`;
	pill.appendChild(dot);

	// Label
	const label = doc.createElement("span");
	label.className = "label";
	label.textContent = session?.displayName ?? session?.sessionName ?? "No session";
	pill.appendChild(label);

	// Branch
	if (session?.gitBranch) {
		const branch = doc.createElement("span");
		branch.className = "branch";
		branch.textContent = session.gitBranch;
		pill.appendChild(branch);
	}

	// Dropdown
	const dropdown = doc.createElement("div");
	dropdown.className = `session-dropdown${dropdownOpen ? " open" : ""}`;
	dropdown.setAttribute("role", "listbox");
	dropdown.setAttribute("aria-label", "Select session");

	for (const s of sessions) {
		const opt = doc.createElement("button");
		opt.className = `session-option${s.sessionId === selectedId ? " selected" : ""}`;
		opt.setAttribute("role", "option");
		opt.setAttribute("aria-selected", s.sessionId === selectedId ? "true" : "false");
		opt.type = "button";

		const optDot = doc.createElement("span");
		optDot.className = `status-dot ${statusClass(s.status)}`;
		opt.appendChild(optDot);

		const optLabel = doc.createElement("span");
		optLabel.className = "opt-label";
		optLabel.textContent = s.displayName ?? s.sessionName;
		opt.appendChild(optLabel);

		if (s.gitBranch) {
			const optBranch = doc.createElement("span");
			optBranch.className = "opt-branch";
			optBranch.textContent = s.gitBranch;
			opt.appendChild(optBranch);
		}

		opt.addEventListener("click", (e) => {
			e.stopPropagation();
			actions.onSessionSelect(s.sessionId);
		});
		dropdown.appendChild(opt);
	}

	pill.appendChild(dropdown);
	return pill;
}

function renderNoteArea(
	doc: Document,
	summary: string | null,
	text: string,
): HTMLElement {
	const area = doc.createElement("div");
	area.className = `note-area${summary ? " visible" : ""}`;

	if (summary) {
		const preview = doc.createElement("div");
		preview.className = "note-preview";
		preview.textContent = summary;
		area.appendChild(preview);
	}

	const input = doc.createElement("input");
	input.type = "text";
	input.className = "note-input";
	input.placeholder = "Add a note… (Enter to confirm, Esc to cancel)";
	input.value = text;
	input.setAttribute("aria-label", "Post-pick note");
	area.appendChild(input);

	const hint = doc.createElement("div");
	hint.className = "note-hint";
	hint.textContent = "Enter to confirm, Esc to cancel";
	area.appendChild(hint);

	return area;
}

export function createToolbar(
	doc: Document,
	actions: ToolbarActions,
): ToolbarHandle {
	// Host element (no Shadow DOM — Shadow DOM breaks extension content script isolation in some browsers;
	// using scoped styles inside the host is sufficient for the toolbar).
	// We rely on all class names being prefixed with data-omp-toolbar context to avoid page CSS bleed.
	const host = doc.createElement("div");
	host.setAttribute(TOOLBAR_ATTR, "true");
	host.style.cssText = `all:initial;position:fixed;bottom:16px;right:16px;z-index:${Z_INDEX};font-family:system-ui,-apple-system,sans-serif;font-size:13px;`;

	// Scoped style
	const style = doc.createElement("style");
	style.textContent = STYLES.replace(/:host/g, `[${TOOLBAR_ATTR}]`);
	host.appendChild(style);

	const toolbar = doc.createElement("div");
	toolbar.className = "toolbar";
	toolbar.setAttribute("role", "toolbar");
	toolbar.setAttribute("aria-label", "Browser feedback toolbar");
	host.appendChild(toolbar);

	doc.body.appendChild(host);

	let dropdownOpen = false;
	let dragState: { startX: number; startY: number; origRight: number; origBottom: number } | null = null;

	// ── Drag handling ──────────────────────────────────────────────────────
	const onMouseDown = (e: MouseEvent) => {
		// Don't drag from interactive children
		const target = e.target as HTMLElement;
		if (target.closest("button, input, select, .session-option, .note-area")) return;

		dragState = {
			startX: e.clientX,
			startY: e.clientY,
			origRight: 16,
			origBottom: 16,
		};
		toolbar.classList.add("dragging");
	};

	const onMouseMove = (e: MouseEvent) => {
		if (!dragState) return;
		const dx = e.clientX - dragState.startX;
		const dy = e.clientY - dragState.startY;
		const newRight = Math.max(0, dragState.origRight - dx);
		const newBottom = Math.max(0, dragState.origBottom - dy);
		host.style.right = `${newRight}px`;
		host.style.bottom = `${newBottom}px`;
	};

	const onMouseUp = () => {
		if (dragState) {
			dragState = null;
			toolbar.classList.remove("dragging");
		}
	};

	doc.addEventListener("mousemove", onMouseMove);
	doc.addEventListener("mouseup", onMouseUp);

	// ── Keyboard handling ──────────────────────────────────────────────────
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			actions.onEscape();
		}
		if (e.key === "Enter" && state?.noteEditing) {
			e.preventDefault();
			e.stopPropagation();
			actions.onSend(state.noteText);
		}
	};

	doc.addEventListener("keydown", onKeyDown, true);

	// ── State ──────────────────────────────────────────────────────────────
	let state: ToolbarState | null = null;

	function render() {
		if (!state || !state.visible) {
			host.remove();
			return;
		}

		// Rebuild toolbar content (simple — no diffing needed for this size)
		toolbar.replaceChildren();

		// Session pill + dropdown
		const pill = renderSessionPill(
			doc,
			state.session,
			dropdownOpen,
			state.sessions,
			state.session?.sessionId,
			actions,
		);

		// Toggle dropdown on pill click
		const pillBtn = pill.querySelector(".session-pill") ?? pill;
		pillBtn.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest(".session-option")) return;
			dropdownOpen = !dropdownOpen;
			const dd = pill.querySelector(".session-dropdown");
			if (dd) dd.classList.toggle("open", dropdownOpen);
		});

		// Close dropdown on outside click
		const closeDropdown = (e: MouseEvent) => {
			if (!pill.contains(e.target as Node)) {
				dropdownOpen = false;
				const dd = pill.querySelector(".session-dropdown");
				if (dd) dd.classList.remove("open");
			}
		};
		doc.addEventListener("click", closeDropdown);

		toolbar.appendChild(pill);

		// Pick count
		if (state.pickCount > 0) {
			const count = doc.createElement("span");
			count.className = "pick-count";
			count.textContent = `${state.pickCount} pick${state.pickCount === 1 ? "" : "s"}`;
			count.setAttribute("aria-label", `${state.pickCount} elements picked`);
			toolbar.appendChild(count);
		}

		// Mode pill
		const mode = doc.createElement("span");
		mode.className = "mode-pill";
		mode.textContent = state.captureMode === "element" ? "Element" : state.captureMode;
		toolbar.appendChild(mode);

		// Send button
		const sendBtn = doc.createElement("button");
		sendBtn.className = "btn btn-send";
		sendBtn.type = "button";
		sendBtn.textContent = "Send";
		sendBtn.setAttribute("aria-label", "Send feedback");
		sendBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			actions.onSend(state?.noteText ?? "");
		});
		toolbar.appendChild(sendBtn);

		// Cancel button
		const cancelBtn = doc.createElement("button");
		cancelBtn.className = "btn btn-cancel";
		cancelBtn.type = "button";
		cancelBtn.textContent = "Cancel";
		cancelBtn.setAttribute("aria-label", "Cancel picker");
		cancelBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			actions.onCancel();
		});
		toolbar.appendChild(cancelBtn);

		// Drag handle
		toolbar.addEventListener("mousedown", onMouseDown);

		// Note area (post-pick)
		if (state.noteEditing) {
			const noteArea = renderNoteArea(doc, state.lastPickedSummary, state.noteText);
			const noteInput = noteArea.querySelector(".note-input") as HTMLInputElement | null;
			if (noteInput) {
				noteInput.addEventListener("input", () => {
					if (state) {
						state = { ...state, noteText: noteInput.value };
					}
				});
				// Auto-focus the note input
				setTimeout(() => noteInput.focus(), 0);
			}
			host.appendChild(noteArea);
		} else {
			const existing = host.querySelector(".note-area");
			if (existing) existing.remove();
		}

		// Ensure host is in DOM
		if (!host.parentElement) {
			doc.body.appendChild(host);
		}
	}

	return {
		update(newState: ToolbarState) {
			state = newState;
			render();
		},
		remove() {
			host.remove();
			doc.removeEventListener("mousemove", onMouseMove);
			doc.removeEventListener("mouseup", onMouseUp);
			doc.removeEventListener("keydown", onKeyDown, true);
		},
		getElement() {
			return host;
		},
	};
}
