import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { crc32 } from './container';
import { preparePngPixelDecodeInput } from './png-pixel-decode-input';

const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
function concat(...parts: Uint8Array[]) {
	const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result;
}
function chunk(type: string, data = new Uint8Array()) {
	const result = new Uint8Array(data.length + 12), view = new DataView(result.buffer);
	view.setUint32(0, data.length); result.set(new TextEncoder().encode(type), 4); result.set(data, 8);
	view.setUint32(result.length - 4, crc32(result.subarray(4, result.length - 4))); return result;
}
const ihdrData = new Uint8Array(13); new DataView(ihdrData.buffer).setUint32(0, 2); new DataView(ihdrData.buffer).setUint32(4, 2); ihdrData[8] = 8; ihdrData[9] = 6;
const ihdr = chunk('IHDR', ihdrData), end = chunk('IEND');
const raw = Uint8Array.of(0,255,0,99,0,0,255,0,127,0,0,0,255,255,11,22,33,255);
const compressed = new Uint8Array(deflateSync(raw));
const idat = chunk('IDAT', compressed), text = chunk('iTXt', Uint8Array.of(78,0,0,0,0,0,198));
const png = (...middle: Uint8Array[]) => concat(signature, ihdr, ...middle, end);

describe('PNG pixel-only decode input', () => {
	test('omits only iTXt and preserves source, image chunks and their CRC bytes', async () => {
		const physical = chunk('pHYs', new Uint8Array(9)), iccp = chunk('iCCP', Uint8Array.of(1,2,3));
		const first = chunk('IDAT', compressed.slice(0, 3)), last = chunk('IDAT', compressed.slice(3));
		const source = png(iccp, text, physical, first, last), before = source.slice();
		expect(await preparePngPixelDecodeInput(source, 2, 2)).toEqual(png(iccp, physical, first, last));
		expect(source).toEqual(before);
	});
	test('returns the original view when no iTXt is present', async () => {
		const source = png(idat); expect(await preparePngPixelDecodeInput(source, 2, 2)).toBe(source);
	});
	test('uses subarray bounds rather than the whole backing buffer', async () => {
		const source = png(text, idat), wrapped = concat(new Uint8Array(7), source, new Uint8Array(9));
		expect(await preparePngPixelDecodeInput(wrapped.subarray(7, 7 + source.length), 2, 2)).toEqual(png(idat));
	});
	test('omits all iTXt independently of its textual compression or Unicode content', async () => {
		const unicode = chunk('iTXt', new TextEncoder().encode('Note\0\0\0\0\0日本'));
		const zipped = chunk('iTXt', concat(Uint8Array.of(78,0,1,0,0,0), new Uint8Array(deflateSync('hello'))));
		expect(await preparePngPixelDecodeInput(png(unicode, text, zipped, idat), 2, 2)).toEqual(png(idat));
	});
	for (const [name, source] of [
		['bad signature', concat(new Uint8Array(8), ihdr, idat, end)],
		['missing IHDR', concat(signature, idat, end)],
		['duplicate IHDR', png(ihdr, idat)],
		['bad IHDR length', concat(signature, chunk('IHDR', new Uint8Array(12)), idat, end)],
		['missing IDAT', png(text)],
		['missing IEND', concat(signature, ihdr, idat)],
		['nonempty IEND', concat(signature, ihdr, idat, chunk('IEND', Uint8Array.of(1)))],
		['trailing bytes', concat(png(idat), Uint8Array.of(0))],
		['second IEND', concat(png(idat), end)],
		['nonletter type', png(chunk('ab1d'), idat)],
		['reserved bit', png(chunk('abcd'), idat)]
	] as const) test(`rejects ${name}`, async () => {
		await expect(preparePngPixelDecodeInput(source, 2, 2)).rejects.toThrow();
	});
	for (const [name, target] of [['removed text', text], ['image', idat], ['retained ancillary', chunk('pHYs', new Uint8Array(9))]] as const) {
		test(`rejects corrupt CRC in ${name} before removal/decode`, async () => {
			const bad = target.slice(); bad[bad.length - 1] ^= 1;
			await expect(preparePngPixelDecodeInput(png(bad, idat), 2, 2)).rejects.toThrow(/CRC/);
		});
	}
	test('rejects every truncated framing boundary', async () => {
		const source = png(text, idat);
		for (let size = 0; size < source.length; size++) await expect(preparePngPixelDecodeInput(source.slice(0, size), 2, 2)).rejects.toThrow();
	});
	test('rejects huge advertised chunk lengths without allocating their payload', async () => {
		const source = png(idat); new DataView(source.buffer).setUint32(33, 0xffffffff);
		await expect(preparePngPixelDecodeInput(source, 2, 2)).rejects.toThrow();
	});
	test('rejects mismatched/unsafe expected dimensions before decoding', async () => {
		for (const [w,h] of [[3,2],[0,2],[-1,2],[2.5,2],[Number.MAX_SAFE_INTEGER,2]]) await expect(preparePngPixelDecodeInput(png(idat),w,h)).rejects.toThrow(/dimensions|unsafe/);
	});
	test('propagates cancellation before and during scanning', async () => {
		await expect(preparePngPixelDecodeInput(png(text,idat),2,2,()=>true)).rejects.toThrow('BOMC load cancelled');
		let checks = 0;
		await expect(preparePngPixelDecodeInput(png(text,idat),2,2,()=>++checks >= 3)).rejects.toThrow('BOMC load cancelled');
	});
	test('yields a macrotask for accumulated MiB so pending cancellation is observed', async () => {
		let cancelled = false; const timer = setTimeout(()=>{cancelled=true;},0);
		try { await expect(preparePngPixelDecodeInput(png(chunk('tEXt',new Uint8Array(1024*1024)),text,idat),2,2,()=>cancelled)).rejects.toThrow('BOMC load cancelled'); }
		finally { clearTimeout(timer); }
	});
});
