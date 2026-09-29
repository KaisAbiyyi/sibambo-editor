const MAGIC = new Uint8Array([66, 79, 77, 74, 67, 77, 13, 10]);
const HEADER_BYTES = 128;
const CHECKPOINT_PIXELS = 131_072;
const MAX_PIXELS = 32_000_000;
const MAX_ENTRIES = 262_144;
const MAX_JPEG_BYTES = 32 * 1024 * 1024;

type ParsedJcm = {
	width: number;
	height: number;
	pixels: number;
	codec: number;
	jpeg: Uint8Array;
	baseHash: Uint8Array;
	outputHash: Uint8Array;
	colors?: Map<number, number>;
	residual?: Uint8Array;
};

export type JcmDecodeOptions = {
	isCancelled?: () => boolean;
	onProgress?: (processed: number, total: number) => void;
};

function fail(message: string): never {
	throw new Error(`BOMC invalid: JPEG color map ${message}.`);
}

function equalBytes(first: Uint8Array, second: Uint8Array) {
	if (first.byteLength !== second.byteLength) return false;
	for (let index = 0; index < first.byteLength; index += 1) if (first[index] !== second[index]) return false;
	return true;
}

export async function digestSha256(bytes: Uint8Array) {
	if (typeof crypto === 'undefined' || !crypto.subtle) fail('SHA-256 is unavailable');
	let input: Uint8Array<ArrayBuffer>;
	if (bytes.buffer instanceof ArrayBuffer) {
		input = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	} else {
		input = new Uint8Array(bytes.byteLength);
		input.set(bytes);
	}
	return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

function validateJpeg(jpeg: Uint8Array, width: number, height: number) {
	if (jpeg.byteLength < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) fail('JPEG bounds or SOI marker');
	let cursor = 2;
	let frameSeen = false;
	let scanSeen = false;
	let entropy = false;
	while (cursor < jpeg.byteLength) {
		if (entropy && jpeg[cursor] !== 0xff) {
			cursor += 1;
			continue;
		}
		if (jpeg[cursor] !== 0xff) fail('JPEG marker');
		cursor += 1;
		while (cursor < jpeg.byteLength && jpeg[cursor] === 0xff) cursor += 1;
		if (cursor >= jpeg.byteLength) fail('truncated JPEG marker');
		const marker = jpeg[cursor++];
		if (entropy && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
		entropy = false;
		if (marker === 0xd9) {
			if (!frameSeen || !scanSeen || cursor !== jpeg.byteLength) fail('JPEG ending');
			return;
		}
		if (marker >= 0xe1 && marker <= 0xef) fail('JPEG metadata marker');
		if (cursor + 2 > jpeg.byteLength) fail('truncated JPEG segment');
		const length = (jpeg[cursor] << 8) | jpeg[cursor + 1];
		if (length < 2 || cursor + length > jpeg.byteLength) fail('JPEG segment length');
		if (marker === 0xc0 || marker === 0xc2) {
			if (frameSeen || length < 8 || jpeg[cursor + 2] !== 8) fail('JPEG frame');
			const frameHeight = (jpeg[cursor + 3] << 8) | jpeg[cursor + 4];
			const frameWidth = (jpeg[cursor + 5] << 8) | jpeg[cursor + 6];
			const components = jpeg[cursor + 7];
			if (![1, 3].includes(components) || length !== 8 + components * 3) fail('JPEG components');
			if (frameWidth !== width || frameHeight !== height) fail('JPEG dimensions');
			frameSeen = true;
		} else if (marker === 0xda) {
			if (!frameSeen || length < 6 || length !== 6 + jpeg[cursor + 2] * 2) fail('JPEG scan');
			scanSeen = true;
			entropy = true;
		} else if (![0xc4, 0xdb, 0xdd, 0xe0, 0xfe].includes(marker)) {
			fail('unsupported JPEG marker');
		}
		cursor += length;
	}
	fail('truncated JPEG');
}

async function inflateCorrection(encoded: Uint8Array, expectedLength: number) {
	if (!expectedLength || expectedLength > MAX_PIXELS * 4) fail('correction bounds');
	if (!encoded.byteLength || encoded.byteLength > expectedLength + 65_536) fail('correction bounds');
	if (typeof DecompressionStream !== 'function') fail('DEFLATE decoder is unavailable');
	const stream = new Blob([encoded.slice().buffer]).stream().pipeThrough(new DecompressionStream('deflate'));
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
		total += chunk.byteLength;
		if (total > expectedLength) {
			await reader.cancel();
			fail('inflated correction exceeds expected length');
		}
		chunks.push(chunk);
	}
	if (total !== expectedLength) fail('inflated correction length');
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

async function parseJcm(payload: Uint8Array, expectedWidth: number, expectedHeight: number): Promise<ParsedJcm> {
	if (payload.byteLength < HEADER_BYTES || !equalBytes(payload.subarray(0, 8), MAGIC)) fail('header');
	const codec = payload[10];
	if (payload[8] !== 1 || payload[9] !== 0 || ![0, 1, 2].includes(codec) || payload[11] !== 1) fail('version or flags');
	const header = new DataView(payload.buffer, payload.byteOffset, HEADER_BYTES);
	const width = header.getUint32(12, true);
	const height = header.getUint32(16, true);
	const count = header.getUint32(20, true);
	const jpegLength = header.getUint32(24, true);
	const correctionLength = header.getUint32(28, true);
	const pixels = width * height;
	if (!width || !height || width > 16_384 || height > 16_384 || pixels > MAX_PIXELS ||
		!Number.isSafeInteger(pixels) || !Number.isSafeInteger(pixels * 4)) fail('pixel dimensions');
	if (width !== expectedWidth || height !== expectedHeight) fail('table dimensions mismatch');
	if (!jpegLength || jpegLength > MAX_JPEG_BYTES) fail('JPEG byte count');

	const rawCorrectionLength = codec === 2 ? pixels * 4 : count * 7;
	if (codec === 2) {
		if (count !== pixels) fail('residual count');
	} else if (!count || count > MAX_ENTRIES || count > pixels) {
		fail('dictionary entry count');
	}
	const payloadCorrectionLength = codec === 0 ? rawCorrectionLength : correctionLength;
	if (codec === 0) {
		if (correctionLength !== 0) fail('stored correction length');
	} else if (!correctionLength || correctionLength > rawCorrectionLength + 65_536) {
		fail('compressed correction bounds');
	}
	const expectedPayloadLength = HEADER_BYTES + jpegLength + payloadCorrectionLength;
	if (!Number.isSafeInteger(expectedPayloadLength) || payload.byteLength !== expectedPayloadLength) fail('payload length');

	const jpeg = payload.subarray(HEADER_BYTES, HEADER_BYTES + jpegLength);
	if (!equalBytes(await digestSha256(jpeg), payload.subarray(32, 64))) fail('JPEG hash mismatch');
	validateJpeg(jpeg, width, height);
	const encodedCorrection = payload.subarray(HEADER_BYTES + jpegLength);
	const correction = codec === 0 ? encodedCorrection : await inflateCorrection(encodedCorrection, rawCorrectionLength);

	const common = {
		width, height, pixels, codec, jpeg,
		baseHash: payload.subarray(64, 96), outputHash: payload.subarray(96, 128)
	};
	if (codec === 2) return { ...common, residual: correction };

	const colors = new Map<number, number>();
	let previousKey = -1;
	for (let index = 0; index < count; index += 1) {
		const offset = index * 7;
		const key = (correction[offset] << 16) | (correction[offset + 1] << 8) | correction[offset + 2];
		if (key <= previousKey) fail('dictionary keys are not strictly sorted');
		if (correction[offset + 6] !== 255) fail('dictionary entry is not opaque');
		const color = (correction[offset + 3] << 24) | (correction[offset + 4] << 16) | (correction[offset + 5] << 8) | 255;
		colors.set(key, color);
		previousKey = key;
	}
	return { ...common, colors };
}

async function reconstructPixels(parsed: ParsedJcm, baseRgba: Uint8Array, options: JcmDecodeOptions = {}) {
	if (baseRgba.byteLength !== parsed.pixels * 4) fail('decoded base byte length');
	if (!equalBytes(await digestSha256(baseRgba), parsed.baseHash)) fail('base pixel hash mismatch');
	const output = new Uint8Array(baseRgba.byteLength);
	for (let pixel = 0; pixel < parsed.pixels; pixel += 1) {
		if (pixel % CHECKPOINT_PIXELS === 0) {
			if (options.isCancelled?.()) throw new Error('BOMC load cancelled');
			options.onProgress?.(pixel, parsed.pixels);
		}
		const sourceOffset = pixel * 4;
		if (baseRgba[sourceOffset + 3] !== 255) fail('base frame is not opaque');
		if (parsed.codec === 2) {
			const residual = parsed.residual;
			if (!residual) fail('missing XOR residual');
			output[sourceOffset] = baseRgba[sourceOffset] ^ residual[sourceOffset];
			output[sourceOffset + 1] = baseRgba[sourceOffset + 1] ^ residual[sourceOffset + 1];
			output[sourceOffset + 2] = baseRgba[sourceOffset + 2] ^ residual[sourceOffset + 2];
			output[sourceOffset + 3] = baseRgba[sourceOffset + 3] ^ residual[sourceOffset + 3];
			if (output[sourceOffset + 3] !== 255) fail('residual output is not opaque');
		} else {
			const colors = parsed.colors;
			if (!colors) fail('missing dictionary');
			const key = (baseRgba[sourceOffset] << 16) | (baseRgba[sourceOffset + 1] << 8) | baseRgba[sourceOffset + 2];
			const color = colors.get(key);
			if (color === undefined) fail('missing dictionary key');
			output[sourceOffset] = color >>> 24;
			output[sourceOffset + 1] = (color >>> 16) & 255;
			output[sourceOffset + 2] = (color >>> 8) & 255;
			output[sourceOffset + 3] = 255;
		}
	}
	if (options.isCancelled?.()) throw new Error('BOMC load cancelled');
	options.onProgress?.(parsed.pixels, parsed.pixels);
	if (!equalBytes(await digestSha256(output), parsed.outputHash)) fail('output pixel hash mismatch');
	return output;
}

export async function decodeBomcJcmPixels(
	payload: Uint8Array, baseRgba: Uint8Array, expectedWidth: number, expectedHeight: number,
	options: JcmDecodeOptions = {}
) {
	const parsed = await parseJcm(payload, expectedWidth, expectedHeight);
	return reconstructPixels(parsed, baseRgba, options);
}

export async function decodeBomcJcmToPng(
	payload: Uint8Array, expectedWidth: number, expectedHeight: number, options: JcmDecodeOptions = {}
) {
	if (typeof createImageBitmap !== 'function') fail('browser JPEG decoder is unavailable');
	const parsed = await parseJcm(payload, expectedWidth, expectedHeight);
	if (options.isCancelled?.()) throw new Error('BOMC load cancelled');
	const jpegBlob = new Blob([parsed.jpeg.slice().buffer], { type: 'image/jpeg' });
	const bitmap = await createImageBitmap(jpegBlob);
	let baseCanvas: OffscreenCanvas | HTMLCanvasElement | undefined;
	let outputCanvas: OffscreenCanvas | HTMLCanvasElement | undefined;
	try {
		if (bitmap.width !== parsed.width || bitmap.height !== parsed.height) fail('decoded JPEG dimensions');
		const makeCanvas = (width: number, height: number): OffscreenCanvas | HTMLCanvasElement => {
			if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			return canvas;
		};
		baseCanvas = makeCanvas(parsed.width, parsed.height);
		const baseContext = baseCanvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
		if (!baseContext) fail('base canvas context is unavailable');
		baseContext.drawImage(bitmap, 0, 0);
		const base = baseContext.getImageData(0, 0, parsed.width, parsed.height).data;
		const output = await reconstructPixels(parsed, new Uint8Array(base.buffer, base.byteOffset, base.byteLength), options);
		if (options.isCancelled?.()) throw new Error('BOMC load cancelled');
		outputCanvas = makeCanvas(parsed.width, parsed.height);
		const outputContext = outputCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
		if (!outputContext) fail('output canvas context is unavailable');
		const outputData = new Uint8ClampedArray(output.buffer, output.byteOffset, output.byteLength);
		outputContext.putImageData(new ImageData(outputData, parsed.width, parsed.height), 0, 0);
		const png = typeof OffscreenCanvas !== 'undefined' && outputCanvas instanceof OffscreenCanvas
			? await outputCanvas.convertToBlob({ type: 'image/png' })
			: await new Promise<Blob>((resolve, reject) => (outputCanvas as HTMLCanvasElement).toBlob((blob) => blob ? resolve(blob) : reject(new Error('BOMC invalid: JPEG color map PNG encoding failed.')), 'image/png'));
		const bytes = new Uint8Array(await png.arrayBuffer());
		return { bytes, sha256: await digestSha256(bytes) };
	} finally {
		bitmap.close();
		if (baseCanvas) { baseCanvas.width = 0; baseCanvas.height = 0; }
		if (outputCanvas) { outputCanvas.width = 0; outputCanvas.height = 0; }
	}
}
