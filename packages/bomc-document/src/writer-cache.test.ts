import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { BomcDocument } from './document.js';
import { parseDirectory } from './binary.js';
import { readWebBomc } from './reader.js';
import { BomcWriter } from './writer.js';
import { createColorGraph, createEmptyGraph, createSharedGraph } from './test-fixtures/documents.js';

function hash(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }

function sectionHashes(bytes: Uint8Array) {
	const directory = parseDirectory(bytes, 'web-core');
	return new Map(directory.sections.map((section) => [
		section.type,
		hash(bytes.subarray(section.offset, section.offset + section.storedLength))
	]));
}

function blockNextHash() {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
	const original = globalThis.crypto;
	let signalStarted!: () => void;
	let releaseDigest!: () => void;
	const started = new Promise<void>((resolve) => { signalStarted = resolve; });
	const gate = new Promise<void>((resolve) => { releaseDigest = resolve; });
	const substitute = {
		subtle: {
			async digest(algorithm: AlgorithmIdentifier, bytes: BufferSource) {
				signalStarted();
				await gate;
				return original.subtle.digest(algorithm, bytes);
			}
		}
	};
	Object.defineProperty(globalThis, 'crypto', { configurable: true, enumerable: descriptor?.enumerable ?? false, writable: true, value: substitute });
	return {
		started,
		release: () => releaseDigest(),
		restore() {
			if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
			else Reflect.deleteProperty(globalThis, 'crypto');
		}
	};
}

async function waitForHashStart(started: Promise<void>) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			started,
			new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Writer did not reach the asynchronous SHA-256 stage.')), 5_000); })
		]);
	} finally { if (timer) clearTimeout(timer); }
}

describe('writer revision cache and ownership', () => {
	test('warm write reuses all sections and caller mutation or ArrayBuffer transfer cannot change the private cache', async () => {
		const document = BomcDocument.fromGraph(createSharedGraph());
		const writer = new BomcWriter(document);
		try {
			const cold = await writer.write();
			const warm = await writer.write();
			expect(warm.sha256).toBe(cold.sha256);
			expect(warm.bytes).toEqual(cold.bytes);
			expect(warm.stats.encodedSectionTypes).toEqual([]);
			expect(warm.stats.compressionAttemptTypes).toEqual([]);
			expect(warm.stats.hashMs).toBe(0);
			const originalLength = warm.bytes.byteLength;
			warm.bytes[0] ^= 0xff;
			const warmBuffer = warm.bytes.buffer as ArrayBuffer;
			const transferred = structuredClone(warmBuffer, { transfer: [warmBuffer] });
			expect(transferred.byteLength).toBe(originalLength);
			expect(warm.bytes.byteLength).toBe(0);
			const next = await writer.write();
			expect(next.sha256).toBe(cold.sha256);
			expect(next.bytes).toEqual(cold.bytes);
			expect(next.stats.encodedSectionTypes).toEqual([]);
		} finally {
			writer.dispose();
			document.dispose();
		}
	});

	test('transform-only edit rebuilds model, transforms, and authoring metadata while stored hashes stay fixed elsewhere', async () => {
		const document = BomcDocument.fromGraph(createSharedGraph());
		const writer = new BomcWriter(document);
		let restored: Awaited<ReturnType<typeof readWebBomc>> | null = null;
		try {
			const cold = await writer.write();
			const coldHashes = sectionHashes(cold.bytes);
			const snapshot = document.snapshot();
			const instance = { ...snapshot.graph.instances[1]!, matrix: [...snapshot.graph.instances[1]!.matrix] };
			instance.matrix[12] += 0.25;
			document.transact([{ type: 'put-instance', value: instance }]);
			const updated = await writer.write();
			const updatedHashes = sectionHashes(updated.bytes);
			const changedTypes = [1, 13, 241];
			expect(updated.stats.encodedSectionTypes).toEqual(changedTypes);
			expect(updated.stats.reusedSectionTypes).toEqual(cold.stats.encodedSectionTypes.filter((type) => !changedTypes.includes(type)));
			for (const type of coldHashes.keys()) {
				if (changedTypes.includes(type)) expect(updatedHashes.get(type)).not.toBe(coldHashes.get(type));
				else expect(updatedHashes.get(type)).toBe(coldHashes.get(type));
			}
			restored = await readWebBomc(updated.bytes);
			expect(restored.snapshot().graph.instances[1]!.matrix[12]).toBe(instance.matrix[12]);
			expect(restored.snapshot().revision).toBe(1);
		} finally {
			restored?.dispose();
			writer.dispose();
			document.dispose();
		}
	});

	test('name, material, geometry, and face-ID edits invalidate their locked section closures', async () => {
		const document = BomcDocument.fromGraph(createColorGraph());
		const writer = new BomcWriter(document);
		try {
			await writer.write();
			document.transact([{ type: 'set-name', name: 'Renamed color fixture' }]);
			expect((await writer.write()).stats.encodedSectionTypes).toEqual([1, 2, 3, 6, 11, 12, 241]);

			const material = document.snapshot().graph.materials[0]!;
			document.transact([{ type: 'put-material', value: { ...material, rgba: [154, 28, 49, 255] as const } }]);
			expect((await writer.write()).stats.encodedSectionTypes).toEqual([1, 3, 6, 12, 241]);

			const mesh = document.snapshot().graph.meshes[0]!;
			const positions = [...mesh.positions];
			positions[0] = positions[0]! + 0.25;
			document.transact([{ type: 'put-mesh', value: { ...mesh, positions } }]);
			expect((await writer.write()).stats.encodedSectionTypes).toEqual([1, 5, 6, 7, 8, 9, 14, 17, 241]);

			const updatedMesh = document.snapshot().graph.meshes[0]!;
			const updatedFace = updatedMesh.faces[0]!;
			const faces = updatedMesh.faces.map((face, index) => index === 0 ? { ...face, id: `${face.id}:renamed` } : face);
			document.transact([{ type: 'put-mesh', value: { ...updatedMesh, faces } }]);
			expect((await writer.write()).stats.encodedSectionTypes).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 11, 12, 13, 14, 17, 241]);
			expect(document.snapshot().graph.meshes[0]!.faces[0]!.id).toBe(`${updatedFace.id}:renamed`);
		} finally {
			writer.dispose();
			document.dispose();
		}
	});

	test('observer mutation is isolated to the next snapshot and a failed hash keeps the prior cache', async () => {
		const document = BomcDocument.fromGraph(createSharedGraph());
		const writer = new BomcWriter(document);
		let restored: Awaited<ReturnType<typeof readWebBomc>> | null = null;
		try {
			const baseline = await writer.write();
			let changedDuringObserver = false;
			const snapshotWrite = await writer.write({ onProgress(progress) {
				if (!changedDuringObserver && progress.phase === 'complete') {
					changedDuringObserver = true;
					document.transact([{ type: 'set-name', name: 'Changed after captured snapshot' }]);
				}
			} });
			expect(changedDuringObserver).toBe(true);
			expect(snapshotWrite.revision).toBe(0);
			restored = await readWebBomc(snapshotWrite.bytes);
		expect(restored.snapshot().graph.name).toBe('shared');
			restored.dispose(); restored = null;
			expect(document.snapshot().revision).toBe(1);
			expect((await writer.write()).stats.encodedSectionTypes).toEqual([1, 2, 6, 11, 12, 241]);

			const instance = document.snapshot().graph.instances[1]!;
			document.transact([{ type: 'put-instance', value: { ...instance, matrix: instance.matrix.map((value, index) => index === 12 ? value + 0.25 : value) } }]);
			const controller = new AbortController();
			const blocker = blockNextHash();
			const pending = writer.write({ signal: controller.signal });
			try {
				await waitForHashStart(blocker.started);
				controller.abort();
				blocker.release();
				await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
			} finally {
				blocker.release();
				blocker.restore();
			}
			const afterAbort = await writer.write();
			expect(afterAbort.revision).toBe(2);
			expect(afterAbort.stats.encodedSectionTypes).toEqual([1, 13, 241]);
			expect(afterAbort.sha256).not.toBe(baseline.sha256);
		} finally {
			restored?.dispose();
			writer.dispose();
			document.dispose();
		}
	});

	test('observer exceptions, reentrancy, pre-abort, hash-time disposal, and close never publish partial results', async () => {
		const document = BomcDocument.fromGraph(createEmptyGraph());
		const writer = new BomcWriter(document, { compressionMode: 'store-only' });
		try {
			await expect(writer.write({ onProgress: () => { throw new Error('observer'); } })).rejects.toMatchObject({ code: 'OBSERVER_ERROR' });
			const reentrantCodes: string[] = [];
			const reentrant = await writer.write({ onProgress: () => { void writer.write().catch((error: any) => reentrantCodes.push(error.code)); } });
			expect(reentrant.bytes.length).toBeGreaterThan(0);
			expect(reentrantCodes.length).toBeGreaterThan(0);
			expect(reentrantCodes.every((code) => code === 'BUSY')).toBe(true);
			const controller = new AbortController(); controller.abort();
			await expect(writer.write({ signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
		} finally {
			writer.dispose();
			document.dispose();
		}

		const disposableDocument = BomcDocument.fromGraph(createEmptyGraph());
		const disposableWriter = new BomcWriter(disposableDocument, { compressionMode: 'store-only' });
		const blocker = blockNextHash();
		const pending = disposableWriter.write();
		try {
			await waitForHashStart(blocker.started);
			disposableWriter.dispose();
			blocker.release();
			await expect(pending).rejects.toMatchObject({ code: 'CLOSED' });
			await expect(disposableWriter.write()).rejects.toMatchObject({ code: 'CLOSED' });
		} finally {
			blocker.release();
			blocker.restore();
			disposableWriter.dispose();
			disposableDocument.dispose();
		}
	});
});
