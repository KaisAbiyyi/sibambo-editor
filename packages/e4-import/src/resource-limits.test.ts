import { deflateSync } from 'node:zlib';
import { describe, expect, test } from 'bun:test';
import { decodeNormalSection, decodePositionBlock, decodeTopologyBlock, decodeTransformSection, decodeUvBlock } from './codecs';
import { buildMeshEdgeAdjacency, createSceneVisibilityIndex, decodeEdges, decodeScenes, decodeTextures } from './bomc-loader';
import { BomcContainer, crc32 } from './container';
import { BOMC_MAGIC } from './types';

describe('BOMC structural validation', () => {
	test('stops DEFLATE output at the declared byte boundary and accepts exact output', async () => {
		const expanded = new Uint8Array(64).fill(65);
		const compressed = new Uint8Array(deflateSync(expanded));
		const overflow = new BomcContainer(buildContainer([{ type: 1, stored: compressed, rawLength: 8, codec: 1 }]));
		await expect(overflow.load(1)).rejects.toThrow(/declared raw size/);

		const exact = new BomcContainer(buildContainer([{ type: 1, stored: compressed, rawLength: 64, codec: 1 }]));
		expect(await exact.load(1)).toEqual(expanded);
	});

	test('validates counted payload lengths before typed-array allocation', () => {
		expect(() => decodeNormalSection(genericHeader(1, 2))).toThrow(/normal codec payload size/);
		expect(() => decodeTransformSection(genericHeader(1, 2))).toThrow(/transform codec payload size/);
		expect(() => decodePositionBlock(positionHeader(2))).toThrow(/position codec payload size/);
	});

	test('checks transform variants and cross-table counts before output allocation', () => {
		const identities = decodeTransformSection(genericHeader(0, 2), 2).transforms;
		expect(identities).toHaveLength(32);
		expect(() => decodeTransformSection(genericHeader(0, 2), 1)).toThrow(/does not match the model count/);

		const invalidHybrid = genericHeader(5, 1, Uint8Array.of(9));
		expect(() => decodeTransformSection(invalidHybrid)).toThrow(/hybrid transform subtype 9/);
		expect(() => decodePositionBlock(positionHeader(2), 1)).toThrow(/does not match the model count/);
		expect(() => decodeTopologyBlock(topologyHeader(2, 0), 1, 0)).toThrow(/does not match the model count/);

		const unsupportedPosition = positionHeader(0);
		unsupportedPosition[1] = 9;
		expect(() => decodePositionBlock(unsupportedPosition)).toThrow(/unsupported position codec 9/);
		const unsupportedUv = new Uint8Array(44);
		unsupportedUv.set([1, 9, 0, 0]);
		expect(() => decodeUvBlock(unsupportedUv)).toThrow(/unsupported UV codec 9/);
	});

	test('rejects non-finite decoded transforms and normals', () => {
		const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
		matrix[12] = Number.NaN;
		expect(() => decodeTransformSection(genericHeader(6, 1, packF64(matrix)))).toThrow(/non-finite value/);
		expect(() => decodeNormalSection(genericHeader(1, 1, packF32([0, Number.NaN, 1])))).toThrow(/non-finite normal value/);
		expect(() => decodeNormalSection(genericHeader(3, 1, packF64([1e300, 0, 1])))).toThrow(/non-finite normal value/);
	});

	test('indexes scene visibility overrides by scene', () => {
		const scene = (visibilitySignature: string) => ({
			visibilitySignature,
			visibility: {
				hiddenFaceIndices: [5], visibleFaceIndices: [], hiddenEdgeIndices: [], visibleEdgeIndices: [],
				hiddenTagIndices: [], visibleTagIndices: []
			}
		}) as never;
		const scenes = [scene('scene-a'), scene('scene-b')];
		const visibilityIndex = createSceneVisibilityIndex(scenes);
		expect(visibilityIndex.byScene.get(scenes[0])?.hiddenFaceIndices.has(5)).toBe(true);
		expect(visibilityIndex.hasFaceOverrides).toBe(true);
	});

	test('deduplicates edge-face adjacency without Array membership scans', () => {
		const faces = Array.from({ length: 64 }, (_, globalIndex) => ({
			globalIndex,
			outer: Uint32Array.of(0, 1, 2),
			holes: [],
			triangles: Uint32Array.of(0, 1, 2)
		}));
		const mesh = { faces } as unknown as Parameters<typeof buildMeshEdgeAdjacency>[0];
		const edge = { first: 0, second: 1 } as Parameters<typeof buildMeshEdgeAdjacency>[1][number];
		const originalIncludes = Array.prototype.includes;
		let usedArrayIncludes = false;
		const patchedIncludes = function(this: unknown[], value: unknown, fromIndex?: number) {
			usedArrayIncludes = true;
			return originalIncludes.call(this, value, fromIndex);
		} as typeof Array.prototype.includes;
		let adjacency: Uint32Array[];
		Array.prototype.includes = patchedIncludes;
		try {
			adjacency = buildMeshEdgeAdjacency(mesh, [edge]);
		} finally {
			Array.prototype.includes = originalIncludes;
		}
		expect(usedArrayIncludes).toBe(false);
		expect([...adjacency![0]]).toEqual(Array.from({ length: 64 }, (_, index) => index));
	});

	test('rejects edge payloads that cannot contain two endpoints per row', () => {
		const edgeBytes = concat(Uint8Array.of(1, 1, 0, 0), packU32([1, 1]), Uint8Array.of(0xff, 0, 0));
		expect(() => decodeEdges(edgeBytes, [], [], 0, 1)).toThrow(/endpoint count exceeds encoded payload/);
	});

	test('rejects scene override counts that exceed bytes available before iterating', () => {
		const sceneBytes = minimalSceneWithShortHiddenNodes(2);
		expect(() => decodeScenes(sceneBytes, ['scene'], [], [])).toThrow(/hidden node count exceeds the remaining section data/);
	});

	test('resolves clip-plane stable and source IDs through the index', () => {
		const strings = ['scene', 'name', '', 'visibility-signature', 'active-plane'];
		const sceneBytes = scenesWithActivePlaneIds(1, 4, 5, 0x220);
		const scopedPlanes = [
			{ index: 0, stableId: 'active-plane', sourcePersistentId: 'other-stable', ownerDefinitionId: 'definition', ownerInstanceId: null },
			{ index: 1, stableId: 'other-source', sourcePersistentId: 'active-plane', ownerDefinitionId: 'definition', ownerInstanceId: null }
		] as never[];
		const [stableIdScene] = decodeScenes(sceneBytes, strings, [], [], 0, 0, [scopedPlanes[0]] as never[]);
		const [sourceIdScene] = decodeScenes(sceneBytes, strings, [], [], 0, 0, [scopedPlanes[1]] as never[]);
		expect(stableIdScene.sectionState.renderingSupport).toBe('metadata-only');
		expect(sourceIdScene.sectionState.renderingSupport).toBe('metadata-only');

		const [unscopedScene] = decodeScenes(sceneBytes, strings, [], [], 0, 0, [{
			index: 0, stableId: 'active-plane', sourcePersistentId: 'other-stable', ownerDefinitionId: null, ownerInstanceId: null
		}] as never[]);
		expect(unscopedScene.sectionState.renderingSupport).toBe('full');
	});

	test('retains non-JCM texture slices without copying their blob buffer', async () => {
		const blobBytes = Uint8Array.of(7, 8, 9);
		const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', blobBytes));
		const tableBytes = concat(
			Uint8Array.of(1, 0, 0, 0), packU32([1]), Uint8Array.of(1), packU32([1, 1]), hash, packU64([0, blobBytes.byteLength])
		);
		const [texture] = await decodeTextures(tableBytes, blobBytes, { expectedCount: 1 });
		expect(texture.bytes.buffer).toBe(blobBytes.buffer);
		expect(texture.bytes.byteOffset).toBe(blobBytes.byteOffset);
		expect(texture.bytes).toEqual(blobBytes);
	});
});

type EncodedSection = { type: number; stored: Uint8Array; rawLength: number; codec: number };

function buildContainer(sections: EncodedSection[]) {
	const directoryBytes = sections.length * 24;
	let cursor = align8(32 + directoryBytes);
	const rows = sections.map((section) => {
		const row = { ...section, offset: cursor };
		cursor = align8(cursor + section.stored.byteLength);
		return row;
	});
	const bytes = new Uint8Array(cursor);
	bytes.set(BOMC_MAGIC);
	const view = new DataView(bytes.buffer);
	view.setUint16(8, 1, true);
	view.setUint16(10, 2, true);
	view.setUint32(12, 0x01020304, true);
	view.setUint32(16, 0x11, true);
	view.setUint32(20, rows.length, true);
	view.setBigUint64(24, 32n, true);
	rows.forEach((row, index) => {
		let offset = 32 + index * 24;
		view.setUint16(offset, row.type, true); offset += 2;
		view.setUint8(offset++, row.codec);
		view.setUint8(offset++, 0);
		view.setUint32(offset, row.offset, true); offset += 4;
		view.setUint32(offset, row.stored.byteLength, true); offset += 4;
		view.setUint32(offset, row.rawLength, true); offset += 4;
		view.setUint32(offset, 0, true); offset += 4;
		view.setUint32(offset, crc32(row.stored), true);
		bytes.set(row.stored, row.offset);
	});
	return bytes.buffer;
}

function genericHeader(codec: number, count: number, payload = new Uint8Array(0)) {
	const bytes = new Uint8Array(12 + payload.byteLength);
	bytes.set([1, codec, 0, 0]);
	new DataView(bytes.buffer).setUint32(4, count, true);
	new DataView(bytes.buffer).setUint32(8, payload.byteLength, true);
	bytes.set(payload, 12);
	return bytes;
}

function positionHeader(count: number, codec = 1) {
	const bytes = new Uint8Array(60);
	bytes.set([1, codec, 0, 0]);
	new DataView(bytes.buffer).setUint32(4, count, true);
	return bytes;
}

function topologyHeader(loopCount: number, triangleCount: number) {
	const bytes = new Uint8Array(20);
	bytes.set([1, 0, 0, 0]);
	new DataView(bytes.buffer).setUint32(4, loopCount, true);
	new DataView(bytes.buffer).setUint32(8, triangleCount, true);
	return bytes;
}

function minimalSceneWithShortHiddenNodes(hiddenCount: number) {
	const bytes = new Uint8Array(6 + 68 + 2);
	bytes[0] = 1;
	bytes[1] = 0;
	new DataView(bytes.buffer).setUint32(2, 1, true);
	const sceneStart = 6;
	for (let index = 0; index < 4; index += 1) new DataView(bytes.buffer).setUint32(sceneStart + index * 4, 0, true);
	for (let index = 0; index < 12; index += 1) new DataView(bytes.buffer).setFloat32(sceneStart + 20 + index * 4, index === 10 ? 1 : 0, true);
	bytes[sceneStart + 68] = hiddenCount;
	bytes[sceneStart + 69] = 0;
	return bytes;
}

function scenesWithActivePlaneIds(sceneCount: number, planeStringIndex: number, version = 4, flags = 0) {
	const planeIndexBytes = encodeVaruint(planeStringIndex);
	const rowBytes = 68 + 14 + planeIndexBytes.byteLength + (version >= 5 ? 1 : 0);
	const bytes = new Uint8Array(6 + sceneCount * rowBytes);
	bytes[0] = version;
	new DataView(bytes.buffer).setUint32(2, sceneCount, true);
	let offset = 6;
	for (let sceneIndex = 0; sceneIndex < sceneCount; sceneIndex += 1) {
		for (const value of [sceneIndex, sceneCount, sceneCount + 1, sceneCount + 2, flags]) {
			new DataView(bytes.buffer).setUint32(offset, value, true);
			offset += 4;
		}
		offset += 12 * 4;
		for (let countIndex = 0; countIndex < 14; countIndex += 1) bytes[offset++] = countIndex === 13 ? 1 : 0;
		bytes.set(planeIndexBytes, offset);
		offset += planeIndexBytes.byteLength;
		if (version >= 5) bytes[offset++] = 0;
	}
	return bytes;
}

function encodeVaruint(value: number) {
	const result: number[] = [];
	do {
		let byte = value & 0x7f;
		value = Math.floor(value / 128);
		if (value) byte |= 0x80;
		result.push(byte);
	} while (value);
	return Uint8Array.from(result);
}

function packU64(values: number[]) {
	const bytes = new Uint8Array(values.length * 8);
	const view = new DataView(bytes.buffer);
	values.forEach((value, index) => view.setBigUint64(index * 8, BigInt(value), true));
	return bytes;
}

function packU32(values: number[]) {
	const bytes = new Uint8Array(values.length * 4);
	const view = new DataView(bytes.buffer);
	values.forEach((value, index) => view.setUint32(index * 4, value, true));
	return bytes;
}

function packF32(values: number[]) {
	const bytes = new Uint8Array(values.length * 4);
	const view = new DataView(bytes.buffer);
	values.forEach((value, index) => view.setFloat32(index * 4, value, true));
	return bytes;
}

function packF64(values: number[]) {
	const bytes = new Uint8Array(values.length * 8);
	const view = new DataView(bytes.buffer);
	values.forEach((value, index) => view.setFloat64(index * 8, value, true));
	return bytes;
}

function concat(...parts: Uint8Array[]) {
	const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
	return bytes;
}

function align8(value: number) { return Math.ceil(value / 8) * 8; }
