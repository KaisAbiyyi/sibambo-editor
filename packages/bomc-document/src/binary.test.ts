import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { align8, assembleContainer, BinaryReader, BinaryWriter, crc32, indexWidth, loadSection, parseDirectory, readVaruint, readZigzag, writeVaruint, writeZigzag } from './binary.js';
import { BomcDocumentError } from './document.js';

describe('BOMC binary primitives', () => {
	test('uses standard CRC32 and the locked adaptive-width sentinels', () => {
		expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
		expect([0, 255, 256, 65535, 65536].map(indexWidth)).toEqual([1, 1, 2, 2, 4]);
		expect(align8(32)).toBe(32);
		expect(align8(33)).toBe(40);
	});

	test('round-trips large varuint and zigzag deltas without 32-bit truncation', () => {
		const writer = new BinaryWriter();
		for (const value of [0, 127, 128, 16384, 0xffffffff, Number.MAX_SAFE_INTEGER]) writeVaruint(writer, value);
		for (const value of [-4_294_967_294, -0xffffffff, -65536, -1, 0, 1, 65536, 0xffffffff, 4_294_967_294]) writeZigzag(writer, value);
		const reader = new BinaryReader(writer.finish());
		for (const value of [0, 127, 128, 16384, 0xffffffff, Number.MAX_SAFE_INTEGER]) expect(readVaruint(reader)).toBe(value);
		for (const value of [-4_294_967_294, -0xffffffff, -65536, -1, 0, 1, 65536, 0xffffffff, 4_294_967_294]) expect(readZigzag(reader)).toBe(value);
		expect(reader.remaining).toBe(0);
	});

	test('enforces exact STORE and DEFLATE raw lengths after validating stored checksums', async () => {
		const raw = new Uint8Array([1, 2, 3]);
		const storedMismatch = assembleContainer([{ type: 2, codec: 0, rawLength: 2, count: 1, bytes: raw }]);
		const storeSection = parseDirectory(storedMismatch, 'web-core').sections[0]!;
		await expect(loadSection(storedMismatch, storeSection)).rejects.toThrow(BomcDocumentError);

		const compressed = new Uint8Array(deflateSync(raw));
		for (const declaredLength of [2, 4]) {
			const deflated = assembleContainer([{ type: 2, codec: 1, rawLength: declaredLength, count: 1, bytes: compressed }]);
			const section = parseDirectory(deflated, 'web-core').sections[0]!;
			await expect(loadSection(deflated, section)).rejects.toThrow(BomcDocumentError);
		}
	});

	test('web-core rejects nonzero padding and trailing bytes while source-envelope retains them', () => {
		const file = assembleContainer([
			{ type: 2, codec: 0, rawLength: 1, count: 1, bytes: new Uint8Array([1]) },
			{ type: 3, codec: 0, rawLength: 1, count: 1, bytes: new Uint8Array([2]) }
		]);
		const parsed = parseDirectory(file, 'web-core');
		const padded = new Uint8Array(file);
		padded[parsed.sections[0]!.offset + parsed.sections[0]!.storedLength] = 0x7f;
		expect(() => parseDirectory(padded, 'web-core')).toThrow(BomcDocumentError);
		expect(parseDirectory(padded, 'source-envelope').sections).toHaveLength(2);
		const trailing = new Uint8Array([...file, 0x55]);
		expect(() => parseDirectory(trailing, 'web-core')).toThrow(BomcDocumentError);
		expect(parseDirectory(trailing, 'source-envelope').sections).toHaveLength(2);
	});

	test('assembles the exact compact 1.2 web profile and rejects corruption before decode', async () => {
		const raw = new Uint8Array([1, 2, 3, 4]);
		const file = assembleContainer([{ type: 2, codec: 0, rawLength: raw.length, count: 1, bytes: raw }]);
		const parsed = parseDirectory(file, 'web-core');
		expect(parsed.header.flags).toBe(0x11);
		expect(parsed.header.directoryOffset).toBe(32);
		expect(parsed.sections[0]).toMatchObject({ type: 2, codec: 0, offset: 56, storedLength: 4, rawLength: 4, count: 1 });
		expect(await loadSection(file, parsed.sections[0]!)).toEqual(raw);
		const corrupt = new Uint8Array(file); corrupt[56] ^= 0xff;
		expect(() => parseDirectory(corrupt, 'web-core')).toThrow(BomcDocumentError);
	});

	test('rejects duplicate section types and integer overflow instead of switching wire formats', () => {
		const one = new Uint8Array([1]);
		expect(() => assembleContainer([
			{ type: 2, codec: 0, rawLength: 1, count: 1, bytes: one },
			{ type: 2, codec: 0, rawLength: 1, count: 1, bytes: one }
		])).toThrow(BomcDocumentError);
		expect(() => indexWidth(0x1_0000_0000)).toThrow(BomcDocumentError);
	});
});
