import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BomcLoader } from '../../packages/e4-import/src/bomc-loader.ts';
import { prepareBomcWorkerTransfer } from '../../packages/e4-import/src/worker-transfer.ts';
import type { AdaptedBomcResult } from '../../packages/e4-import/src/types.ts';
import { prepareApplicationRenderScene } from '../../packages/scene-runtime/src/application-preparation.ts';

const FILE = fileURLToPath(import.meta.url);
const EDITOR_ROOT = path.resolve(path.dirname(FILE), '../..');
const MANIFEST_RELATIVE = 'tooling/performance/fixtures.json';
const MANIFEST_SHA256 = 'dd87a9556e00d92265a622f46170d2fbad7f27d19595fea34d3d338757d51aed';
const MAX_GEOMETRY_TRANSFERS = 16;
const MAX_ASSET_TRANSFERS = 43;
const FIXTURES = {
	'L-old': {
		bytes: 17_202_790,
		sha256: 'ec35fe0ce92a8c72d9bc317990515d023f01e264fbfac8ff972ba682fca2f098'
	},
	'S2-new': {
		bytes: 2_319_634,
		sha256: 'df19a9f07df845661d065b98b221dbcfc53e9ec2c3efe7a11f434b7fcb0ac452'
	}
} as const;

type FixtureManifest = {
	schemaVersion: string;
	plan: string;
	fixtures: Array<{ id: string; locator: string; bytes: number; sha256: string }>;
};

type FingerprintView = {
	distinctViewId: number;
	objectId: number;
	path: string;
	backingId: number;
	constructor: string;
	byteOffset: number;
	byteLength: number;
	length: number;
};

type FingerprintBacking = {
	backingId: number;
	byteLength: number;
	sha256: string;
	representativePath: string;
	representativeViewId: number;
	representativeByteOffset: number;
};

type FingerprintAsset = {
	index: number;
	path: string;
	constructor: string;
	byteOffset: number;
	byteLength: number;
	viewSha256: string;
	backingId: number;
	backingByteLength: number;
	backingSha256: string;
};

export type TransferFingerprint = {
	version: 'bomc-transfer-fingerprint-1';
	graphSha256: string;
	objectCount: number;
	viewCount: number;
	backings: FingerprintBacking[];
	views: FingerprintView[];
	assets: FingerprintAsset[];
};

type FingerprintRuntime = {
	views: Array<{ view: ArrayBufferView; buffer: ArrayBuffer }>;
	backings: ArrayBuffer[];
};

const fingerprintRuntime = new WeakMap<TransferFingerprint, FingerprintRuntime>();

type ViewSpec = {
	name: string;
	prototype: object;
	dataView: boolean;
	bytesPerElement: number;
};

type ViewInfo = {
	spec: ViewSpec;
	buffer: ArrayBuffer;
	byteOffset: number;
	byteLength: number;
	length: number;
};

type WalkEntry = { value: unknown; path: string };

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const viewSpecs: ViewSpec[] = [
	{ name: 'Int8Array', prototype: Int8Array.prototype, dataView: false, bytesPerElement: 1 },
	{ name: 'Uint8Array', prototype: Uint8Array.prototype, dataView: false, bytesPerElement: 1 },
	{ name: 'Uint8ClampedArray', prototype: Uint8ClampedArray.prototype, dataView: false, bytesPerElement: 1 },
	{ name: 'Int16Array', prototype: Int16Array.prototype, dataView: false, bytesPerElement: 2 },
	{ name: 'Uint16Array', prototype: Uint16Array.prototype, dataView: false, bytesPerElement: 2 },
	{ name: 'Int32Array', prototype: Int32Array.prototype, dataView: false, bytesPerElement: 4 },
	{ name: 'Uint32Array', prototype: Uint32Array.prototype, dataView: false, bytesPerElement: 4 },
	{ name: 'Float32Array', prototype: Float32Array.prototype, dataView: false, bytesPerElement: 4 },
	{ name: 'Float64Array', prototype: Float64Array.prototype, dataView: false, bytesPerElement: 8 },
	{ name: 'BigInt64Array', prototype: BigInt64Array.prototype, dataView: false, bytesPerElement: 8 },
	{ name: 'BigUint64Array', prototype: BigUint64Array.prototype, dataView: false, bytesPerElement: 8 },
	{ name: 'DataView', prototype: DataView.prototype, dataView: true, bytesPerElement: 1 }
];
const getter = (prototype: object, name: string) => {
	const value = Object.getOwnPropertyDescriptor(prototype, name)?.get;
	if (!value) throw new Error(`Transfer proof requires the built-in ${name} getter.`);
	return value as (this: unknown) => unknown;
};
const typedBuffer = getter(typedArrayPrototype, 'buffer');
const typedOffset = getter(typedArrayPrototype, 'byteOffset');
const typedBytes = getter(typedArrayPrototype, 'byteLength');
const typedLength = getter(typedArrayPrototype, 'length');
const dataBuffer = getter(DataView.prototype, 'buffer');
const dataOffset = getter(DataView.prototype, 'byteOffset');
const dataBytes = getter(DataView.prototype, 'byteLength');
const arrayBufferBytes = getter(ArrayBuffer.prototype, 'byteLength');

function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function bufferLength(buffer: ArrayBuffer): number {
	const length = Number(arrayBufferBytes.call(buffer));
	if (!Number.isSafeInteger(length) || length < 0) throw new Error('Transfer proof encountered an invalid ArrayBuffer.');
	return length;
}

function hashBuffer(buffer: ArrayBuffer, byteOffset = 0, byteLength = bufferLength(buffer)): string {
	if (!Number.isSafeInteger(byteOffset) || !Number.isSafeInteger(byteLength) || byteOffset < 0 || byteLength < 0 || byteOffset + byteLength > bufferLength(buffer)) {
		throw new Error('Transfer proof buffer range is invalid.');
	}
	return sha256(new Uint8Array(buffer, byteOffset, byteLength));
}

function viewInfo(view: ArrayBufferView, pathLabel: string): ViewInfo {
	let prototype: object | null;
	try { prototype = Object.getPrototypeOf(view) as object | null; }
	catch { throw new Error(`Transfer proof cannot inspect view prototype at ${pathLabel}.`); }
	const spec = viewSpecs.find((candidate) => candidate.prototype === prototype);
	if (!spec) throw new Error(`Transfer proof found an unsupported view at ${pathLabel}.`);
	try {
		const buffer = (spec.dataView ? dataBuffer : typedBuffer).call(view) as ArrayBuffer;
		const byteOffset = Number((spec.dataView ? dataOffset : typedOffset).call(view));
		const byteLength = Number((spec.dataView ? dataBytes : typedBytes).call(view));
		const length = Number(spec.dataView ? byteLength : typedLength.call(view));
		if (!(buffer instanceof ArrayBuffer) || ![byteOffset, byteLength, length].every(Number.isSafeInteger) || byteOffset < 0 || byteLength < 0 || length < 0 || byteOffset + byteLength > bufferLength(buffer)) {
			throw new Error(`Transfer proof found an invalid view range at ${pathLabel}.`);
		}
		if (!spec.dataView && byteLength !== length * spec.bytesPerElement) throw new Error(`Transfer proof found inconsistent typed-array length at ${pathLabel}.`);
		return { spec, buffer, byteOffset, byteLength, length };
	} catch (cause) {
		if (cause instanceof Error && cause.message.startsWith('Transfer proof')) throw cause;
		throw new Error(`Transfer proof cannot inspect view at ${pathLabel}.`);
	}
}

function isArrayIndexKey(key: string): boolean {
	const index = Number(key);
	return Number.isInteger(index) && index >= 0 && index < 0xffff_ffff && String(index) === key;
}

function orderedKeys(value: object): string[] {
	const keys = Object.keys(value);
	if (!Array.isArray(value)) return keys;
	const numeric = keys.filter(isArrayIndexKey).sort((left, right) => Number(left) - Number(right));
	return [...numeric, ...keys.filter((key) => !isArrayIndexKey(key))];
}

function isPlain(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return Array.isArray(value) ? prototype === Array.prototype : prototype === Object.prototype || prototype === null;
}

function isSkipped(pathLabel: string, key: string): boolean {
	return (pathLabel === '$.appearance' && key === 'assets') || (pathLabel === '$.diagnostics' && key === 'workerTransfer');
}

function appendToken(hash: ReturnType<typeof createHash>, tag: string, value = ''): void {
	hash.update(tag);
	hash.update(String(value.length));
	hash.update(':');
	hash.update(value);
	hash.update(';');
}

function appendExactString(hash: ReturnType<typeof createHash>, value: string): void {
	hash.update(`s${value.length}:`);
	const chunk = Buffer.allocUnsafe(Math.min(8192, Math.max(2, value.length * 2)));
	let used = 0;
	for (let index = 0; index < value.length; index += 1) {
		chunk.writeUInt16LE(value.charCodeAt(index), used);
		used += 2;
		if (used === chunk.byteLength || index === value.length - 1) {
			hash.update(chunk.subarray(0, used));
			used = 0;
		}
	}
	hash.update(';');
}

function appendNumber(hash: ReturnType<typeof createHash>, value: number): void {
	const bytes = Buffer.allocUnsafe(8);
	bytes.writeDoubleLE(value, 0);
	hash.update('n');
	hash.update(bytes);
	hash.update(';');
}

function childPath(parent: string, key: string, array: boolean): string {
	if (array && isArrayIndexKey(key)) return `${parent}[${key}]`;
	return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function snapshotAssets(value: unknown): { assets: FingerprintAsset[]; backingRecords: FingerprintBacking[]; views: ArrayBufferView[] } {
	if (value === null || typeof value !== 'object') throw new Error('Transfer proof result has no appearance object.');
	const appearanceDescriptor = Object.getOwnPropertyDescriptor(value, 'appearance');
	if (!appearanceDescriptor || !('value' in appearanceDescriptor) || appearanceDescriptor.value === null || typeof appearanceDescriptor.value !== 'object') {
		throw new Error('Transfer proof result has no data-valued appearance object.');
	}
	const assetsDescriptor = Object.getOwnPropertyDescriptor(appearanceDescriptor.value, 'assets');
	if (!assetsDescriptor || !('value' in assetsDescriptor) || !Array.isArray(assetsDescriptor.value)) throw new Error('Transfer proof appearance.assets is not a data-valued array.');
	const backingsByBuffer = new Map<ArrayBuffer, number>();
	const backingRecords: FingerprintBacking[] = [];
	const views: ArrayBufferView[] = [];
	const assets = (assetsDescriptor.value as Array<{ path: string; bytes: Uint8Array }>).map((asset, index) => {
		if (!asset || typeof asset !== 'object' || typeof asset.path !== 'string' || !ArrayBuffer.isView(asset.bytes)) throw new Error(`Transfer proof asset ${index} has an invalid shape.`);
		const details = viewInfo(asset.bytes, `$.appearance.assets[${index}].bytes`);
		views.push(asset.bytes);
		const byteLength = bufferLength(details.buffer);
		let backingId = backingsByBuffer.get(details.buffer);
		if (backingId === undefined) {
			backingId = backingRecords.length;
			backingsByBuffer.set(details.buffer, backingId);
			backingRecords.push({
				backingId,
				byteLength,
				sha256: hashBuffer(details.buffer),
				representativePath: `$.appearance.assets[${index}].bytes`,
				representativeViewId: index,
				representativeByteOffset: details.byteOffset
			});
		}
		return {
			index,
			path: asset.path,
			constructor: details.spec.name,
			byteOffset: details.byteOffset,
			byteLength: details.byteLength,
			viewSha256: hashBuffer(details.buffer, details.byteOffset, details.byteLength),
			backingId,
			backingByteLength: byteLength,
			backingSha256: backingRecords[backingId]!.sha256
		};
	});
	return { assets, backingRecords, views };
}

/** Capture a deterministic, non-serialized inventory for the native-transfer proof. */
export function createTransferFingerprint(result: unknown): TransferFingerprint {
	const hash = createHash('sha256');
	const objectIds = new WeakMap<object, number>();
	const backingIds = new Map<ArrayBuffer, number>();
	const backingBuffers: ArrayBuffer[] = [];
	const backings: FingerprintBacking[] = [];
	const viewIds = new WeakMap<ArrayBufferView, number>();
	const views: FingerprintView[] = [];
	const viewRefs: Array<{ view: ArrayBufferView; buffer: ArrayBuffer }> = [];
	const seenObjects = new WeakSet<object>();
	const stack: WalkEntry[] = [{ value: result, path: '$' }];
	let nextObjectId = 0;
	let objectCount = 0;
	let nextViewId = 0;
	appendToken(hash, 'fingerprint-version', 'bomc-transfer-fingerprint-1');

	while (stack.length > 0) {
		const entry = stack.pop()!;
		const current = entry.value;
		if (current === null) { appendToken(hash, 'null'); continue; }
		if (current === undefined) { appendToken(hash, 'undefined'); continue; }
		if (typeof current === 'string') { appendExactString(hash, current); continue; }
		if (typeof current === 'boolean') { appendToken(hash, current ? 'true' : 'false'); continue; }
		if (typeof current === 'number') { appendNumber(hash, current); continue; }
		if (typeof current === 'bigint') { appendToken(hash, 'bigint', current.toString(10)); continue; }
		if (typeof current === 'function' || typeof current === 'symbol') throw new Error(`Transfer proof found an unsupported value at ${entry.path}.`);
		if (typeof current !== 'object') throw new Error(`Transfer proof found an unsupported ${typeof current} value at ${entry.path}.`);

		const priorId = objectIds.get(current);
		if (priorId !== undefined) { appendToken(hash, 'reference', String(priorId)); continue; }
		const objectId = nextObjectId++;
		objectCount += 1;
		objectIds.set(current, objectId);

		if (ArrayBuffer.isView(current)) {
			const details = viewInfo(current, entry.path);
			let backingId = backingIds.get(details.buffer);
			if (backingId === undefined) {
				backingId = backings.length;
				backingIds.set(details.buffer, backingId);
				backingBuffers.push(details.buffer);
				const distinctViewId = nextViewId;
				backings.push({
					backingId,
					byteLength: bufferLength(details.buffer),
					sha256: hashBuffer(details.buffer),
					representativePath: entry.path,
					representativeViewId: distinctViewId,
					representativeByteOffset: details.byteOffset
				});
			}
			const distinctViewId = nextViewId++;
			viewIds.set(current, distinctViewId);
			views.push({
				distinctViewId,
				objectId,
				path: entry.path,
				backingId,
				constructor: details.spec.name,
				byteOffset: details.byteOffset,
				byteLength: details.byteLength,
				length: details.length
			});
			viewRefs.push({ view: current, buffer: details.buffer });
			appendToken(hash, 'view', `${objectId}:${details.spec.name}:${details.length}:${details.byteLength}`);
			hash.update(new Uint8Array(details.buffer, details.byteOffset, details.byteLength));
			hash.update(';');
			continue;
		}

		if (current instanceof ArrayBuffer || Object.prototype.toString.call(current) === '[object SharedArrayBuffer]') {
			throw new Error(`Transfer proof found a naked/shared backing buffer at ${entry.path}.`);
		}
		if (!isPlain(current)) throw new Error(`Transfer proof found a non-plain object at ${entry.path}.`);
		if (seenObjects.has(current)) throw new Error(`Transfer proof encountered an inconsistent graph walk at ${entry.path}.`);
		seenObjects.add(current);
		const isArray = Array.isArray(current);
		const keys = orderedKeys(current).filter((key) => !isSkipped(entry.path, key));
		appendToken(hash, isArray ? 'array' : 'object', String(objectId));
		if (isArray) appendToken(hash, 'array-length', String((current as unknown[]).length));
		appendToken(hash, 'property-count', String(keys.length));
		for (const key of keys) appendExactString(hash, key);
		for (let index = keys.length - 1; index >= 0; index -= 1) {
			const key = keys[index]!;
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (!descriptor || !('value' in descriptor)) throw new Error(`Transfer proof found an accessor or missing field at ${childPath(entry.path, key, isArray)}.`);
			stack.push({ value: descriptor.value, path: childPath(entry.path, key, isArray) });
		}
	}

	const assetSnapshot = snapshotAssets(result);
	const fingerprint: TransferFingerprint = {
		version: 'bomc-transfer-fingerprint-1',
		graphSha256: hash.digest('hex'),
		objectCount,
		viewCount: views.length,
		backings,
		views,
		assets: assetSnapshot.assets
	};
	fingerprintRuntime.set(fingerprint, { views: viewRefs, backings: backingBuffers });
	return fingerprint;
}

function require(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`Transfer proof failed: ${message}.`);
}

/** Compare graph content, view identities and original backing placement after native transfer. */
export function verifyTransferFingerprint(received: unknown, inventory: TransferFingerprint) {
	const expectedRuntime = fingerprintRuntime.get(inventory);
	if (!expectedRuntime) throw new Error('Transfer proof fingerprint has no live verification inventory.');
	const actual = createTransferFingerprint(received);
	const actualRuntime = fingerprintRuntime.get(actual)!;
	require(actual.graphSha256 === inventory.graphSha256, 'prepared result graph fingerprint changed');
	require(actual.objectCount === inventory.objectCount, 'prepared result object count changed');
	require(actual.viewCount === inventory.viewCount, 'prepared result typed-view count changed');
	require(actual.views.length === inventory.views.length, 'prepared result typed-view inventory changed');
	require(actual.backings.length > 0 || inventory.backings.length === 0, 'prepared result backing inventory disappeared');

	for (let index = 0; index < inventory.views.length; index += 1) {
		const expected = inventory.views[index]!;
		const found = actual.views[index]!;
		require(found.path === expected.path, `typed view ${expected.path} moved in the DTO graph`);
		require(found.constructor === expected.constructor, `typed view constructor changed at ${expected.path}`);
		require(found.length === expected.length && found.byteLength === expected.byteLength, `typed view length changed at ${expected.path}`);
		require(found.distinctViewId === expected.distinctViewId, `typed view identity changed at ${expected.path}`);
	}

	const expectedToActualBacking = new Map<number, number>();
	const placementGroups = new Map<number, Array<{ originalBackingId: number; start: number; end: number; path: string }>>();
	const viewsByBacking = new Map<number, FingerprintView[]>();
	for (const view of inventory.views) {
		const group = viewsByBacking.get(view.backingId) ?? [];
		group.push(view);
		viewsByBacking.set(view.backingId, group);
	}
	for (const original of inventory.backings) {
		const representative = inventory.views[original.representativeViewId];
		if (!representative) throw new Error(`Transfer proof representative is missing for backing ${original.backingId}.`);
		const receivedView = actualRuntime.views[representative.distinctViewId]?.view;
		if (!ArrayBuffer.isView(receivedView)) throw new Error(`Transfer proof representative view disappeared at ${original.representativePath}.`);
		const receivedDetails = viewInfo(receivedView, original.representativePath);
		const base = receivedDetails.byteOffset - original.representativeByteOffset;
		require(Number.isSafeInteger(base) && base >= 0, `backing ${original.backingId} has an invalid placement base`);
		const actualBackingId = actual.views[original.representativeViewId]?.backingId;
		if (actualBackingId === undefined) throw new Error(`Transfer proof output backing is missing for ${original.representativePath}.`);
		const priorActualBacking = expectedToActualBacking.get(original.backingId);
		if (priorActualBacking !== undefined) require(priorActualBacking === actualBackingId, `original backing ${original.backingId} split across output buffers`);
		expectedToActualBacking.set(original.backingId, actualBackingId);
		const receivedBacking = actualRuntime.backings[actualBackingId]!;
		require(base + original.byteLength <= bufferLength(receivedBacking), `backing ${original.backingId} exceeds its output buffer`);
		require(hashBuffer(receivedBacking, base, original.byteLength) === original.sha256, `whole backing bytes changed for ${original.representativePath}`);
		const group = placementGroups.get(actualBackingId) ?? [];
		group.push({ originalBackingId: original.backingId, start: base, end: base + original.byteLength, path: original.representativePath });
		placementGroups.set(actualBackingId, group);

		for (const expectedView of viewsByBacking.get(original.backingId) ?? []) {
			const output = actualRuntime.views[expectedView.distinctViewId]?.view;
			if (!ArrayBuffer.isView(output)) throw new Error(`Transfer proof view disappeared at ${expectedView.path}.`);
			const outputInfo = viewInfo(output, expectedView.path);
			require(outputInfo.buffer === receivedBacking, `views from original backing ${original.backingId} no longer share storage`);
			require(outputInfo.byteOffset === base + expectedView.byteOffset, `relative view offset changed at ${expectedView.path}`);
			require(outputInfo.spec.name === expectedView.constructor && outputInfo.length === expectedView.length && outputInfo.byteLength === expectedView.byteLength, `view shape changed at ${expectedView.path}`);
		}
	}
	for (const [backingId, intervals] of placementGroups) {
		intervals.sort((left, right) => left.start - right.start || left.end - right.end);
		for (let index = 1; index < intervals.length; index += 1) {
			const previous = intervals[index - 1]!;
			const current = intervals[index]!;
			require(previous.end <= current.start, `independent original backings overlap in output buffer ${backingId}: ${previous.path} and ${current.path}`);
		}
	}

	const outputAssetSnapshot = snapshotAssets(received);
	const outputAssets = outputAssetSnapshot.assets;
	require(outputAssets.length === inventory.assets.length, 'appearance asset count changed');
	const assetBuffers = new Set<ArrayBuffer>();
	for (let index = 0; index < inventory.assets.length; index += 1) {
		const expected = inventory.assets[index]!;
		const actualAsset = outputAssets[index]!;
		require(actualAsset.index === expected.index && actualAsset.path === expected.path, `appearance asset path/order changed at index ${index}`);
		require(actualAsset.constructor === expected.constructor && actualAsset.byteLength === expected.byteLength, `appearance asset view shape changed at index ${index}`);
		require(actualAsset.viewSha256 === expected.viewSha256, `appearance asset bytes changed at index ${index}`);
		require(actualAsset.byteOffset === 0 && actualAsset.backingByteLength === actualAsset.byteLength, `appearance asset ${index} is not exact offset-zero storage`);
		const asset = outputAssetSnapshot.views[index];
		if (!ArrayBuffer.isView(asset)) throw new Error(`Transfer proof asset bytes disappeared at index ${index}.`);
		const details = viewInfo(asset, `$.appearance.assets[${index}].bytes`);
		require(!assetBuffers.has(details.buffer), `appearance asset ${index} does not own an independent buffer`);
		assetBuffers.add(details.buffer);
	}

	const nonemptyBackingCount = actual.backings.filter((backing) => backing.byteLength > 0).length;
	const nonemptyBackingBytes = actual.backings.reduce((sum, backing) => sum + (backing.byteLength > 0 ? backing.byteLength : 0), 0);
	return {
		graphSha256: actual.graphSha256,
		objectCount: actual.objectCount,
		viewCount: actual.viewCount,
		geometry: {
			viewBackingCount: actual.backings.length,
			viewBackingBytes: actual.backings.reduce((sum, backing) => sum + backing.byteLength, 0),
			nonemptyViewBackingCount: nonemptyBackingCount,
			nonemptyViewBackingBytes: nonemptyBackingBytes
		},
		assetCount: outputAssets.length,
		assetBytes: outputAssets.reduce((sum, asset) => sum + asset.byteLength, 0)
	};
}

function parseArgs(args: string[]): { workspaceRoot: string; output: string } {
	const values = new Map<string, string>();
	for (let index = 0; index < args.length; index += 1) {
		const key = args[index]!;
		if (key !== '--workspace-root' && key !== '--output') throw new Error(`Unknown argument ${key}.`);
		const value = args[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}.`);
		if (values.has(key)) throw new Error(`Duplicate argument ${key}.`);
		values.set(key, value);
		index += 1;
	}
	if (values.size !== 2) throw new Error('Required arguments: --workspace-root and --output.');
	return { workspaceRoot: path.resolve(values.get('--workspace-root')!), output: path.resolve(values.get('--output')!) };
}

function ensureWorkspacePath(workspaceRoot: string, locator: string): string {
	if (path.isAbsolute(locator)) throw new Error(`Fixture locator must be workspace-relative: ${locator}.`);
	const target = path.resolve(workspaceRoot, locator);
	const relative = path.relative(workspaceRoot, target);
	if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Workspace path escapes root: ${locator}.`);
	return target;
}

function validateFixtureManifest() {
	const manifestPath = path.resolve(EDITOR_ROOT, MANIFEST_RELATIVE);
	const manifestRelative = path.relative(EDITOR_ROOT, manifestPath);
	if (manifestRelative === '..' || manifestRelative.startsWith(`..${path.sep}`) || path.isAbsolute(manifestRelative)) throw new Error('Fixture manifest path escapes the Editor repository.');
	const manifestBytes = readFileSync(manifestPath);
	const actualSha = sha256(manifestBytes);
	if (actualSha !== MANIFEST_SHA256) throw new Error(`Fixture manifest SHA-256 ${actualSha} does not match pinned ${MANIFEST_SHA256}.`);
	const manifest = JSON.parse(manifestBytes.toString('utf8')) as FixtureManifest;
	if (manifest.schemaVersion !== 'bomc-loader-fixture-manifest-v1' || manifest.plan !== 'BOMC-LOADER-001/v1.0' || manifest.fixtures.length !== 8) {
		throw new Error('Fixture manifest schema/plan/count does not match the pinned eight-input corpus.');
	}
	for (const [id, expected] of Object.entries(FIXTURES)) {
		const fixture = manifest.fixtures.find((candidate) => candidate.id === id);
		if (!fixture || fixture.bytes !== expected.bytes || fixture.sha256 !== expected.sha256) throw new Error(`${id}: fixture manifest entry differs from the frozen proof input.`);
	}
	return { manifestPath, manifestSha256: actualSha, manifest };
}

function readVerifiedFixture(workspaceRoot: string, manifest: FixtureManifest, id: keyof typeof FIXTURES) {
	const fixture = manifest.fixtures.find((candidate) => candidate.id === id)!;
	const filePath = ensureWorkspacePath(workspaceRoot, fixture.locator);
	if (!existsSync(filePath)) throw new Error(`${id}: fixture is missing at ${fixture.locator}.`);
	const file = readFileSync(filePath);
	if (file.byteLength !== FIXTURES[id].bytes) throw new Error(`${id}: byte length ${file.byteLength} does not match pinned ${FIXTURES[id].bytes}.`);
	const actualSha = sha256(file);
	if (actualSha !== FIXTURES[id].sha256) throw new Error(`${id}: SHA-256 ${actualSha} does not match pinned ${FIXTURES[id].sha256}.`);
	return { fixture, filePath, bytes: file, arrayBuffer: file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer, sha256: actualSha };
}

function gitIdentity() {
	const git = (...args: string[]) => execFileSync('git', args, { cwd: EDITOR_ROOT, encoding: 'utf8' }).trim();
	return { repository: git('rev-parse', '--show-toplevel'), head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), status: git('status', '--porcelain') };
}

function sourceModuleHashes() {
	const relativeFiles = [
		'packages/e4-import/src/types.ts',
		'packages/e4-import/src/worker-transfer.ts',
		'packages/e4-import/src/bomc-loader.ts',
		'packages/scene-runtime/src/application-preparation.ts',
		'tooling/performance/loader-transfer-proof.ts'
	];
	return Object.fromEntries(relativeFiles.map((relative) => [relative, sha256(readFileSync(path.join(EDITOR_ROOT, relative)))]));
}

function applyWorkerPreparation(result: AdaptedBomcResult): void {
	const preparation = prepareApplicationRenderScene(result.preparedRuntimeScene, result.encodingContract?.profile);
	if (preparation.solidCoplanarResolutionMs !== undefined) result.diagnostics.timings.solidCoplanarResolutionMs = preparation.solidCoplanarResolutionMs;
	if (preparation.surfaceBatching) {
		result.diagnostics.finalTypedArrayBytes = preparation.surfaceBatching.typedArrayBytes;
		result.diagnostics.timings.surfaceBatchingMs = preparation.surfaceBatching.preparationMs;
	}
}

function transferBytes(buffers: ArrayBuffer[]): number {
	return buffers.reduce((sum, buffer) => sum + bufferLength(buffer), 0);
}

function appendEvent(output: string, event: Record<string, unknown>): void {
	appendFileSync(path.join(output, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf8');
}

function writeJson(filePath: string, value: unknown): void {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function runTransferProof(workspaceRootInput: string, outputInput: string) {
	const workspaceRoot = path.resolve(workspaceRootInput);
	const output = path.resolve(outputInput);
	const worklogRoot = path.join(workspaceRoot, 'docs', 'worklogs', 'BOMC-LOADER-001');
	const outputRelative = path.relative(worklogRoot, output);
	if (outputRelative === '' || outputRelative === '..' || outputRelative.startsWith(`..${path.sep}`) || path.isAbsolute(outputRelative)) {
		throw new Error('Output must be a fresh directory below W/docs/worklogs/BOMC-LOADER-001/.');
	}
	if (existsSync(output)) throw new Error(`Output directory already exists: ${output}.`);
	const manifestState = validateFixtureManifest();
	const identity = gitIdentity();
	const moduleHashes = sourceModuleHashes();
	mkdirSync(output, { recursive: false });
	const proofPath = path.join(output, 'proof.json');
	const proof: Record<string, unknown> = {
		schemaVersion: 'bomc-loader-transfer-proof-v1',
		status: 'running',
		metadata: {
			recordedAt: new Date().toISOString(),
			workspaceRoot,
			repository: identity,
			fixtureManifest: { path: path.relative(workspaceRoot, manifestState.manifestPath).replaceAll(path.sep, '/'), sha256: manifestState.manifestSha256 },
			sourceModules: moduleHashes,
			runtime: { bun: typeof Bun === 'undefined' ? null : Bun.version, node: process.versions.node, platform: process.platform, architecture: process.arch },
			cases: ['L-old', 'S2-new']
		},
		cases: { 'L-old': { status: 'not-started' }, 'S2-new': { status: 'not-started' } }
	};
	writeJson(path.join(output, 'metadata.json'), proof.metadata);
	writeJson(proofPath, proof);
	appendEvent(output, { type: 'proof-start', status: 'running' });

	let lOldPassed = false;
	appendEvent(output, { type: 'case-start', fixtureId: 'L-old', action: 'native-offline-transfer' });
	try {
		const input = readVerifiedFixture(workspaceRoot, manifestState.manifest, 'L-old');
		const sourceBuffer = input.arrayBuffer;
		const sourceBefore = { byteLength: bufferLength(sourceBuffer), sha256: hashBuffer(sourceBuffer) };
		const result = await new BomcLoader().load(sourceBuffer, path.basename(input.filePath), { prepareSolid: true });
		applyWorkerPreparation(result);
		const inventory = createTransferFingerprint(result);
		const originalAssets = result.appearance.assets;
		const originalAssetBackings = new Map<ArrayBuffer, { byteLength: number; sha256: string }>();
		for (const asset of originalAssets) {
			const buffer = asset.bytes.buffer as ArrayBuffer;
			if (!originalAssetBackings.has(buffer)) originalAssetBackings.set(buffer, { byteLength: bufferLength(buffer), sha256: hashBuffer(buffer) });
		}
		const packed = prepareBomcWorkerTransfer(result, sourceBuffer);
		const transferBufferBytes = transferBytes(packed.transferList);
		const retainedOriginalBuffers = new Set<ArrayBuffer>([sourceBuffer, ...originalAssetBackings.keys()]);
		const retainedBufferInList = packed.transferList.some((buffer) => retainedOriginalBuffers.has(buffer));
		require(!retainedBufferInList, 'source/original asset backing buffer appears in transfer list');
		require(packed.transferList.length <= MAX_GEOMETRY_TRANSFERS + MAX_ASSET_TRANSFERS, `total transfer count ${packed.transferList.length} exceeds ${MAX_GEOMETRY_TRANSFERS + MAX_ASSET_TRANSFERS}`);
		const geometryStats = packed.result.diagnostics.workerTransfer?.geometry;
		if (!geometryStats) throw new Error('Transfer proof failed: worker transfer geometry diagnostics are missing.');
		require(geometryStats.packedBufferCount <= MAX_GEOMETRY_TRANSFERS, `geometry transfer count ${geometryStats.packedBufferCount} exceeds ${MAX_GEOMETRY_TRANSFERS}`);
		const received = structuredClone(packed.result, { transfer: packed.transferList });
		const after = verifyTransferFingerprint(received, inventory);
		const sourceAfter = { byteLength: bufferLength(sourceBuffer), sha256: hashBuffer(sourceBuffer) };
		require(sourceAfter.byteLength === sourceBefore.byteLength && sourceAfter.sha256 === sourceBefore.sha256, 'retained source buffer changed or detached');
		for (const [buffer, expected] of originalAssetBackings) {
			require(bufferLength(buffer) === expected.byteLength && hashBuffer(buffer) === expected.sha256, 'retained original asset backing changed or detached');
		}
		const diagnostics = packed.result.diagnostics.workerTransfer!;
		const record = {
			status: 'pass',
			fixture: { id: input.fixture.id, locator: input.fixture.locator, byteLength: input.bytes.byteLength, sha256: input.sha256 },
			nativeTransfer: true,
			assertions: {
				graphFingerprintPreserved: true,
				constructorLengthAndViewIdentityPreserved: true,
				fullOriginalBackingBytesPreserved: true,
				relativeOffsetsAndOverlapPreserved: true,
				independentBackingIntervalsDisjoint: true,
				assetsPayloadOrderPathAndExactStoragePreserved: true,
				sourceAndOriginalAssetsRetainedUnchanged: true,
				retainedBuffersExcludedFromTransfer: true,
				geometryTransferLimit: geometryStats.packedBufferCount <= MAX_GEOMETRY_TRANSFERS,
				totalTransferLimit: packed.transferList.length <= MAX_GEOMETRY_TRANSFERS + MAX_ASSET_TRANSFERS
			},
			sourceCounts: result.counts,
			before: {
				geometryViewBackingCount: inventory.backings.length,
				geometryViewBackingBytes: inventory.backings.reduce((sum, backing) => sum + backing.byteLength, 0),
				nonemptyGeometryBackingCount: inventory.backings.filter((backing) => backing.byteLength > 0).length,
				nonemptyGeometryBackingBytes: inventory.backings.reduce((sum, backing) => sum + (backing.byteLength > 0 ? backing.byteLength : 0), 0),
				geometryViewCount: inventory.viewCount,
				assetCount: inventory.assets.length,
				assetBytes: inventory.assets.reduce((sum, asset) => sum + asset.byteLength, 0)
			},
			after: {
				...after,
				geometryStats,
				transferBufferCount: packed.transferList.length,
				transferBufferBytes,
				assetBufferCount: diagnostics.assetBufferCount,
				assetBytes: diagnostics.assetBytes,
				totalPackingMs: diagnostics.totalPackingMs
			},
			sourceBuffer: { before: sourceBefore, after: sourceAfter },
			originalAssetBackingCount: originalAssetBackings.size
		};
		(proof.cases as Record<string, unknown>)['L-old'] = record;
		lOldPassed = true;
		writeJson(proofPath, proof);
		appendEvent(output, { type: 'case-finish', fixtureId: 'L-old', status: 'pass', geometryTransferCount: geometryStats.packedBufferCount, totalTransferCount: packed.transferList.length });
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		(proof.cases as Record<string, unknown>)['L-old'] = { status: 'fail', error: message };
		writeJson(proofPath, proof);
		appendEvent(output, { type: 'case-finish', fixtureId: 'L-old', status: 'fail', error: message });
	}

	let s2Passed = false;
	appendEvent(output, { type: 'case-start', fixtureId: 'S2-new', action: 'unchanged-material-version-rejection' });
	try {
		const input = readVerifiedFixture(workspaceRoot, manifestState.manifest, 'S2-new');
		const sourceBuffer = input.arrayBuffer;
		const before = { byteLength: bufferLength(sourceBuffer), sha256: hashBuffer(sourceBuffer) };
		let rejection = '';
		let returnedResult: AdaptedBomcResult | undefined;
		try { returnedResult = await new BomcLoader().load(sourceBuffer, path.basename(input.filePath), { prepareSolid: true }); }
		catch (cause) { rejection = cause instanceof Error ? cause.message : String(cause); }
		const expectedRejection = 'BOMC invalid: material section version.';
		const after = { byteLength: bufferLength(sourceBuffer), sha256: hashBuffer(sourceBuffer) };
		require(returnedResult === undefined, 'S2-new unexpectedly returned a renderable/full result');
		require(rejection === expectedRejection, `S2-new rejection was ${JSON.stringify(rejection)}, expected ${JSON.stringify(expectedRejection)}`);
		require(before.byteLength === after.byteLength && before.sha256 === after.sha256, 'S2-new rejection changed its source buffer');
		(proof.cases as Record<string, unknown>)['S2-new'] = {
			status: 'pass',
			fixture: { id: input.fixture.id, locator: input.fixture.locator, byteLength: input.bytes.byteLength, sha256: input.sha256 },
			returnedFullResult: false,
		exactRejection: rejection,
			sourceBuffer: { before, after }
		};
		s2Passed = true;
		writeJson(proofPath, proof);
		appendEvent(output, { type: 'case-finish', fixtureId: 'S2-new', status: 'pass', rejection });
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		(proof.cases as Record<string, unknown>)['S2-new'] = { status: 'fail', error: message };
		writeJson(proofPath, proof);
		appendEvent(output, { type: 'case-finish', fixtureId: 'S2-new', status: 'fail', error: message });
	}

	proof.status = lOldPassed && s2Passed ? 'pass' : 'fail';
	writeJson(proofPath, proof);
	appendEvent(output, { type: 'proof-finish', status: proof.status });
	return { output, status: proof.status, lOldPassed, s2Passed };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const result = await runTransferProof(args.workspaceRoot, args.output);
	process.stdout.write(`${JSON.stringify(result)}\n`);
	if (result.status !== 'pass') process.exitCode = 1;
}

if (import.meta.main) {
	main().catch((cause) => {
		process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
		process.exitCode = 1;
	});
}
