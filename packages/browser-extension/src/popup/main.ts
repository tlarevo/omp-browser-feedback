import type { BrowserSessionRegistration } from "@oh-my-pi/browser-protocol";

export interface PopupSession {
	sessionId: string;
	displayName: string;
	cwd: string;
	projectName?: string;
	gitBranch?: string;
	status: string;
	lastActiveAt?: string;
}

export function renderSessionLabel(session: PopupSession): string {
	const branch = session.gitBranch ? ` · ${session.gitBranch}` : "";
	return `${session.displayName} · ${session.cwd}${branch} · ${session.status}`;
}

export function projectBasename(session: PopupSession): string {
	if (session.projectName) return session.projectName;
	const parts = session.cwd.replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] ?? session.cwd;
}

export function relativeFreshness(lastActiveAt?: string): string {
	if (!lastActiveAt) return "";
	const diff = Date.now() - new Date(lastActiveAt).getTime();
	if (diff < 0) return "just now";
	const seconds = Math.floor(diff / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
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
	| { kind: "no-broker"; attemptedPorts: number[] }
	| { kind: "unpaired"; baseUrl: string }
	| { kind: "pairing-error"; baseUrl: string; message: string }
	| { kind: "no-sessions"; baseUrl: string }
	| {
			kind: "ready";
			baseUrl: string;
			selectedSessionId?: string;
			sessions: BrowserSessionRegistration[];
			consoleCaptureEnabled?: boolean;
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
	onToggleConsoleCapture?: (enabled: boolean) => void;
	onRefresh?: () => void;
	onForget?: () => void;
}

function clear(element: HTMLElement): void {
	element.replaceChildren();
}

function el<K extends keyof HTMLElementTagNameMap>(
	document: Document,
	tag: K,
	attrs?: Record<string, string>,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (attrs) {
		for (const [k, v] of Object.entries(attrs)) {
			node.setAttribute(k, v);
		}
	}
	return node;
}

function createButton(
	document: Document,
	label: string,
	onClick?: () => void,
	attrs?: Record<string, string>,
): HTMLButtonElement {
	const button = el(document, "button", { type: "button", ...attrs });
	button.textContent = label;
	if (onClick) button.addEventListener("click", onClick);
	return button;
}

function announceStatus(doc: Document, text: string): void {
	const region = doc.getElementById("status-announcer");
	if (region) region.textContent = text;
}

function renderLoading(root: HTMLElement): void {
	const doc = root.ownerDocument;
	const wrapper = el(doc, "div", { class: "loading", role: "status" });
	wrapper.setAttribute("aria-label", "Loading");
	wrapper.append(el(doc, "div", { class: "spinner" }), "Connecting\u2026");
	root.append(wrapper);
	announceStatus(doc, "Loading\u2026");
}

function renderToolbar(root: HTMLElement, handlers: PopupActionHandlers): void {
	const doc = root.ownerDocument;
	const toolbar = el(doc, "div", { class: "toolbar" });
	const title = el(doc, "span", { class: "toolbar-title" });
	title.textContent = "OMP";
	toolbar.append(title);

	const refreshBtn = createButton(doc, "\u21BB", handlers.onRefresh, {
		"aria-label": "Refresh sessions",
		title: "Refresh",
	});
	refreshBtn.style.fontSize = "16px";
	toolbar.append(refreshBtn);
	root.append(toolbar);
}

function renderPairingForm(
	document: Document,
	root: HTMLElement,
	onPairWithCode?: (code: string) => void,
): void {
	const input = el(document, "input", {
		type: "text",
		autocomplete: "off",
		placeholder: "Pairing code",
		"aria-label": "Pairing code",
	});
	const button = createButton(document, "Pair", () =>
		onPairWithCode?.(input.value),
	);
	button.classList.add("primary");
	const row = el(document, "div", {
		style: "display:flex;gap:6px;margin-top:6px;",
	});
	row.append(input, button);
	root.append(row);
}

function renderFooter(root: HTMLElement, handlers: PopupActionHandlers): void {
	const doc = root.ownerDocument;
	const footer = el(doc, "div", { class: "footer" });

	const shortcutRow = el(doc, "div");
	shortcutRow.textContent = "Keyboard shortcut: ";
	const shortcutLink = el(doc, "button", {
		class: "link",
		type: "button",
	});
	shortcutLink.textContent = "Configure in Chrome";
	shortcutLink.addEventListener("click", () => {
		chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
	});
	shortcutRow.append(shortcutLink);
	footer.append(shortcutRow);

	if (handlers.onForget) {
		const forgetBtn = createButton(
			doc,
			"Forget this browser",
			handlers.onForget,
			{ class: "danger", "aria-label": "Forget this browser" },
		);
		forgetBtn.style.marginTop = "4px";
		forgetBtn.style.alignSelf = "flex-start";
		footer.append(forgetBtn);
	}

	root.append(footer);
}

function renderSessionCards(
	document: Document,
	root: HTMLElement,
	sessions: BrowserSessionRegistration[],
	selectedSessionId: string | undefined,
	onSelect?: (sessionId: string) => void,
): void {
	const list = el(document, "ul", {
		class: "session-list",
		role: "listbox",
		"aria-label": "OMP sessions",
	});

	for (const session of sessions) {
		const isSelected = session.sessionId === selectedSessionId;
		const card = el(document, "li", {
			class: `session-card${isSelected ? " selected" : ""}`,
			role: "option",
			tabindex: "0",
			"aria-selected": String(isSelected),
			"aria-label": renderSessionLabel({
				sessionId: session.sessionId,
				displayName: session.displayName,
				cwd: session.cwd,
				projectName: session.projectName,
				gitBranch: session.gitBranch,
				status: session.status,
				lastActiveAt: session.lastActiveAt,
			}),
		});

		const dot = el(document, "span", {
			class: `presence-dot presence-${session.status}`,
			"aria-hidden": "true",
		});

		const info = el(document, "div", { class: "session-card-info" });
		const name = el(document, "div", { class: "session-card-name" });
		name.textContent = session.displayName;
		const meta = el(document, "div", { class: "session-card-meta" });
		const parts: string[] = [projectBasename(session)];
		if (session.gitBranch) parts.push(session.gitBranch);
		parts.push(relativeFreshness(session.lastActiveAt));
		meta.textContent = parts.join(" \u00B7 ");
		info.append(name, meta);

		card.append(dot, info);

		const activate = () => onSelect?.(session.sessionId);
		card.addEventListener("click", activate);
		card.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				activate();
			}
		});

		list.append(card);
	}

	root.append(list);
}

export function renderPopup(
	root: HTMLElement,
	state: PopupState,
	handlers: PopupActionHandlers = {},
): void {
	clear(root);
	const document = root.ownerDocument;

	if (state.kind === "loading") {
		renderLoading(root);
		return;
	}

	renderToolbar(root, handlers);

	if (state.kind === "no-broker") {
		const msg = el(document, "p", { class: "status" });
		msg.textContent = `No OMP broker found on ports ${state.attemptedPorts[0]}\u2013${state.attemptedPorts[state.attemptedPorts.length - 1]}.`;
		root.append(msg);
		announceStatus(document, "No broker found");
		return;
	}

	if (state.kind === "unpaired") {
		const msg = el(document, "p", { class: "status" });
		msg.textContent = `Broker found at ${state.baseUrl}. Enter pairing code from /bf pair.`;
		root.append(msg);
		renderPairingForm(document, root, handlers.onPairWithCode);
		announceStatus(document, "Broker found, enter pairing code");
		return;
	}

	if (state.kind === "pairing-error") {
		const msg = el(document, "p", { class: "status" });
		msg.textContent = `Broker found at ${state.baseUrl}. Enter pairing code from /bf pair.`;
		root.append(msg);
		const err = el(document, "p", { class: "status error" });
		err.textContent = state.message;
		root.append(err);
		renderPairingForm(document, root, handlers.onPairWithCode);
		announceStatus(document, `Pairing error: ${state.message}`);
		return;
	}

	if (state.kind === "no-sessions") {
		const msg = el(document, "p", { class: "status" });
		msg.textContent = `Connected to ${state.baseUrl}. No active OMP sessions.`;
		root.append(msg);
		announceStatus(document, "No active sessions");
		return;
	}

	if (state.kind === "error") {
		const msg = el(document, "p", { class: "status error" });
		msg.textContent = state.message;
		root.append(msg);
		announceStatus(document, `Error: ${state.message}`);
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
	const captureLabel = document.createElement("label");
	captureLabel.style.cssText =
		"display:flex;align-items:center;gap:6px;margin:8px 0;font-size:13px;";
	const captureCheckbox = document.createElement("input");
	captureCheckbox.type = "checkbox";
	captureCheckbox.checked = state.consoleCaptureEnabled ?? false;
	captureCheckbox.addEventListener("change", () =>
		handlers.onToggleConsoleCapture?.(captureCheckbox.checked),
	);
	captureLabel.append(
		captureCheckbox,
		document.createTextNode("Capture console errors"),
	);
	root.append(captureLabel);

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
	// ── ready ──
	renderSessionCards(
		document,
		root,
		state.sessions,
		state.selectedSessionId,
		handlers.onSelectSession,
	);

	const activeSessionId =
		state.selectedSessionId ?? state.sessions[0]?.sessionId;

	const noteArea = el(document, "textarea", {
		placeholder:
			"Optional note \u2014 e.g. \u2018Change the button color to blue\u2019",
		rows: "2",
		"aria-label": "Optional feedback note",
	});
	root.append(noteArea);

	const pickBtn = createButton(
		document,
		"Pick element",
		activeSessionId
			? () =>
					handlers.onStartPicker?.(
						activeSessionId,
						noteArea.value.trim() || undefined,
					)
			: undefined,
	);
	pickBtn.classList.add("primary");
	if (!activeSessionId) pickBtn.disabled = true;
	pickBtn.setAttribute(
		"aria-label",
		activeSessionId ? "Start picking an element" : "No session selected",
	);
	root.append(pickBtn);

	renderFooter(root, handlers);
	announceStatus(
		document,
		`${state.sessions.length} session${state.sessions.length === 1 ? "" : "s"} available`,
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
