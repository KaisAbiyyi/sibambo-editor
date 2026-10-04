import { describe, expect, test } from 'bun:test';
import { decodeMaterials } from './bomc-loader';

const STRINGS = ['Material A', 'Material B'];

function buildMaterials(version: 1 | 2, stringWidth = 1, textureWidth = 1) {
	const count = 2;
	const pieces = [
		Uint8Array.of(version, stringWidth, textureWidth, 0), packU32([count]),
		packIndices([0, 1], stringWidth), packIndices([1, 0], stringWidth),
		Uint8Array.of(10, 20, 30, 40, 50, 60, 70, 80), packU16([12345, 65535]),
		packIndices([1, 0], textureWidth), packF32([1.25, 2.5]), packF32([3.75, 5])
	];
	if (version === 2) {
		pieces.push(Uint8Array.of(2, 2), Uint8Array.of(1, 2));
		pieces.push(packF64([92.5, 0.125, -0.25, -180, -0.5, 0.75]));
		pieces.push(Uint8Array.from([...new Array(32).fill(1), ...new Array(32).fill(2)]));
	}
	return concat(...pieces);
}

function packIndices(values: number[], width: number) {
	const bytes = new Uint8Array(values.length * width);
	const view = new DataView(bytes.buffer);
	values.forEach((value, index) => {
		if (width === 1) view.setUint8(index, value);
		else if (width === 2) view.setUint16(index * width, value, true);
		else view.setUint32(index * width, value, true);
	});
	return bytes;
}
function packU32(values: number[]) { return pack(values, 4, (view, offset, value) => view.setUint32(offset, value, true)); }
function packU16(values: number[]) { return pack(values, 2, (view, offset, value) => view.setUint16(offset, value, true)); }
function packF32(values: number[]) { return pack(values, 4, (view, offset, value) => view.setFloat32(offset, value, true)); }
function packF64(values: number[]) { return pack(values, 8, (view, offset, value) => view.setFloat64(offset, value, true)); }
function pack(values: number[], size: number, set: (view: DataView, offset: number, value: number) => void) {
	const bytes = new Uint8Array(values.length * size);
	const view = new DataView(bytes.buffer);
	values.forEach((value, index) => set(view, index * size, value));
	return bytes;
}
function concat(...pieces: Uint8Array[]) {
	const output = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
	let offset = 0;
	for (const piece of pieces) { output.set(piece, offset); offset += piece.byteLength; }
	return output;
}
function parse(bytes: Uint8Array, expectedCount = 2) { return decodeMaterials(bytes, STRINGS, expectedCount); }
function set8(bytes: Uint8Array, offset: number, value: number) { bytes[offset] = value; }

describe('MATERIALS v2 counted wire parser', () => {
	test.each([1, 2, 4])('decodes v2 interleaved HLS triples at adaptive width %i', (width) => {
		const [first, second] = parse(buildMaterials(2, width, width));
		expect(first).toMatchObject({
			name: 'Material A', displayName: 'Material B', rgba: [10, 20, 30, 40], opacity: 12345 / 65535,
			texture: 1, textureWidthM: 1.25, textureHeightM: 3.75,
			semantic: { materialType: 2, colorizeMode: 1, deltas: [92.5, 0.125, -0.25], outputRgbaSha256: '01'.repeat(32) }
		});
		expect(second.semantic).toEqual({ materialType: 2, colorizeMode: 2, deltas: [-180, -0.5, 0.75], outputRgbaSha256: '02'.repeat(32) });
	});

	test('keeps v1 common fields unchanged and omits semantic metadata', () => {
		const [first, second] = parse(buildMaterials(1));
		expect(first).toEqual({ name: 'Material A', displayName: 'Material B', rgba: [10, 20, 30, 40], opacity: 12345 / 65535, texture: 1, textureWidthM: 1.25, textureHeightM: 3.75 });
		expect(second.semantic).toBeUndefined();
	});

	test('rejects unsupported version, reserved byte, widths, count, trailing and truncated rows', () => {
		const unsupportedVersion = buildMaterials(2); set8(unsupportedVersion, 0, 3);
		const reserved = buildMaterials(2); set8(reserved, 3, 1);
		const badStringWidth = buildMaterials(2); set8(badStringWidth, 1, 3);
		const badTextureWidth = buildMaterials(2); set8(badTextureWidth, 2, 3);
		const valid = buildMaterials(2);
		expect(() => parse(unsupportedVersion)).toThrow('material section version');
		expect(() => parse(reserved)).toThrow('material section reserved');
		expect(() => parse(badStringWidth)).toThrow('adaptive-width');
		expect(() => parse(badTextureWidth)).toThrow('adaptive-width');
		expect(() => parse(valid, 1)).toThrow('does not match the model count');
		expect(() => parse(concat(valid, Uint8Array.of(0)))).toThrow('material section byte count');
		expect(() => parse(valid.subarray(0, valid.length - 1))).toThrow(/material section byte count|truncated/);
	});

	test('rejects invalid codes even on rows that would otherwise be inactive', () => {
		const invalidType = buildMaterials(2); set8(invalidType, 42, 3);
		const invalidMode = buildMaterials(2); set8(invalidMode, 44, 3);
		expect(() => parse(invalidType)).toThrow('material 0 type code');
		expect(() => parse(invalidMode)).toThrow('material 0 colorize mode code');
	});

	test('requires complete valid metadata only for active type-2 rows', () => {
		const missingTexture = buildMaterials(2); set8(missingTexture, 24, 0xff);
		expect(() => parse(missingTexture)).toThrow('semantic material 0 texture reference is missing');

		const zeroHash = buildMaterials(2); zeroHash.fill(0, 94, 126);
		expect(() => parse(zeroHash)).toThrow('semantic material 0 output RGBA hash is zero');

		const badHue = buildMaterials(2); new DataView(badHue.buffer).setFloat64(46, 360.1, true);
		expect(() => parse(badHue)).toThrow('semantic material 0 HLS deltas');

		const nonFinite = buildMaterials(2); new DataView(nonFinite.buffer).setFloat64(46, Number.NaN, true);
		expect(() => parse(nonFinite)).toThrow('semantic material 0 HLS deltas');
	});

	test('preserves inactive metadata without validating its texture, deltas or hash', () => {
		const bytes = buildMaterials(2);
		set8(bytes, 42, 2); set8(bytes, 43, 1);
		set8(bytes, 24, 0xff);
		new DataView(bytes.buffer).setFloat64(46, Number.NaN, true);
		bytes.fill(0, 94, 126);
		set8(bytes, 44, 0);
		set8(bytes, 45, 1);
		const [first, second] = parse(bytes);
		expect(first.semantic).toMatchObject({ materialType: 2, colorizeMode: 0, outputRgbaSha256: '00'.repeat(32) });
		expect(Number.isNaN(first.semantic?.deltas[0])).toBe(true);
		expect(second.semantic?.materialType).toBe(1);
	});
});
