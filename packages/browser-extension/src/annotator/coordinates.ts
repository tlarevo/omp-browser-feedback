// Coordinate normalization — display space ↔ normalized [0,1] image space.
// Top-left origin; independent of fit scale and device-pixel ratio.

import type { Point } from "./model";

export interface FitMetrics {
	/** CSS offset left of the image within the canvas container */
	offsetX: number;
	/** CSS offset top of the image within the canvas container */
	offsetY: number;
	/** CSS display width of the fitted image */
	displayWidth: number;
	/** CSS display height of the fitted image */
	displayHeight: number;
}

export function fitImageToCanvas(
	imageWidth: number,
	imageHeight: number,
	canvasWidth: number,
	canvasHeight: number,
): FitMetrics {
	const scaleX = canvasWidth / imageWidth;
	const scaleY = canvasHeight / imageHeight;
	const scale = Math.min(scaleX, scaleY);
	const displayWidth = imageWidth * scale;
	const displayHeight = imageHeight * scale;
	return {
		offsetX: (canvasWidth - displayWidth) / 2,
		offsetY: (canvasHeight - displayHeight) / 2,
		displayWidth,
		displayHeight,
	};
}

/** Convert a display-space point (CSS px on canvas) to normalized [0,1] image space. */
export function displayToNormalized(point: Point, metrics: FitMetrics): Point {
	return {
		x: clamp((point.x - metrics.offsetX) / metrics.displayWidth),
		y: clamp((point.y - metrics.offsetY) / metrics.displayHeight),
	};
}

/** Convert a normalized [0,1] point to display-space (CSS px on canvas). */
export function normalizedToDisplay(point: Point, metrics: FitMetrics): Point {
	return {
		x: point.x * metrics.displayWidth + metrics.offsetX,
		y: point.y * metrics.displayHeight + metrics.offsetY,
	};
}

function clamp(value: number): number {
	return Math.max(0, Math.min(1, value));
}
