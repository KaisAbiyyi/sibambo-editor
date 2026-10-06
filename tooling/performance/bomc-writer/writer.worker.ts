import { BomcDocument } from '../../../packages/bomc-document/src/document.ts';
import { BomcWriter } from '../../../packages/bomc-document/src/writer.ts';
import type { BomcGraph, CompressionMode, DocumentEdit } from '../../../packages/bomc-document/src/types.ts';
import {
	createColorGraph, createEmptyGraph, createFacesBenchmarkGraph, createHoleGraph, createSharedGraph
} from '../../../packages/bomc-document/src/test-fixtures/documents.ts';

type FixtureId = 'color' | 'hole' | 'shared' | 'empty' | 'B-FACES';
type Request =
	| { type: 'write'; id: number; fixture: FixtureId; compressionMode?: CompressionMode; includeBytes?: boolean }
	| { type: 'sequence'; id: number; fixture: 'shared' }
	| { type: 'close' };
type Output = { bytes: ArrayBuffer; byteLength: number; sha256: string; revision: number; compressionMode: CompressionMode; stats: unknown; timeOriginMs: number; startedAtMs: number; completedAtMs: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let document: BomcDocument | null = null;
let writer: BomcWriter | null = null;
let currentFixture: FixtureId | null = null;
let currentMode: CompressionMode | null = null;
let activeJobId: number | null = null;
const factories: Record<FixtureId, () => BomcGraph> = {
	color: createColorGraph,
	hole: createHoleGraph,
	shared: createSharedGraph,
	empty: createEmptyGraph,
	'B-FACES': createFacesBenchmarkGraph
};

function disposeCurrent() {
	writer?.dispose();
	document?.dispose();
	writer = null;
	document = null;
	currentFixture = null;
	currentMode = null;
}

function ensureDocument(fixture: FixtureId, mode: CompressionMode) {
	if (!document || !writer || currentFixture !== fixture || currentMode !== mode) {
		disposeCurrent();
		document = BomcDocument.fromGraph(factories[fixture]());
		writer = new BomcWriter(document, { compressionMode: mode });
		currentFixture = fixture;
		currentMode = mode;
	}
	return { document, writer };
}

function ownedTransfer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes);
	return copy.buffer;
}

async function writeOne(id: number, fixture: FixtureId, mode: CompressionMode, announce = true): Promise<Output> {
	const startedAtMs = performance.timeOrigin + performance.now();
	if (announce) scope.postMessage({ type: 'job-start', id, fixture, phase: 'construct', timeOriginMs: performance.timeOrigin, startedAtMs });
	const current = ensureDocument(fixture, mode);
	const result = await current.writer.write({
		onProgress(progress) {
			scope.postMessage({ type: 'progress', id, fixture, progress, timeOriginMs: performance.timeOrigin, atMs: performance.timeOrigin + performance.now() });
		}
	});
	return {
		bytes: ownedTransfer(result.bytes), byteLength: result.bytes.byteLength, sha256: result.sha256,
		revision: result.revision, compressionMode: mode, stats: result.stats,
		timeOriginMs: performance.timeOrigin, startedAtMs, completedAtMs: performance.timeOrigin + performance.now()
	};
}

scope.addEventListener('message', (event: MessageEvent<Request>) => {
	const request = event.data;
	if (request.type === 'close') {
		disposeCurrent();
		return;
	}
	if (activeJobId !== null) {
		scope.postMessage({ type: 'error', id: request.id, code: 'BUSY', message: `Job ${activeJobId} is already active.` });
		return;
	}
	activeJobId = request.id;
	void (async () => {
		try {
			if (request.type === 'write') {
				const output = await writeOne(request.id, request.fixture, request.compressionMode ?? 'auto');
				scope.postMessage({ type: 'result', id: request.id, fixture: request.fixture, output }, [output.bytes]);
				return;
			}
			const current = ensureDocument('shared', 'auto');
			const cold = await writeOne(request.id, 'shared', 'auto');
			const warm = await writeOne(request.id, 'shared', 'auto', false);
			const graph = current.document.snapshot().graph;
			const moving = graph.instances.find((row) => row.id === 'fixture:shared:instance:1');
			if (!moving) throw new Error('F-SHARED transform target fixture:shared:instance:1 is missing.');
			const matrix = [...moving.matrix];
			matrix[12] = matrix[12]! + 0.25;
			const edits: DocumentEdit[] = [{ type: 'put-instance', value: { ...moving, matrix } }];
			current.document.transact(edits);
			const transformed = await writeOne(request.id, 'shared', 'auto', false);
			const outputs = [cold, warm, transformed];
			scope.postMessage({ type: 'result', id: request.id, fixture: 'shared', outputs }, outputs.map((row) => row.bytes));
		} catch (error) {
			const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : 'INTERNAL_ERROR';
			scope.postMessage({ type: 'error', id: request.id, code, message: error instanceof Error ? error.message : String(error) });
		} finally {
			activeJobId = null;
		}
	})();
});

scope.postMessage({ type: 'ready', timeOriginMs: performance.timeOrigin, readyAtMs: performance.timeOrigin + performance.now() });
