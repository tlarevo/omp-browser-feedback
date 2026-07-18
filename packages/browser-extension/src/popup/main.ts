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

function readOptionalString(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const candidate = record[key];
	return typeof candidate === "string" ? candidate : undefined;
}

export async function ensureBrowserInstallId(): Promise<string> {
	return new Promise((resolve) => {
		chrome.storage.local.get(["browserInstallId"], (items) => {
			const existingInstallId = readOptionalString(items, "browserInstallId");
			if (existingInstallId) {
				resolve(existingInstallId);
				return;
			}

			const nextInstallId = `browser_${crypto.randomUUID()}`;
			chrome.storage.local.set({ browserInstallId: nextInstallId }, () => {
				resolve(nextInstallId);
			});
		});
	});
}

export type PopupState =
	| { kind: "no-broker"; attemptedPorts: number[] }
	| { kind: "unpaired"; baseUrl: string }
	| { kind: "pairing-error"; baseUrl: string; message: string }
	| { kind: "no-sessions"; baseUrl: string }
	| {
			kind: "ready";
			baseUrl: string;
			selectedSessionId?: string;
			sessions: BrowserSessionRegistration[];
	  }
	| {
			kind: "capturing";
			baseUrl: string;
			selectedSessionId?: string;
			sessions: BrowserSessionRegistration[];
			current: number;
			total: number;
	  }
	| { kind: "error"; message: string };

export interface PopupActionHandlers {
	onPairWithCode?: (code: string) => void;
	onSelectSession?: (sessionId: string) => void;
	onStartPicker?: (sessionId: string, note?: string) => void;
	onStartFullpageCapture?: (sessionId: string) => void;
	onCancelCapture?: () => void;
}

function clear(element: HTMLElement): void {
	element.replaceChildren();
}

function createButton(
	document: Document,
	label: string,
	onClick?: () => void,
): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	if (onClick) button.addEventListener("click", onClick);
	return button;
}

function appendStatus(
	document: Document,
	root: HTMLElement,
	text: string,
): void {
	const paragraph = document.createElement("p");
	paragraph.textContent = text;
	root.append(paragraph);
}

function appendPairingForm(
	document: Document,
	root: HTMLElement,
	onPairWithCode?: (code: string) => void,
): void {
	const input = document.createElement("input");
	input.autocomplete = "off";
	input.placeholder = "Pairing code";
	root.append(
		input,
		createButton(document, "Pair", () => onPairWithCode?.(input.value)),
	);
}

export function renderPopup(
	root: HTMLElement,
	state: PopupState,
	handlers: PopupActionHandlers = {},
): void {
	clear(root);
	const document = root.ownerDocument;

	if (state.kind === "no-broker") {
		appendStatus(
			document,
			root,
			`No OMP browser broker found on ports ${state.attemptedPorts.join(", ")}.`,
		);
		return;
	}

	if (state.kind === "unpaired") {
		appendStatus(
			document,
			root,
			`Broker found at ${state.baseUrl}. Enter pairing code from /bf pair.`,
		);
		appendPairingForm(document, root, handlers.onPairWithCode);
		return;
	}

	if (state.kind === "pairing-error") {
		appendStatus(
			document,
			root,
			`Broker found at ${state.baseUrl}. Enter pairing code from /bf pair.`,
		);
		appendStatus(document, root, state.message);
		appendPairingForm(document, root, handlers.onPairWithCode);
		return;
	}

	if (state.kind === "no-sessions") {
		appendStatus(
			document,
			root,
			`Connected to ${state.baseUrl}. No active OMP sessions.`,
		);
		return;
	}

	if (state.kind === "error") {
		appendStatus(document, root, state.message);
		return;
	}
	if (state.kind === "capturing") {
		renderCapturingState(document, root, state, handlers);
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
		input.addEventListener("change", () =>
			handlers.onSelectSession?.(session.sessionId),
		);
		label.append(input, document.createTextNode(renderSessionLabel(session)));
		item.append(label);
		list.append(item);
	}
	root.append(list);

	const noteArea = document.createElement("textarea");
	noteArea.placeholder =
		"Optional note — e.g. 'Change the button color to blue'";
	noteArea.rows = 2;

	const activeSessionId =
		state.selectedSessionId ?? state.sessions[0]?.sessionId;
	root.append(
		noteArea,
		createButton(
			document,
			"Pick element",
			activeSessionId
				? () =>
						handlers.onStartPicker?.(
							activeSessionId,
							noteArea.value.trim() || undefined,
						)
				: undefined,
		),
		createButton(
			document,
			"Full page",
			activeSessionId
				? () => handlers.onStartFullpageCapture?.(activeSessionId)
				: undefined,
		),
	);
}

function renderCapturingState(
	document: Document,
	root: HTMLElement,
	state: Extract<PopupState, { kind: "capturing" }>,
	handlers: PopupActionHandlers,
): void {
	const list = document.createElement("ul");
	for (const session of state.sessions) {
		const item = document.createElement("li");
		const label = document.createElement("label");
		const input = document.createElement("input");
		input.type = "radio";
		input.name = "session";
		input.value = session.sessionId;
		input.checked = session.sessionId === state.selectedSessionId;
		input.disabled = true;
		label.append(input, document.createTextNode(renderSessionLabel(session)));
		item.append(label);
		list.append(item);
	}
	root.append(list);

	appendStatus(document, root, `Capturing… ${state.current}/${state.total}`);

	root.append(
		createButton(document, "Cancel", () => handlers.onCancelCapture?.()),
	);
}
