import { expect, test } from 'bun:test';
import { decodeBomcJcmToPng, digestSha256 } from './jpeg-color-map';

const fixtureJpeg = new Uint8Array([
	255, 216, 255, 192, 0, 17, 8, 0, 1, 0, 1, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0,
	255, 218, 0, 12, 3, 1, 0, 2, 0, 3, 0, 0, 63, 0, 1, 255, 217
]);

async function makeJcm() {
	const base = new Uint8Array([10, 20, 30, 255]);
	const output = new Uint8Array([11, 22, 33, 255]);
	const header = new Uint8Array(128);
	header.set(new TextEncoder().encode('BOMJCM\r\n'), 0);
	header.set([1, 0, 0, 1], 8);
	const view = new DataView(header.buffer);
	view.setUint32(12, 1, true);
	view.setUint32(16, 1, true);
	view.setUint32(20, 1, true);
	view.setUint32(24, fixtureJpeg.byteLength, true);
	header.set(await digestSha256(fixtureJpeg), 32);
	header.set(await digestSha256(base), 64);
	header.set(await digestSha256(output), 96);
	const entry = new Uint8Array([10, 20, 30, 11, 22, 33, 255]);
	return { base, payload: new Uint8Array([...header, ...fixtureJpeg, ...entry]) };
}

test('encodes a JPEG color map through HTML canvas when OffscreenCanvas is unavailable', async () => {
	const { base, payload } = await makeJcm();
	const encoded = new Uint8Array([137, 80, 78, 71]);
	const globals = ['OffscreenCanvas', 'createImageBitmap', 'document', 'ImageData'] as const;
	const original = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
	let canvases = 0;
	let usedToBlob = false;
	let closedBitmap = false;
	try {
		Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
		Object.defineProperty(globalThis, 'createImageBitmap', {
			configurable: true, value: async () => ({ width: 1, height: 1, close: () => { closedBitmap = true; } })
		});
		Object.defineProperty(globalThis, 'document', {
			configurable: true, value: { createElement: () => {
				canvases += 1;
				return {
					width: 0, height: 0,
					getContext: () => ({
						drawImage: () => {},
						getImageData: () => ({ data: new Uint8ClampedArray(base) }),
						putImageData: () => {}
					}),
					toBlob: (callback: (blob: Blob) => void) => {
						usedToBlob = true;
						callback(new Blob([encoded], { type: 'image/png' }));
					}
				};
			} }
		});
		Object.defineProperty(globalThis, 'ImageData', {
			configurable: true, value: class { constructor(_data: Uint8ClampedArray, _width: number, _height: number) {} }
		});
		expect('OffscreenCanvas' in globalThis).toBe(false);
		const result = await decodeBomcJcmToPng(payload, 1, 1);
		expect(result.bytes).toEqual(encoded);
		expect(result.sha256).toEqual(await digestSha256(encoded));
		expect(canvases).toBe(2);
		expect(usedToBlob).toBe(true);
		expect(closedBitmap).toBe(true);
	} finally {
		for (const name of globals) {
			const descriptor = original.get(name);
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
	}
});
