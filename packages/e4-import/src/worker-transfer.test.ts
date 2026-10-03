import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { packGeometryTransfer, prepareBomcWorkerTransfer } from './worker-transfer.js';
import { createTransferFingerprint, verifyTransferFingerprint } from '../../../tooling/performance/loader-transfer-proof.ts';

const SLAB_BYTES = 16 * 1024 * 1024;

describe('BOMC worker full-result transfer packing', () => {
	test('keeps cycles, repeated objects, repeated views, overlap, constructors and whole backing bytes', () => {
		const firstBacking = patternedBuffer(64, 17);
		const secondBacking = patternedBuffer(13, 91);
		const first = new Uint8Array(firstBacking, 6, 20);
		const overlap = new DataView(firstBacking, 11, 17);
		const floatView = new Float32Array(firstBacking, 24, 4);
		const independent = new Uint16Array(secondBacking, 4, 3);
		const shared = { first, overlap, repeated: first, floatView };
		const root: Record<string, unknown> = { shared, alias: shared, independent, views: [first, overlap, first] };
		root.self = root;
		const expectedFirstBacking = copyBytes(firstBacking);
		const expectedSecondBacking = copyBytes(secondBacking);
		const expectedFirstOffset = first.byteOffset;
		const expectedOverlapOffset = overlap.byteOffset;
		const expectedFloatOffset = floatView.byteOffset;
		const expectedIndependentOffset = independent.byteOffset;

		const packed = packGeometryTransfer(root, { retainedBuffers: new Set() });
		expect(packed.result).toBe(root);
		expect(root.alias).toBe(shared);
		expect(root.shared).toBe(shared);
		expect(root.self).toBe(root);
		expect(packed.stats.originalBufferCount).toBe(2);
		expect(packed.stats.originalBufferBytes).toBe(77);
		expect(packed.stats.packedBufferCount).toBe(1);
		expect(packed.stats.packedBufferBytes).toBe(77);
		expect(packed.stats.copiedBytes).toBe(77);
		expect(packed.stats.paddingBytes).toBe(0);
		expect(packed.stats.packedSmallOriginalCount).toBe(2);
		expect(Number.isFinite(packed.stats.packingMs)).toBe(true);

		const received = structuredClone(packed.result, { transfer: packed.transferList }) as typeof root;
		const receivedShared = received.shared as typeof shared;
		const receivedFirst = receivedShared.first;
		const receivedOverlap = receivedShared.overlap;
		const receivedFloat = receivedShared.floatView;
		const receivedIndependent = received.independent as Uint16Array;
		expect(received.self).toBe(received);
		expect(received.alias).toBe(received.shared);
		expect(receivedShared.repeated).toBe(receivedFirst);
		expect((received.views as unknown[])[0]).toBe(receivedFirst);
		expect((received.views as unknown[])[2]).toBe(receivedFirst);
		expect(receivedFirst.buffer).toBe(receivedOverlap.buffer);
		expect(receivedFirst.buffer).toBe(receivedFloat.buffer);
		expect(receivedFirst.byteOffset).toBe(expectedFirstOffset);
		expect(receivedOverlap.byteOffset - receivedFirst.byteOffset).toBe(expectedOverlapOffset - expectedFirstOffset);
		expect(receivedFloat.byteOffset - receivedFirst.byteOffset).toBe(expectedFloatOffset - expectedFirstOffset);
		expect(receivedIndependent.byteOffset).toBe(expectedIndependentOffset + 64);
		expect(receivedIndependent.buffer).toBe(receivedFirst.buffer);
		expect(receivedFirst.buffer.byteLength).toBe(77);
		expect(copyBytes(receivedFirst.buffer, 0, 64)).toEqual(expectedFirstBacking);
		expect(copyBytes(receivedFirst.buffer, 64, 13)).toEqual(expectedSecondBacking);
		expect(receivedIndependent.buffer).not.toBe(receivedFirst.buffer.slice(0, 0));
	});

	test('preserves every admitted built-in typed view and exact IEEE/BigInt payload bits', () => {
		const views: ArrayBufferView[] = [
			new Int8Array([-7, 2, 12]),
			new Uint8Array([1, 2, 250]),
			new Uint8ClampedArray([0, 128, 255]),
			new Int16Array([-3, 4, 900]),
			new Uint16Array([1, 2048, 65530]),
			new Int32Array([-90000, 7]),
			new Uint32Array([1, 0xfedcba98]),
			new Float32Array([Math.fround(-0), Math.fround(1 / 3)]),
			new Float64Array([-0, Number.NaN, Math.PI]),
			new BigInt64Array([-1n, 0x0102030405060708n]),
			new BigUint64Array([0n, 0xfedcba9876543210n]),
			new DataView(patternedBuffer(19, 33), 3, 12)
		];
		const expected = views.map((view) => ({ name: view.constructor.name, length: view.byteLength, bytes: copyViewBytes(view) }));
		const packed = packGeometryTransfer({ views }, { retainedBuffers: new Set() });
		const received = structuredClone(packed.result, { transfer: packed.transferList });
		const actualViews = received.views as ArrayBufferView[];
		expect(actualViews).toHaveLength(views.length);
		for (let index = 0; index < expected.length; index++) {
			expect(actualViews[index]!.constructor.name).toBe(expected[index]!.name);
			expect(actualViews[index]!.byteLength).toBe(expected[index]!.length);
			expect(copyViewBytes(actualViews[index]!)).toEqual(expected[index]!.bytes);
		}
		expect(Object.is((actualViews[8] as Float64Array)[0], -0)).toBe(true);
		expect(Number.isNaN((actualViews[8] as Float64Array)[1])).toBe(true);
		expect((actualViews[9] as BigInt64Array)[1]).toBe(0x0102030405060708n);
		expect((actualViews[10] as BigUint64Array)[1]).toBe(0xfedcba9876543210n);
	});

	test('uses exact-capacity slabs, starts a new slab at the boundary, and keeps a partial slab across direct buffers', () => {
		const almostCapacity = patternedBuffer(SLAB_BYTES - 1, 5);
		const oneByte = patternedBuffer(1, 77);
		const exactCapacity = patternedBuffer(SLAB_BYTES, 12);
		const overCapacity = patternedBuffer(SLAB_BYTES + 1, 22);
		const afterLarge = patternedBuffer(4, 199);
		const input = {
			almostCapacity: new Uint8Array(almostCapacity),
			oneByte: new Uint8Array(oneByte),
			exactCapacity: new Uint8Array(exactCapacity),
			overCapacity: new Uint8Array(overCapacity),
			afterLarge: new Uint8Array(afterLarge)
		};
		const expected = {
			almostCapacity: copyBytes(almostCapacity),
			oneByte: copyBytes(oneByte),
			exactCapacity: copyBytes(exactCapacity),
			overCapacity: copyBytes(overCapacity),
			afterLarge: copyBytes(afterLarge)
		};
		const packed = packGeometryTransfer(input, { retainedBuffers: new Set() });
		expect(packed.transferList.map((buffer) => buffer.byteLength)).toEqual([SLAB_BYTES - 1, 12, SLAB_BYTES, SLAB_BYTES + 1]);
		expect(packed.stats.packedSmallOriginalCount).toBe(3);
		expect(packed.stats.packedBufferCount).toBe(4);
		expect(packed.stats.packedBufferBytes).toBe(packed.stats.originalBufferBytes + packed.stats.paddingBytes);
		expect(packed.stats.paddingBytes).toBeLessThanOrEqual(7 * packed.stats.packedSmallOriginalCount);
		expect(packed.stats.copiedBytes).toBe((SLAB_BYTES - 1) + 1 + 4);

		const received = structuredClone(packed.result, { transfer: packed.transferList });
		expect(copyViewBytes(received.almostCapacity)).toEqual(expected.almostCapacity);
		expect(copyViewBytes(received.oneByte)).toEqual(expected.oneByte);
		expect(copyViewBytes(received.exactCapacity)).toEqual(expected.exactCapacity);
		expect(copyViewBytes(received.overCapacity)).toEqual(expected.overCapacity);
		expect(copyViewBytes(received.afterLarge)).toEqual(expected.afterLarge);
		expect(received.oneByte.buffer).toBe(received.afterLarge.buffer);
		expect(received.afterLarge.byteOffset).toBe(8);
		expect(received.exactCapacity.buffer.byteLength).toBe(SLAB_BYTES);
		expect(received.overCapacity.buffer.byteLength).toBe(SLAB_BYTES + 1);
	});

	test('packs ten thousand distinct four-byte arrays into one bounded transfer buffer', () => {
		const source = Array.from({ length: 10_000 }, (_, index) => {
			const view = new Uint32Array(1);
			view[0] = index * 17;
			return view;
		});
		const packed = packGeometryTransfer({ source }, { retainedBuffers: new Set() });
		expect(packed.stats.originalBufferCount).toBe(10_000);
		expect(packed.stats.originalBufferBytes).toBe(40_000);
		expect(packed.stats.packedSmallOriginalCount).toBe(10_000);
		expect(packed.stats.packedBufferCount).toBe(1);
		expect(packed.stats.packedBufferBytes).toBe(40_000 + packed.stats.paddingBytes);
		expect(packed.stats.paddingBytes).toBeLessThanOrEqual(70_000);
		const received = structuredClone(packed.result, { transfer: packed.transferList });
		expect(received.source).toHaveLength(10_000);
		expect(received.source[0]!.buffer).toBe(received.source[9_999]!.buffer);
		expect(received.source[0]![0]).toBe(0);
		expect(received.source[5_000]![0]).toBe(85_000);
		expect(received.source[9_999]![0]).toBe(169_983);
	});

	test('copies retained small and large storage while leaving retained buffers attached', () => {
		const small = patternedBuffer(32, 42);
		const large = patternedBuffer(SLAB_BYTES, 56);
		const smallBytes = copyBytes(small);
		const largeBytes = copyBytes(large);
		const input = { small: new Uint8Array(small, 3, 12), large: new Uint8Array(large, 8, 9) };
		const packed = packGeometryTransfer(input, { retainedBuffers: new Set([small, large]) });
		expect(packed.transferList).toHaveLength(2);
		expect(packed.transferList[0]!.byteLength).toBe(32);
		expect(packed.transferList[1]!.byteLength).toBe(SLAB_BYTES);
		expect(packed.stats.copiedBytes).toBe(32 + SLAB_BYTES);
		expect(packed.transferList).not.toContain(small);
		expect(packed.transferList).not.toContain(large);
		const received = structuredClone(packed.result, { transfer: packed.transferList });
		expect(small.byteLength).toBe(32);
		expect(large.byteLength).toBe(SLAB_BYTES);
		expect(copyBytes(small)).toEqual(smallBytes);
		expect(copyBytes(large)).toEqual(largeBytes);
		expect(received.small.buffer).not.toBe(small);
		expect(received.large.buffer).not.toBe(large);
		expect(copyBytes(received.small.buffer)).toEqual(smallBytes);
		expect(copyBytes(received.large.buffer)).toEqual(largeBytes);
	});

	test('keeps empty backing/view identities without transferring empties and preserves zero views at backing ends', () => {
		const retainedEmpty = new ArrayBuffer(0);
		const ordinaryEmpty = new ArrayBuffer(0);
		const nonempty = patternedBuffer(12, 8);
		const retainedView = new Uint8Array(retainedEmpty);
		const repeatedRetainedView = retainedView;
		const ordinaryView = new DataView(ordinaryEmpty, 0, 0);
		const repeatedOrdinaryView = new Uint8Array(ordinaryEmpty, 0, 0);
		const atEnd = new Uint8Array(nonempty, 12, 0);
		const packed = packGeometryTransfer({ retainedView, repeatedRetainedView, ordinaryView, repeatedOrdinaryView, atEnd }, { retainedBuffers: new Set([retainedEmpty]) });
		expect(packed.transferList).toHaveLength(1);
		expect(packed.transferList[0]!.byteLength).toBe(12);
		expect(packed.stats.originalBufferCount).toBe(1);
		expect(packed.stats.originalBufferBytes).toBe(12);
		expect(packed.result.retainedView.buffer).not.toBe(retainedEmpty);
		expect(packed.result.retainedView.buffer).toBe(packed.result.repeatedRetainedView.buffer);
		expect(packed.result.ordinaryView.buffer).toBe(ordinaryEmpty);
		expect(packed.result.ordinaryView.buffer).toBe(packed.result.repeatedOrdinaryView.buffer);
		const received = structuredClone(packed.result, { transfer: packed.transferList });
		expect(received.retainedView).toBe(received.repeatedRetainedView);
		expect(received.retainedView.buffer.byteLength).toBe(0);
		expect(received.ordinaryView.buffer).toBe(received.repeatedOrdinaryView.buffer);
		expect(received.ordinaryView.buffer).not.toBe(received.retainedView.buffer);
		expect(received.atEnd.byteOffset).toBe(12);
		expect(received.atEnd.byteLength).toBe(0);
		expect(received.atEnd.buffer.byteLength).toBe(12);
		expect(retainedEmpty.byteLength).toBe(0);
		expect(ordinaryEmpty.byteLength).toBe(0);
	});

	test('rejects unsupported graphs, accessors, subclasses and non-writable view slots without invoking getters', () => {
		const custom = new (class CustomView extends Uint8Array {})(4);
		const accessor = Object.defineProperty({}, 'view', { enumerable: true, get() { throw new Error('getter ran'); } });
		const readonly = Object.freeze({ view: new Uint8Array(4) });
		const unsupported: unknown[] = [
			{ buffer: new ArrayBuffer(4) },
			{ value: new Map() },
			{ value: new (class CustomObject {})() },
			{ value: () => 1 },
			{ value: Symbol('not data') },
			{ value: custom },
			accessor,
			readonly
		];
		if (typeof SharedArrayBuffer !== 'undefined') {
			unsupported.push({ value: new Uint8Array(new SharedArrayBuffer(8)) });
			unsupported.push({ value: new SharedArrayBuffer(8) });
		}
		for (const invalid of unsupported) expect(() => packGeometryTransfer(invalid, { retainedBuffers: new Set() })).toThrow(/^BOMC transfer invalid:/);
		if (typeof SharedArrayBuffer !== 'undefined') {
			expect(() => packGeometryTransfer({ value: new Uint8Array(new SharedArrayBuffer(8)) }, { retainedBuffers: new Set() })).toThrow(/^BOMC transfer invalid:/);
		}
	});

	test('rejects resizable ArrayBuffers when the runtime supports them', () => {
		const ResizableArrayBuffer = ArrayBuffer as unknown as new (length: number, options: { maxByteLength: number }) => ArrayBuffer & { resizable?: boolean };
		let buffer: ArrayBuffer & { resizable?: boolean };
		try { buffer = new ResizableArrayBuffer(8, { maxByteLength: 16 }); }
		catch { return; }
		if (buffer.resizable !== true) return;
		expect(() => packGeometryTransfer({ view: new Uint8Array(buffer) }, { retainedBuffers: new Set() })).toThrow(/^BOMC transfer invalid:/);
	});

	test('isolates source and overlapping/repeated full-result assets into exact independent buffers', () => {
		const source = patternedBuffer(SLAB_BYTES + 1, 31);
		const otherAssetBacking = patternedBuffer(10, 112);
		const sourceBefore = hashBuffer(source);
		const otherBefore = copyBytes(otherAssetBacking);
		const sharedAsset = new Uint8Array(source, 3, 4);
		const result = makeResult({
			geometry: new Uint8Array(source, 1, 20),
			additional: new Uint16Array(otherAssetBacking, 2, 3),
			assets: [
				{ path: 'a', bytes: sharedAsset },
				{ path: 'same-source-again', bytes: sharedAsset },
				{ path: 'overlap', bytes: new Uint8Array(source, 5, 3) },
				{ path: 'other-buffer', bytes: new Uint8Array(otherAssetBacking, 3, 2) },
				{ path: 'empty', bytes: new Uint8Array(0) }
			]
		});
		const originalAssets = result.appearance.assets;
		const originalAssetSnapshots = originalAssets.map((asset) => ({ path: asset.path, bytes: copyViewBytes(asset.bytes) }));
		const packed = prepareBomcWorkerTransfer(result, source);
		expect(result.appearance.assets).not.toBe(originalAssets);
		expect(result.appearance.assets).toHaveLength(5);
		expect(packed.transferList).toHaveLength(6);
		expect(new Set(packed.transferList).size).toBe(packed.transferList.length);
		expect(packed.transferList).not.toContain(source);
		expect(packed.transferList).not.toContain(otherAssetBacking);
		expect(result.diagnostics.workerTransfer?.version).toBe('bomc-packed-full-result-1');
		expect(result.diagnostics.workerTransfer?.geometry.originalBufferCount).toBe(2);
		expect(result.diagnostics.workerTransfer?.geometry.originalBufferBytes).toBe(SLAB_BYTES + 11);
		expect(result.diagnostics.workerTransfer?.geometry.packedBufferCount).toBe(2);
		expect(result.diagnostics.workerTransfer?.geometry.copiedBytes).toBe(SLAB_BYTES + 11);
		expect(result.diagnostics.workerTransfer?.assetBufferCount).toBe(4);
		expect(result.diagnostics.workerTransfer?.assetBytes).toBe(13);
		expect(result.diagnostics.workerTransfer?.totalTransferBufferCount).toBe(6);
		expect(result.diagnostics.workerTransfer?.totalTransferBytes).toBe(SLAB_BYTES + 24);
		expect(Number.isFinite(result.diagnostics.workerTransfer?.totalPackingMs)).toBe(true);
		const emptyAssetBuffer = result.appearance.assets.find((asset) => asset.path === 'empty')!.bytes.buffer;
		expect(packed.transferList).not.toContain(emptyAssetBuffer);
		const received = structuredClone(packed.result, { transfer: packed.transferList });
		expect(source.byteLength).toBe(SLAB_BYTES + 1);
		expect(otherAssetBacking.byteLength).toBe(10);
		expect(hashBuffer(source)).toBe(sourceBefore);
		expect(copyBytes(otherAssetBacking)).toEqual(otherBefore);
		expect(received.appearance.assets.map((asset) => asset.path)).toEqual(originalAssetSnapshots.map((asset) => asset.path));
		for (let index = 0; index < originalAssetSnapshots.length; index++) {
			const asset = received.appearance.assets[index]!;
			expect(asset.bytes.constructor).toBe(Uint8Array);
			expect(asset.bytes.byteOffset).toBe(0);
			expect(asset.bytes.buffer.byteLength).toBe(asset.bytes.byteLength);
			expect(copyViewBytes(asset.bytes)).toEqual(originalAssetSnapshots[index]!.bytes);
		}
		const assetBuffers = received.appearance.assets.map((asset) => asset.bytes.buffer);
		expect(new Set(assetBuffers).size).toBe(assetBuffers.length);
		const receivedSourceView = received.preparedRuntimeScene.geometry as Uint8Array;
		expect(receivedSourceView.byteOffset).toBe(1);
		expect(hashBuffer(receivedSourceView.buffer as ArrayBuffer)).toBe(sourceBefore);
	});

	test('restores the original asset array when geometry validation fails', () => {
		const assets = [{ path: 'keep', bytes: new Uint8Array([1, 2, 3]) }];
		const result = makeResult({ assets, invalid: new Map() });
		expect(() => prepareBomcWorkerTransfer(result, new ArrayBuffer(8))).toThrow(/^BOMC transfer invalid:/);
		expect(result.appearance.assets).toBe(assets);
	});

	test('real-transfer fingerprint rejects a changed byte and displaced original-view alias', () => {
		const backing = new Uint8Array([11, 22, 33, 44, 55, 66]).buffer;
		const first = new Uint8Array(backing, 0, 4);
		const overlap = new Uint8Array(backing, 2, 4);
		const root = { first, overlap, repeated: first, appearance: { assets: [{ path: 'test-asset', bytes: new Uint8Array([7, 8, 9]) }] }, diagnostics: {} };
		const inventory = createTransferFingerprint(root);
		const packed = prepareBomcWorkerTransfer(root as unknown as import('./types.js').AdaptedBomcResult, new ArrayBuffer(8));
		const received = structuredClone(packed.result, { transfer: packed.transferList });
		expect(verifyTransferFingerprint(received, inventory).viewCount).toBe(2);

		const changedByte = structuredClone(received);
		changedByte.first[0] ^= 0xff;
		expect(() => verifyTransferFingerprint(changedByte, inventory)).toThrow(/graph fingerprint changed/);

		const displacedAlias = structuredClone(received);
		displacedAlias.overlap = new Uint8Array([33, 44, 55, 66]);
		expect(() => verifyTransferFingerprint(displacedAlias, inventory)).toThrow(/views from original backing .* no longer share storage/);
	});
});

function makeResult(input: { assets: Array<{ path: string; bytes: Uint8Array }>; geometry?: unknown; additional?: unknown; invalid?: unknown }) {
	const preparedRuntimeScene: Record<string, unknown> = { meshes: [], groups: [], totalUnits: 0 };
	if (input.geometry !== undefined) preparedRuntimeScene.geometry = input.geometry;
	if (input.additional !== undefined) preparedRuntimeScene.additional = input.additional;
	if (input.invalid !== undefined) preparedRuntimeScene.invalid = input.invalid;
	return {
		version: 'test',
		profile: 'production',
		faces: [],
		preparedRuntimeScene,
		appearance: { materials: [], assets: input.assets },
		bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 } },
		materialRows: [],
		counts: { materials: 0, tags: 0, meshes: 0, faces: 0, definitions: 0, instances: 0, transforms: 0, textures: 0, edges: 0 },
		scenes: [],
		diagnostics: {}
	} as unknown as import('./types.js').AdaptedBomcResult;
}

function patternedBuffer(length: number, seed: number): ArrayBuffer {
	const buffer = new ArrayBuffer(length);
	const bytes = new Uint8Array(buffer);
	for (let index = 0; index < bytes.length; index++) bytes[index] = (seed + index * 29) & 0xff;
	return buffer;
}

function copyBytes(buffer: ArrayBuffer, byteOffset = 0, byteLength = buffer.byteLength - byteOffset): number[] {
	return Array.from(new Uint8Array(buffer, byteOffset, byteLength));
}

function copyViewBytes(view: ArrayBufferView): number[] {
	return Array.from(new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength));
}

function hashBuffer(buffer: ArrayBuffer): string {
	return createHash('sha256').update(new Uint8Array(buffer)).digest('hex');
}
