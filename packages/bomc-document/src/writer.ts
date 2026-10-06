import { zlibSync } from 'fflate';
import type { BomcDocumentErrorCode, BomcSnapshot, BomcWriteProgress, BomcWriteResult, CompressionMode } from './types.js';
import { BomcDocument, BomcDocumentError } from './document.js';
import { assembleContainer, crc32, parseDirectory, type StoredSection } from './binary.js';
import { deriveLayout, encodeSection, requiredOutputSectionTypes, type WriterLayout } from './section-codec.js';

type WriterOptions = { compressionMode?: CompressionMode };
type WriteOptions = { signal?: AbortSignal; onProgress?: (progress: BomcWriteProgress) => void };
type CachedSection = StoredSection & { key: string; rawLength: number; bytes: Uint8Array };
type CompleteCache = { revision: number; bytes: Uint8Array; sha256: string; stats: BomcWriteResult['stats'] };
type StageTimes = { validationMs: number; encodeMs: number; compressMs: number; assemblyMs: number; hashMs: number };

function now() { return globalThis.performance?.now?.() ?? Date.now(); }
function abort(signal?: AbortSignal) { if (signal?.aborted) throw new BomcDocumentError('ABORTED', 'BOMC write was aborted.'); }
function closed(value: boolean) { if (value) throw new BomcDocumentError('CLOSED', 'BOMC writer is closed.'); }
function tokenKey(snapshot: BomcSnapshot, type: number): string {
	const { tokens } = snapshot;
	const key = (...parts: number[]) => parts.join(':');
	if (type === 1) return key(tokens.name, tokens.strings, tokens.layout, tokens.materials, tokens.definitions, tokens.instances, tokens.transforms, tokens.geometry);
	if (type === 2) return key(tokens.strings);
	if (type === 3) return key(tokens.materials, tokens.strings, tokens.layout);
	if (type === 5) return key(tokens.geometry, tokens.layout);
	if (type === 6) return key(tokens.geometry, tokens.materials, tokens.strings, tokens.layout);
	if ([7, 8, 9, 14, 17].includes(type)) return key(tokens.geometry, tokens.layout);
	if (type === 11) return key(tokens.definitions, tokens.strings, tokens.layout);
	if (type === 12) return key(tokens.instances, tokens.materials, tokens.strings, tokens.layout);
	if (type === 13) return key(tokens.transforms, tokens.layout);
	if (type === 20) return 'schema:1';
	if (type === 241) return key(snapshot.revision, tokens.strings, tokens.layout);
	throw new BomcDocumentError('INTERNAL_ERROR', `No cache dependency is defined for section ${type}.`);
}
function frozenList(values: number[]) { return Object.freeze([...values].sort((a, b) => a - b)); }
function freezeRecord<T extends Record<string, number>>(record: T): Readonly<T> { return Object.freeze({ ...record }); }
function shaHex(bytes: ArrayBuffer) { return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join(''); }
function ownedBytes(bytes: Uint8Array) { return new Uint8Array(bytes); }
function bufferSetBytes(values: readonly Uint8Array[]) {
	const set = new Set<ArrayBuffer>();
	for (const value of values) set.add(value.buffer as ArrayBuffer);
	return [...set].reduce((sum, buffer) => sum + buffer.byteLength, 0);
}

/** A single-document serializer. Its cached byte arrays never leave this instance. */
export class BomcWriter {
	private readonly document: BomcDocument;
	private readonly mode: CompressionMode;
	private sectionCache = new Map<number, CachedSection>();
	private layoutCache: { key: string; layout: WriterLayout } | null = null;
	private complete: CompleteCache | null = null;
	private active = false;
	private isClosed = false;

	constructor(document: BomcDocument, options: WriterOptions = {}) {
		if (!(document instanceof BomcDocument)) throw new BomcDocumentError('INVALID_DOCUMENT', 'BomcWriter requires a BomcDocument instance.');
		const mode = options.compressionMode ?? 'auto';
		if (mode !== 'auto' && mode !== 'store-only') throw new BomcDocumentError('INVALID_DOCUMENT', 'Unknown compression mode.');
		this.document = document;
		this.mode = mode;
	}

	async write(options: WriteOptions = {}): Promise<BomcWriteResult> {
		closed(this.isClosed);
		if (this.active) throw new BomcDocumentError('BUSY', 'A write is already active on this writer.');
		abort(options.signal);
		this.active = true;
		const callStarted = now();
		try {
			const snapshot = this.document.snapshot();
			if (this.complete?.revision === snapshot.revision) return await this.warmCopy(snapshot, callStarted, options);
			const result = await this.writeCold(snapshot, callStarted, options);
			return result;
		} catch (error) {
			if (error instanceof BomcDocumentError) throw error;
			throw new BomcDocumentError('INTERNAL_ERROR', 'Unexpected BOMC writer failure.', error);
		} finally {
			this.active = false;
		}
	}

	dispose(): void {
		if (this.isClosed) return;
		this.isClosed = true;
		this.sectionCache.clear();
		this.layoutCache = null;
		this.complete = null;
	}

	private notify(callback: WriteOptions['onProgress'], progress: BomcWriteProgress) {
		if (!callback) return;
		try { callback(Object.freeze({ ...progress })); }
		catch (error) { throw new BomcDocumentError('OBSERVER_ERROR', 'BOMC progress observer threw.', error); }
	}

	private check(options: WriteOptions) { closed(this.isClosed); abort(options.signal); }

	private async warmCopy(snapshot: BomcSnapshot, callStarted: number, options: WriteOptions): Promise<BomcWriteResult> {
		const complete = this.complete!;
		const types = requiredOutputSectionTypes(snapshot.graph);
		this.notify(options.onProgress, { phase: 'complete', revision: snapshot.revision, completedSections: types.length, totalSections: types.length });
		this.check(options);
		const bytes = ownedBytes(complete.bytes);
		const stats = Object.freeze({
			...complete.stats,
			encodedSectionTypes: frozenList([]), reusedSectionTypes: frozenList(types), compressionAttemptTypes: frozenList([]),
			validationMs: 0, encodeMs: 0, compressMs: 0, assemblyMs: 0, hashMs: 0,
			totalMs: Math.max(0, now() - callStarted), cacheBytes: this.cacheByteCount(),
			knownPeakBinaryBytes: bufferSetBytes([complete.bytes, bytes, ...[...this.sectionCache.values()].map((entry) => entry.bytes)])
		});
		return Object.freeze({ bytes, sha256: complete.sha256, revision: snapshot.revision, profile: 'exact', stats });
	}

	private async writeCold(snapshot: BomcSnapshot, callStarted: number, options: WriteOptions): Promise<BomcWriteResult> {
		const stages: StageTimes = { validationMs: 0, encodeMs: 0, compressMs: 0, assemblyMs: 0, hashMs: 0 };
		const types = requiredOutputSectionTypes(snapshot.graph);
		const total = types.length;
		const staged = new Map<number, CachedSection>();
		const layoutKey = `${snapshot.tokens.strings}:${snapshot.tokens.layout}`;
		let layout = this.layoutCache?.key === layoutKey ? this.layoutCache.layout : null;
		let completed = 0;
		let validationStart = now();
		this.notify(options.onProgress, { phase: 'validate', revision: snapshot.revision, completedSections: 0, totalSections: total });
		this.check(options);
		if (!layout) layout = deriveLayout(snapshot);
		// BomcDocument admission is the complete graph validator; this pass also
		// forces wire-bound computations before any bytes are staged.
		for (const value of snapshot.graph.meshes) {
			for (const coordinate of value.positions) if (!Number.isFinite(coordinate)) throw new BomcDocumentError('INVALID_DOCUMENT', 'Snapshot contains a non-finite coordinate.');
		}
		stages.validationMs = Math.max(0, now() - validationStart);
		const encodedTypes: number[] = [];
		const reusedTypes: number[] = [];
		const compressionTypes: number[] = [];
		const rawBytes: Record<number, number> = {};
		const storedBytes: Record<number, number> = {};
		let liveCandidates: Uint8Array[] = [];
		let knownPeakBinaryBytes = bufferSetBytes([
			...(this.complete ? [this.complete.bytes] : []),
			...[...this.sectionCache.values()].map((entry) => entry.bytes)
		]);
		const updatePeak = (additional: readonly Uint8Array[] = []) => {
			const retainedOld = [
				...(this.complete ? [this.complete.bytes] : []),
				...[...this.sectionCache.values()].map((entry) => entry.bytes)
			];
			const stagedBuffers = [...staged.values()].map((entry) => entry.bytes);
			knownPeakBinaryBytes = Math.max(knownPeakBinaryBytes, bufferSetBytes([...retainedOld, ...stagedBuffers, ...liveCandidates, ...additional]));
		};
		for (const type of types) {
			this.check(options);
			const key = tokenKey(snapshot, type);
			const cached = this.sectionCache.get(type);
			if (cached?.key === key && cached.codec <= 1) {
				staged.set(type, cached);
				reusedTypes.push(type);
				rawBytes[type] = cached.rawLength;
				storedBytes[type] = cached.bytes.byteLength;
				completed += 1;
				continue;
			}
			this.notify(options.onProgress, { phase: 'encode', revision: snapshot.revision, completedSections: completed, totalSections: total, sectionType: type });
			this.check(options);
			const encodeStart = now();
			const encoded = encodeSection(type, snapshot, layout);
			liveCandidates = [encoded.raw];
			updatePeak();
			stages.encodeMs += Math.max(0, now() - encodeStart);
			encodedTypes.push(type);
			rawBytes[type] = encoded.raw.byteLength;
			let bytes = encoded.raw;
			let codec = 0;
			if (this.mode === 'auto' && encoded.raw.byteLength >= 64) {
				this.notify(options.onProgress, { phase: 'compress', revision: snapshot.revision, completedSections: completed, totalSections: total, sectionType: type });
				this.check(options);
				compressionTypes.push(type);
				const compressStart = now();
				let compressed: Uint8Array;
				try { compressed = zlibSync(encoded.raw, { level: 6 }); }
				catch (error) { throw new BomcDocumentError('INTERNAL_ERROR', `Deflate failed for section ${type}.`, error); }
				stages.compressMs += Math.max(0, now() - compressStart);
				liveCandidates = [encoded.raw, compressed];
				updatePeak();
				if (compressed.byteLength < encoded.raw.byteLength) { bytes = compressed; codec = 1; }
			}
			if (bytes === encoded.raw) liveCandidates = [encoded.raw];
			const privateBytes = ownedBytes(bytes);
			staged.set(type, { type, codec, flags: 0, rawLength: encoded.raw.byteLength, count: encoded.count, bytes: privateBytes, key });
			liveCandidates = [encoded.raw, ...(this.mode === 'auto' && encoded.raw.byteLength >= 64 && bytes !== encoded.raw ? [bytes] : [])];
			updatePeak([privateBytes]);
			storedBytes[type] = privateBytes.byteLength;
			completed += 1;
			liveCandidates = [];
		}
		this.check(options);
		const sectionRows = types.map((type) => staged.get(type)!);
		this.notify(options.onProgress, { phase: 'assemble', revision: snapshot.revision, completedSections: completed, totalSections: total });
		this.check(options);
		const assemblyStart = now();
		const assembled = assembleContainer(sectionRows);
		updatePeak([assembled]);
		const parsed = parseDirectory(assembled, 'web-core');
		for (const descriptor of parsed.sections) {
			const section = sectionRows.find((item) => item.type === descriptor.type)!;
			if (descriptor.count !== section.count || descriptor.rawLength !== section.rawLength || awaitSectionCRC(assembled, descriptor) !== descriptor.crc32) {
				throw new BomcDocumentError('INTERNAL_ERROR', `Generated section ${descriptor.type} did not validate against its staged descriptor.`);
			}
		}
		stages.assemblyMs = Math.max(0, now() - assemblyStart);
		this.check(options);
		this.notify(options.onProgress, { phase: 'hash', revision: snapshot.revision, completedSections: completed, totalSections: total });
		this.check(options);
		const hashStart = now();
		const subtle = globalThis.crypto?.subtle;
		if (!subtle) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'Web Crypto SHA-256 is unavailable.');
		let digest: ArrayBuffer;
		try { digest = await subtle.digest('SHA-256', assembled); }
		catch (error) { throw new BomcDocumentError('INTERNAL_ERROR', 'SHA-256 failed for generated BOMC.', error); }
		stages.hashMs = Math.max(0, now() - hashStart);
		this.check(options);
		const sha256 = shaHex(digest);
		const outputCopy = ownedBytes(assembled);
		updatePeak([assembled, outputCopy]);
		const cacheBytes = bufferSetBytes([...staged.values()].map((entry) => entry.bytes)) + assembled.byteLength;
		const peakBuffers = [assembled, outputCopy, ...[...staged.values()].map((entry) => entry.bytes), ...liveCandidates, ...(this.complete ? [this.complete.bytes] : [])];
		const stats = Object.freeze({
			encodedSectionTypes: frozenList(encodedTypes), reusedSectionTypes: frozenList(reusedTypes), compressionAttemptTypes: frozenList(compressionTypes),
			rawSectionBytes: freezeRecord(rawBytes), storedSectionBytes: freezeRecord(storedBytes), totalBytes: assembled.byteLength, cacheBytes,
			knownPeakBinaryBytes: Math.max(knownPeakBinaryBytes, bufferSetBytes(peakBuffers)), ...stages, totalMs: Math.max(0, now() - callStarted)
		});
		this.notify(options.onProgress, { phase: 'complete', revision: snapshot.revision, completedSections: total, totalSections: total });
		this.check(options);
		// Publication is atomic and happens only after the final observer and cancellation check.
		this.sectionCache = staged;
		this.layoutCache = { key: layoutKey, layout };
		this.complete = { revision: snapshot.revision, bytes: assembled, sha256, stats };
		return Object.freeze({ bytes: outputCopy, sha256, revision: snapshot.revision, profile: 'exact', stats });
	}

	private cacheByteCount() {
		return bufferSetBytes([...this.sectionCache.values()].map((entry) => entry.bytes)) + (this.complete?.bytes.byteLength ?? 0);
	}
}

function awaitSectionCRC(bytes: Uint8Array, descriptor: ReturnType<typeof parseDirectory>['sections'][number]) {
	return crc32(bytes.subarray(descriptor.offset, descriptor.offset + descriptor.storedLength));
}
