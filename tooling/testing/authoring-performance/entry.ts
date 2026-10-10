import { Vector3 } from 'three';
import { readWebBomc } from '@sibambo/bomc-document/reader';
import { AuthoringClient } from '../../../apps/editor/src/lib/authoring/bomc-authoring-client.js';
import { graphsEqual } from '../../../apps/editor/src/lib/authoring/history.js';
import { projectAuthoringScene } from '../../../apps/editor/src/lib/authoring/scene.js';
import { PreparedSceneViewport, type ViewportBounds } from '@sibambo/viewport';
import type { PreparedRuntimeGeometryScene } from '@sibambo/scene-runtime/types';

const workloadBounds: ViewportBounds = {
	min: { x: -1, y: -3, z: -1 },
	max: { x: 16, y: 3, z: 16 }
};

type CommandTiming = {
	kind: 'CREATE_RECTANGLE' | 'EXTRUDE_RECTANGLE';
	dispatchToAckMs: number;
	ackToRenderMs: number;
	revision: number;
	sequence: number;
};

type HarnessState = { viewport: PreparedSceneViewport | null; lastWorkloadEvidence: Record<string, unknown> | null };
const state: HarnessState = { viewport: null, lastWorkloadEvidence: null };

function emptyScene(): PreparedRuntimeGeometryScene {
	return { meshes: [], groups: [], edgeSets: [], solidEdgeSets: [], totalUnits: 0, totalTriangles: 0, totalVertices: 0 };
}

function nextFrame() {
	return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function percentileNearestRank(values: number[], percentile: number) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!;
}

function recordLongTasks() {
	const events: Array<{ startTime: number; durationMs: number }> = [];
	if (typeof PerformanceObserver === 'undefined') return { events, supported: false, dispose: () => undefined };
	const observer = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) events.push({ startTime: entry.startTime, durationMs: entry.duration });
	});
	try {
		observer.observe({ type: 'longtask', buffered: true });
		return { events, supported: true, dispose: () => observer.disconnect() };
	} catch {
		observer.disconnect();
		return { events, supported: false, dispose: () => undefined };
	}
}

async function decodeScreenshot(dataUrl: string) {
	const image = new Image();
	image.src = dataUrl;
	await image.decode();
	const scratch = document.createElement('canvas');
	scratch.width = image.naturalWidth;
	scratch.height = image.naturalHeight;
	const context = scratch.getContext('2d', { willReadFrequently: true });
	if (!context) throw new Error('Canvas2D is unavailable for the positive-draw check.');
	context.drawImage(image, 0, 0);
	return { width: scratch.width, height: scratch.height, data: context.getImageData(0, 0, scratch.width, scratch.height).data };
}

async function changedModelPixelCount(emptyDataUrl: string, populatedDataUrl: string) {
	const [empty, populated] = await Promise.all([decodeScreenshot(emptyDataUrl), decodeScreenshot(populatedDataUrl)]);
	if (empty.width !== populated.width || empty.height !== populated.height) throw new Error('Empty and populated authoring captures have different dimensions.');
	let count = 0;
	for (let offset = 0; offset < empty.data.length; offset += 4) {
		const difference = Math.max(
			Math.abs(empty.data[offset]! - populated.data[offset]!),
			Math.abs(empty.data[offset + 1]! - populated.data[offset + 1]!),
			Math.abs(empty.data[offset + 2]! - populated.data[offset + 2]!)
		);
		if (difference > 5) count += 1;
	}
	return count;
}

async function mountViewport() {
	state.viewport?.dispose();
	state.viewport = null;
	const host = document.querySelector<HTMLElement>('#viewport');
	if (!host) throw new Error('Authoring performance viewport host is missing.');
	host.replaceChildren();
	const viewport = await PreparedSceneViewport.mount(host, { scene: emptyScene(), encodingProfile: 'exact', editorMode: true }, '?renderer=webgl2');
	state.viewport = viewport;
	try {
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let timeoutId: number;
			const cleanup = () => {
				window.clearTimeout(timeoutId);
				viewport.setOnReady(undefined);
			};
			const fail = (error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const ready = () => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve();
			};
			timeoutId = window.setTimeout(() => fail(new Error('PreparedSceneViewport did not become ready within 120000 ms.')), 120_000);
			try { viewport.setOnReady(ready); }
			catch (error) { fail(error); }
		});
		if (!host.querySelector('canvas') || !host.contains(host.querySelector('canvas'))) throw new Error('PreparedSceneViewport canvas is not connected.');
		viewport.viewBounds('iso', workloadBounds);
		return viewport;
	} catch (error) {
		viewport.setOnReady(undefined);
		viewport.dispose();
		if (state.viewport === viewport) state.viewport = null;
		throw error;
	}
}

function applyProjection(viewport: PreparedSceneViewport, snapshot: NonNullable<AuthoringClient['checkpoint']>['snapshot']) {
	const projection = projectAuthoringScene(snapshot, viewport.getDisplayState());
	viewport.setDomainOverlay('authoring-content', projection.group);
	viewport.setAuthoringBounds(projection.bounds);
}

async function projectAndRender(viewport: PreparedSceneViewport, snapshot: NonNullable<AuthoringClient['checkpoint']>['snapshot']) {
	applyProjection(viewport, snapshot);
	await nextFrame();
	const captured = viewport.captureWithObservation();
	if (!captured.screenshot.startsWith('data:image/png;base64,')) throw new Error('PreparedSceneViewport did not return its real PNG capture.');
	if (captured.observation.viewport.pixelRatio !== 1) throw new Error(`Expected DPR 1, got ${captured.observation.viewport.pixelRatio}.`);
	if (captured.observation.backend !== 'webgl2') throw new Error(`Expected WebGL2, got ${captured.observation.backend}.`);
	return { renderedAt: performance.now(), capture: captured };
}

function orbitPose(index: number, center = new Vector3(7.5, 0, 7.5)) {
	const radius = 27;
	const angle = index * Math.PI / 90;
	return {
		position: center.clone().add(new Vector3(Math.cos(angle) * radius, 12, Math.sin(angle) * radius)),
		target: center.clone()
	};
}

async function measureIdleOrbit(viewport: PreparedSceneViewport, frameCount: number) {
	const completed: number[] = [];
	for (let index = 0; index < frameCount; index += 1) {
		await nextFrame();
		viewport.setCameraPose(orbitPose(index));
		completed.push(performance.now());
	}
	return completed.slice(1).map((time, index) => time - completed[index]!);
}

async function writeWhileOrbiting(client: AuthoringClient, viewport: PreparedSceneViewport) {
	const frameCompleted: number[] = [];
	let writeSettled = false;
	let writeCompletedAt: number | null = null;
	const writeStarted = performance.now();
	const writePromise = client.write().then((value) => {
		writeSettled = true;
		writeCompletedAt = performance.now();
		return value;
	}, (error: unknown) => {
		writeSettled = true;
		writeCompletedAt = performance.now();
		throw error;
	});
	let frameIndex = 0;
	while (!writeSettled) {
		await nextFrame();
		if (writeCompletedAt !== null && performance.now() >= writeCompletedAt) break;
		viewport.setCameraPose(orbitPose(frameIndex++));
		const renderedAt = performance.now();
		if (renderedAt > writeStarted && (writeCompletedAt === null || renderedAt < writeCompletedAt)) frameCompleted.push(renderedAt);
	}
	const result = await writePromise;
	return {
		result,
		writeStarted,
		writeCompleted: writeCompletedAt ?? performance.now(),
		frameTimestampsMs: frameCompleted,
		frameIntervalsMs: frameCompleted.slice(1).map((time, index) => time - frameCompleted[index]!)
	};
}

async function runWorkload() {
	const observer = recordLongTasks();
	const commandTimings: CommandTiming[] = [];
	const partialEvidence: Record<string, unknown> = {
		status: 'running', phase: 'mount', commandTimings, rectangleAcks: 0, extrusionAcks: 0
	};
	state.lastWorkloadEvidence = partialEvidence;
	const client = new AuthoringClient();
	let viewport: PreparedSceneViewport | null = null;
	try {
		viewport = await mountViewport();
		partialEvidence.phase = 'empty-viewport-capture';
		await nextFrame();
		const emptyCapture = viewport.captureWithObservation();
		partialEvidence.phase = 'create-document';
		await client.create();
		let checkpoint = client.checkpoint;
		if (!checkpoint) throw new Error('Authoring CREATE did not produce an acknowledged checkpoint.');
		let render = await projectAndRender(viewport, checkpoint.snapshot);
		const entityIds: string[] = [];

		for (let index = 0; index < 100; index += 1) {
			partialEvidence.phase = `rectangle-${index + 1}`;
			const x = (index % 10) * 1.5;
			const z = Math.floor(index / 10) * 1.5;
			const dispatchAt = performance.now();
			const result = await client.command({ kind: 'CREATE_RECTANGLE', first: [x, 0, z], opposite: [x + 1.2, 0, z + 1.1] });
			const ackAt = performance.now();
			const entityId = result.commandResult?.entityId;
			if (!entityId) throw new Error(`Rectangle ${index} ACK omitted its canonical entity id.`);
			entityIds.push(entityId);
			checkpoint = result.checkpoint;
			render = await projectAndRender(viewport, checkpoint.snapshot);
			commandTimings.push({ kind: 'CREATE_RECTANGLE', dispatchToAckMs: ackAt - dispatchAt, ackToRenderMs: render.renderedAt - ackAt, revision: checkpoint.snapshot.revision, sequence: checkpoint.sequence });
			partialEvidence.rectangleAcks = index + 1;
		}

		for (let index = 0; index < 100; index += 1) {
			partialEvidence.phase = `extrusion-${index + 1}`;
			const dispatchAt = performance.now();
			const result = await client.command({ kind: 'EXTRUDE_RECTANGLE', entityId: entityIds[index]!, distance: index % 2 === 0 ? 2.7 : -2.7 });
			const ackAt = performance.now();
			checkpoint = result.checkpoint;
			render = await projectAndRender(viewport, checkpoint.snapshot);
			commandTimings.push({ kind: 'EXTRUDE_RECTANGLE', dispatchToAckMs: ackAt - dispatchAt, ackToRenderMs: render.renderedAt - ackAt, revision: checkpoint.snapshot.revision, sequence: checkpoint.sequence });
			partialEvidence.extrusionAcks = index + 1;
		}

		partialEvidence.phase = 'idle-orbit';
		const idleOrbitFrameIntervalsMs = await measureIdleOrbit(viewport, 24);
		partialEvidence.phase = 'first-write-and-camera';
		const concurrentWrite = await writeWhileOrbiting(client, viewport);
		const write = concurrentWrite.result;
		const firstBlobStarted = performance.now();
		const outputBlob = new Blob([write.ownedBuffer], { type: 'application/octet-stream' });
		const firstBlobConstructionMs = performance.now() - firstBlobStarted;
		const firstAck = await client.acknowledgeDownload(write.writeId, write.revision);
		if (firstAck.dirty) throw new Error('First WRITE acknowledgment did not mark the exact current graph clean.');

		const warmWriteStarted = performance.now();
		const warmWrite = await client.write();
		const warmWriteRoundTripMs = performance.now() - warmWriteStarted;
		const reopened = await readWebBomc(new Uint8Array(warmWrite.ownedBuffer.slice(0)));
		let roundTripGraphEqual = false;
		try { roundTripGraphEqual = graphsEqual(reopened.snapshot().graph, client.checkpoint!.snapshot.graph); }
		finally { reopened.dispose(); }
		const warmAck = await client.acknowledgeDownload(warmWrite.writeId, warmWrite.revision);
		if (warmAck.dirty) throw new Error('Warm WRITE acknowledgment did not mark the exact current graph clean.');
		const positivePixels = await changedModelPixelCount(emptyCapture.screenshot, render.capture.screenshot);
		const orbitDuringWriteMs = concurrentWrite.writeCompleted - concurrentWrite.writeStarted;
		const idleMedian = percentileNearestRank(idleOrbitFrameIntervalsMs, 0.5);
		const idleP95 = percentileNearestRank(idleOrbitFrameIntervalsMs, 0.95);
		const writingP95 = percentileNearestRank(concurrentWrite.frameIntervalsMs, 0.95);
		const writeSpansTwoIdleFrames = idleMedian !== null && orbitDuringWriteMs >= 2 * idleMedian;
		const frameDuringWriteObserved = concurrentWrite.frameTimestampsMs.some((time) => time > concurrentWrite.writeStarted && time < concurrentWrite.writeCompleted);
		await nextFrame();
		const writeLongTasks = observer.events.filter((event) => event.startTime < concurrentWrite.writeCompleted && event.startTime + event.durationMs > concurrentWrite.writeStarted);

		const report = {
			viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio, backend: render.capture.observation.backend, pixelRatio: render.capture.observation.viewport.pixelRatio },
			entities: { rectangles: entityIds.length, extrusions: commandTimings.filter((row) => row.kind === 'EXTRUDE_RECTANGLE').length, finalRevision: checkpoint.snapshot.revision, finalSequence: checkpoint.sequence },
			commands: {
				count: commandTimings.length,
				p95DispatchToAckMs: percentileNearestRank(commandTimings.map((row) => row.dispatchToAckMs), 0.95),
				p95AckToRenderMs: percentileNearestRank(commandTimings.map((row) => row.ackToRenderMs), 0.95),
				timings: commandTimings
			},
			writes: {
				firstBytes: write.length,
				firstSha256: write.sha256,
				firstWorkerMs: write.stats.totalMs,
				firstBlobConstructionMs,
				firstBlobBytes: outputBlob.size,
				writeDurationMs: orbitDuringWriteMs,
				framesDuringWrite: concurrentWrite.frameTimestampsMs.length,
				frameDuringWriteStatus: writeSpansTwoIdleFrames ? (frameDuringWriteObserved ? 'observed' : 'missing-required-frame') : 'not-measurable-short-write',
				cameraDuringWriteStatus: writeSpansTwoIdleFrames
					? (writingP95 !== null && idleP95 !== null ? 'measured' : 'insufficient-frame-samples')
					: 'not-measurable-short-write',
				frameIntervalsMs: concurrentWrite.frameIntervalsMs,
				idleOrbitFrameIntervalsMs,
				idleOrbitP95Ms: idleP95,
				writeOrbitP95Ms: writingP95,
				warmWriteRoundTripMs,
				warmWorkerMs: warmWrite.stats.totalMs,
				warmSha256: warmWrite.sha256,
				warmBytes: warmWrite.length,
				warmReusedSectionTypes: warmWrite.stats.reusedSectionTypes,
				warmCacheBytes: warmWrite.stats.cacheBytes,
				roundTripGraphEqual
			},
			positivePixels,
			longTasks: { supported: observer.supported, events: observer.events, overlappingWrite: writeLongTasks }
		};
		Object.assign(partialEvidence, report, { status: 'complete', phase: 'complete' });
		return report;
	} catch (error) {
		Object.assign(partialEvidence, {
			status: 'failed',
			error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
			longTasks: { supported: observer.supported, events: observer.events }
		});
		throw error;
	} finally {
		observer.dispose();
		if (viewport) viewport.dispose();
		state.viewport = null;
		await client.close().catch(() => undefined);
	}
}

async function runCrashRecovery() {
	let faultWorker: Worker | null = null;
	const client = new AuthoringClient({
		workerFactory: () => {
			faultWorker = new Worker(new URL('./authoring-fault.worker.ts', import.meta.url), { type: 'module' });
			return faultWorker;
		}
	});
	try {
		await client.create();
		const acknowledged = await client.command({ kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [1.2, 0, 1.1] });
		const checkpoint = acknowledged.checkpoint;
		faultWorker?.postMessage({ proofControl: 'arm-one-worker-fault' });
		let failedCommandRejected = false;
		try {
			await client.command({ kind: 'EXTRUDE_RECTANGLE', entityId: acknowledged.commandResult!.entityId, distance: 2.7 });
		} catch {
			failedCommandRejected = true;
		}
		const deadline = performance.now() + 10_000;
		while (performance.now() < deadline && client.isRestoring) await new Promise<void>((resolve) => setTimeout(resolve, 10));
		const restored = client.checkpoint;
		const exactGraph = Boolean(restored && graphsEqual(restored.snapshot.graph, checkpoint.snapshot.graph));
		const exactHistory = Boolean(restored && JSON.stringify(restored.history) === JSON.stringify(checkpoint.history));
		const exactIdentity = Boolean(restored && restored.snapshot.revision === checkpoint.snapshot.revision && restored.sequence === checkpoint.sequence);
		const restoreError = client.restoreError?.message ?? null;
		return { failedCommandRejected, exactGraph, exactHistory, exactIdentity, isRestoring: client.isRestoring, restoreError };
	} finally {
		await client.close().catch(() => undefined);
	}
}

async function runAbortRecovery() {
	const client = new AuthoringClient();
	try {
		await client.create();
		for (let index = 0; index < 100; index += 1) {
			const x = (index % 10) * 1.5;
			const z = Math.floor(index / 10) * 1.5;
			await client.command({ kind: 'CREATE_RECTANGLE', first: [x, 0, z], opposite: [x + 1.2, 0, z + 1.1] });
		}
		const checkpoint = client.checkpoint;
		if (!checkpoint) throw new Error('Abort recovery fixture has no acknowledged checkpoint.');
		const controller = new AbortController();
		let writeProgressObserved = false;
		let writeRejected = false;
		try {
			await client.write({
				signal: controller.signal,
				onProgress: () => {
					writeProgressObserved = true;
					controller.abort();
				}
			});
		} catch {
			writeRejected = true;
		}
		const deadline = performance.now() + 10_000;
		while (performance.now() < deadline && client.isRestoring) await new Promise<void>((resolve) => setTimeout(resolve, 10));
		const restored = client.checkpoint;
		return {
			writeProgressObserved,
			writeRejected,
			exactGraph: Boolean(restored && graphsEqual(restored.snapshot.graph, checkpoint.snapshot.graph)),
			exactHistory: Boolean(restored && JSON.stringify(restored.history) === JSON.stringify(checkpoint.history)),
			exactIdentity: Boolean(restored && restored.snapshot.revision === checkpoint.snapshot.revision && restored.sequence === checkpoint.sequence),
			isRestoring: client.isRestoring,
			restoreError: client.restoreError?.message ?? null
		};
	} finally {
		await client.close().catch(() => undefined);
	}
}

const harness = { runWorkload, runCrashRecovery, runAbortRecovery, lastWorkloadEvidence: () => state.lastWorkloadEvidence };
Object.assign(window, { __editorAuthoringPerformanceHarness: harness });

declare global {
	interface Window { __editorAuthoringPerformanceHarness: typeof harness }
}
