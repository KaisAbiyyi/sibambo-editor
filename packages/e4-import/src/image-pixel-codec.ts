export type SemanticImageMedia = 1 | 2 | 3;

export type PixelFrame = {
	width: number;
	height: number;
	data: Uint8ClampedArray;
};

export type ImagePixelCodec = {
	decode(source: { media: SemanticImageMedia; bytes: Uint8Array; width: number; height: number }, isCancelled?: () => boolean): Promise<PixelFrame>;
	encodePng(frame: PixelFrame, isCancelled?: () => boolean): Promise<Uint8Array>;
};

type PngCodec = {
	decode(data: ArrayBuffer, options: { bitDepth: 8 }): Promise<ImageData>;
	encode(data: { data: Uint8ClampedArray; width: number; height: number }, options: { bitDepth: 8 }): Promise<ArrayBuffer>;
};
type WebpCodec = { decode(data: ArrayBuffer): Promise<ImageData> };

let pngCodecPromise: Promise<PngCodec> | undefined;
let webpCodecPromise: Promise<WebpCodec> | undefined;

function getPngCodec() {
	if (!pngCodecPromise) {
		pngCodecPromise = (async () => {
			const [decoder, encoder, wasm] = await Promise.all([
				import('@jsquash/png/decode.js'),
				import('@jsquash/png/encode.js'),
				import('@jsquash/png/codec/pkg/squoosh_png_bg.wasm?url')
			]);
			await decoder.init(wasm.default);
			await encoder.init(wasm.default);
			return { decode: decoder.decode, encode: encoder.default };
		})().catch((error) => {
			pngCodecPromise = undefined;
			throw error;
		});
	}
	return pngCodecPromise;
}

function getWebpCodec() {
	if (!webpCodecPromise) {
		webpCodecPromise = (async () => {
			const [decoder, wasm] = await Promise.all([
				import('@jsquash/webp/decode.js'),
				import('@jsquash/webp/codec/dec/webp_dec.wasm?url')
			]);
			await decoder.init({ locateFile: () => wasm.default });
			return { decode: decoder.default };
		})().catch((error) => {
			webpCodecPromise = undefined;
			throw error;
		});
	}
	return webpCodecPromise;
}

export const defaultImagePixelCodec: ImagePixelCodec = {
	async decode(source, isCancelled) {
		checkCancelled(isCancelled);
		const encoded = exactArrayBuffer(source.bytes);
		let decoded: ImageData;
		if (source.media === 1) {
			const png = await getPngCodec();
			checkCancelled(isCancelled);
			decoded = await png.decode(encoded, { bitDepth: 8 });
		} else if (source.media === 2) {
			decoded = await decodeJpeg(encoded, isCancelled);
		} else if (source.media === 3) {
			const webp = await getWebpCodec();
			checkCancelled(isCancelled);
			decoded = await webp.decode(encoded);
		} else {
			throw new Error(`BOMC semantic image media ${source.media} is unsupported.`);
		}
		checkCancelled(isCancelled);
		return takeOwnedFrame(decoded, source.width, source.height);
	},

	async encodePng(frame, isCancelled) {
		checkCancelled(isCancelled);
		assertDimensions(frame.width, frame.height);
		assertRgbaLength(frame.data, frame.width, frame.height);
		let ownedFrameData = frame.data;
		if (frame.data.byteOffset !== 0 || frame.data.buffer.byteLength !== frame.data.byteLength) {
			ownedFrameData = frame.data.slice();
		}
		const png = await getPngCodec();
		checkCancelled(isCancelled);
		const encoded = await png.encode({ data: ownedFrameData, width: frame.width, height: frame.height }, { bitDepth: 8 });
		checkCancelled(isCancelled);
		return new Uint8Array(encoded);
	}
};

async function decodeJpeg(encoded: ArrayBuffer, isCancelled?: () => boolean): Promise<ImageData> {
	if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
		throw new Error('BOMC semantic JPEG requires worker createImageBitmap and OffscreenCanvas support.');
	}
	checkCancelled(isCancelled);
	const bitmap = await createImageBitmap(new Blob([encoded], { type: 'image/jpeg' }), {
		imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none'
	});
	let canvas: OffscreenCanvas | undefined;
	try {
		checkCancelled(isCancelled);
		canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
		if (!context) throw new Error('BOMC semantic JPEG OffscreenCanvas 2D context is unavailable.');
		context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
		const frame = context.getImageData(0, 0, bitmap.width, bitmap.height);
		for (let offset = 3; offset < frame.data.byteLength; offset += 4) {
			if (frame.data[offset] !== 255) throw new Error(`BOMC semantic JPEG decoder returned non-opaque alpha at pixel ${(offset - 3) / 4}.`);
		}
		return frame;
	} finally {
		bitmap.close();
		if (canvas) { canvas.width = 0; canvas.height = 0; }
	}
}

function takeOwnedFrame(image: ImageData, expectedWidth: number, expectedHeight: number): PixelFrame {
	assertDimensions(expectedWidth, expectedHeight);
	if (image.width !== expectedWidth || image.height !== expectedHeight) {
		throw new Error(`BOMC semantic decoded dimensions ${image.width}x${image.height} do not match ${expectedWidth}x${expectedHeight}.`);
	}
	assertRgbaLength(image.data, image.width, image.height);
	// Codec output may be a view into a reusable WASM heap; the loader owns this copy.
	const data = new Uint8ClampedArray(image.data.byteLength);
	data.set(image.data);
	return { width: image.width, height: image.height, data };
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function assertDimensions(width: number, height: number) {
	if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
		throw new Error('BOMC semantic image dimensions are invalid.');
	}
	const pixels = width * height;
	const bytes = pixels * 4;
	if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(bytes)) throw new Error('BOMC semantic image RGBA byte length is unsafe.');
}

function assertRgbaLength(data: Uint8Array | Uint8ClampedArray, width: number, height: number) {
	assertDimensions(width, height);
	if (data.byteLength !== width * height * 4) throw new Error('BOMC semantic image RGBA byte length is invalid.');
}

function checkCancelled(isCancelled?: () => boolean) {
	if (isCancelled?.()) throw new Error('BOMC load cancelled');
}
