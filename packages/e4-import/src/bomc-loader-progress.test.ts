import { describe, expect, test } from 'bun:test';
import { BomcLoader } from './bomc-loader.js';
import { crc32 } from './container.js';
import { BOMC_MAGIC, BOMC_SECTION } from './types.js';
import type { GeometryPreparationProgress } from '@sibambo/scene-runtime';

describe('BOMC Solid preparation progress', () => {
	test('forwards preparation phases through the importer callback and retains timing', async () => {
		const progress: GeometryPreparationProgress[] = [];
		const result = await new BomcLoader().load(buildBomc(2), 'research-progress.bomc', {
			prepareSolid: true,
			callbacks: { onSolidPreparationProgress: (item) => progress.push(item) }
		});

		expect(progress.length).toBeGreaterThan(0);
		expect(progress.some((item) => item.phase === 'solid-indices')).toBe(true);
		expect(result.diagnostics.timings.solidResolverMs).toBeGreaterThanOrEqual(0);
		expect(result.preparedRuntimeScene.solidCoplanarResolution).toBeDefined();
	});

	test('keeps Exact geometry unprepared even when Solid preparation is requested', async () => {
		const progress: GeometryPreparationProgress[] = [];
		const result = await new BomcLoader().load(buildBomc(1), 'exact-progress.bomc', {
			prepareSolid: true,
			callbacks: { onSolidPreparationProgress: (item) => progress.push(item) }
		});

		expect(progress).toEqual([]);
		expect(result.preparedRuntimeScene.solidCoplanarResolution).toBeUndefined();
		expect(result.preparedRuntimeScene.groups[0].solidIndices).toBeUndefined();
	});
});

type Section = { type: number; bytes: Uint8Array; count: number };

function buildBomc(profile: 1 | 2) {
	const strings = stringSection(['model', 'tiny.bomc']);
	const positions = positionBlock(packF32([0, 0, 0, 2, 0, 0, 0, 2, 0]));
	const topology = concat(Uint8Array.of(1, 0, 0, 0), packU32([3, 3, 3, 3]), varuint(0), varuint(2), varuint(2), varuint(0), varuint(2), varuint(2));
	const model = concat(Uint8Array.of(1, 1, 1, 5), packU32([0]), packF64([0, 0, 0, 2, 2, 0]), packU32([0, 0, 1, 1, 1, 1, 1, 0, 0]), Uint8Array.of(1, 0));
	const meshes = concat(Uint8Array.of(1, 1, 0, 0), packU32([1]), Uint8Array.of(0), ...[
		[3], [0], [1], [0], [0], [0], [positions.length], [0], [topology.length], [0], [0]
	].map(packU32));
	const faces = concat(
		Uint8Array.of(1, 1, 1, 1), packU32([1, 1, 1, 1, 1]),
		Uint8Array.of(2), Uint8Array.of(0), Uint8Array.of(2),
		Uint8Array.of(0xff), Uint8Array.of(0xff), Uint8Array.of(0xff), Uint8Array.of(0xff),
		Uint8Array.of(1), Uint8Array.of(3), Uint8Array.of(3)
	);
	const definitions = concat(Uint8Array.of(1, 1, 1, 0), packU32([1]), Uint8Array.of(0), Uint8Array.of(1), Uint8Array.of(0));
	const instances = concat(
		Uint8Array.of(1, 1, 1, 1, 1, 1, 0, 0), packU32([1]),
		Uint8Array.of(0), Uint8Array.of(1), Uint8Array.of(0xff), Uint8Array.of(0), Uint8Array.of(0),
		Uint8Array.of(0xff), Uint8Array.of(0xff), Uint8Array.of(1), Uint8Array.of(0), Uint8Array.of(0xff)
	);
	const contract = new Uint8Array(76);
	const contractView = new DataView(contract.buffer);
	contractView.setUint16(0, 1, true);
	contractView.setUint8(2, profile);
	contractView.setBigUint64(4, 0n, true);
	contractView.setFloat64(12, 0, true);
	contractView.setFloat64(20, 0, true);
	contractView.setBigUint64(28, 0n, true);
	contractView.setFloat64(36, 0.0005, true);
	contractView.setFloat64(44, 0.1, true);
	contractView.setFloat64(52, 0.0001, true);
	contractView.setFloat64(60, 0.00001, true);
	contractView.setUint8(68, profile === 1 ? 1 : 2);
	contractView.setUint8(69, 1);
	contractView.setUint8(70, 1);
	contractView.setUint8(71, 1);
	contractView.setUint32(72, 1, true);

	return toArrayBuffer(encodeContainer([
		{ type: BOMC_SECTION.MODEL, bytes: model, count: 1 },
		{ type: BOMC_SECTION.STRINGS, bytes: strings, count: 2 },
		{ type: BOMC_SECTION.MESHES, bytes: meshes, count: 1 },
		{ type: BOMC_SECTION.FACES, bytes: faces, count: 1 },
		{ type: BOMC_SECTION.POSITIONS, bytes: positions, count: 1 },
		{ type: BOMC_SECTION.TOPOLOGY, bytes: topology, count: 1 },
		{ type: BOMC_SECTION.NORMALS, bytes: genericCodec(3, packF64([0, 0, 1])), count: 1 },
		{ type: BOMC_SECTION.DEFINITIONS, bytes: definitions, count: 1 },
		{ type: BOMC_SECTION.INSTANCES, bytes: instances, count: 1 },
		{ type: BOMC_SECTION.TRANSFORMS, bytes: genericCodec(5, Uint8Array.of(0)), count: 1 },
		{ type: BOMC_SECTION.COVERAGE, bytes: packU32([1, 1, 0, 0, 0, 0]), count: 1 },
		{ type: BOMC_SECTION.ENCODING_CONTRACT, bytes: contract, count: 1 }
	]));
}

function encodeContainer(sections: Section[]) {
	const rows = [...sections].sort((left, right) => left.type - right.type).map((section) => ({ ...section, offset: 0 }));
	const entryBytes = 24;
	let cursor = align8(32 + rows.length * entryBytes);
	for (const row of rows) { row.offset = cursor; cursor = align8(cursor + row.bytes.length); }
	const output = new Uint8Array(cursor);
	output.set(BOMC_MAGIC);
	const view = new DataView(output.buffer);
	view.setUint16(8, 1, true); view.setUint16(10, 2, true); view.setUint32(12, 0x01020304, true);
	view.setUint32(16, 0x11, true); view.setUint32(20, rows.length, true); view.setBigUint64(24, 32n, true);
	rows.forEach((row, index) => {
		let at = 32 + index * entryBytes;
		view.setUint16(at, row.type, true); at += 2;
		view.setUint8(at++, 0); view.setUint8(at++, 0);
		view.setUint32(at, row.offset, true); at += 4;
		view.setUint32(at, row.bytes.length, true); at += 4;
		view.setUint32(at, row.bytes.length, true); at += 4;
		view.setUint32(at, row.count, true); at += 4;
		view.setUint32(at, crc32(row.bytes), true);
		output.set(row.bytes, row.offset);
	});
	return output;
}

function stringSection(values: string[]) {
	const encoded = values.map((value) => new TextEncoder().encode(value));
	const offsets = [0];
	encoded.forEach((value) => offsets.push(offsets[offsets.length - 1] + value.length));
	return concat(Uint8Array.of(1, 0, 0, 0), packU32([values.length, offsets[offsets.length - 1]]), packU32(offsets), ...encoded);
}

function positionBlock(payload: Uint8Array) {
	return concat(Uint8Array.of(1, 2, 0, 0), packU32([3, payload.length]), packF64([0, 0, 0]), packF64([0, 0, 0]), payload);
}

function genericCodec(codec: number, payload: Uint8Array) {
	return concat(Uint8Array.of(1, codec, 0, 0), packU32([1, payload.length]), payload);
}

function toArrayBuffer(bytes: Uint8Array) {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function align8(value: number) { return Math.ceil(value / 8) * 8; }
function concat(...arrays: Uint8Array[]) {
	const result = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0));
	let offset = 0;
	for (const array of arrays) { result.set(array, offset); offset += array.length; }
	return result;
}
function pack(values: number[], bytes: number, setValue: (view: DataView, offset: number, value: number) => void) {
	const result = new Uint8Array(values.length * bytes);
	const view = new DataView(result.buffer);
	values.forEach((value, index) => setValue(view, index * bytes, value));
	return result;
}
const packU32 = (values: number[]) => pack(values, 4, (view, offset, value) => view.setUint32(offset, value, true));
const packF32 = (values: number[]) => pack(values, 4, (view, offset, value) => view.setFloat32(offset, value, true));
const packF64 = (values: number[]) => pack(values, 8, (view, offset, value) => view.setFloat64(offset, value, true));
function varuint(value: number) {
	const bytes: number[] = [];
	do { let byte = value & 0x7f; value = Math.floor(value / 128); if (value) byte |= 0x80; bytes.push(byte); } while (value);
	return Uint8Array.from(bytes);
}
