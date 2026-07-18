import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { detectFrameworkComponent } from "../src/component-detection";

function installDom(html: string): { document: Document } {
	const parsed = parseHTML(html);
	globalThis.document = parsed.document;
	return { document: parsed.document };
}

function qsOrThrow(doc: Document, sel: string): Element {
	const el = doc.querySelector(sel);
	if (!el) throw new Error(`Missing ${sel}`);
	return el;
}

describe("detectFrameworkComponent", () => {
	test("returns null when element not found", () => {
		installDom("<div></div>");
		expect(detectFrameworkComponent("#nonexistent")).toBeNull();
	});

	test("detects React fiber tree with named components", () => {
		const { document } = installDom(
			"<div><button id='btn'>Click</button></div>",
		);
		const btn = qsOrThrow(document, "#btn");

		function App() {}
		App.displayName = "App";
		function Button() {}
		Button.displayName = "Button";

		(btn as unknown as Record<string, unknown>).__reactFiber$ = {
			type: Button,
			return: {
				type: App,
				return: null,
			},
		};

		const result = detectFrameworkComponent("#btn");
		expect(result).toEqual({
			framework: "react",
			ancestors: [{ name: "Button" }, { name: "App" }],
		});
	});

	test("detects React fiber with _debugSource", () => {
		const { document } = installDom("<div><span id='s'></span></div>");
		const span = qsOrThrow(document, "#s");

		function Card() {}
		Card.displayName = "Card";

		(span as unknown as Record<string, unknown>).__reactFiber$ = {
			type: Card,
			_debugSource: {
				fileName: "src/components/Card.tsx",
				lineNumber: 42,
			},
			return: null,
		};

		const result = detectFrameworkComponent("#s");
		expect(result).toEqual({
			framework: "react",
			ancestors: [{ name: "Card", source: "src/components/Card.tsx:42" }],
		});
	});

	test("skips anonymous and Fragment components", () => {
		const { document } = installDom("<div><span id='s'></span></div>");
		const span = qsOrThrow(document, "#s");

		const Anonymous = (() => {
			const fn = () => {};
			return fn;
		})();

		(span as unknown as Record<string, unknown>).__reactFiber$ = {
			type: Anonymous,
			return: {
				type: Symbol.for("react.fragment"),
				return: {
					type: "div",
					return: null,
				},
			},
		};

		const result = detectFrameworkComponent("#s");
		expect(result).toBeNull();
	});

	test("limits ancestors to 5", () => {
		const { document } = installDom("<div><span id='s'></span></div>");
		const span = qsOrThrow(document, "#s");

		const makeComponent = (name: string) => {
			const fn = () => {};
			Object.defineProperty(fn, "name", { value: name });
			return fn;
		};

		const chain = Array.from({ length: 8 }, (_, i) =>
			makeComponent(`Comp${i}`),
		);

		let fiber: Record<string, unknown> = { type: chain[7], return: null };
		for (let i = 6; i >= 0; i--) {
			fiber = { type: chain[i], return: fiber };
		}

		(span as unknown as Record<string, unknown>).__reactFiber$ = fiber;

		const result = detectFrameworkComponent("#s");
		expect(result).not.toBeNull();
		expect(result?.ancestors).toHaveLength(5);
		expect(result?.ancestors[0].name).toBe("Comp0");
		expect(result?.ancestors[4].name).toBe("Comp4");
	});

	test("detects Vue 3 via __vueParentComponent", () => {
		const { document } = installDom("<div><button id='btn'></button></div>");
		const btn = qsOrThrow(document, "#btn");

		(btn as unknown as Record<string, unknown>).__vueParentComponent = {
			type: { name: "SubmitButton" },
			parent: {
				type: { name: "FormContainer" },
				parent: null,
			},
		};

		const result = detectFrameworkComponent("#btn");
		expect(result).toEqual({
			framework: "vue",
			ancestors: [{ name: "SubmitButton" }, { name: "FormContainer" }],
		});
	});

	test("detects Vue 3 with __file source", () => {
		const { document } = installDom("<div><span id='s'></span></div>");
		const span = qsOrThrow(document, "#s");

		(span as unknown as Record<string, unknown>).__vueParentComponent = {
			type: {
				name: "Icon",
				__file: "src/components/Icon.vue",
			},
			parent: null,
		};

		const result = detectFrameworkComponent("#s");
		expect(result).toEqual({
			framework: "vue",
			ancestors: [{ name: "Icon", source: "src/components/Icon.vue" }],
		});
	});

	test("detects Vue 3 with __name fallback", () => {
		const { document } = installDom("<div><span id='s'></span></div>");
		const span = qsOrThrow(document, "#s");

		(span as unknown as Record<string, unknown>).__vueParentComponent = {
			type: { __name: "MyWidget" },
			parent: null,
		};

		const result = detectFrameworkComponent("#s");
		expect(result).toEqual({
			framework: "vue",
			ancestors: [{ name: "MyWidget" }],
		});
	});

	test("detects Vue 2 via __vue__", () => {
		const { document } = installDom("<div><span id='s'></span></div>");
		const span = qsOrThrow(document, "#s");

		(span as unknown as Record<string, unknown>).__vue__ = {
			$options: { name: "LegacyButton" },
			$parent: {
				$options: { name: "LegacyForm" },
				$parent: null,
			},
		};

		const result = detectFrameworkComponent("#s");
		expect(result).toEqual({
			framework: "vue",
			ancestors: [{ name: "LegacyButton" }, { name: "LegacyForm" }],
		});
	});

	test("detects Vue 2 with _componentTag fallback", () => {
		const { document } = installDom("<div><span id='s'></span></div>");
		const span = qsOrThrow(document, "#s");

		(span as unknown as Record<string, unknown>).__vue__ = {
			$options: { _componentTag: "my-btn" },
			$parent: null,
		};

		const result = detectFrameworkComponent("#s");
		expect(result).toEqual({
			framework: "vue",
			ancestors: [{ name: "my-btn" }],
		});
	});

	test("returns null for element with no framework keys", () => {
		installDom("<div><span id='s'>Hello</span></div>");
		expect(detectFrameworkComponent("#s")).toBeNull();
	});

	test("returns null when detection throws", () => {
		const { document } = installDom("<div><span id='s'></span></div>");
		const span = qsOrThrow(document, "#s");

		Object.defineProperty(span, "__reactFiber$", {
			get() {
				throw new Error("corrupted fiber");
			},
			configurable: true,
			enumerable: true,
		});

		expect(detectFrameworkComponent("#s")).toBeNull();
	});

	test("prefers React over Vue when both keys present", () => {
		const { document } = installDom("<div><span id='s'></span></div>");
		const span = qsOrThrow(document, "#s");

		function ReactComp() {}
		ReactComp.displayName = "ReactComp";

		(span as unknown as Record<string, unknown>).__reactFiber$ = {
			type: ReactComp,
			return: null,
		};
		(span as unknown as Record<string, unknown>).__vueParentComponent = {
			type: { name: "VueComp" },
			parent: null,
		};

		const result = detectFrameworkComponent("#s");
		expect(result?.framework).toBe("react");
		expect(result?.ancestors[0].name).toBe("ReactComp");
	});
});
