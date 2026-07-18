import type { DomSelectionFeedback } from "@oh-my-pi/browser-protocol";
import { BATCH_FEEDBACK_LIMITS } from "@oh-my-pi/browser-protocol";

export interface BasketItem {
	itemId: string;
	event: DomSelectionFeedback;
	note: string;
	addedAt: string;
}

export interface Basket {
	items: BasketItem[];
	batchNote: string;
	error?: string;
}

export function createEmptyBasket(): Basket {
	return { items: [], batchNote: "" };
}

export function addItemToBasket(
	basket: Basket,
	event: DomSelectionFeedback,
	note: string,
): Basket {
	if (basket.items.length >= BATCH_FEEDBACK_LIMITS.maxItems) {
		return {
			...basket,
			error: `Basket full (max ${BATCH_FEEDBACK_LIMITS.maxItems} items)`,
		};
	}
	return {
		...basket,
		items: [
			...basket.items,
			{
				itemId: crypto.randomUUID(),
				event,
				note,
				addedAt: new Date().toISOString(),
			},
		],
		error: undefined,
	};
}

export function removeItemFromBasket(basket: Basket, itemId: string): Basket {
	return {
		...basket,
		items: basket.items.filter((item) => item.itemId !== itemId),
		error: undefined,
	};
}

export function reorderBasketItems(
	basket: Basket,
	fromIndex: number,
	toIndex: number,
): Basket {
	const items = [...basket.items];
	const [moved] = items.splice(fromIndex, 1);
	if (!moved) return basket;
	items.splice(toIndex, 0, moved);
	return { ...basket, items };
}

export function clearBasketError(basket: Basket): Basket {
	return { ...basket, error: undefined };
}

export function basketItemCount(basket: Basket): number {
	return basket.items.length;
}
