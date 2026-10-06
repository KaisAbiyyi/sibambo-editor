import { BomcDocument } from '../../../packages/bomc-document/src/document.ts';
import { readWebBomc } from '../../../packages/bomc-document/src/reader.ts';
import type { BomcGraph, CompressionMode } from '../../../packages/bomc-document/src/types.ts';
import { createColorGraph, createEmptyGraph, createHoleGraph, createSharedGraph } from '../../../packages/bomc-document/src/test-fixtures/documents.ts';
import { loadE4InWorker } from '../../../apps/editor/src/lib/e4-worker-client.js';
import { PreparedSceneViewport } from '../../../packages/viewport/src/prepared-scene-viewport.ts';

type FixtureId = 'color' | 'hole' | 'shared' | 'empty' | 'B-FACES';
type WorkerRecord = {
	worker: Worker; message: (event: MessageEvent) => void; error: (event: ErrorEvent) => void;
	terminated: boolean; ready: Promise<void>; readySettled: boolean; resolveReady(): void; rejectReady(error: Error): void;
};
type Pending = { id: number; fixture: FixtureId | 'shared'; started: boolean; start?: Record<string, unknown>; events: Record<string, unknown>[]; promise: Promise<any>; resolve(value: any): void; reject(error: Error): void; settlements: number; settled: boolean };
type HostOutput = { byteLength: number; sha256: string; revision: number; compressionMode: CompressionMode; stats: any; startedAtMs: number; completedAtMs: number; bytesBase64?: string; canonicalGraph?: BomcGraph; canonicalRevision?: number; viewport?: any };

declare global {
	interface Window {
		__bomcWriterProof: {
			ready: boolean;
			writeFixture(fixture: FixtureId, options?: { compressionMode?: CompressionMode; mount?: boolean; includeBytes?: boolean }): Promise<HostOutput>;
			writeSequence(fixture: 'shared'): Promise<HostOutput[]>;
			cancelActive(): Promise<Record<string, unknown>>;
			dispatchLateReplyForTest(jobId?: number): Record<string, unknown>;
			observe(): Record<string, unknown>;
			dispose(): Record<string, unknown>;
			snapshot(): Record<string, unknown>;
		}
	}
}

const host = document.querySelector<HTMLElement>('#viewport');
const status = document.querySelector<HTMLElement>('#status');
if (!host || !status) throw new Error('Writer proof harness mount points are missing.');
let workerRecord: WorkerRecord | null = null;
let pendingJob: Pending | null = null;
let nextJobId = 0;
let activeViewport: PreparedSceneViewport | null = null;
let lastCanvas: HTMLCanvasElement | null = null;
let activeFixture: FixtureId | null = null;
let lateIgnoredCount = 0;
let disposed = false;
let currentOutput: HostOutput | null = null;
let workerStarts = 0;
let workerTerminations = 0;
let listenersRemoved = 0;
let viewportDisposals = 0;
const workerTimes: Array<{ id: number; fixture: string; phase: string; startedAtMs: number; completedAtMs?: number; timeOriginMs: number }> = [];
const frameTimes: number[] = [];
const longTasks: Array<{ startTime: number; duration: number }> = [];
let frameLoopHandle = 0;
const smallFactories: Record<'color' | 'hole' | 'shared' | 'empty', () => BomcGraph> = { color: createColorGraph, hole: createHoleGraph, shared: createSharedGraph, empty: createEmptyGraph };
const longTaskObserver = typeof PerformanceObserver === 'undefined' ? null : new PerformanceObserver((list) => {
	for (const entry of list.getEntries()) longTasks.push({ startTime: performance.timeOrigin + entry.startTime, duration: entry.duration });
});
try { longTaskObserver?.observe({ type: 'longtask', buffered: true }); } catch { /* unsupported in the installed Chromium build */ }
const frameLoop = (timestamp: number) => { frameLoopHandle = 0; frameTimes.push(performance.timeOrigin + timestamp); if (frameTimes.length > 20_000) frameTimes.shift(); frameLoopHandle = requestAnimationFrame(frameLoop); };
frameLoopHandle = requestAnimationFrame(frameLoop);

function toBase64(bytes: Uint8Array) {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
	return btoa(binary);
}
function exactBuffer(bytes: Uint8Array) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; }
function errorWithCode(code: string, message: string) { return Object.assign(new Error(message), { code }); }

function dispatchWorkerMessage(message: any) {
	if (message?.type === 'ready') return;
	const pending = pendingJob;
	if (!pending || message?.id !== pending.id || pending.settled) { lateIgnoredCount += 1; return; }
	if (message.type === 'job-start') {
		pending.started = true;
		pending.start = message;
		workerTimes.push({ id: pending.id, fixture: String(message.fixture), phase: String(message.phase), startedAtMs: Number(message.startedAtMs), timeOriginMs: Number(message.timeOriginMs) });
		status!.textContent = `Worker started ${String(message.fixture)}.`;
		return;
	}
	if (message.type === 'progress') { pending.events.push(message); return; }
	if (message.type === 'error') { settle(pending, () => pending.reject(errorWithCode(String(message.code ?? 'INTERNAL_ERROR'), String(message.message ?? 'Writer worker failed.')))); return; }
	if (message.type !== 'result') return;
	try {
		const outputs: any[] = message.outputs ?? [message.output];
		if (!Array.isArray(outputs) || outputs.length === 0) throw new Error('Writer worker returned an empty result list.');
		const normalized = outputs.map((output) => {
			if (!output || !(output.bytes instanceof ArrayBuffer)) throw new Error('Writer worker result did not contain an ArrayBuffer.');
			const bytes = new Uint8Array(output.bytes);
			return { ...output, bytes };
		});
		const terminalAt = Number(normalized.at(-1)?.completedAtMs ?? performance.timeOrigin + performance.now());
		const timing = workerTimes.find((row) => row.id === pending.id);
		if (timing) {
			if (message.outputs?.length) {
				timing.startedAtMs = Number(normalized[0]?.startedAtMs ?? timing.startedAtMs);
				timing.completedAtMs = Number(normalized[0]?.completedAtMs ?? terminalAt);
				for (const output of normalized.slice(1)) workerTimes.push({ id: pending.id, fixture: String(message.fixture), phase: 'write', startedAtMs: Number(output.startedAtMs), completedAtMs: Number(output.completedAtMs), timeOriginMs: Number(output.timeOriginMs) });
			} else timing.completedAtMs = terminalAt;
		}
		settle(pending, () => pending.resolve(normalized));
	} catch (error) {
		settle(pending, () => pending.reject(error instanceof Error ? error : new Error(String(error))));
		const record = workerRecord;
		if (record) terminateWorker(record, false);
	}
}

function settle(pending: Pending, action: () => void) {
	if (pending.settled) return;
	pending.settled = true;
	pending.settlements += 1;
	if (pendingJob === pending) pendingJob = null;
	action();
}

function ensureWorker(): Promise<WorkerRecord> {
	if (disposed) return Promise.reject(errorWithCode('CLOSED', 'Writer proof harness is disposed.'));
	if (workerRecord) {
		const existing = workerRecord;
		return existing.ready.then(() => existing);
	}
	let resolveReady!: () => void;
	let rejectReady!: (error: Error) => void;
	const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
	const worker = new Worker(new URL('./writer.worker.ts', import.meta.url), { type: 'module' });
	const record: WorkerRecord = {
		worker, terminated: false, readySettled: false, resolveReady, rejectReady,
		message: (event) => { if (event.data?.type === 'ready' && !record.readySettled) { record.readySettled = true; resolveReady(); } dispatchWorkerMessage(event.data); },
		error: (event) => {
			const error = new Error(event.message || 'Writer proof worker failed.');
			if (!record.readySettled) { record.readySettled = true; rejectReady(error); }
			const pending = pendingJob;
			if (pending) settle(pending, () => pending.reject(error));
			terminateWorker(record, false);
		},
		ready
	};
	workerRecord = record;
	workerStarts += 1;
	worker.addEventListener('message', record.message);
	worker.addEventListener('error', record.error);
	return ready.then(() => record);
}

function terminateWorker(record: WorkerRecord, postClose: boolean) {
	if (record.terminated) return false;
	record.terminated = true;
	if (!record.readySettled) {
		record.readySettled = true;
		record.rejectReady(errorWithCode('CLOSED', 'Writer proof worker was terminated before its ready handshake.'));
	}
	if (postClose) {
		try { record.worker.postMessage({ type: 'close' }); }
		catch { /* terminate below remains the authoritative cleanup */ }
	}
	record.worker.removeEventListener('message', record.message);
	record.worker.removeEventListener('error', record.error);
	listenersRemoved += 2;
	record.worker.terminate();
	workerTerminations += 1;
	if (workerRecord === record) workerRecord = null;
	return true;
}

async function requestJob(fixture: FixtureId | 'shared', request: Record<string, unknown>) {
	const record = await ensureWorker();
	if (disposed || record.terminated || workerRecord !== record) throw errorWithCode('CLOSED', 'Writer proof worker closed before its job could be dispatched.');
	if (pendingJob) throw errorWithCode('BUSY', `Job ${pendingJob.id} is already active.`);
	const id = ++nextJobId;
	let resolve!: (value: any) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<any>((accept, fail) => { resolve = accept; reject = fail; });
	const pending: Pending = { id, fixture, started: false, events: [], promise, resolve, reject, settlements: 0, settled: false };
	pendingJob = pending;
	try { record.worker.postMessage({ ...request, id }); }
	catch (error) {
		const failure = errorWithCode('INTERNAL_ERROR', `Writer proof request ${id} could not be posted: ${error instanceof Error ? error.message : String(error)}`);
		settle(pending, () => pending.reject(failure));
		terminateWorker(record, false);
	}
	return { id, pending, promise };
}

async function normalizeOutput(output: any, expectedGraph?: BomcGraph, mount = false, includeBytes = true): Promise<HostOutput> {
	const bytes = output.bytes as Uint8Array;
	const digest = await crypto.subtle.digest('SHA-256', exactBuffer(bytes));
	const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
	if (sha256 !== output.sha256 || bytes.byteLength !== output.byteLength) throw new Error('Writer worker output copy differs from the reported length or SHA-256.');
	const normalized: HostOutput = {
		byteLength: output.byteLength, sha256, revision: output.revision, compressionMode: output.compressionMode, stats: output.stats,
		startedAtMs: output.startedAtMs, completedAtMs: output.completedAtMs,
		...(includeBytes ? { bytesBase64: toBase64(bytes) } : {})
	};
	if (expectedGraph) {
		const restored = await readWebBomc(bytes);
		const expected = BomcDocument.fromGraph(expectedGraph);
		try {
			const snapshot = restored.snapshot();
			if (!exactValue(snapshot.graph, expected.snapshot().graph)) throw new Error('Canonical reader output graph differs from its independent fixture graph.');
			normalized.canonicalGraph = snapshot.graph;
			normalized.canonicalRevision = snapshot.revision;
		} finally { restored.dispose(); expected.dispose(); }
	}
	if (mount) normalized.viewport = await mountOutput(bytes, expectedGraph?.name ?? 'generated.bomc');
	currentOutput = normalized;
	return normalized;
}

async function mountOutput(bytes: Uint8Array, sourceName: string) {
	disposeViewport();
	let candidate: PreparedSceneViewport | null = null;
	try {
		const nativeWorker = window.Worker;
		const importWorkerLifecycle = { created: 0, terminated: 0 };
		window.Worker = new Proxy(nativeWorker, {
			construct(target, args, newTarget) {
				const worker = Reflect.construct(target, args, newTarget);
				importWorkerLifecycle.created += 1;
				const terminate = worker.terminate.bind(worker);
				Object.defineProperty(worker, 'terminate', { configurable: true, value() { importWorkerLifecycle.terminated += 1; return terminate(); } });
				return worker;
			}
		});
		let loaded: Awaited<ReturnType<typeof loadE4InWorker>>;
		try { loaded = await loadE4InWorker(exactBuffer(bytes), sourceName, undefined); }
		finally { window.Worker = nativeWorker; }
		candidate = await PreparedSceneViewport.mount(host!, {
			scene: loaded.preparedRuntimeScene, appearance: loaded.appearance, scenes: loaded.scenes,
			activeSceneId: loaded.activeSceneId, clipPlanes: loaded.clipPlanes,
			encodingProfile: loaded.encodingContract?.profile, editorMode: false
		}, '?renderer=webgl2');
		activeViewport = candidate;
		lastCanvas = host!.querySelector('canvas');
		candidate.setDisplayState({ faceStyle: 'shaded-textures', effects: { xray: false, ambientOcclusion: false } });
		for (let frame = 0; frame < 3; frame += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		const captured = candidate.captureWithObservation();
		return { screenshotBase64: captured.screenshot.slice(captured.screenshot.indexOf(',') + 1), observation: captured.observation, canvasFacts: observeWriterCanvas(), sourceName, loaderCounts: loaded.counts, importWorkerLifecycle };
	} catch (error) {
		candidate?.dispose();
		activeViewport = null;
		lastCanvas = null;
		throw error;
	}
}

function observeWriterCanvas() {
	if (!lastCanvas) return null;
	const bounds = lastCanvas.getBoundingClientRect();
	return {
		connected: lastCanvas.isConnected,
		cssWidth: bounds.width,
		cssHeight: bounds.height,
		pixelWidth: lastCanvas.width,
		pixelHeight: lastCanvas.height
	};
}

function disposeViewport() {
	if (!activeViewport) return false;
	activeViewport.dispose();
	activeViewport = null;
	viewportDisposals += 1;
	lastCanvas = null;
	return true;
}

function exactValue(left: unknown, right: unknown): boolean {
	if (typeof left === 'number' || typeof right === 'number') return typeof left === 'number' && typeof right === 'number' && Object.is(left, right);
	if (left === right) return true;
	if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => exactValue(value, right[index]));
	if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord).sort();
	const rightKeys = Object.keys(rightRecord).sort();
	return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && exactValue(leftRecord[key], rightRecord[key]));
}

const api: Window['__bomcWriterProof'] = {
	ready: false,
	async writeFixture(fixture, options = {}) {
		activeFixture = fixture;
		const started = await requestJob(fixture, { type: 'write', fixture, compressionMode: options.compressionMode ?? 'auto', includeBytes: options.includeBytes ?? true });
		const values = await started.promise;
		const factory = fixture === 'B-FACES' ? undefined : smallFactories[fixture];
		return normalizeOutput(values[0], factory?.(), options.mount ?? false, options.includeBytes ?? true);
	},
	async writeSequence(fixture) {
		activeFixture = fixture;
		const started = await requestJob(fixture, { type: 'sequence', fixture });
		const values = await started.promise;
		const expected = createSharedGraph();
		return Promise.all(values.map((value: any, index: number) => {
			const graph = index < 2 ? expected : {
				...expected,
				instances: expected.instances.map((row) => row.id === 'fixture:shared:instance:1'
					? { ...row, matrix: row.matrix.map((entry, position) => position === 12 ? entry + 0.25 : entry) }
					: row)
			};
			return normalizeOutput(value, graph, false, true);
		}));
	},
	async cancelActive() {
		const pending = pendingJob;
		const record = workerRecord;
		if (!pending || !record || !pending.started) throw errorWithCode('INVALID_STATE', 'A running worker job-start handshake is required before cancellation.');
		const jobId = pending.id;
		const cancelled = new Set<number>((window as any).__cancelledWriterJobIds ?? []);
		cancelled.add(jobId); (window as any).__cancelledWriterJobIds = [...cancelled];
		terminateWorker(record, false);
		settle(pending, () => pending.reject(errorWithCode('ABORTED', 'Writer job cancelled by its owning host.')));
		const rejection = await pending.promise.catch((error: any) => ({ code: error.code ?? error.name ?? 'ERROR', message: error.message }));
		return { jobId, rejection, rejectionCode: rejection.code, settlementCount: pending.settlements, terminatedOnce: record.terminated, listenerRemovalCount: listenersRemoved };
	},
	dispatchLateReplyForTest(jobId) {
		const target = jobId ?? Number((window as any).__cancelledWriterJobIds?.at(-1));
		const before = lateIgnoredCount;
		dispatchWorkerMessage({ type: 'result', id: target, output: { bytes: new ArrayBuffer(0) } });
		return { jobId: target, ignored: lateIgnoredCount === before + 1, lateIgnoredCount };
	},
	observe() {
		const times = workerTimes.map((row) => ({ ...row }));
		const completed = times.filter((row) => Number.isFinite(row.completedAtMs));
		const framesDuringWorkerWrites = completed.flatMap((write) => frameTimes.filter((atMs) => atMs >= write.startedAtMs && atMs <= write.completedAtMs!));
		return {
			timeOriginMs: performance.timeOrigin, mainNowMs: performance.timeOrigin + performance.now(),
			workerTimes: times, frameCount: frameTimes.length, framesDuringWorkerWrites, longTasks: [...longTasks],
			activeJobId: pendingJob?.id ?? null, activeJobStarted: pendingJob?.started ?? false,
			workerReady: !!workerRecord, workerStarts, workerTerminations, listenerRemovalCount: listenersRemoved,
			viewportMounted: !!activeViewport, viewportConnected: !!lastCanvas?.isConnected,
			canvasFacts: observeWriterCanvas()
		};
	},
	dispose() {
		disposed = true;
		if (frameLoopHandle) cancelAnimationFrame(frameLoopHandle);
		frameLoopHandle = 0;
		longTaskObserver?.disconnect();
		const pending = pendingJob;
		if (pending) settle(pending, () => pending.reject(errorWithCode('CLOSED', 'Writer proof harness was disposed.')));
		const terminated = workerRecord ? terminateWorker(workerRecord, true) : false;
		const viewportDisposed = disposeViewport();
		return { disposed: true, terminatedWorker: terminated, viewportDisposed, workerStarts, workerTerminations, listenerRemovalCount: listenersRemoved, viewportDisposals };
	},
	snapshot() {
		return {
			ready: api.ready, activeFixture, activeJobId: pendingJob?.id ?? null,
			activeJobStarted: pendingJob?.started ?? false, activeJobStart: pendingJob?.start ?? null,
			activeProgress: pendingJob?.events ?? [],
			workerStarts, workerTerminations, listenerRemovalCount: listenersRemoved, viewportDisposals,
			viewportMounted: !!activeViewport, viewportConnected: !!lastCanvas?.isConnected,
			lateIgnoredCount, currentOutput: currentOutput ? { byteLength: currentOutput.byteLength, sha256: currentOutput.sha256, revision: currentOutput.revision, compressionMode: currentOutput.compressionMode, stats: currentOutput.stats } : null
		};
	}
};

window.__bomcWriterProof = api;
window.addEventListener('pagehide', () => { api.dispose(); }, { once: true });
requestAnimationFrame(() => { api.ready = true; status!.textContent = 'Isolated writer proof harness ready'; });
