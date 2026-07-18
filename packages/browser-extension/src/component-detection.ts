/**
 * Framework component detection — injected into the page's MAIN world at pick time.
 *
 * Walks React fiber trees (React 17+/18/19) and Vue instance chains (Vue 2/3)
 * to report the nearest named component ancestors for a picked element.
 *
 * Must be self-contained: no imports from project modules. Gets serialized
 * and executed via chrome.scripting.executeScript({ world: "MAIN" }).
 */

export interface ComponentAncestor {
	name: string;
	source?: string;
}

export interface ComponentDetectionResult {
	framework: string;
	ancestors: ComponentAncestor[];
}

const MAX_ANCESTORS = 5;

/**
 * Main-world detection function. Takes a CSS selector, finds the element,
 * walks the framework tree, and returns up to MAX_ANCESTORS named ancestors.
 * Returns null if no framework is detected or the element can't be found.
 */
export function detectFrameworkComponent(
	selector: string,
): ComponentDetectionResult | null {
	try {
		const el = document.querySelector(selector);
		if (!el) return null;

		// React: walk fiber tree via __reactFiber$* key
		for (const key of Object.keys(el)) {
			if (!key.startsWith("__reactFiber$")) continue;
			const fiber = (el as unknown as Record<string, unknown>)[key] as Record<
				string,
				unknown
			> | null;
			if (!fiber) return null;

			const ancestors: ComponentAncestor[] = [];
			let current: Record<string, unknown> | null = fiber;

			while (current && ancestors.length < MAX_ANCESTORS) {
				const type = current.type as
					| { displayName?: string; name?: string }
					| undefined;
				if (type) {
					const name = type.displayName || type.name;
					if (name) {
						const src = current._debugSource as
							| { fileName?: string; lineNumber?: number }
							| undefined;
						const source = src?.fileName
							? `${src.fileName}${src.lineNumber ? `:${src.lineNumber}` : ""}`
							: undefined;
						ancestors.push(source ? { name, source } : { name });
					}
				}
				current = (current.return as Record<string, unknown>) ?? null;
			}

			if (ancestors.length > 0) return { framework: "react", ancestors };
		}

		// Vue 3: __vueParentComponent → walk parent chain
		if ("__vueParentComponent" in el) {
			const instance = (el as Record<string, unknown>)
				.__vueParentComponent as Record<string, unknown> | null;
			if (instance) {
				const ancestors: ComponentAncestor[] = [];
				let cur: Record<string, unknown> | null = instance;

				while (cur && ancestors.length < MAX_ANCESTORS) {
					const type = cur.type as Record<string, unknown> | undefined;
					const options = cur.$options as Record<string, unknown> | undefined;
					const name =
						(type && (typeof type.name === "string" ? type.name : undefined)) ??
						(type &&
							(typeof type.__name === "string" ? type.__name : undefined)) ??
						(options &&
							(typeof options.name === "string" ? options.name : undefined));
					if (name) {
						const source =
							type && typeof type.__file === "string" ? type.__file : undefined;
						ancestors.push(source ? { name, source } : { name });
					}
					cur = (cur.parent as Record<string, unknown>) ?? null;
				}

				if (ancestors.length > 0) return { framework: "vue", ancestors };
			}
		}

		// Vue 2: __vue__ instance
		if ("__vue__" in el) {
			const instance = (el as Record<string, unknown>).__vue__ as Record<
				string,
				unknown
			> | null;
			if (instance) {
				const ancestors: ComponentAncestor[] = [];
				let cur: Record<string, unknown> | null = instance;

				while (cur && ancestors.length < MAX_ANCESTORS) {
					const options = cur.$options as Record<string, unknown> | undefined;
					const name =
						(options &&
							(typeof options.name === "string" ? options.name : undefined)) ??
						(options &&
							(typeof options._componentTag === "string"
								? options._componentTag
								: undefined));
					if (name) ancestors.push({ name });
					cur = (cur.$parent as Record<string, unknown>) ?? null;
				}

				if (ancestors.length > 0) return { framework: "vue", ancestors };
			}
		}

		return null;
	} catch {
		return null;
	}
}
