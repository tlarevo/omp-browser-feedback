import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { walkableChild, walkableParent } from "../src/picker/overlay";

describe("walkableParent", () => {
	test("returns parentElement for light-DOM elements", () => {
		const { document } = parseHTML(
			"<html><body><div id='parent'><span id='child'>Hi</span></div></body></html>",
		);
		const child = document.querySelector("#child") as Element;
		const parent = document.querySelector("#parent") as Element;
		expect(walkableParent(child)).toBe(parent);
	});

	test("returns non-null for body element (parent is html)", () => {
		const { document } = parseHTML(
			"<html><body><div id='only'></div></body></html>",
		);
		const body = document.querySelector("body") as Element;
		expect(walkableParent(body)).not.toBeNull();
	});
});

describe("walkableChild", () => {
	test("returns firstElementChild for light-DOM elements", () => {
		const { document } = parseHTML(
			"<html><body><div id='parent'><span id='child1'>A</span><span id='child2'>B</span></div></body></html>",
		);
		const parent = document.querySelector("#parent") as Element;
		const child1 = document.querySelector("#child1") as Element;
		expect(walkableChild(parent)).toBe(child1);
	});

	test("returns null when element has no children", () => {
		const { document } = parseHTML(
			"<html><body><div id='empty'></div></body></html>",
		);
		const empty = document.querySelector("#empty") as Element;
		expect(walkableChild(empty)).toBeNull();
	});

	test("returns first child of open shadow root", () => {
		const { document } = parseHTML(
			"<html><body><div id='host'></div></body></html>",
		);
		const host = document.querySelector("#host") as Element;
		const shadowRoot = host.attachShadow({ mode: "open" });
		const inner = document.createElement("p");
		shadowRoot.appendChild(inner);

		expect(walkableChild(host)).toBe(inner);
	});

	test("returns firstElementChild when no shadow root exists", () => {
		const { document } = parseHTML(
			"<html><body><div id='no-shadow'><span>Child</span></div></body></html>",
		);
		const noShadow = document.querySelector("#no-shadow") as Element;
		const child = noShadow.firstElementChild;
		expect(walkableChild(noShadow)).toBe(child);
	});
});

describe("walk transitions", () => {
	test("parent → child → parent round-trip preserves identity", () => {
		const { document } = parseHTML(
			"<html><body><div id='root'><span id='leaf'>Hi</span></div></body></html>",
		);
		const root = document.querySelector("#root") as Element;
		const leaf = document.querySelector("#leaf") as Element;

		// Walk down from root to child
		const down = walkableChild(root);
		expect(down).toBe(leaf);

		// Walk up from leaf back to root
		const up = walkableParent(leaf);
		expect(up).toBe(root);
	});
});
