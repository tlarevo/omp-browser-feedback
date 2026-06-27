import type { BrowserSessionRegistration } from "@oh-my-pi/browser-protocol";

export interface PopupSession {
	sessionId: string;
	displayName: string;
	cwd: string;
	gitBranch?: string;
	status: string;
	lastActiveAt?: string;
}

export function renderSessionLabel(session: PopupSession): string {
	const branch = session.gitBranch ? ` · ${session.gitBranch}` : "";
	return `${session.displayName} · ${session.cwd}${branch} · ${session.status}`;
}

export type PopupState =
	| { kind: "no-broker"; attemptedPorts: number[] }
	| { kind: "missing-auth"; baseUrl: string }
	| { kind: "no-sessions"; baseUrl: string }
	| { kind: "ready"; baseUrl: string; selectedSessionId?: string; sessions: BrowserSessionRegistration[] }
	| { kind: "error"; message: string };

export interface PopupActionHandlers {
	onSelectSession?: (sessionId: string) => void;
	onStartPicker?: (sessionId: string, note?: string) => void;
	onSaveToken?: (token: string) => void;
}

function clear(element: HTMLElement): void {
	element.replaceChildren();
}

function createButton(document: Document, label: string, onClick?: () => void): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	if (onClick) button.addEventListener("click", onClick);
	return button;
}

function appendStatus(document: Document, root: HTMLElement, text: string): void {
	const paragraph = document.createElement("p");
	paragraph.textContent = text;
	root.append(paragraph);
}

export function renderPopup(root: HTMLElement, state: PopupState, handlers: PopupActionHandlers = {}): void {
	clear(root);
	const document = root.ownerDocument;

	if (state.kind === "no-broker") {
		appendStatus(document, root, `No OMP browser broker found on ports ${state.attemptedPorts.join(", ")}.`);
		return;
	}

	if (state.kind === "missing-auth") {
		appendStatus(document, root, `Broker found at ${state.baseUrl}. Paste the local auth token to continue.`);
		const input = document.createElement("input");
		input.type = "password";
		input.autocomplete = "off";
		input.placeholder = "Auth token";
		const button = createButton(document, "Save", () => handlers.onSaveToken?.(input.value));
		root.append(input, button);
		return;
	}

	if (state.kind === "no-sessions") {
		appendStatus(document, root, `Connected to ${state.baseUrl}. No active OMP sessions.`);
		return;
	}

	if (state.kind === "error") {
		appendStatus(document, root, state.message);
		return;
	}

	const list = document.createElement("ul");
	for (const session of state.sessions) {
		const item = document.createElement("li");
		const label = document.createElement("label");
		const input = document.createElement("input");
		input.type = "radio";
		input.name = "session";
		input.value = session.sessionId;
		input.checked = session.sessionId === state.selectedSessionId;
		input.addEventListener("change", () => handlers.onSelectSession?.(session.sessionId));
		label.append(input, document.createTextNode(renderSessionLabel(session)));
		item.append(label);
		list.append(item);
	}
	root.append(list);

	const noteArea = document.createElement("textarea");
	noteArea.placeholder = "Optional note — e.g. 'Change the button color to blue'";
	noteArea.rows = 2;

	const activeSessionId = state.selectedSessionId ?? state.sessions[0]?.sessionId;
	root.append(
		noteArea,
		createButton(
			document,
			"Pick element",
			activeSessionId
				? () => handlers.onStartPicker?.(activeSessionId, noteArea.value.trim() || undefined)
				: undefined,
		),
	);
}
