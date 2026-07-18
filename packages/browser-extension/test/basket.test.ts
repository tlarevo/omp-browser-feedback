import { describe, expect, test } from "bun:test";
import type { DomSelectionFeedback } from "@oh-my-pi/browser-protocol";
import {
	addItemToBasket,
	type Basket,
	clearBasketError,
	createEmptyBasket,
	removeItemFromBasket,
	reorderBasketItems,
} from "../src/basket";

const stubEvent: DomSelectionFeedback = {
	protocolVersion: 1,
	eventId: "evt_1",
	type: "dom.selection",
	channelId: "ses_1",
	createdAt: "2026-06-27T10:00:00.000Z",
	page: {
		url: "https://example.com",
		title: "Example",
		viewport: { width: 1200, height: 800, devicePixelRatio: 2 },
	},
	element: {
		selector: "button",
		tagName: "BUTTON",
		outerHtml: "<button>Save</button>",
		attributes: {},
		bounds: { x: 1, y: 2, width: 3, height: 4 },
		computedStyles: { display: "block" },
	},
};

describe("basket reducer", () => {
	test("createEmptyBasket returns empty basket", () => {
		const basket = createEmptyBasket();
		expect(basket.items).toHaveLength(0);
		expect(basket.batchNote).toBe("");
		expect(basket.error).toBeUndefined();
	});

	test("addItemToBasket adds an item", () => {
		const basket = createEmptyBasket();
		const updated = addItemToBasket(basket, stubEvent, "Fix spacing");
		expect(updated.items).toHaveLength(1);
		expect(updated.items[0].event.eventId).toBe("evt_1");
		expect(updated.items[0].note).toBe("Fix spacing");
		expect(updated.items[0].itemId).toBeTruthy();
	});

	test("addItemToBasket clears error", () => {
		const basket: Basket = {
			...createEmptyBasket(),
			error: "Previous error",
		};
		const updated = addItemToBasket(basket, stubEvent, "note");
		expect(updated.error).toBeUndefined();
	});

	test("addItemToBasket rejects when at cap", () => {
		let basket = createEmptyBasket();
		for (let i = 0; i < 20; i++) {
			basket = addItemToBasket(
				basket,
				{ ...stubEvent, eventId: `evt_${i}` },
				"",
			);
		}
		expect(basket.items).toHaveLength(20);
		const updated = addItemToBasket(basket, stubEvent, "overflow");
		expect(updated.error).toContain("Basket full");
		expect(updated.items).toHaveLength(20);
	});

	test("removeItemFromBasket removes by itemId", () => {
		let basket = createEmptyBasket();
		basket = addItemToBasket(basket, stubEvent, "note1");
		basket = addItemToBasket(
			basket,
			{ ...stubEvent, eventId: "evt_2" },
			"note2",
		);
		expect(basket.items).toHaveLength(2);

		const id = basket.items[0].itemId;
		const updated = removeItemFromBasket(basket, id);
		expect(updated.items).toHaveLength(1);
		expect(updated.items[0].event.eventId).toBe("evt_2");
	});

	test("removeItemFromBasket clears error", () => {
		let basket: Basket = { ...createEmptyBasket(), error: "some error" };
		basket = addItemToBasket(basket, stubEvent, "note");
		const updated = removeItemFromBasket(basket, basket.items[0].itemId);
		expect(updated.error).toBeUndefined();
	});

	test("reorderBasketItems swaps positions", () => {
		let basket = createEmptyBasket();
		basket = addItemToBasket(basket, { ...stubEvent, eventId: "a" }, "");
		basket = addItemToBasket(basket, { ...stubEvent, eventId: "b" }, "");
		basket = addItemToBasket(basket, { ...stubEvent, eventId: "c" }, "");

		const updated = reorderBasketItems(basket, 0, 2);
		expect(updated.items[0].event.eventId).toBe("b");
		expect(updated.items[1].event.eventId).toBe("c");
		expect(updated.items[2].event.eventId).toBe("a");
	});

	test("reorderBasketItems handles invalid index", () => {
		let basket = createEmptyBasket();
		basket = addItemToBasket(basket, stubEvent, "");
		const updated = reorderBasketItems(basket, 5, 0);
		expect(updated.items).toHaveLength(1);
	});

	test("clearBasketError removes error", () => {
		const basket: Basket = {
			...createEmptyBasket(),
			error: "some error",
		};
		const updated = clearBasketError(basket);
		expect(updated.error).toBeUndefined();
	});
});
