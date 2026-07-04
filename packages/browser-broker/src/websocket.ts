import type { BrowserFeedbackEvent } from "@oh-my-pi/browser-protocol";
import type { ServerWebSocket } from "bun";

export interface BrowserBrokerSocketData {
	kind: "omp";
	sessionId: string;
}

export class BrowserWebSocketRouter {
	readonly #ompSockets = new Map<
		string,
		Set<ServerWebSocket<BrowserBrokerSocketData>>
	>();

	add(socket: ServerWebSocket<BrowserBrokerSocketData>): void {
		const sockets = this.#ompSockets.get(socket.data.sessionId) ?? new Set();
		sockets.add(socket);
		this.#ompSockets.set(socket.data.sessionId, sockets);
	}

	remove(socket: ServerWebSocket<BrowserBrokerSocketData>): void {
		const sockets = this.#ompSockets.get(socket.data.sessionId);
		if (!sockets) return;
		sockets.delete(socket);
		if (sockets.size === 0) this.#ompSockets.delete(socket.data.sessionId);
	}

	sendFeedback(sessionId: string, event: BrowserFeedbackEvent): void {
		const sockets = this.#ompSockets.get(sessionId);
		if (!sockets) return;
		for (const socket of sockets) {
			this.sendFeedbackToSocket(socket, event);
		}
	}

	sendFeedbackToSocket(
		socket: ServerWebSocket<BrowserBrokerSocketData>,
		event: BrowserFeedbackEvent,
	): void {
		socket.send(JSON.stringify({ type: "browser.feedback", event }));
	}
}
