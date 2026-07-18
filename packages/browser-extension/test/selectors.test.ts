import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { generateSelector } from "../src/picker/selectors";

interface Fixture {
	name: string;
	html: string;
	target: string;
	expected: string;
}

const fixtures: Fixture[] = [
	{
		name: "prefers a unique data-testid",
		html: '<button data-testid="save">Save</button><button>Cancel</button>',
		target: "button[data-testid='save']",
		expected: '[data-testid="save"]',
	},
	{
		name: "test attribute beats id, aria-label, and classes",
		html: '<button id="save" aria-label="Save order" class="primary" data-testid="submit">Save</button>',
		target: "#save",
		expected: '[data-testid="submit"]',
	},
	{
		name: "overlong test attribute skipped in favor of shorter verified selector",
		html: `<button data-testid="${"x".repeat(500)}" id="go">Click</button>`,
		target: "#go",
		expected: "#go",
	},
	{
		name: "unique id beats accessible and stable class candidates",
		html: '<button id="checkout" aria-label="Pay now" class="primary">Pay</button>',
		target: "#checkout",
		expected: "#checkout",
	},
	{
		name: "duplicate ids are rejected as unique anchors",
		html: '<section><span id="dup" class="alpha">a</span></section><section><span id="dup" class="beta">b</span></section>',
		target: "section:nth-of-type(2) > #dup",
		expected: ".beta",
	},
	{
		name: "accessible attribute wins when no id or test attribute",
		html: '<input aria-label="Search query" class="field"><input class="field">',
		target: "input[aria-label='Search query']",
		expected: '[aria-label="Search query"]',
	},
	{
		name: "stable semantic class is used when attributes are absent",
		html: '<div class="hero-banner">a</div><div class="hero-footer">b</div>',
		target: ".hero-banner",
		expected: ".hero-banner",
	},
	{
		name: "BEM class names are not classified as generated",
		html: '<div class="card__header">a</div><div class="card__footer">b</div>',
		target: ".card__header",
		expected: ".card__header",
	},
	{
		name: "generated hash-like classes are omitted",
		html: '<button class="css-1a2b3c sc-bdVaJa">A</button><button class="css-9z8y7x">B</button>',
		target: "button:nth-of-type(1)",
		expected: "button:nth-of-type(1)",
	},
	{
		name: "utility-only classes are omitted in favor of positional fallback",
		html: '<div class="flex px-4 mt-2">a</div><div class="flex px-4 mt-2">b</div>',
		target: "div:nth-of-type(2)",
		expected: "div:nth-of-type(2)",
	},
	{
		name: "semantic class kept alongside utility noise",
		html: '<nav class="flex px-4 site-nav">a</nav><nav class="flex px-4 other">b</nav>',
		target: ".site-nav",
		expected: ".site-nav",
	},
	{
		name: "nested structure qualifies through stable ancestor class",
		html: '<div class="panel-left"><span class="item">x</span></div><div class="panel-right"><span class="item">y</span></div>',
		target: ".panel-right > .item",
		expected: "div.panel-right > span.item",
	},
	{
		name: "falls back to an nth-of-type path when nothing is stable",
		html: "<main><section><button>Save</button><button>Cancel</button></section><section><button>Save</button><button>Cancel</button></section></main>",
		target: "section:nth-of-type(2) > button:nth-of-type(2)",
		expected: "section:nth-of-type(2) > button:nth-of-type(2)",
	},
	{
		name: "SVG element uses a stable class selector",
		html: '<svg><circle class="marker"></circle><path class="stroke"></path></svg>',
		target: "path",
		expected: ".stroke",
	},
	{
		name: "SVG child falls back to a positional selector",
		html: '<svg><circle class="dup"></circle><circle class="dup"></circle></svg>',
		target: "circle:nth-of-type(2)",
		expected: "circle:nth-of-type(2)",
	},
	{
		name: "special characters in a class are escaped",
		html: '<div class="chart.line">a</div><div class="chart">b</div>',
		target: "div:nth-of-type(1)",
		expected: ".chart\\.line",
	},
	{
		name: "special characters in id are escaped",
		html: '<div id="user.name">a</div><div>b</div>',
		target: "#user\\.name",
		expected: "#user\\.name",
	},
];

describe("generateSelector", () => {
	for (const fixture of fixtures) {
		test(fixture.name, () => {
			const { document } = parseHTML(`<!doctype html><body>${fixture.html}`);
			const element = document.querySelector(fixture.target);
			expect(element, `target not found: ${fixture.target}`).toBeTruthy();

			const selector = generateSelector(element as Element);
			expect(selector).toBe(fixture.expected);

			// Every returned selector must resolve to exactly the target in its root.
			const root = (element as Element).getRootNode() as ParentNode;
			const matches = root.querySelectorAll(selector);
			expect(matches.length).toBe(1);
			expect(matches[0]).toBe(element as Element);
		});
	}
});
describe("generateSelector control characters", () => {
	test("newline in attribute value is CSS-escaped via setAttribute", () => {
		const { document } = parseHTML(
			"<!doctype html><body><button>A</button><button>B</button></body>",
		);
		const element = document.querySelector("button") as Element;
		element.setAttribute("data-testid", "line1\nline2");

		const selector = generateSelector(element);
		expect(selector).toBe('[data-testid="line1\\a line2"]');

		const matches = document.querySelectorAll(selector);
		expect(matches.length).toBe(1);
		expect(matches[0]).toBe(element);
	});
});

describe("generateSelector bounds", () => {
	test("deep ancestry stays within the configured depth and resolves uniquely", () => {
		const depth = 40;
		const open = "<div>".repeat(depth);
		const close = "</div>".repeat(depth);
		// A shallow button forces a bare tag to be non-unique, so qualification runs.
		const { document } = parseHTML(
			`<!doctype html><body><button>shallow</button>${open}<button>deep</button>${close}`,
		);
		const element = document.querySelectorAll("button")[1];
		expect(element).toBeTruthy();

		const selector = generateSelector(element as Element);
		// The deep button's only div ancestor immediately disambiguates from the
		// shallow button (whose parent is <body>).
		expect(selector).toBe("div > button");

		const matches = document.querySelectorAll(selector);
		expect(matches.length).toBe(1);
		expect(matches[0]).toBe(element as Element);
	});

	test("structurally indistinguishable branches beyond depth bound throw", () => {
		// Two identical >8-level branches — the branching point is beyond
		// MAX_ANCESTOR_DEPTH, so no positional path can distinguish them.
		const depth = 12;
		const branch = `${"<div>".repeat(depth)}<span>X</span>${"</div>".repeat(depth)}`;
		const branch2 = `${"<div>".repeat(depth)}<span>Y</span>${"</div>".repeat(depth)}`;
		const { document } = parseHTML(
			`<!doctype html><body><div>${branch}${branch2}</div></body>`,
		);
		const element = document.querySelectorAll("span")[0];
		expect(element).toBeTruthy();

		expect(() => generateSelector(element as Element)).toThrow(
			"No unique selector found within configured bounds",
		);
	});

	test("overlong semantic path is rejected in favor of short positional fallback", () => {
		// Two branches diverge within MAX_ANCESTOR_DEPTH so nthOfType can
		// disambiguate, but long class names cause the localPart path to exceed
		// MAX_SELECTOR_LENGTH (512). The generator falls back to nth-of-type.
		const cls =
			"card-section-panel-content-wrapper-container-item-block-element-node-".repeat(
				4,
			);
		const open = `<div class="${cls}">`.repeat(2);
		const close = "</div>".repeat(2);
		const branch1 = `${open}<span>A</span>${close}`;
		const branch2 = `${open}<span>B</span>${close}`;
		const { document } = parseHTML(
			`<!doctype html><body><div>${branch1}${branch2}</div></body>`,
		);
		const element = document.querySelectorAll("span")[0];
		expect(element).toBeTruthy();

		const selector = generateSelector(element as Element);
		// Semantic path (localPart) overflows MAX_SELECTOR_LENGTH at depth 2;
		// nth-of-type path is short and unique via the branching parent.
		expect(selector).toBe("div:nth-of-type(1) > div > span");

		const matches = document.querySelectorAll(selector);
		expect(matches.length).toBe(1);
		expect(matches[0]).toBe(element as Element);
	});
	test("unique generated class is used as last resort when positional paths fail", () => {
		// Deep identical branches beyond MAX_ANCESTOR_DEPTH — positional paths
		// can't disambiguate, but a generated class on the target IS unique.
		const depth = 12;
		const branch = `${"<div>".repeat(depth)}<div class="css-abc123">A</div>${"</div>".repeat(depth)}`;
		const branch2 = `${"<div>".repeat(depth)}<div>B</div>${"</div>".repeat(depth)}`;
		const { document } = parseHTML(
			`<!doctype html><body><div>${branch}${branch2}</div></body>`,
		);
		const element = document.querySelector(".css-abc123");
		expect(element).toBeTruthy();

		const selector = generateSelector(element as Element);
		expect(selector).toBe(".css-abc123");

		const matches = document.querySelectorAll(selector);
		expect(matches.length).toBe(1);
		expect(matches[0]).toBe(element as Element);
	});
});

describe("generateSelector shadow scoping", () => {
	test("verifies uniqueness within the element's shadow root, not the document", () => {
		const { document } = parseHTML(
			'<!doctype html><body><button data-testid="dup">page</button><div id="host"></div>',
		);
		const host = document.getElementById("host");
		expect(host).toBeTruthy();
		const shadow = (host as Element).attachShadow({ mode: "open" });
		shadow.innerHTML = '<button data-testid="dup">shadow</button>';
		const element = shadow.querySelector("button");
		expect(element).toBeTruthy();

		// data-testid is duplicated across roots but unique inside the shadow root.
		const selector = generateSelector(element as Element);
		expect(selector).toBe('[data-testid="dup"]');
		const matches = shadow.querySelectorAll(selector);
		expect(matches.length).toBe(1);
		expect(matches[0]).toBe(element as Element);
	});
});
