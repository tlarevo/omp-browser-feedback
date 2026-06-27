const PADDING_CSS_PX = 40;
const MAX_BLOB_BYTES = 3 * 1024 * 1024;

export interface CapturedScreenshot {
	blob: Blob;
	width: number;
	height: number;
	kind: "crop" | "full-visible-tab";
}

export async function captureAndCrop(
	windowId: number,
	bounds: { x: number; y: number; width: number; height: number },
	devicePixelRatio: number,
): Promise<CapturedScreenshot | undefined> {
	let dataUrl: string;
	try {
		dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
	} catch {
		return undefined;
	}

	const res = await fetch(dataUrl);
	const fullBlob = await res.blob();

	const dpr = Math.max(1, devicePixelRatio);
	const pad = Math.round(PADDING_CSS_PX * dpr);

	const fullBitmap = await createImageBitmap(fullBlob);
	const imgW = fullBitmap.width;
	const imgH = fullBitmap.height;
	fullBitmap.close();

	const sx = Math.max(0, Math.floor(bounds.x * dpr - pad));
	const sy = Math.max(0, Math.floor(bounds.y * dpr - pad));
	const ex = Math.min(imgW, Math.ceil((bounds.x + bounds.width) * dpr + pad));
	const ey = Math.min(imgH, Math.ceil((bounds.y + bounds.height) * dpr + pad));
	const sw = ex - sx;
	const sh = ey - sy;

	if (sw <= 0 || sh <= 0) {
		if (fullBlob.size > MAX_BLOB_BYTES) return undefined;
		return { blob: fullBlob, width: imgW, height: imgH, kind: "full-visible-tab" };
	}

	const croppedBitmap = await createImageBitmap(fullBlob, sx, sy, sw, sh);
	const canvas = new OffscreenCanvas(sw, sh);
	const ctx = canvas.getContext("2d");

	if (!ctx) {
		croppedBitmap.close();
		if (fullBlob.size > MAX_BLOB_BYTES) return undefined;
		return { blob: fullBlob, width: imgW, height: imgH, kind: "full-visible-tab" };
	}

	ctx.drawImage(croppedBitmap, 0, 0);
	croppedBitmap.close();

	const croppedBlob = await canvas.convertToBlob({ type: "image/png" });

	if (croppedBlob.size > MAX_BLOB_BYTES) {
		if (fullBlob.size > MAX_BLOB_BYTES) return undefined;
		return { blob: fullBlob, width: imgW, height: imgH, kind: "full-visible-tab" };
	}

	return { blob: croppedBlob, width: sw, height: sh, kind: "crop" };
}
