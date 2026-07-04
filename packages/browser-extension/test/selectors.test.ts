import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { generateSelector } from "../src/picker/selectors";

describe("generateSelector", () => {
	test("prefers a unique data-testid", () => {
		const { document } = parseHTML(
			'<button data-testid="save">Save</button><button>Cancel</button>',
		);
		const element = document.querySelector("button[data-testid='save']");
		expect(element).toBeTruthy();

		expect(generateSelector(element as Element)).toBe('[data-testid="save"]');
	});

	test("falls back to an nth-of-type path when stable attributes are unavailable", () => {
		const { document } = parseHTML(
			"<main><section><button>Save</button><button>Cancel</button></section><section><button>Save</button><button>Cancel</button></section></main>",
		);
		const element = document.querySelector(
			"section:nth-of-type(2) > button:nth-of-type(2)",
		);
		expect(element).toBeTruthy();

		expect(generateSelector(element as Element)).toBe(
			"section:nth-of-type(2) > button:nth-of-type(2)",
		);
	});
});
