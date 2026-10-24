import { crc32 } from './container';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const YIELD_BYTES = 1024 * 1024;

/** Text metadata is retained in source assets, but is not input to raw pixel decoding. */
export async function preparePngPixelDecodeInput(
	bytes: Uint8Array,
	expectedWidth: number,
	expectedHeight: number,
	isCancelled?: () => boolean
): Promise<Uint8Array> {
	const check = () => { if (isCancelled?.()) throw new Error('BOMC load cancelled'); };
	check();
	if (!Number.isSafeInteger(expectedWidth) || expectedWidth <= 0 || !Number.isSafeInteger(expectedHeight) || expectedHeight <= 0 ||
		!Number.isSafeInteger(expectedWidth * expectedHeight * 4)) throw new Error('BOMC PNG dimensions are invalid or unsafe.');
	if (bytes.length < 8 || SIGNATURE.some((v, i) => bytes[i] !== v)) throw new Error('BOMC PNG signature is invalid.');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ranges: Array<[number, number]> = [[0, 8]];
	let offset = 8, retained = 8, scanned = 0, removed = false, hasHeader = false, hasData = false, hasEnd = false;
	while (offset < bytes.length) {
		check();
		if (bytes.length - offset < 12) throw new Error('BOMC PNG chunk framing is truncated.');
		const length = view.getUint32(offset), end = offset + length + 12;
		if (!Number.isSafeInteger(end) || end > bytes.length) throw new Error('BOMC PNG chunk range is truncated or unsafe.');
		const typeBytes = bytes.subarray(offset + 4, offset + 8);
		if (!typeBytes.every((v) => (v >= 65 && v <= 90) || (v >= 97 && v <= 122)) || typeBytes[2] < 65 || typeBytes[2] > 90) {
			throw new Error('BOMC PNG chunk type is invalid.');
		}
		const type = String.fromCharCode(...typeBytes);
		if (crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) throw new Error(`BOMC PNG ${type} CRC mismatch.`);
		if (!hasHeader && type !== 'IHDR') throw new Error('BOMC PNG first chunk must be IHDR.');
		if (type === 'IHDR') {
			if (hasHeader || length !== 13) throw new Error('BOMC PNG IHDR is repeated or invalid.');
			if (view.getUint32(offset + 8) !== expectedWidth || view.getUint32(offset + 12) !== expectedHeight) throw new Error('BOMC PNG dimensions do not match expected dimensions.');
			hasHeader = true;
		} else if (type === 'IDAT') hasData = true;
		else if (type === 'IEND') {
			if (length !== 0 || !hasData || end !== bytes.length) throw new Error('BOMC PNG IEND or image data is invalid.');
			hasEnd = true;
		}
		if (type === 'iTXt') removed = true;
		else { ranges.push([offset, end]); retained += end - offset; }
		scanned += end - offset;
		offset = end;
		if (scanned >= YIELD_BYTES) { await new Promise<void>((resolve) => setTimeout(resolve, 0)); scanned = 0; check(); }
	}
	if (!hasHeader || !hasData || !hasEnd) throw new Error('BOMC PNG is missing required image chunks.');
	check();
	if (!removed) return bytes;
	const result = new Uint8Array(retained);
	let target = 0, copied = 0;
	for (const [start, end] of ranges) {
		check(); result.set(bytes.subarray(start, end), target); target += end - start; copied += end - start;
		if (copied >= YIELD_BYTES) { await new Promise<void>((resolve) => setTimeout(resolve, 0)); copied = 0; check(); }
	}
	check();
	return result;
}
