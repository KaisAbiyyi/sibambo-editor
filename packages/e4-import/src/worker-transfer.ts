import type { AdaptedBomcResult, BomcWorkerTransferDiagnostics, GeometryTransferStats } from './types.js';

export type { GeometryTransferStats } from './types.js';

const SMALL_SLAB_CAPACITY = 16 * 1024 * 1024;
const ALIGNMENT = 8;
const MAX_ERROR_PATH = 220;

type ViewKind = {
	name: string;
	prototype: object;
	bytesPerElement: number;
	make(buffer: ArrayBuffer, byteOffset: number, length: number): ArrayBufferView;
};

type ViewDetails = {
	kind: ViewKind;
	buffer: ArrayBuffer;
	byteOffset: number;
	byteLength: number;
	length: number;
};

type BufferRecord = {
	buffer: ArrayBuffer;
	byteLength: number;
	retained: boolean;
	outputBuffer?: ArrayBuffer;
	placement?: { kind: 'slab'; slabIndex: number; base: number } | { kind: 'large'; base: 0 } | { kind: 'empty'; base: 0 };
};

type ViewRecord = ViewDetails & { originalView: ArrayBufferView; originalBuffer: BufferRecord; path: string };
type SlabPlan = { usedBytes: number; placements: Map<ArrayBuffer, number> };
type WalkEntry = { value: unknown; path: string; parent?: object; key?: string };

const viewKinds: ViewKind[] = [
	{ name: 'Int8Array', prototype: Int8Array.prototype, bytesPerElement: 1, make: (buffer, offset, length) => new Int8Array(buffer, offset, length) },
	{ name: 'Uint8Array', prototype: Uint8Array.prototype, bytesPerElement: 1, make: (buffer, offset, length) => new Uint8Array(buffer, offset, length) },
	{ name: 'Uint8ClampedArray', prototype: Uint8ClampedArray.prototype, bytesPerElement: 1, make: (buffer, offset, length) => new Uint8ClampedArray(buffer, offset, length) },
	{ name: 'Int16Array', prototype: Int16Array.prototype, bytesPerElement: 2, make: (buffer, offset, length) => new Int16Array(buffer, offset, length) },
	{ name: 'Uint16Array', prototype: Uint16Array.prototype, bytesPerElement: 2, make: (buffer, offset, length) => new Uint16Array(buffer, offset, length) },
	{ name: 'Int32Array', prototype: Int32Array.prototype, bytesPerElement: 4, make: (buffer, offset, length) => new Int32Array(buffer, offset, length) },
	{ name: 'Uint32Array', prototype: Uint32Array.prototype, bytesPerElement: 4, make: (buffer, offset, length) => new Uint32Array(buffer, offset, length) },
	{ name: 'Float32Array', prototype: Float32Array.prototype, bytesPerElement: 4, make: (buffer, offset, length) => new Float32Array(buffer, offset, length) },
	{ name: 'Float64Array', prototype: Float64Array.prototype, bytesPerElement: 8, make: (buffer, offset, length) => new Float64Array(buffer, offset, length) },
	{ name: 'BigInt64Array', prototype: BigInt64Array.prototype, bytesPerElement: 8, make: (buffer, offset, length) => new BigInt64Array(buffer, offset, length) },
	{ name: 'BigUint64Array', prototype: BigUint64Array.prototype, bytesPerElement: 8, make: (buffer, offset, length) => new BigUint64Array(buffer, offset, length) },
	{ name: 'DataView', prototype: DataView.prototype, bytesPerElement: 1, make: (buffer, offset, length) => new DataView(buffer, offset, length) }
];

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBufferGetter = requiredGetter(typedArrayPrototype, 'buffer');
const typedArrayByteOffsetGetter = requiredGetter(typedArrayPrototype, 'byteOffset');
const typedArrayByteLengthGetter = requiredGetter(typedArrayPrototype, 'byteLength');
const typedArrayLengthGetter = requiredGetter(typedArrayPrototype, 'length');
const dataViewBufferGetter = requiredGetter(DataView.prototype, 'buffer');
const dataViewByteOffsetGetter = requiredGetter(DataView.prototype, 'byteOffset');
const dataViewByteLengthGetter = requiredGetter(DataView.prototype, 'byteLength');
const arrayBufferByteLengthGetter = requiredGetter(ArrayBuffer.prototype, 'byteLength');
const arrayBufferResizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const arrayBufferDetachedGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached')?.get;

function requiredGetter(prototype: object, name: string): (this: unknown) => unknown {
	const getter = Object.getOwnPropertyDescriptor(prototype, name)?.get;
	if (!getter) throw new Error(`BOMC transfer invalid: built-in ${name} getter is unavailable.`);
	return getter as (this: unknown) => unknown;
}

function fail(path: string, message: string): never {
	const boundedPath = path.length <= MAX_ERROR_PATH ? path : `${path.slice(0, 96)}…${path.slice(-96)}`;
	throw new TypeError(`BOMC transfer invalid: ${message} at ${boundedPath}.`);
}

function now(): number {
	const value = globalThis.performance?.now();
	if (!Number.isFinite(value) || value! < 0) fail('$', 'performance clock returned a non-finite value');
	return value!;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
	return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === ArrayBuffer.prototype;
}

function arrayBufferLength(buffer: ArrayBuffer, path: string): number {
	try {
		if (arrayBufferDetachedGetter?.call(buffer) === true) fail(path, 'detached ArrayBuffer is unsupported');
		if (arrayBufferResizableGetter?.call(buffer) === true) fail(path, 'resizable ArrayBuffer is unsupported');
		const length = arrayBufferByteLengthGetter.call(buffer);
		if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) fail(path, 'invalid ArrayBuffer length');
		return length;
	} catch (error) {
		if (error instanceof TypeError && error.message.startsWith('BOMC transfer invalid:')) throw error;
		fail(path, 'ArrayBuffer cannot be inspected');
	}
}

function viewKind(value: ArrayBufferView, path: string): ViewKind {
	let prototype: object | null;
	try { prototype = Object.getPrototypeOf(value) as object | null; }
	catch { return fail(path, 'view prototype cannot be inspected'); }
	const kind = viewKinds.find((candidate) => candidate.prototype === prototype);
	if (!kind) fail(path, 'typed-array subclass or unsupported view is not allowed');
	return kind;
}

function viewDetails(value: ArrayBufferView, path: string): ViewDetails {
	const kind = viewKind(value, path);
	try {
		const isDataView = kind.name === 'DataView';
		const rawBuffer = (isDataView ? dataViewBufferGetter : typedArrayBufferGetter).call(value);
		if (!isArrayBuffer(rawBuffer)) fail(path, 'view must use an ordinary ArrayBuffer');
		const buffer = rawBuffer as ArrayBuffer;
		const byteOffset = Number((isDataView ? dataViewByteOffsetGetter : typedArrayByteOffsetGetter).call(value));
		const byteLength = Number((isDataView ? dataViewByteLengthGetter : typedArrayByteLengthGetter).call(value));
		const length = Number(isDataView ? byteLength : typedArrayLengthGetter.call(value));
		const bufferBytes = arrayBufferLength(buffer, path);
		if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || !Number.isSafeInteger(byteLength) || byteLength < 0 || !Number.isSafeInteger(length) || length < 0) {
			fail(path, 'view has an invalid offset or length');
		}
		if (byteOffset + byteLength > bufferBytes) fail(path, 'view range exceeds its backing buffer');
		if (!Number.isSafeInteger(byteOffset + byteLength)) fail(path, 'view range exceeds the safe integer range');
		if (kind.name !== 'DataView' && byteLength !== length * kind.bytesPerElement) fail(path, 'typed-array byte length does not match its element length');
		return { kind, buffer, byteOffset, byteLength, length };
	} catch (error) {
		if (error instanceof TypeError && error.message.startsWith('BOMC transfer invalid:')) throw error;
		fail(path, 'view cannot be inspected');
	}
}

function isPlainContainer(value: object, path: string): value is Record<string, unknown> | unknown[] {
	let prototype: object | null;
	try { prototype = Object.getPrototypeOf(value) as object | null; }
	catch { return fail(path, 'object prototype cannot be inspected'); }
	if (Array.isArray(value)) {
		if (prototype !== Array.prototype) fail(path, 'array subclass is unsupported');
		return true;
	}
	if (prototype === Object.prototype || prototype === null) return true;
	fail(path, 'custom object is unsupported');
}

function propertyKeys(value: object, path: string): string[] {
	let keys: string[];
	try { keys = Object.keys(value); }
	catch { return fail(path, 'object keys cannot be inspected'); }
	if (Array.isArray(value)) {
		const numeric = keys.filter(isArrayIndexKey).sort((left, right) => Number(left) - Number(right));
		const remaining = keys.filter((key) => !isArrayIndexKey(key));
		return [...numeric, ...remaining];
	}
	return keys;
}

function isArrayIndexKey(key: string): boolean {
	const index = Number(key);
	return Number.isInteger(index) && index >= 0 && index < 0xffffffff && String(index) === key;
}

function childPath(parent: string, key: string, isArray: boolean): string {
	if (isArray && isArrayIndexKey(key)) return `${parent}[${key}]`;
	return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function align(value: number): number {
	return Math.ceil(value / ALIGNMENT) * ALIGNMENT;
}

function graphSlots(value: unknown): { buffers: BufferRecord[]; views: ViewRecord[]; rootView?: ArrayBufferView } {
	const buffersByIdentity = new Map<ArrayBuffer, BufferRecord>();
	const viewsByIdentity = new Map<ArrayBufferView, ViewRecord>();
	const buffers: BufferRecord[] = [];
	const views: ViewRecord[] = [];
	const seenPlain = new WeakSet<object>();
	const stack: WalkEntry[] = [{ value, path: '$' }];
	let rootView: ArrayBufferView | undefined;

	while (stack.length > 0) {
		const entry = stack.pop()!;
		const current = entry.value;
		if (current === null || current === undefined || typeof current === 'string' || typeof current === 'boolean' || typeof current === 'number' || typeof current === 'bigint') continue;
		if (typeof current === 'function') fail(entry.path, 'function value is unsupported');
		if (typeof current === 'symbol') fail(entry.path, 'symbol value is unsupported');
		if (typeof current !== 'object') fail(entry.path, `unsupported ${typeof current} value`);
		if (isArrayBuffer(current)) fail(entry.path, 'naked ArrayBuffer is unsupported');

		if (ArrayBuffer.isView(current)) {
			const existing = viewsByIdentity.get(current);
			if (!existing) {
				const details = viewDetails(current, entry.path);
				let originalBuffer = buffersByIdentity.get(details.buffer);
				if (!originalBuffer) {
					originalBuffer = {
						buffer: details.buffer,
						byteLength: arrayBufferLength(details.buffer, entry.path),
						retained: false
					};
					buffersByIdentity.set(details.buffer, originalBuffer);
					buffers.push(originalBuffer);
				}
				const record: ViewRecord = { ...details, originalView: current, originalBuffer, path: entry.path };
				viewsByIdentity.set(current, record);
				views.push(record);
			}
			if (entry.parent && entry.key !== undefined) {
				const descriptor = Object.getOwnPropertyDescriptor(entry.parent, entry.key);
				if (!descriptor || !('value' in descriptor) || descriptor.value !== current) fail(entry.path, 'view slot changed during validation');
				if (descriptor.writable !== true) fail(entry.path, 'view slot is not writable');
			} else if (!entry.parent) {
				rootView = current;
			}
			continue;
		}

		if (seenPlain.has(current)) continue;
		seenPlain.add(current);
		if (!isPlainContainer(current, entry.path)) continue;
		const keys = propertyKeys(current, entry.path);
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index]!;
			const path = childPath(entry.path, key, Array.isArray(current));
			let descriptor: PropertyDescriptor | undefined;
			try { descriptor = Object.getOwnPropertyDescriptor(current, key); }
			catch { fail(path, 'property descriptor cannot be inspected'); }
			if (!descriptor || !('value' in descriptor)) fail(path, 'accessor field is unsupported');
			stack.push({ value: descriptor.value, path, parent: current, key });
		}
	}
	return { buffers, views, rootView };
}

export function packGeometryTransfer<T>(value: T, options: { retainedBuffers: ReadonlySet<ArrayBuffer> }): {
	result: T;
	transferList: ArrayBuffer[];
	stats: GeometryTransferStats;
} {
	const startedAt = now();
	const retainedBuffers = options?.retainedBuffers;
	if (!retainedBuffers || typeof retainedBuffers.has !== 'function') fail('$', 'retainedBuffers must be a ReadonlySet');
	const graph = graphSlots(value);
	for (const record of graph.buffers) record.retained = retainedBuffers.has(record.buffer);

	const slabPlans: SlabPlan[] = [];
	let currentSlabIndex = -1;
	let currentSlabUsed = 0;
	let originalBufferBytes = 0;
	let packedSmallOriginalCount = 0;

	for (const record of graph.buffers) {
		if (record.byteLength === 0) {
			record.placement = { kind: 'empty', base: 0 };
			continue;
		}
		originalBufferBytes += record.byteLength;
		if (!Number.isSafeInteger(originalBufferBytes)) fail('$', 'geometry backing-byte total exceeds the safe integer range');
		if (record.byteLength >= SMALL_SLAB_CAPACITY) {
			record.placement = { kind: 'large', base: 0 };
			continue;
		}

		if (currentSlabIndex < 0) {
			currentSlabIndex = slabPlans.length;
			slabPlans.push({ usedBytes: 0, placements: new Map() });
			currentSlabUsed = 0;
		}
		let base = align(currentSlabUsed);
		if (base + record.byteLength > SMALL_SLAB_CAPACITY) {
			currentSlabIndex = slabPlans.length;
			slabPlans.push({ usedBytes: 0, placements: new Map() });
			currentSlabUsed = 0;
			base = 0;
		}
		const plan = slabPlans[currentSlabIndex]!;
		plan.placements.set(record.buffer, base);
		currentSlabUsed = base + record.byteLength;
		plan.usedBytes = currentSlabUsed;
		record.placement = { kind: 'slab', slabIndex: currentSlabIndex, base };
		packedSmallOriginalCount++;
	}

	const slabBuffers = slabPlans.map((plan, index) => {
		if (plan.usedBytes <= 0 || plan.usedBytes > SMALL_SLAB_CAPACITY) fail(`$slab[${index}]`, 'invalid planned slab length');
		return new ArrayBuffer(plan.usedBytes);
	});
	let copiedBytes = 0;
	for (const record of graph.buffers) {
		const placement = record.placement!;
		if (placement.kind === 'empty') {
			record.outputBuffer = record.retained ? new ArrayBuffer(0) : record.buffer;
			continue;
		}
		if (placement.kind === 'slab') {
			const output = slabBuffers[placement.slabIndex]!;
			new Uint8Array(output, placement.base, record.byteLength).set(new Uint8Array(record.buffer, 0, record.byteLength));
			record.outputBuffer = output;
			copiedBytes += record.byteLength;
			continue;
		}
		if (record.retained) {
			const output = new ArrayBuffer(record.byteLength);
			new Uint8Array(output).set(new Uint8Array(record.buffer, 0, record.byteLength));
			record.outputBuffer = output;
			copiedBytes += record.byteLength;
		} else {
			record.outputBuffer = record.buffer;
		}
	}

	const transferList: ArrayBuffer[] = [...slabBuffers];
	for (const record of graph.buffers) {
		if (record.byteLength > 0 && record.byteLength >= SMALL_SLAB_CAPACITY) transferList.push(record.outputBuffer!);
	}
	const transferSet = new Set(transferList);
	if (transferSet.size !== transferList.length) fail('$', 'duplicate buffer in transfer list');
	for (const buffer of transferList) {
		if (arrayBufferLength(buffer, '$transferList') === 0) fail('$transferList', 'empty buffer cannot be transferred');
		if (retainedBuffers.has(buffer)) fail('$transferList', 'retained source or asset buffer cannot be transferred');
	}

	const viewReplacements = new Map<ArrayBufferView, ArrayBufferView>();
	for (const record of graph.views) {
		const placement = record.originalBuffer.placement!;
		const base = placement.kind === 'slab' ? placement.base : 0;
		const outputBuffer = record.originalBuffer.outputBuffer!;
		const outputView = record.kind.make(outputBuffer, base + record.byteOffset, record.length);
		viewReplacements.set(record.originalView, outputView);
	}

	let rootResult: unknown = value;
	if (graph.rootView) rootResult = viewReplacements.get(graph.rootView)!;
	const seenForRewrite = new WeakSet<object>();
	const rewriteStack: WalkEntry[] = [{ value: rootResult, path: '$' }];
	while (rewriteStack.length > 0) {
		const entry = rewriteStack.pop()!;
		const current = entry.value;
		if (current === null || typeof current !== 'object' || ArrayBuffer.isView(current) || isArrayBuffer(current)) continue;
		if (seenForRewrite.has(current)) continue;
		seenForRewrite.add(current);
		if (!isPlainContainer(current, entry.path)) continue;
		const keys = propertyKeys(current, entry.path);
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index]!;
			const path = childPath(entry.path, key, Array.isArray(current));
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (!descriptor || !('value' in descriptor)) fail(path, 'field changed after graph validation');
			const child = descriptor.value;
			if (ArrayBuffer.isView(child)) {
				const replacement = viewReplacements.get(child);
				if (replacement) {
					if (descriptor.writable !== true) fail(path, 'view slot is not writable');
					(current as Record<string, unknown>)[key] = replacement;
				}
			} else {
				rewriteStack.push({ value: child, path, parent: current, key });
			}
		}
	}

	for (const record of graph.views) {
		const outputView = viewReplacements.get(record.originalView)!;
		const outputDetails = viewDetails(outputView, record.path);
		if (retainedBuffers.has(outputDetails.buffer)) fail(record.path, 'output view aliases a retained source or asset buffer');
		if (outputDetails.byteLength > 0 && !transferSet.has(outputDetails.buffer)) fail(record.path, 'nonempty output view is absent from the transfer list');
	}

	const packedBufferBytes = transferList.reduce((sum, buffer) => sum + arrayBufferLength(buffer, '$transferList'), 0);
	const paddingBytes = packedBufferBytes - originalBufferBytes;
	if (!Number.isSafeInteger(packedBufferBytes) || !Number.isSafeInteger(copiedBytes) || !Number.isSafeInteger(paddingBytes)) fail('$', 'geometry transfer statistics exceed the safe integer range');
	if (paddingBytes < 0 || paddingBytes > 7 * packedSmallOriginalCount) fail('$', 'geometry packing padding exceeds the alignment bound');
	const elapsed = now() - startedAt;
	if (!Number.isFinite(elapsed) || elapsed < 0) fail('$', 'geometry packing duration is invalid');
	const stats: GeometryTransferStats = {
		originalBufferCount: graph.buffers.filter((record) => record.byteLength > 0).length,
		originalBufferBytes,
		packedBufferCount: transferList.length,
		packedBufferBytes,
		packedSmallOriginalCount,
		copiedBytes,
		paddingBytes,
		packingMs: elapsed
	};
	return { result: rootResult as T, transferList, stats };
}

function ownDataValue(object: object, key: string, path: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (!descriptor || !('value' in descriptor)) fail(path, 'accessor or missing field is unsupported');
	return descriptor.value;
}

function assertNoRetainedViewBuffers(value: unknown, retainedBuffers: ReadonlySet<ArrayBuffer>): void {
	const stack: WalkEntry[] = [{ value, path: '$' }];
	const seen = new WeakSet<object>();
	while (stack.length > 0) {
		const entry = stack.pop()!;
		const current = entry.value;
		if (current === null || typeof current !== 'object') continue;
		if (ArrayBuffer.isView(current)) {
			const details = viewDetails(current, entry.path);
			if (retainedBuffers.has(details.buffer)) fail(entry.path, 'complete result still references retained storage');
			continue;
		}
		if (isArrayBuffer(current)) fail(entry.path, 'naked ArrayBuffer is unsupported');
		if (seen.has(current)) continue;
		seen.add(current);
		if (!isPlainContainer(current, entry.path)) continue;
		const keys = propertyKeys(current, entry.path);
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index]!;
			const path = childPath(entry.path, key, Array.isArray(current));
			stack.push({ value: ownDataValue(current, key, path), path });
		}
	}
}

export function prepareBomcWorkerTransfer(result: AdaptedBomcResult, sourceBuffer: ArrayBuffer): {
	result: AdaptedBomcResult;
	transferList: ArrayBuffer[];
} {
	const totalStartedAt = now();
	const appearance = ownDataValue(result, 'appearance', '$.appearance');
	if (appearance === null || typeof appearance !== 'object' || Array.isArray(appearance) || !isPlainContainer(appearance, '$.appearance')) {
		fail('$.appearance', 'appearance must be a plain object');
	}
	const assetsDescriptor = Object.getOwnPropertyDescriptor(appearance, 'assets');
	if (!assetsDescriptor || !('value' in assetsDescriptor) || assetsDescriptor.writable !== true || !Array.isArray(assetsDescriptor.value) || Object.getPrototypeOf(assetsDescriptor.value) !== Array.prototype) {
		fail('$.appearance.assets', 'assets must be a writable plain array');
	}
	if (!isArrayBuffer(sourceBuffer)) fail('$.sourceBuffer', 'source must be an ordinary ArrayBuffer');
	const sourceBytes = arrayBufferLength(sourceBuffer, '$.sourceBuffer');
	void sourceBytes;

	const originalAssets = assetsDescriptor.value as Array<{ path: string; bytes: Uint8Array }>;
	const retainedBuffers = new Set<ArrayBuffer>([sourceBuffer]);
	const isolatedAssets: Array<{ path: string; bytes: Uint8Array }> = [];
	let assetBytes = 0;
	for (let index = 0; index < originalAssets.length; index++) {
		const assetPath = `$.appearance.assets[${index}]`;
		const originalAsset = originalAssets[index] as unknown;
		if (originalAsset === null || typeof originalAsset !== 'object' || Array.isArray(originalAsset) || !isPlainContainer(originalAsset, assetPath)) {
			fail(assetPath, 'asset must be a plain object');
		}
		const path = ownDataValue(originalAsset, 'path', `${assetPath}.path`);
		const bytes = ownDataValue(originalAsset, 'bytes', `${assetPath}.bytes`);
		if (typeof path !== 'string') fail(`${assetPath}.path`, 'asset path must be a string');
		if (!(bytes instanceof Uint8Array) || Object.getPrototypeOf(bytes) !== Uint8Array.prototype) fail(`${assetPath}.bytes`, 'asset bytes must be a built-in Uint8Array');
		const details = viewDetails(bytes, `${assetPath}.bytes`);
		retainedBuffers.add(details.buffer);
		assetBytes += details.byteLength;
		if (!Number.isSafeInteger(assetBytes)) fail('$.appearance.assets', 'asset byte total exceeds the safe integer range');
		const ownedBytes = new Uint8Array(details.byteLength);
		if (details.byteLength > 0) ownedBytes.set(new Uint8Array(details.buffer, details.byteOffset, details.byteLength));
		isolatedAssets.push({ path, bytes: ownedBytes });
	}

	let completed = false;
	try {
		appearance.assets = [];
		const packed = packGeometryTransfer(result, { retainedBuffers });
		appearance.assets = isolatedAssets;
		const transferList = [...packed.transferList];
		const transferSet = new Set(transferList);
		let assetBufferCount = 0;
		for (const asset of isolatedAssets) {
			const details = viewDetails(asset.bytes, '$.appearance.assets.bytes');
			if (details.byteOffset !== 0 || details.buffer.byteLength !== details.byteLength) fail('$.appearance.assets', 'isolated asset must use exact offset-zero storage');
			if (details.byteLength === 0) continue;
			assetBufferCount++;
			if (retainedBuffers.has(details.buffer)) fail('$.appearance.assets', 'isolated asset aliases retained storage');
			if (transferSet.has(details.buffer)) fail('$.appearance.assets', 'asset transfer buffer duplicates geometry storage');
			transferSet.add(details.buffer);
			transferList.push(details.buffer);
		}
		assertNoRetainedViewBuffers(packed.result, retainedBuffers);
		const totalTransferBytes = transferList.reduce((sum, buffer) => sum + arrayBufferLength(buffer, '$transferList'), 0);
		if (!Number.isSafeInteger(totalTransferBytes)) fail('$transferList', 'total transfer bytes exceed the safe integer range');
		const totalPackingMs = now() - totalStartedAt;
		if (!Number.isFinite(totalPackingMs) || totalPackingMs < 0) fail('$', 'total packing duration is invalid');
		const diagnostics: BomcWorkerTransferDiagnostics = {
			version: 'bomc-packed-full-result-1',
			geometry: packed.stats,
			assetBufferCount,
			assetBytes,
			totalTransferBufferCount: transferList.length,
			totalTransferBytes,
			totalPackingMs
		};
		const resultDiagnostics = ownDataValue(packed.result, 'diagnostics', '$.diagnostics');
		if (resultDiagnostics === null || typeof resultDiagnostics !== 'object' || Array.isArray(resultDiagnostics) || !isPlainContainer(resultDiagnostics, '$.diagnostics')) {
			fail('$.diagnostics', 'diagnostics must be a plain object');
		}
		(resultDiagnostics as Record<string, unknown>).workerTransfer = diagnostics;
		completed = true;
		return { result: packed.result, transferList };
	} finally {
		if (!completed) appearance.assets = originalAssets;
	}
}
