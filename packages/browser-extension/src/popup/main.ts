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
	| { kind: "loading" }
	| { kind: "hint"; message: string }
	| { kind: "no-broker"; attemptedPorts: number[] }
	| { kind: "unpaired"; baseUrl: string }
	| { kind: "pairing-error"; baseUrl: string; message: string }
	| { kind: "no-sessions"; baseUrl: string }
	| {
			kind: "ready";
			baseUrl: string;
			selectedSessionId?: string;
			sessions: BrowserSessionRegistration[];
			basket?: BasketState;
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

export interface BasketItemState {
	itemId: string;
	tagName: string;
	selector: string;
	note: string;
	text?: string;
}

export interface BasketState {
	items: BasketItemState[];
	batchNote: string;
	error?: string;
}

export interface PopupActionHandlers {
	onPairWithCode?: (code: string) => void;
	onSelectSession?: (sessionId: string) => void;
	onStartPicker?: (sessionId: string, note?: string) => void;
	onStartMultiPick?: (sessionId: string) => void;
	onSubmitBatch?: () => void;
	onRemoveBasketItem?: (itemId: string) => void;
=======
	onStartFullpageCapture?: (sessionId: string) => void;
	onCancelCapture?: () => void;
>>>>>>> tharinduabeydeera/tha-118-extension-full-page-capture-via-scroll-and-stitch
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

	if (state.kind === "loading") {
		appendStatus(document, root, "Connecting to broker\u2026");
		return;
	}

	if (state.kind === "hint") {
		appendStatus(document, root, state.message);
		return;
	}

	if (state.kind === "no-broker") {
		appendStatus(
			document,
			root,
			`No OMP browser broker found on ports ${state.attemptedPorts.join(", ")}.`,
		);
		root.append(createButton(document, "Retry", handlers.onRetry));
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

	const basket = state.basket;
	if (basket && basket.items.length > 0) {
		const basketSection = document.createElement("div");
		basketSection.style.marginTop = "12px";
		const heading = document.createElement("strong");
		heading.textContent = `Basket (${basket.items.length} items)`;
		basketSection.append(heading);

		const basketList = document.createElement("ul");
		basketList.style.listStyle = "none";
		basketList.style.padding = "0";
		basketList.style.margin = "4px 0";
		for (const item of basket.items) {
			const li = document.createElement("li");
			li.style.fontSize = "12px";
			li.style.padding = "2px 0";
			const tag = item.tagName.toLowerCase();
			const preview = item.text
				? `<${tag}> ${item.text.slice(0, 30)}`
				: `<${tag}> ${item.selector.slice(0, 40)}`;
			const removeBtn = document.createElement("button");
			removeBtn.textContent = "×";
			removeBtn.style.marginLeft = "4px";
			removeBtn.style.cursor = "pointer";
			removeBtn.addEventListener("click", () =>
				handlers.onRemoveBasketItem?.(item.itemId),
			);
			li.append(
				document.createTextNode(
					`${preview}${item.note ? ` — ${item.note}` : ""}`,
				),
				removeBtn,
			);
			basketList.append(li);
		}
		basketSection.append(basketList);

		if (basket.error) {
			const errDiv = document.createElement("div");
			errDiv.style.color = "red";
			errDiv.style.fontSize = "12px";
			errDiv.textContent = basket.error;
			basketSection.append(errDiv);
		}

		root.append(basketSection);
		root.append(createButton(document, "Send batch", handlers.onSubmitBatch));
	}
}
