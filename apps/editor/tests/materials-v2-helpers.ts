import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { BomcContainer, BOMC_MAGIC, BOMC_SECTION, crc32 } from '@sibambo/e4-import';
import { decodeMaterials, decodeStrings } from '@sibambo/e4-import/bomc-loader';
import type { Page } from '@playwright/test';

const helperDir = path.dirname(fileURLToPath(import.meta.url));
export const editorRoot = path.resolve(helperDir, '../../..');
export const workspaceRoot = path.resolve(editorRoot, '..');
export const fixtureManifestPath = path.join(editorRoot, 'tooling', 'performance', 'fixtures.json');

export type OracleMaterial = {
	materialIndex: number; name: string | null; displayName: string | null; rgba: number[]; opacity: number;
	textureIndex: number | null; textureWidthM: number; textureHeightM: number; activeSemantic: boolean;
	semantic?: { materialType: number; colorizeMode: number; deltas: number[]; outputRgbaSha256: string };
};
export type OracleMetadata = {
	schemaVersion: string; producer: { commit: string; root: string; sourceSha256: Record<string, string> };
	fixtureManifestSha256: string; fixtures: Array<{
		id: string; bytes: number; sha256: string; materialVersion: number; sourceTextureCount: number;
		activeSemanticCount: number; materials: OracleMaterial[];
	}>; activeSemanticMaterialCount: number;
};

export type PinnedInput = { id: 'S1-new' | 'S2-new' | 'S2-jcm'; fileName: string; bytes: Buffer; byteLength: number; sha256: string; materialVersion: number; sourceTextureCount: number; activeSemanticCount: number };

export function loadOracleMetadata(): OracleMetadata {
	const worklogRoot = requiredWorklogRoot();
	const metadata = JSON.parse(readFileSync(path.join(worklogRoot, 'oracle', 'metadata.json'), 'utf8')) as OracleMetadata;
	if (metadata.schemaVersion !== 'bomc-materials-v2-ruby-oracle-v1' || metadata.activeSemanticMaterialCount !== 54) {
		throw new Error('MATERIALS-v2 Ruby oracle identity is invalid.');
	}
	const manifestSha256 = shaFile(fixtureManifestPath);
	if (metadata.fixtureManifestSha256 !== manifestSha256) throw new Error('Fixture manifest changed after Ruby oracle generation.');
	return metadata;
}

export function requiredWorklogRoot() {
	const value = process.env.SIBAMBO_M2_WORKLOG;
	if (!value || !path.isAbsolute(value)) throw new Error('SIBAMBO_M2_WORKLOG must be an absolute path.');
	const root = path.resolve(value);
	assertNested(path.join(workspaceRoot, 'docs', 'worklogs', 'BOMC-MATERIALS-V2-001'), root);
	return root;
}

export function readPinnedInput(id: PinnedInput['id']): PinnedInput {
	const manifest = JSON.parse(readFileSync(fixtureManifestPath, 'utf8')) as {
		schemaVersion: string; plan: string; fixtures: Array<{ id: string; locator: string; bytes: number; sha256: string; expected: { materialVersion: number; sourceTextureCount: number; activeSemanticCount: number } }>;
	};
	if (manifest.schemaVersion !== 'bomc-loader-fixture-manifest-v1' || manifest.plan !== 'BOMC-LOADER-001/v1.0') {
		throw new Error('Pinned fixture manifest does not match the reviewed source inventory.');
	}
	const descriptor = manifest.fixtures.find((fixture) => fixture.id === id);
	if (!descriptor) throw new Error(`Fixture ${id} is not pinned in the manifest.`);
	const filePath = path.resolve(workspaceRoot, descriptor.locator);
	assertNested(workspaceRoot, filePath);
	const bytes = readFileSync(filePath);
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	if (bytes.byteLength !== descriptor.bytes || sha256 !== descriptor.sha256) {
		throw new Error(`Fixture ${id} size/SHA-256 differs from its pinned manifest identity.`);
	}
	return {
		id, fileName: path.basename(filePath), bytes, byteLength: bytes.byteLength, sha256,
		materialVersion: descriptor.expected.materialVersion,
		sourceTextureCount: descriptor.expected.sourceTextureCount,
		activeSemanticCount: descriptor.expected.activeSemanticCount
	};
}

type CompactSection = {
	index: number; type: number; codec: number; flags: number; offset: number; storedLength: number;
	rawLength: number; count: number; checksum: number; stored: Uint8Array;
};

export async function corruptFirstActiveSemanticHash(source: Buffer) {
	const sourceBytes = Uint8Array.from(source);
	const container = new BomcContainer(exactArrayBuffer(sourceBytes));
	if (container.header.major !== 1 || container.header.minor !== 2 || container.header.directoryEntryBytes !== 24) {
		throw new Error('Corrupted replacement expects the pinned compact BOMC 1.2 container.');
	}
	const directory = parseCompactSections(sourceBytes);
	const materialEntry = directory.entries.find((entry) => entry.type === BOMC_SECTION.MATERIALS);
	const stringsEntry = directory.entries.find((entry) => entry.type === BOMC_SECTION.STRINGS);
	if (!materialEntry || !stringsEntry) throw new Error('Pinned S2-new is missing MATERIALS or STRINGS.');
	const rawMaterials = decodeSection(materialEntry);
	const strings = decodeStrings(decodeSection(stringsEntry));
	const materials = decodeMaterials(rawMaterials, strings);
	const materialIndex = materials.findIndex((material) => material.semantic?.materialType === 2 && (material.semantic.colorizeMode === 1 || material.semantic.colorizeMode === 2));
	if (materialIndex < 0) throw new Error('Pinned S2-new contains no active semantic material to corrupt.');
	const activeMaterial = materials[materialIndex];
	const expectedHash = activeMaterial.semantic!.outputRgbaSha256;
	const view = new DataView(rawMaterials.buffer, rawMaterials.byteOffset, rawMaterials.byteLength);
	const count = view.getUint32(4, true);
	const stringWidth = rawMaterials[1];
	const textureWidth = rawMaterials[2];
	const hashesOffset = 8 + count * (2 * stringWidth + 4 + 2 + textureWidth + 8 + 2 + 24);
	const hashByteOffset = hashesOffset + materialIndex * 32;
	if (count !== materials.length || hashByteOffset + 32 > rawMaterials.byteLength) throw new Error('MATERIALS v2 output-hash column is outside its section.');
	const changedMaterials = Uint8Array.from(rawMaterials);
	changedMaterials[hashByteOffset] ^= 0x01;
	const corruptedHash = [...changedMaterials.subarray(hashByteOffset, hashByteOffset + 32)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	const corruptedRows = decodeMaterials(changedMaterials, strings);
	if (corruptedRows[materialIndex].semantic?.outputRgbaSha256 !== corruptedHash || corruptedHash === expectedHash) {
		throw new Error('The test fixture did not change exactly the selected semantic output hash.');
	}

	const rebuiltEntries = directory.entries.map((entry) => {
		if (entry.type !== BOMC_SECTION.MATERIALS) return { ...entry, stored: Uint8Array.from(entry.stored) };
		const stored = entry.codec === 1 ? new Uint8Array(deflateSync(changedMaterials)) : Uint8Array.from(changedMaterials);
		if (entry.codec !== 0 && entry.codec !== 1) throw new Error(`Pinned MATERIALS section uses unsupported codec ${entry.codec}.`);
		return { ...entry, stored };
	});
	const corrupted = rebuildCompactContainer(sourceBytes, directory.directoryOffset, rebuiltEntries);
	const rebuilt = parseCompactSections(corrupted);
	for (const entry of rebuilt.entries) {
		if (crc32(entry.stored) !== entry.checksum) throw new Error(`Rebuilt section ${entry.type} has an invalid CRC.`);
		const original = directory.entries[entry.index];
		if (entry.type !== BOMC_SECTION.MATERIALS && !equalBytes(entry.stored, original.stored)) {
			throw new Error(`Corrupted replacement changed unrelated section ${entry.type} stored bytes.`);
		}
		if (entry.count !== original.count || entry.rawLength !== original.rawLength || entry.codec !== original.codec) {
			throw new Error(`Corrupted replacement changed section ${entry.type} count, raw size, or codec.`);
		}
	}
	const rebuiltMaterialEntry = rebuilt.entries.find((entry) => entry.type === BOMC_SECTION.MATERIALS)!;
	const rebuiltRawMaterials = decodeSection(rebuiltMaterialEntry);
	let changedByteCount = 0;
	for (let index = 0; index < rawMaterials.byteLength; index += 1) {
		if (rawMaterials[index] !== rebuiltRawMaterials[index]) changedByteCount += 1;
	}
	if (changedByteCount !== 1 || rebuiltRawMaterials[hashByteOffset] !== changedMaterials[hashByteOffset]) {
		throw new Error('Corrupted replacement must differ from source MATERIALS by one output-hash byte only.');
	}
	const rebuiltContainer = new BomcContainer(exactArrayBuffer(corrupted));
	if (rebuiltContainer.header.sectionCount !== container.header.sectionCount) throw new Error('Corrupted replacement changed the section count.');
	return {
		bytes: Buffer.from(corrupted), materialIndex, expectedHash, corruptedHash,
		sourceSha256: createHash('sha256').update(source).digest('hex'),
		corruptedSha256: createHash('sha256').update(corrupted).digest('hex'),
		changedPayloadBytes: changedByteCount, changedSections: ['MATERIALS']
	};
}

export async function installEditorMaterialsV2Probe(page: Page) {
	await page.addInitScript(() => {
		const nativeWorker = window.Worker;
		const state = {
			activeRequestId: null as number | null,
			requests: [] as any[],
			draws: new WeakMap<HTMLCanvasElement, any>(),
			rememberedCanvas: null as HTMLCanvasElement | null,
			rememberedTitle: '',
			assetProbePromises: new Map<number, Promise<any[]>>(),
			assetProbeResults: new Map<number, any[]>()
		};
		const canvasSelector = 'canvas[aria-label="Interactive 3D model viewport"]';
		const zeroDrawCounts = () => ({ drawArrays: 0, drawElements: 0, drawRangeElements: 0, drawArraysInstanced: 0, drawElementsInstanced: 0, drawArraysInstancedANGLE: 0, drawElementsInstancedANGLE: 0 });
		const resetCanvas = (canvas: HTMLCanvasElement, requestId: number | null) => {
			state.draws.set(canvas, { requestId, counts: zeroDrawCounts() });
		};
		const summarizeResult = (result: any) => {
			const appearance = result?.appearance || {};
			const diagnostics = result?.diagnostics || {};
			const semantic = diagnostics.semanticMaterials || null;
			return {
				sourceFileName: result?.sourceFileName ?? null,
				modelName: result?.modelName ?? null,
				counts: result?.counts || null,
				diagnosticTextureCount: diagnostics.textures ?? null,
				texturePayloadBytes: diagnostics.texturePayloadBytes ?? null,
				sourceFileBytes: diagnostics.sourceFileBytes ?? null,
				semanticMaterials: semantic ? {
					sectionVersion: semantic.sectionVersion, activeCount: semantic.activeCount,
					verifiedCount: semantic.verifiedCount, generatedAssetCount: semantic.generatedAssetCount,
					generatedPngBytes: semantic.generatedPngBytes, baseDecodeCount: semantic.baseDecodeCount,
					maxLiveBaseFrames: semantic.maxLiveBaseFrames, maxLiveOutputFrames: semantic.maxLiveOutputFrames,
					maxMemoEntries: semantic.maxMemoEntries,
					baseDecodes: (semantic.baseDecodes || []).map((row: any) => ({ ...row })),
					materialProofs: (semantic.materialProofs || []).map((row: any) => ({ ...row }))
				} : null,
				textureMetrics: (diagnostics.textureMetrics || []).map((row: any) => ({ materialIndex: row.materialIndex, textureAsset: row.textureAsset, textureWidthM: row.textureWidthM, textureHeightM: row.textureHeightM })),
				materialPaths: (appearance.materials || []).map((row: any, index: number) => ({ index, textureAsset: row.textureAsset ?? null, textureWidthM: row.textureWidthM, textureHeightM: row.textureHeightM })),
				groupPaths: (result?.preparedRuntimeScene?.groups || []).map((row: any) => ({ materialIndex: row.materialIndex ?? null, textureAsset: row.textureAsset ?? null, sourceMeshIndex: row.sourceMeshIndex, renderSide: row.renderSide ?? null })),
				assets: (appearance.assets || []).map((row: any) => ({ path: row.path, bytes: row.bytes?.byteLength ?? -1 }))
			};
		};
		const probeReferencedSemanticPngs = async (result: any) => {
			const assets = new Map<string, any>((result?.appearance?.assets || []).map((asset: any) => [asset.path, asset]));
			const referenced = new Set<string>();
			for (const material of result?.appearance?.materials || []) if (typeof material.textureAsset === 'string' && material.textureAsset.startsWith('bomc/textures/semantic-')) referenced.add(material.textureAsset);
			for (const group of result?.preparedRuntimeScene?.groups || []) if (typeof group.textureAsset === 'string' && group.textureAsset.startsWith('bomc/textures/semantic-')) referenced.add(group.textureAsset);
			const receipts: any[] = [];
			for (const assetPath of [...referenced].sort()) {
				const asset = assets.get(assetPath);
				const dimensions = /-(\d+)x(\d+)\.png$/.exec(assetPath);
				if (!asset || !dimensions) {
					receipts.push({ path: assetPath, passed: false, error: 'referenced generated asset or dimensions are missing' });
					continue;
				}
				const url = URL.createObjectURL(new Blob([asset.bytes], { type: 'image/png' }));
				const image = new Image();
				try {
					image.src = url;
					await image.decode();
					const expectedWidth = Number(dimensions[1]);
					const expectedHeight = Number(dimensions[2]);
					receipts.push({ path: assetPath, bytes: asset.bytes.byteLength, expectedWidth, expectedHeight, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, passed: image.naturalWidth === expectedWidth && image.naturalHeight === expectedHeight });
				} catch (error) {
					receipts.push({ path: assetPath, bytes: asset.bytes.byteLength, passed: false, error: error instanceof Error ? error.message : String(error) });
				} finally {
					image.src = '';
					URL.revokeObjectURL(url);
				}
			}
			return receipts;
		};
		const registerTerminal = (record: any, message: any) => {
			record.messages.push({ id: message.id ?? null, type: message.type ?? null });
			if (message.id !== record.requestId) record.idMismatches.push({ expected: record.requestId, actual: message.id ?? null });
			if (message.type === 'complete' || message.type === 'error' || message.type === 'cancelled') {
				record.terminals.push({ id: message.id ?? null, type: message.type, error: message.error ?? null });
				if (message.type === 'complete') {
					record.result = summarizeResult(message.result);
					state.assetProbePromises.set(record.requestId, probeReferencedSemanticPngs(message.result).then((receipts) => {
						state.assetProbeResults.set(record.requestId, receipts);
						return receipts;
					}));
				}
			}
		};
		class ObservedWorker extends nativeWorker {
			private readonly record: any;
			constructor(scriptURL: string | URL, options?: WorkerOptions) {
				super(scriptURL, options);
				this.record = { workerIndex: state.requests.length, scriptURL: String(scriptURL), options: options ?? {}, requestId: null, sourceName: null, inputByteLength: null, postedMessages: [], messages: [], terminals: [], idMismatches: [], errors: [], terminated: false, result: null };
				state.requests.push(this.record);
				this.addEventListener('message', (event: MessageEvent) => registerTerminal(this.record, event.data));
				this.addEventListener('error', (event: ErrorEvent) => this.record.errors.push({ message: event.message, filename: event.filename }));
			}
			postMessage(message: any, transfer?: Transferable[] | StructuredSerializeOptions) {
				if (message?.type === 'load') {
					this.record.requestId = message.id;
					this.record.sourceName = message.sourceName ?? null;
					this.record.inputByteLength = message.buffer?.byteLength ?? null;
					this.record.postedMessages.push({ type: message.type, id: message.id, sourceName: this.record.sourceName, inputByteLength: this.record.inputByteLength, transferCount: Array.isArray(transfer) ? transfer.length : transfer?.transfer?.length ?? 0 });
					state.activeRequestId = message.id;
					const currentCanvas = document.querySelector<HTMLCanvasElement>(canvasSelector);
					if (currentCanvas) resetCanvas(currentCanvas, message.id);
				} else {
					this.record.postedMessages.push({ type: message?.type ?? null, id: message?.id ?? null });
				}
				return Reflect.apply(nativeWorker.prototype.postMessage, this, Array.from(arguments));
			}
			terminate() {
				this.record.terminated = true;
				return Reflect.apply(nativeWorker.prototype.terminate, this, Array.from(arguments));
			}
		}
		window.Worker = ObservedWorker;

		const countDraw = (name: string, context: any) => {
			const canvas = context?.canvas;
			if (!(canvas instanceof HTMLCanvasElement) || state.activeRequestId === null) return;
			let record = state.draws.get(canvas);
			if (!record || record.requestId !== state.activeRequestId) {
				record = { requestId: state.activeRequestId, counts: zeroDrawCounts() };
				state.draws.set(canvas, record);
			}
			record.counts[name] = (record.counts[name] || 0) + 1;
		};
		const hookDrawMethods = (prototype: any) => {
			if (!prototype) return;
			for (const name of ['drawArrays', 'drawElements', 'drawRangeElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawArraysInstancedANGLE', 'drawElementsInstancedANGLE']) {
				const original = prototype[name];
				if (typeof original !== 'function' || original.__m2Observed) continue;
				const wrapper = function (this: unknown, ...args: unknown[]) {
					countDraw(name, this);
					return Reflect.apply(original, this, args);
				};
				Object.defineProperty(wrapper, '__m2Observed', { value: true });
				Object.defineProperty(prototype, name, { value: wrapper, configurable: true, writable: true });
			}
		};
		hookDrawMethods(window.WebGLRenderingContext?.prototype);
		hookDrawMethods(window.WebGL2RenderingContext?.prototype);

		(window as any).__m2UiProbe = {
			requests: state.requests,
			resetDraw(canvas: HTMLCanvasElement) {
				resetCanvas(canvas, state.activeRequestId);
				return state.activeRequestId;
			},
			drawInfo(canvas: HTMLCanvasElement) {
				const record = state.draws.get(canvas) || null;
				const rect = canvas.getBoundingClientRect();
				return { requestId: record?.requestId ?? null, counts: record?.counts ?? zeroDrawCounts(), total: record ? Object.values(record.counts).reduce((sum: number, value: any) => sum + value, 0) : 0, connected: canvas.isConnected, cssWidth: rect.width, cssHeight: rect.height, pixelWidth: canvas.width, pixelHeight: canvas.height };
			},
			rememberSession() {
				state.rememberedCanvas = document.querySelector<HTMLCanvasElement>(canvasSelector);
				state.rememberedTitle = document.querySelector<HTMLElement>('.tool-context span')?.textContent ?? '';
			},
			sessionStillMounted() {
				return { sameCanvas: !!state.rememberedCanvas && state.rememberedCanvas === document.querySelector<HTMLCanvasElement>(canvasSelector), sameTitle: state.rememberedTitle === (document.querySelector<HTMLElement>('.tool-context span')?.textContent ?? ''), title: document.querySelector<HTMLElement>('.tool-context span')?.textContent ?? '' };
			},
			async waitForAssetProbes(requestId: number) {
				await state.assetProbePromises.get(requestId);
				return state.assetProbeResults.get(requestId) || [];
			},
			snapshot() {
				return { activeRequestId: state.activeRequestId, requests: state.requests.map((record) => ({ ...record, postedMessages: [...record.postedMessages], messages: [...record.messages], terminals: [...record.terminals], idMismatches: [...record.idMismatches], errors: [...record.errors] })) };
			}
		};
	});
}

export async function captureSourceHashes() {
	const paths = [
		'packages/e4-import/src/bomc-loader.ts',
		'packages/e4-import/src/semantic-colorize.ts',
		'packages/e4-import/src/image-pixel-codec.ts',
		'packages/e4-import/src/types.ts',
		'packages/e4-import/package.json',
		'apps/editor/src/lib/e4-import.worker.ts',
		'apps/editor/src/lib/e4-worker-client.ts',
		'apps/editor/tests/materials-v2.spec.ts',
		'apps/editor/tests/materials-v2-helpers.ts',
		'bun.lock'
	];
	return Object.fromEntries(paths.map((relative) => [relative, shaFile(path.join(editorRoot, relative))]));
}

export function shaFile(filePath: string) { return createHash('sha256').update(readFileSync(filePath)).digest('hex'); }

function parseCompactSections(source: Uint8Array) {
	if (source.byteLength < 32 || !BOMC_MAGIC.every((byte, index) => source[index] === byte)) throw new Error('BOMC header is malformed.');
	const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
	const major = view.getUint16(8, true);
	const minor = view.getUint16(10, true);
	const flags = view.getUint32(16, true);
	const sectionCount = view.getUint32(20, true);
	const directoryOffset = Number(view.getBigUint64(24, true));
	if (major !== 1 || minor !== 2 || (flags & 0x10) === 0 || !Number.isSafeInteger(directoryOffset) || directoryOffset < 32 || directoryOffset + sectionCount * 24 > source.byteLength) {
		throw new Error('BOMC is not the pinned compact BOMC 1.2 format.');
	}
	const entries: CompactSection[] = [];
	for (let index = 0; index < sectionCount; index += 1) {
		let cursor = directoryOffset + index * 24;
		const type = view.getUint16(cursor, true); cursor += 2;
		const codec = view.getUint8(cursor++);
		const flags = view.getUint8(cursor++);
		const offset = view.getUint32(cursor, true); cursor += 4;
		const storedLength = view.getUint32(cursor, true); cursor += 4;
		const rawLength = view.getUint32(cursor, true); cursor += 4;
		const count = view.getUint32(cursor, true); cursor += 4;
		const checksum = view.getUint32(cursor, true);
		if (offset + storedLength > source.byteLength) throw new Error(`BOMC section ${type} exceeds the source file.`);
		entries.push({ index, type, codec, flags, offset, storedLength, rawLength, count, checksum, stored: source.subarray(offset, offset + storedLength) });
	}
	return { directoryOffset, entries };
}

function decodeSection(entry: CompactSection) {
	if (crc32(entry.stored) !== entry.checksum) throw new Error(`BOMC section ${entry.type} CRC is invalid.`);
	if (entry.codec === 0) return Uint8Array.from(entry.stored);
	if (entry.codec === 1) return new Uint8Array(inflateSync(entry.stored));
	throw new Error(`BOMC section ${entry.type} uses unsupported test-fixture codec ${entry.codec}.`);
}

function rebuildCompactContainer(header: Uint8Array, directoryOffset: number, entries: CompactSection[]) {
	let cursor = align8(directoryOffset + entries.length * 24);
	const moved = entries.map((entry) => {
		const result = { ...entry, offset: cursor, storedLength: entry.stored.byteLength, checksum: crc32(entry.stored) };
		cursor = align8(result.offset + result.storedLength);
		return result;
	});
	const output = new Uint8Array(cursor);
	output.set(header.subarray(0, directoryOffset));
	const view = new DataView(output.buffer);
	moved.forEach((entry, index) => {
		let at = directoryOffset + index * 24;
		view.setUint16(at, entry.type, true); at += 2;
		view.setUint8(at++, entry.codec);
		view.setUint8(at++, entry.flags);
		view.setUint32(at, entry.offset, true); at += 4;
		view.setUint32(at, entry.storedLength, true); at += 4;
		view.setUint32(at, entry.rawLength, true); at += 4;
		view.setUint32(at, entry.count, true); at += 4;
		view.setUint32(at, entry.checksum, true);
		output.set(entry.stored, entry.offset);
	});
	return output;
}

function exactArrayBuffer(bytes: Uint8Array) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; }
function equalBytes(first: Uint8Array, second: Uint8Array) { return first.byteLength === second.byteLength && first.every((value, index) => value === second[index]); }
function align8(value: number) { return value + ((8 - value % 8) % 8); }
function assertNested(root: string, target: string) {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Path must be nested in ${root}.`);
}
