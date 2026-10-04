const EQUAL_TOL = 0.001;
const MAX_MEMO_ENTRIES = 65_536;
const CHECKPOINT_PIXELS = 32_768;

export type SemanticColorizeMode = 1 | 2;
export type SemanticColorizeDeltas = readonly [h: number, l: number, s: number];

export function colorizePixel(
	rByte: number,
	gByte: number,
	bByte: number,
	mode: SemanticColorizeMode,
	deltas: SemanticColorizeDeltas
): [number, number, number] {
	let r = Math.fround(rByte / 255);
	let g = Math.fround(gByte / 255);
	let b = Math.fround(bByte / 255);
	let max = r;
	let min = r;
	if (gt(g, max)) max = g;
	if (gt(b, max)) max = b;
	if (lt(g, min)) min = g;
	if (lt(b, min)) min = b;
	const l0 = (max + min) / 2;
	let h = -1;
	let s = 0;
	if (!eq(min, max)) {
		s = le(l0, 0.5) ? (max - min) / (max + min) : (max - min) / (2 - max - min);
		const rc = (max - r) / (max - min);
		const gc = (max - g) / (max - min);
		const bc = (max - b) / (max - min);
		h = eq(r, max) ? bc - gc : eq(g, max) ? 2 + rc - bc : 4 + gc - rc;
		h *= 60;
		if (lt(h, 0)) h += 360;
	}

	h = mode === 1 ? h + deltas[0] : deltas[0];
	while (lt(h, 0)) h += 360;
	while (gt(h, 360)) h -= 360;
	s = clamp(s + deltas[2], 0, 1);
	const l = clamp(l0 + deltas[1], 0.01, 1);
	if (eq(s, 0)) {
		const gray = byte(l);
		return [gray, gray, gray];
	}
	const m2 = lt(l, 0.5) ? l * (1 + s) : l + s - l * s;
	const m1 = 2 * l - m2;
	return [calc(m1, m2, h + 120), calc(m1, m2, h), calc(m1, m2, h - 120)];
}

export async function colorizeRgba(
	data: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number,
	mode: SemanticColorizeMode,
	deltas: SemanticColorizeDeltas,
	options: { isCancelled?: () => boolean } = {}
): Promise<{ data: Uint8ClampedArray; maxMemoEntries: number }> {
	if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
		throw new Error('BOMC semantic texture dimensions are invalid.');
	}
	const pixels = width * height;
	const byteLength = pixels * 4;
	if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(byteLength) || data.byteLength !== byteLength) {
		throw new Error('BOMC semantic texture RGBA byte length is invalid.');
	}
	checkCancelled(options.isCancelled);
	const memo = new Map<number, number>();
	let output: Uint8ClampedArray | null = new Uint8ClampedArray(byteLength);
	let maxMemoEntries = 0;
	try {
		for (let pixel = 0; pixel < pixels; pixel += 1) {
			const offset = pixel * 4;
			const r = data[offset];
			const g = data[offset + 1];
			const b = data[offset + 2];
			const key = (r << 16) | (g << 8) | b;
			let color = memo.get(key);
			if (color === undefined) {
				const [nextR, nextG, nextB] = colorizePixel(r, g, b, mode, deltas);
				color = (nextR << 16) | (nextG << 8) | nextB;
				if (memo.size < MAX_MEMO_ENTRIES) {
					memo.set(key, color);
					if (memo.size > maxMemoEntries) maxMemoEntries = memo.size;
				}
			}
			output[offset] = (color >>> 16) & 0xff;
			output[offset + 1] = (color >>> 8) & 0xff;
			output[offset + 2] = color & 0xff;
			output[offset + 3] = data[offset + 3];
			if ((pixel + 1) % CHECKPOINT_PIXELS === 0) {
				checkCancelled(options.isCancelled);
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				checkCancelled(options.isCancelled);
			}
		}
		checkCancelled(options.isCancelled);
		const result = output;
		output = null;
		return { data: result, maxMemoEntries };
	} catch (error) {
		memo.clear();
		output = null;
		throw error;
	} finally {
		memo.clear();
	}
}

function eq(a: number, b: number) { return Math.abs(a - b) < EQUAL_TOL; }
function lt(a: number, b: number) { return (a - b) <= -EQUAL_TOL; }
function gt(a: number, b: number) { return (a - b) >= EQUAL_TOL; }
function le(a: number, b: number) { return lt(a, b) || eq(a, b); }
function clamp(value: number, minimum: number, maximum: number) { return Math.min(Math.max(value, minimum), maximum); }
function byte(value: number) {
	if (value <= 0) return 0;
	if (value >= 1) return 255;
	return Math.floor(value * 255);
}
function calc(n1: number, n2: number, inputHue: number) {
	let hue = inputHue;
	if (gt(hue, 360)) hue -= 360;
	if (lt(hue, 0)) hue += 360;
	if (lt(hue, 60)) return byte(n1 + (n2 - n1) * hue / 60);
	if (lt(hue, 180)) return byte(n2);
	if (lt(hue, 240)) return byte(n1 + (n2 - n1) * (240 - hue) / 60);
	return byte(n1);
}
function checkCancelled(isCancelled?: () => boolean) {
	if (isCancelled?.()) throw new Error('BOMC load cancelled');
}
