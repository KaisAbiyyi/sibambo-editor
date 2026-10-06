import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { crc32, parseDirectory } from './binary.js';
import { BomcDocumentError } from './document.js';
import { retainBomcSource } from './source-envelope.js';
import { readWebBomc } from './reader.js';

const sourceFixtures = [
	['S1-new', 'D:/projects/sibambo/skps/model-eval-exports/PROJECT SBOOST 1__SIBAMBO-BOMC-v1.2.0__EXACT.bomc', 2_428_754, 'd306fb89c0a59edf5ecdbcaf26d27e795e521cceb1c689e59958e1038932918c'],
	['S2-new', 'D:/projects/sibambo/skps/model-eval-exports/PROJECT SBOOST 2__SIBAMBO-BOMC-v1.2.0__EXACT.bomc', 2_319_634, 'df19a9f07df845661d065b98b221dbcfc53e9ec2c3efe7a11f434b7fcb0ac452']
] as const;

function envelope(wide: boolean, badCrc = false) {
	const payload = new Uint8Array([0x78, 0x9c, 0x03]);
	const descriptorBytes = wide ? 40 : 24;
	const dataOffset = wide ? 72 : 64;
	const paddingBytes = dataOffset - (32 + descriptorBytes);
	const trailing = new Uint8Array([0xa5, 0x5a]);
	const bytes = new Uint8Array(dataOffset + payload.length + trailing.length);
	bytes.set([0x42, 0x4f, 0x4d, 0x43, 0x0d, 0x0a, 0x1a, 0x0a]);
	const view = new DataView(bytes.buffer);
	view.setUint16(8, 1, true); view.setUint16(10, 2, true); view.setUint32(12, 0x01020304, true);
	view.setUint32(16, wide ? 0x07 : 0x77, true); view.setUint32(20, 1, true); view.setBigUint64(24, 32n, true);
	view.setUint16(32, 65000, true); view.setUint8(34, 3); view.setUint8(35, 0x81);
	if (wide) {
		view.setBigUint64(36, BigInt(dataOffset), true); view.setBigUint64(44, BigInt(payload.length), true); view.setBigUint64(52, 9n, true);
		view.setUint32(60, 7, true); view.setUint32(64, badCrc ? crc32(payload) ^ 1 : crc32(payload), true); view.setUint32(68, 0, true);
	} else {
		view.setUint32(36, dataOffset, true); view.setUint32(40, payload.length, true); view.setUint32(44, 9, true);
		view.setUint32(48, 7, true); view.setUint32(52, badCrc ? crc32(payload) ^ 1 : crc32(payload), true);
	}
	bytes.fill(0x3c, 56, 56 + paddingBytes);
	bytes.set(payload, dataOffset); bytes.set(trailing, dataOffset + payload.length);
	return bytes;
}

describe('unchanged source-byte envelope', () => {
	for (const [name, path, expectedLength, expectedHash] of sourceFixtures) test(`retains ${name} without turning it into editable web-core`, async () => {
		const bytes = new Uint8Array(await readFile(path));
		expect(bytes.byteLength).toBe(expectedLength);
		expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedHash);
		const retained = retainBomcSource(bytes);
		bytes[0] ^= 0xff;
		const copy = retained.copyUnchanged();
		expect(createHash('sha256').update(copy).digest('hex')).toBe(expectedHash);
		const validCopy = new Uint8Array(copy);
		copy[0] ^= 0xff;
		expect(createHash('sha256').update(retained.copyUnchanged()).digest('hex')).toBe(expectedHash);
		retained.dispose(); retained.dispose();
		expect(() => retained.copyUnchanged()).toThrow(BomcDocumentError);
		await expect(readWebBomc(validCopy)).rejects.toMatchObject({ code: expect.any(String) });
	});

	test('accepts unknown codecs, flags, nonzero padding, trailing bytes, and a wide source directory unchanged', () => {
		for (const wide of [false, true]) {
			const input = envelope(wide);
			const retained = retainBomcSource(input);
			expect(retained.header.directoryEntryBytes).toBe(wide ? 40 : 24);
			expect(retained.sections[0]).toMatchObject({ type: 65000, codec: 3, flags: 0x81, count: 7 });
			expect(retained.copyUnchanged()).toEqual(input);
			expect(parseDirectory(retained.copyUnchanged(), 'source-envelope').sections[0]!.rawLength).toBe(9);
		}
	});

	test('rejects a bad stored checksum and truncated, overlapping, or duplicate descriptors', () => {
		expect(() => retainBomcSource(envelope(false, true))).toThrow(BomcDocumentError);
		const valid = envelope(false);
		const truncated = valid.slice(0, 52);
		expect(() => retainBomcSource(truncated)).toThrow(BomcDocumentError);
		const overlap = new Uint8Array(valid); new DataView(overlap.buffer).setUint32(36, 32, true);
		expect(() => retainBomcSource(overlap)).toThrow(BomcDocumentError);
		const duplicate = new Uint8Array(valid);
		const view = new DataView(duplicate.buffer); view.setUint32(20, 2, true);
		const extended = new Uint8Array(duplicate.length + 24); extended.set(duplicate);
		const extView = new DataView(extended.buffer); extView.setUint16(56, 65000, true); extView.setUint8(58, 3); extView.setUint8(59, 0);
		extView.setUint32(60, 64, true); extView.setUint32(64, 0, true); extView.setUint32(68, 0, true); extView.setUint32(72, 7, true); extView.setUint32(76, 0, true);
		expect(() => retainBomcSource(extended)).toThrow(BomcDocumentError);
	});
});
