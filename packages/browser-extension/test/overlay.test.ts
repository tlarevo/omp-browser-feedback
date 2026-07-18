import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { activatePicker } from "../src/picker/overlay";

function domWithButton() {
	const { document } = parseHTML(
		"<!doctype html><body><button id='save'>Save</button><button id='cancel'>Cancel</button></body>",
	);
	return { document };
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
});
