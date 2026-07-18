import { BROWSER_FEEDBACK_LIMITS } from "@oh-my-pi/browser-protocol";

// ── Stitch plan ────────────────────────────────────────────────────────────

export interface StitchStep {
	y: number;
	frameIndex: number;
	cropHeight: number;
}

export interface StitchPlan {
	steps: StitchStep[];
	totalHeight: number;
}

/**
 * Calculate how many scroll steps are needed and where to crop each frame.
 *
 * `captureVisibleTab` always returns a full viewport-height image. For the
 * last frame we only keep the portion that overlaps page content.
 */
export function calculateStitchPlan(
	scrollHeight: number,
	viewportHeight: number,
): StitchPlan {
	if (scrollHeight <= viewportHeight) {
		return {
			steps: [{ y: 0, frameIndex: 0, cropHeight: scrollHeight }],
			totalHeight: scrollHeight,
		};
	}

	const stepCount = Math.ceil(scrollHeight / viewportHeight);
	const steps: StitchStep[] = [];

	for (let i = 0; i < stepCount; i++) {
		const y = i * viewportHeight;
		const remaining = scrollHeight - y;
		const cropHeight = Math.min(viewportHeight, remaining);
		steps.push({ y, frameIndex: i, cropHeight });
	}

	return { steps, totalHeight: scrollHeight };
}

// ── Downscale ──────────────────────────────────────────────────────────────

export function calculateDownscaleFactor(
	totalDevicePixels: number,
	maxDevicePixels: number,
): number {
	if (totalDevicePixels <= maxDevicePixels) return 1;
	return maxDevicePixels / totalDevicePixels;
}

// ── Stitching ──────────────────────────────────────────────────────────────

export interface StitchResult {
	blob: Blob;
	width: number;
	height: number;
	downscaled: boolean;
}

/**
 * Stitch an array of viewport-height ImageBitmaps into a single tall PNG.
 *
 * Each frame is a `captureVisibleTab` snapshot at the corresponding scroll
 * position. `plan.steps[i].cropHeight` tells how many CSS pixels of content
 * that frame actually contains (last frame may be shorter).
 *
 * Frames are at device-pixel resolution — all math uses `* dpr`.
 */
export async function stitchFrames(
	frames: ImageBitmap[],
	plan: StitchPlan,
	dpr: number,
): Promise<StitchResult> {
	if (frames.length === 0) {
		throw new Error("No frames to stitch");
	}

	const frameWidth = frames[0].width;
	const totalCssHeight = plan.totalHeight;
	const totalDeviceHeight = Math.ceil(totalCssHeight * dpr);

	// Check canvas height limit
	const maxHeightPx = BROWSER_FEEDBACK_LIMITS.maxStitchedHeight;
	const scale = calculateDownscaleFactor(totalDeviceHeight, maxHeightPx);

	const scaledHeight = Math.floor(totalDeviceHeight * scale);
	const scaledWidth = Math.floor(frameWidth * scale);

	const canvas = new OffscreenCanvas(scaledWidth, scaledHeight);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Failed to get 2d context");

	// White background to avoid transparent seams
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, scaledWidth, scaledHeight);

	for (let i = 0; i < frames.length; i++) {
		const step = plan.steps[i];
		const frame = frames[i];
		const cropDeviceH = Math.ceil(step.cropHeight * dpr);

		// Source: full width, cropped height from top of frame
		const sx = 0;
		const sy = 0;
		const sw = frame.width;
		const sh = Math.min(cropDeviceH, frame.height);

		// Dest: y offset in scaled canvas
		const dy = Math.floor(step.y * dpr * scale);

		if (scale < 1) {
			ctx.drawImage(
				frame,
				sx,
				sy,
				sw,
				sh,
				0,
				dy,
				scaledWidth,
				Math.ceil(sh * scale),
			);
		} else {
			ctx.drawImage(frame, sx, sy, sw, sh, 0, dy, sw, sh);
		}
	}

	let blob = await canvas.convertToBlob({ type: "image/png" });
	let downscaled = scale < 1;

	// If blob exceeds byte limit, try JPEG
	const maxBytes = BROWSER_FEEDBACK_LIMITS.maxScreenshotBytes;
	if (blob.size > maxBytes) {
		blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
		downscaled = true;
	}

	return {
		blob,
		width: scaledWidth,
		height: scaledHeight,
		downscaled,
	};
}

// ── Fullpage capture state (service-worker side) ───────────────────────────

const CAPTURE_INTERVAL_MS = 550; // respect ~2/sec rate limit
const SETTLE_DELAY_MS = 150; // wait for lazy content

export interface FullpageCaptureContext {
	tabId: number;
	windowId: number;
	channelId: string;
	originalScrollY: number;
	scrollHeight: number;
	viewportHeight: number;
	dpr: number;
	plan: StitchPlan;
	frames: ImageBitmap[];
	cancelled: boolean;
}
let _activeCapture: FullpageCaptureContext | null = null;

export function getActiveCapture(): FullpageCaptureContext | null {
	return _activeCapture;
}

export function setActiveCapture(ctx: FullpageCaptureContext | null): void {
	_activeCapture = ctx;
}

export function cancelActiveCapture(): void {
	if (_activeCapture) {
		_activeCapture.cancelled = true;
	}
}

export { CAPTURE_INTERVAL_MS, SETTLE_DELAY_MS };
