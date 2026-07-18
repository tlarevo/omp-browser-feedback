import { describe, expect, test } from "bun:test";
import { BROWSER_PROTOCOL_VERSION } from "@oh-my-pi/browser-protocol";
import { parseHTML } from "linkedom";
import { buildPageScreenshotFeedback } from "../src/content-script";
import {
	activateRegionCapture,
	normalizeRegionRect,
	type RegionRect,
} from "../src/picker/region";

// ── normalizeRegionRect ────────────────────────────────────────────────────

describe("normalizeRegionRect", () => {
	test("drag from top-left to bottom-right", () => {
		const rect = normalizeRegionRect({ x: 100, y: 50 }, { x: 300, y: 200 });
		expect(rect).toEqual({ x: 100, y: 50, width: 200, height: 150 });
	});

	test("drag from bottom-right to top-left (reversed)", () => {
		const rect = normalizeRegionRect({ x: 300, y: 200 }, { x: 100, y: 50 });
		expect(rect).toEqual({ x: 100, y: 50, width: 200, height: 150 });
	});

	test("drag from top-right to bottom-left", () => {
		const rect = normalizeRegionRect({ x: 300, y: 50 }, { x: 100, y: 200 });
		expect(rect).toEqual({ x: 100, y: 50, width: 200, height: 150 });
	});

	test("drag from bottom-left to top-right", () => {
		const rect = normalizeRegionRect({ x: 100, y: 200 }, { x: 300, y: 50 });
		expect(rect).toEqual({ x: 100, y: 50, width: 200, height: 150 });
	});

	test("zero-area click (same point)", () => {
		const rect = normalizeRegionRect({ x: 100, y: 100 }, { x: 100, y: 100 });
		expect(rect).toEqual({ x: 100, y: 100, width: 0, height: 0 });
	});
});

// ── buildPageScreenshotFeedback ────────────────────────────────────────────

describe("buildPageScreenshotFeedback", () => {
	// linkedom window properties are read-only on subsequent parseHTML calls;
	// build a minimal Window-like object for tests that need custom DPR.
	function fakeWindow(overrides: {
		href: string;
		title: string;
		innerWidth: number;
		innerHeight: number;
		devicePixelRatio: number;
	}) {
		return {
			location: { href: overrides.href },
			document: { title: overrides.title },
			innerWidth: overrides.innerWidth,
			innerHeight: overrides.innerHeight,
			devicePixelRatio: overrides.devicePixelRatio,
		} as unknown as Window;
	}

	test("builds a valid page.screenshot event with DPR-scaled dimensions", () => {
		const win = fakeWindow({
			href: "https://example.com/dashboard",
			title: "Test Page",
			innerWidth: 1280,
			innerHeight: 720,
			devicePixelRatio: 2,
		});

		const event = buildPageScreenshotFeedback({
			channelId: "ses_region_1",
			region: { x: 100, y: 200, width: 400, height: 300 },
			note: "This chart looks wrong",
			eventId: "evt_region_1",
			createdAt: "2026-07-18T12:00:00.000Z",
			window: win,
		});

		expect(event.protocolVersion).toBe(BROWSER_PROTOCOL_VERSION);
		expect(event).toMatchObject({
			eventId: "evt_region_1",
			type: "page.screenshot",
			channelId: "ses_region_1",
			createdAt: "2026-07-18T12:00:00.000Z",
			page: {
				url: "https://example.com/dashboard",
				title: "Test Page",
				viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
			},
			note: "This chart looks wrong",
			screenshot: {
				kind: "crop",
				ref: "pending",
				mimeType: "image/png",
				width: 800, // 400 * 2 DPR
				height: 600, // 300 * 2 DPR
			},
		});
	});

	test("DPR=1 produces pixel-accurate dimensions", () => {
		const win = fakeWindow({
			href: "https://example.com",
			title: "T",
			innerWidth: 1280,
			innerHeight: 720,
			devicePixelRatio: 1,
		});

		const event = buildPageScreenshotFeedback({
			channelId: "ses_1",
			region: { x: 0, y: 0, width: 500, height: 350 },
			window: win,
		});

		expect(event.screenshot.width).toBe(500);
		expect(event.screenshot.height).toBe(350);
	});

	test("DPR=3 scales correctly", () => {
		const win = fakeWindow({
			href: "https://example.com",
			title: "T",
			innerWidth: 1280,
			innerHeight: 720,
			devicePixelRatio: 3,
		});

		const event = buildPageScreenshotFeedback({
			channelId: "ses_1",
			region: { x: 10, y: 20, width: 100, height: 80 },
			window: win,
		});

		expect(event.screenshot.width).toBe(300);
		expect(event.screenshot.height).toBe(240);
	});
});

// ── activateRegionCapture ──────────────────────────────────────────────────

describe("activateRegionCapture", () => {
	function dom() {
		const { document } = parseHTML(
			"<!doctype html><body><div id='target' style='width:400px;height:300px;background:red'></div></body>",
		);
		return { document };
	}

	// linkedom events need _path and preventDefault/stopPropagation stubs
	function fakeEvent(type: string, extra: Record<string, unknown>): Event {
		return {
			type,
			bubbles: true,
			_path: [],
			preventDefault() {},
			stopPropagation() {},
			...extra,
		} as unknown as Event;
	}

	test("returns a handle with deactivate method", () => {
		const { document } = dom();
		const handle = activateRegionCapture(document, {
			onRegion: () => {},
			onCancel: () => {},
		});
		expect(typeof handle.deactivate).toBe("function");
		handle.deactivate();
	});

	test("appends marquee and label elements on activation", () => {
		const { document } = dom();
		const handle = activateRegionCapture(document, {
			onRegion: () => {},
			onCancel: () => {},
		});
		expect(document.querySelector("[data-omp-region-marquee]")).not.toBeNull();
		expect(document.querySelector("[data-omp-region-label]")).not.toBeNull();
		handle.deactivate();
	});

	test("removes elements on deactivate", () => {
		const { document } = dom();
		const handle = activateRegionCapture(document, {
			onRegion: () => {},
			onCancel: () => {},
		});
		handle.deactivate();
		expect(document.querySelector("[data-omp-region-marquee]")).toBeNull();
		expect(document.querySelector("[data-omp-region-label]")).toBeNull();
	});

	test("sets crosshair cursor and restores on deactivate", () => {
		const { document } = dom();
		const original = document.body.style.cursor;
		const handle = activateRegionCapture(document, {
			onRegion: () => {},
			onCancel: () => {},
		});
		expect(document.body.style.cursor).toBe("crosshair");
		handle.deactivate();
		expect(document.body.style.cursor).toBe(original);
	});

	test("deactivate is idempotent (AbortController)", () => {
		const { document } = dom();
		const handle = activateRegionCapture(document, {
			onRegion: () => {},
			onCancel: () => {},
		});
		handle.deactivate();
		expect(() => handle.deactivate()).not.toThrow();
	});

	test("Escape calls onCancel and cleans up", () => {
		const { document } = dom();
		let cancelled = false;
		const _handle = activateRegionCapture(document, {
			onRegion: () => {},
			onCancel: () => {
				cancelled = true;
			},
		});

		document.dispatchEvent(fakeEvent("keydown", { key: "Escape" }));

		expect(cancelled).toBe(true);
		expect(document.querySelector("[data-omp-region-marquee]")).toBeNull();
	});

	test("drag below 8px threshold calls onCancel", () => {
		const { document } = dom();
		let cancelled = false;
		let regionReceived = false;
		activateRegionCapture(document, {
			onRegion: () => {
				regionReceived = true;
			},
			onCancel: () => {
				cancelled = true;
			},
		});

		document.dispatchEvent(
			fakeEvent("mousedown", { clientX: 100, clientY: 100 }),
		);
		document.dispatchEvent(
			fakeEvent("mouseup", { clientX: 105, clientY: 105 }),
		);

		expect(cancelled).toBe(true);
		expect(regionReceived).toBe(false);
	});

	test("valid drag calls onRegion with correct rect", () => {
		const { document } = dom();
		let receivedRegion: RegionRect | null = null;
		activateRegionCapture(document, {
			onRegion: (region) => {
				receivedRegion = region;
			},
			onCancel: () => {},
		});

		document.dispatchEvent(
			fakeEvent("mousedown", { clientX: 100, clientY: 100 }),
		);
		document.dispatchEvent(
			fakeEvent("mouseup", { clientX: 500, clientY: 400 }),
		);

		expect(receivedRegion).not.toBeNull();
		expect(receivedRegion!.x).toBe(100);
		expect(receivedRegion!.y).toBe(100);
		expect(receivedRegion!.width).toBe(400);
		expect(receivedRegion!.height).toBe(300);
	});

	test("reversed drag (bottom-right to top-left) normalizes correctly", () => {
		const { document } = dom();
		let receivedRegion: RegionRect | null = null;
		activateRegionCapture(document, {
			onRegion: (region) => {
				receivedRegion = region;
			},
			onCancel: () => {},
		});

		document.dispatchEvent(
			fakeEvent("mousedown", { clientX: 500, clientY: 400 }),
		);
		document.dispatchEvent(
			fakeEvent("mouseup", { clientX: 100, clientY: 100 }),
		);

		expect(receivedRegion).not.toBeNull();
		expect(receivedRegion!.x).toBe(100);
		expect(receivedRegion!.y).toBe(100);
		expect(receivedRegion!.width).toBe(400);
		expect(receivedRegion!.height).toBe(300);
	});
});
