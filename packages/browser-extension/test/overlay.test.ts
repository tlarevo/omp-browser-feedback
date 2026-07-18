import { describe, expect, test } from "bun:test";
import { Event as LinkedomEvent, parseHTML } from "linkedom";
import { activatePicker } from "../src/picker/overlay";

function domWithButton() {
	const { document } = parseHTML(
		"<!doctype html><body><button id='save'>Save</button><button id='cancel'>Cancel</button></body>",
	);
	return { document };
}

/** Build a linkedom Event with a `key` property for Escape simulation. */
function keyDown(key: string): Event {
	const e = new LinkedomEvent("keydown", { bubbles: true });
	(e as unknown as Record<string, unknown>).key = key;
	return e as unknown as Event;
}

describe("activatePicker", () => {
	test("returns a handle with deactivate method", () => {
		const { document } = domWithButton();
		const handle = activatePicker(document, {
			onSelect: () => {},
			onExit: () => {},
		});
		expect(typeof handle.deactivate).toBe("function");
		handle.deactivate();
	});

	test("appends an overlay element to the body on activation", () => {
		const { document } = domWithButton();
		activatePicker(document, { onSelect: () => {}, onExit: () => {} });
		const overlay = document.querySelector("[data-omp-picker-overlay]");
		expect(overlay).not.toBeNull();
		// Clean up
		activatePicker(document, {
			onSelect: () => {},
			onExit: () => {},
		}).deactivate();
	});

	test("removes the overlay when deactivate is called", () => {
		const { document } = domWithButton();
		const handle = activatePicker(document, {
			onSelect: () => {},
			onExit: () => {},
		});
		expect(document.querySelector("[data-omp-picker-overlay]")).not.toBeNull();
		handle.deactivate();
		expect(document.querySelector("[data-omp-picker-overlay]")).toBeNull();
	});

	test("sets crosshair cursor on activation and restores it on deactivate", () => {
		const { document } = domWithButton();
		const original = document.body.style.cursor;
		const handle = activatePicker(document, {
			onSelect: () => {},
			onExit: () => {},
		});
		expect(document.body.style.cursor).toBe("crosshair");
		handle.deactivate();
		expect(document.body.style.cursor).toBe(original);
	});

	test("second deactivate is a no-op (AbortController is idempotent)", () => {
		const { document } = domWithButton();
		const handle = activatePicker(document, {
			onSelect: () => {},
			onExit: () => {},
		});
		handle.deactivate();
		expect(() => handle.deactivate()).not.toThrow();
	});

	test("stay-active chip shows correct text", () => {
		const { document } = domWithButton();
		const handle = activatePicker(
			document,
			{ onSelect: () => {}, onExit: () => {} },
			{ stayActive: true },
		);
		const chip = document.querySelector("[data-omp-picker-chip]");
		expect(chip).not.toBeNull();
		expect(chip?.textContent).toContain("click to pick");
		handle.deactivate();
	});

	test("single-pick chip shows correct text", () => {
		const { document } = domWithButton();
		const handle = activatePicker(document, {
			onSelect: () => {},
			onExit: () => {},
		});
		const chip = document.querySelector("[data-omp-picker-chip]");
		expect(chip).not.toBeNull();
		expect(chip?.textContent).toContain("Esc to cancel");
		handle.deactivate();
	});

	test("deactivate removes overlay and chip", () => {
		const { document } = domWithButton();
		const handle = activatePicker(
			document,
			{ onSelect: () => {}, onExit: () => {} },
			{ stayActive: true },
		);
		expect(document.querySelector("[data-omp-picker-overlay]")).not.toBeNull();
		expect(document.querySelector("[data-omp-picker-chip]")).not.toBeNull();
		handle.deactivate();
		expect(document.querySelector("[data-omp-picker-overlay]")).toBeNull();
		expect(document.querySelector("[data-omp-picker-chip]")).toBeNull();
	});
	test("deactivate() does not call onExit (programmatic teardown)", () => {
		const { document } = domWithButton();
		const exitCalls: number[] = [];
		const handle = activatePicker(
			document,
			{ onSelect: () => {}, onExit: () => exitCalls.push(1) },
			{ stayActive: true },
		);
		handle.deactivate();
		expect(exitCalls).toHaveLength(0);
	});

	test("stay-active: first Escape disarms, second Escape exits", () => {
		const { document } = domWithButton();
		const exitCalls: number[] = [];
		activatePicker(
			document,
			{ onSelect: () => {}, onExit: () => exitCalls.push(1) },
			{ stayActive: true },
		);
		// Simulate hover on button
		const button = document.querySelector("button") as Element;
		button.dispatchEvent(
			new LinkedomEvent("mouseover", { bubbles: true }) as unknown as Event,
		);
		// First Escape: disarms hover
		document.dispatchEvent(keyDown("Escape"));
		expect(exitCalls).toHaveLength(0);
		// Second Escape: exits picker
		document.dispatchEvent(keyDown("Escape"));
		expect(exitCalls).toHaveLength(1);
		expect(document.querySelector("[data-omp-picker-overlay]")).toBeNull();
	});

	test("single-pick: Escape exits immediately", () => {
		const { document } = domWithButton();
		const exitCalls: number[] = [];
		activatePicker(
			document,
			{ onSelect: () => {}, onExit: () => exitCalls.push(1) },
			{ stayActive: false },
		);
		document.dispatchEvent(keyDown("Escape"));
		expect(exitCalls).toHaveLength(1);
		expect(document.querySelector("[data-omp-picker-overlay]")).toBeNull();
	});

	test("stay-active: onSelect fires but picker stays active", () => {
		const { document } = domWithButton();
		const picks: string[] = [];
		const exitCalls: number[] = [];
		activatePicker(
			document,
			{
				onSelect: (el) => picks.push(el.id),
				onExit: () => exitCalls.push(1),
			},
			{ stayActive: true },
		);
		// Hover and click
		const button = document.querySelector("button#save") as Element;
		button.dispatchEvent(
			new LinkedomEvent("mouseover", { bubbles: true }) as unknown as Event,
		);
		document.dispatchEvent(
			new LinkedomEvent("click", { bubbles: true }) as unknown as Event,
		);
		expect(picks).toEqual(["save"]);
		expect(exitCalls).toHaveLength(0); // still active
		// Hover and click another
		const cancel = document.querySelector("button#cancel") as Element;
		cancel.dispatchEvent(
			new LinkedomEvent("mouseover", { bubbles: true }) as unknown as Event,
		);
		document.dispatchEvent(
			new LinkedomEvent("click", { bubbles: true }) as unknown as Event,
		);
		expect(picks).toEqual(["save", "cancel"]);
		expect(exitCalls).toHaveLength(0); // still active
		// Escape to exit
		document.dispatchEvent(keyDown("Escape"));
		document.dispatchEvent(keyDown("Escape"));
		expect(exitCalls).toHaveLength(1);
	});
});
