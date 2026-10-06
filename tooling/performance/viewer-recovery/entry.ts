import { InstancedMesh, Matrix4, Mesh, OrthographicCamera, PerspectiveCamera, Raycaster, Scene, Vector2, Vector3, type Object3D } from 'three';
import type { PreparedRuntimeGeometryScene } from '@sibambo/scene-runtime/types';
import { prepareApplicationRenderScene } from '@sibambo/scene-runtime';
import { PreparedSceneViewport, type CameraDragSnapshot, type CameraPose } from '@sibambo/viewport';
import { BomcLoader } from '@sibambo/e4-import/bomc-loader';
import { loadE4InWorker } from '../../../apps/editor/src/lib/e4-worker-client.js';

type FixtureId = 'S1-new' | 'S2-new' | 'S2-jcm';
type QueryHit = { point: [number, number, number]; distance: number; recordIndex: number; instanceIndex: number; faceIndex: number; sourceMeshIndex: number | null };
type RawQueryHit = { point: Vector3; distance: number; recordIndex: number; instanceIndex: number; faceIndex: number };
type MeshRecordView = {
	mesh: InstancedMesh; sourceMeshIndex: number; definitionIndex: number; materialId: string; navigationVisible: boolean;
	visibleOccurrenceIndices: Set<number>; occurrenceHandles?: string[]; sourceOccurrenceIndices: number[];
	baseMatrices: Float32Array; occurrenceHierarchyIndices?: Uint32Array; occurrenceInstanceIndices?: Uint32Array | number[];
	geometryGroupIndex: number; sourceFaceIndicesByTriangle?: Uint32Array; visibleSourceFaceIndicesByTriangle?: Uint32Array;
	sourceTagIndicesByTriangle?: Uint32Array; fullSourceFaceIndicesByTriangle?: Uint32Array;
};
type OracleDrawRecord = { mesh: Mesh; sourceRecord: MeshRecordView; recordIndex: number; localOccurrenceIndex: number; parent: Scene };
type EdgeRecordView = { lines: { visible: boolean; geometry: { getAttribute(name: string): { array: ArrayLike<number>; needsUpdate?: boolean } } }; basePositions: Float32Array; segmentStartsByOccurrence: Map<string, number[]> };
type NavigationQueryView = { query: (...args: any[]) => RawQueryHit | null };
type InternalViewport = {
	scene3d: Scene;
	navigationQuery: NavigationQueryView;
	meshRecords: MeshRecordView[];
	edgeRecords: EdgeRecordView[];
	activeClipPlanes: Array<{ }>; // The test delegate passes these through without editing them.
	canvas: HTMLCanvasElement;
		rendererHost: {
			camera: PerspectiveCamera | OrthographicCamera;
			controls: { target: Vector3 };
			setCamera(camera: PerspectiveCamera | OrthographicCamera): void;
			renderNow(): void;
		};
	automaticNavigation: { pointers: Map<number, unknown>; capturedPointers: Set<number> };
};
type Instrumentation = {
	restore(): void;
	lastHit: QueryHit | null;
	queryMs: number[];
	currentDrag: { tool: string; sceneEpoch: number; position: number[]; target: number[]; orbitAnchor: number[] } | null;
	counts: { begins: number; drags: number; ends: number; zooms: number };
};

const fixturePins: Record<FixtureId, { bytes: number; sha256: string }> = {
	'S1-new': { bytes: 2_428_754, sha256: 'd306fb89c0a59edf5ecdbcaf26d27e795e521cceb1c689e59958e1038932918c' },
	'S2-new': { bytes: 2_319_634, sha256: 'df19a9f07df845661d065b98b221dbcfc53e9ec2c3efe7a11f434b7fcb0ac452' },
	'S2-jcm': { bytes: 3_354_834, sha256: '39851b73848aa42cb742e1be6230965327a41c31ec6b1051848304ac09faf637' }
};

let viewport: PreparedSceneViewport | null = null;
let oracleViewport: PreparedSceneViewport | null = null;
let oracleResult: any = null;
let oracleDraws: OracleDrawRecord[] = [];
let oracleBaseMeshes: InstancedMesh[] = [];
let oracleInputScene: PreparedRuntimeGeometryScene | null = null;
let doorLineVisibility: Array<{ viewport: PreparedSceneViewport; values: boolean[] }> = [];
let candidateMirrorScene: PreparedRuntimeGeometryScene | null = null;
let rawMirrorScene: PreparedRuntimeGeometryScene | null = null;
let mirrorOffset: [number, number, number] = [0, 0, 0];
let currentFixture: { id: FixtureId | 'HOLLOW-open' | 'HOLLOW-closed'; sha256?: string; sourceBytes?: number; result?: any; sourceLabels?: Record<number, string>; workerLifecycle?: { created: number; terminated: number; urls: string[] } } | null = null;
let instrumentation: Instrumentation | null = null;
let lastCanvas: HTMLCanvasElement | null = null;
const status = document.querySelector<HTMLElement>('#status');

declare global {
	interface Window {
		__viewerRecovery: {
			ready: boolean;
			initializeHollow(closedExterior?: boolean): Promise<unknown>;
			loadFixture(id: FixtureId): Promise<unknown>;
			loadRawFixture(id: FixtureId): Promise<unknown>;
			prepareDoorComparison(): Promise<unknown>;
			waitDoorReady(timeoutMs?: number): Promise<unknown>;
			doorSnapshot(): unknown;
			probeOrdinaryOracleVisibility(): unknown;
			captureDoorPose(position: [number, number, number], target: [number, number, number]): Promise<unknown>;
			setDoorSourceLinesVisible(visible: boolean): unknown;
			captureRepeatedDoorPose(position: [number, number, number], target: [number, number, number]): Promise<unknown>;
			comparePixelCaptures(candidate: string, oracle: string): Promise<unknown>;
			runMirrorFixture(): Promise<unknown>;
			captureMirrorFace(face: 'front' | 'back'): Promise<unknown>;
			mirrorPick(handle: string, localPoint: [number, number, number]): unknown;
			mirrorFilter(handle: string | null): unknown;
			mirrorEdgeSnapshot(handle: string): unknown;
			mirrorMove(handle: string, offset: [number, number, number] | null): unknown;
			mirrorState(): unknown;
			loadS1SourceComparison(): Promise<unknown>;
			disposeOracle(): unknown;
			setPose(position: [number, number, number], target: [number, number, number]): unknown;
			setOrthographic(): unknown;
			pose(): unknown;
			observation(): unknown;
			beginOrbit(): unknown;
			centerHit(): unknown;
			dispatchWheel(deltaY: number, clientX?: number, clientY?: number): unknown;
			dispatchWheelBurst(count: number, deltaY: number, clientX?: number, clientY?: number): unknown;
			walkThroughExterior(maxEvents?: number): unknown;
			walkThroughDoorway(maxEvents?: number): unknown;
			measureWheelBurst(count?: number, deltaY?: number): unknown;
			verifyDoorOpening(): unknown;
			waitFrames(count?: number): Promise<void>;
			snapshot(): unknown;
			dispose(): unknown;
			disposeAndVerifyPostInput(): unknown;
		};
	}
}

const api: Window['__viewerRecovery'] = {
	ready: false,
	loadS1SourceComparison() { return loadS1SourceComparison(); },
	disposeOracle() { disposeOracle(); },
	async initializeHollow(closedExterior = false) {
		await replaceViewport(buildHollowScene(closedExterior), undefined, []);
		currentFixture = { id: closedExterior ? 'HOLLOW-closed' : 'HOLLOW-open', sourceLabels: labelsForHollow(closedExterior) };
		await waitFrames(2);
		api.setPose([-5, 1.6, 5], [10, 1.6, 5]);
		setStatus(`${currentFixture.id} ready`);
		return api.snapshot();
	},
	async loadFixture(id) {
		const pin = fixturePins[id];
		const response = await fetch(`/__fixture__/${encodeURIComponent(id)}`, { cache: 'no-store' });
		if (!response.ok) throw new Error(`${id} pinned fixture request returned ${response.status}.`);
		const buffer = await response.arrayBuffer();
		const sourceBytes = buffer.byteLength;
		const sha256 = await digestSha256(buffer);
		if (sourceBytes !== pin.bytes || sha256 !== pin.sha256) throw new Error(`${id} fixture identity mismatch: ${sourceBytes}/${sha256}.`);
		setStatus(`Loading ${id} with the Editor E4 worker…`);
		const nativeWorker = window.Worker;
		const workerLifecycle = { created: 0, terminated: 0, urls: [] as string[] };
		window.Worker = new Proxy(nativeWorker, {
			construct(target, args, newTarget) {
				const worker = Reflect.construct(target, args, newTarget);
				workerLifecycle.created += 1;
				workerLifecycle.urls.push(String(args[0]));
				const terminate = worker.terminate.bind(worker);
				Object.defineProperty(worker, 'terminate', {
					configurable: true,
					value() {
						workerLifecycle.terminated += 1;
						return terminate();
					}
				});
				return worker;
			}
		});
		let result: Awaited<ReturnType<typeof loadE4InWorker>>;
		try {
			result = await loadE4InWorker(buffer, `PROJECT SBOOST ${id === 'S2-new' || id === 'S2-jcm' ? '2' : '1'}.skp`);
		} finally {
			window.Worker = nativeWorker;
		}
		await replaceViewport(result.preparedRuntimeScene, result.appearance, result.scenes, result.activeSceneId, result.clipPlanes, result.encodingContract?.profile);
		currentFixture = { id, sourceBytes, sha256, result, workerLifecycle };
		await waitFrames(2);
		setStatus(`${id} worker result mounted`);
		return api.snapshot();
	},
	async loadRawFixture(id) {
		const loaded = await loadPinnedRawFixture(id);
		oracleResult = loaded;
		oracleInputScene = loaded.preparedRuntimeScene as PreparedRuntimeGeometryScene;
		return rawSourceSummary(id, loaded);
	},
	async prepareDoorComparison() {
		if (currentFixture?.id !== 'S2-new' || !currentFixture.result) throw new Error('Load S2-new through the Editor worker before preparing the raw door oracle.');
		disposeOracle();
		const loaded = await loadPinnedRawFixture('S2-new');
		oracleResult = loaded;
		oracleInputScene = loaded.preparedRuntimeScene as PreparedRuntimeGeometryScene;
		const host = document.querySelector<HTMLElement>('#oracle-viewer');
		if (!host) throw new Error('Ordinary-render oracle host is missing.');
		oracleViewport = await PreparedSceneViewport.mount(host, {
			scene: oracleInputScene, appearance: loaded.appearance, scenes: loaded.scenes,
			activeSceneId: loaded.activeSceneId, clipPlanes: loaded.clipPlanes,
			encodingProfile: loaded.encodingContract?.profile, editorMode: false
		}, '?renderer=webgl2');
		oracleViewport.setDisplayState({ faceStyle: 'shaded-textures', effects: { xray: false, ambientOcclusion: false } });
		replaceVisibleOracleInstancedDraws();
		await waitFrames(2);
		return { candidate: api.observation(), oracle: observeOracleViewport(), inventory: { candidate: await inventoryDraws(viewport!, currentFixture.result.preparedRuntimeScene, 'candidate-instanced'), oracle: await inventoryDraws(oracleViewport, oracleInputScene, 'oracle-ordinary') } };
	},
	async waitDoorReady(timeoutMs = 30_000) {
		const deadline = performance.now() + timeoutMs;
		while (performance.now() < deadline) {
			const candidate = observeViewport();
			const oracle = observeOracleViewport();
			if (candidate?.firstFrameAtMs !== null && candidate?.readyAtMs !== null && oracle?.firstFrameAtMs !== null && oracle?.readyAtMs !== null) {
			return { candidate, oracle, inventory: { candidate: await inventoryDraws(viewport!, currentFixture!.result.preparedRuntimeScene, 'candidate-instanced'), oracle: await inventoryDraws(oracleViewport!, oracleInputScene!, 'oracle-ordinary') } };
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
		}
		throw new Error(`Candidate/raw S2 viewports did not both reach appearance-ready within ${timeoutMs}ms.`);
	},
	async doorSnapshot() {
		if (!viewport || !oracleViewport || !currentFixture?.result || !oracleInputScene) throw new Error('Prepare both S2 door viewports before capturing an inventory.');
		return {
			fixture: { ...fixturePins['S2-new'], candidateBytes: currentFixture.sourceBytes, candidateSha256: currentFixture.sha256, rawSourceBytes: oracleResult?.diagnostics?.sourceFileBytes ?? null },
			candidate: observeViewport(), oracle: observeOracleViewport(),
			candidateInventory: await inventoryDraws(viewport, currentFixture.result.preparedRuntimeScene, 'candidate-instanced'),
			oracleInventory: await inventoryDraws(oracleViewport, oracleInputScene, 'oracle-ordinary')
		};
	},
	probeOrdinaryOracleVisibility() { return probeOrdinaryOracleVisibility(); },
	async captureDoorPose(position, target) {
		if (!viewport || !oracleViewport) throw new Error('Prepare both S2 door viewports before capture.');
		const candidate = await captureViewportPose(viewport, position, target);
		const oracle = await captureViewportPose(oracleViewport, position, target);
		return { candidate, oracle, cameraNearFar: { candidate: candidate.observation.camera, oracle: oracle.observation.camera } };
	},
	setDoorSourceLinesVisible(visible) {
		if (!viewport || !oracleViewport) throw new Error('Prepare both S2 door viewports before changing diagnostic source-line visibility.');
		const targets = [viewport, oracleViewport];
		if (!doorLineVisibility.length) doorLineVisibility = targets.map((target) => ({ viewport: target, values: requireInternalFor(target).edgeRecords.map((record) => record.lines.visible) }));
		for (const target of targets) {
			const internal = requireInternalFor(target);
			for (const record of internal.edgeRecords) record.lines.visible = visible;
			internal.rendererHost.renderNow();
		}
		if (visible) restoreDoorLineVisibility();
		return { visible, candidateLines: requireInternalFor(viewport).edgeRecords.length, oracleLines: requireInternalFor(oracleViewport).edgeRecords.length };
	},
	async captureRepeatedDoorPose(position, target) {
		if (!viewport || !oracleViewport) throw new Error('Prepare both S2 door viewports before repeated capture.');
		const candidate: string[] = [];
		const oracle: string[] = [];
		for (let index = 0; index < 3; index += 1) {
			candidate.push((await captureViewportPose(viewport, position, target)).screenshotBase64);
			oracle.push((await captureViewportPose(oracleViewport, position, target)).screenshotBase64);
		}
		return { candidate, oracle };
	},
	async comparePixelCaptures(candidate, oracle) { return comparePixelCaptures(candidate, oracle); },
	async runMirrorFixture() {
		await prepareMirrorFixture();
		return api.mirrorState();
	},
	async captureMirrorFace(face) {
		if (!viewport || !oracleViewport) throw new Error('Run the mirror fixture before capture.');
		const position: [number, number, number] = face === 'front' ? [5.125, 0.5, 10] : [5.125, 0.5, -10];
		const target: [number, number, number] = [5.125, 0.5, 0];
		const candidate = await captureViewportPose(viewport, position, target);
		const oracle = await captureViewportPose(oracleViewport, position, target);
		return { candidate, oracle, samples: { candidate: await sampleMirrorCards(viewport, candidate.screenshotBase64), oracle: await sampleMirrorCards(oracleViewport, oracle.screenshotBase64) } };
	},
	mirrorPick(handle, localPoint) { return pickMirrorHandle(viewport!, handle, localPoint); },
	mirrorFilter(handle) {
		if (!viewport) throw new Error('Mirror candidate viewport is missing.');
		viewport.setSourceFaceFilter(handle ? [{ sourceFaceIndex: 100, occurrenceHandle: handle }] : null);
		return api.mirrorPick('mirror', [0.5, 0.5, 0]);
	},
	mirrorEdgeSnapshot(handle) { return edgeVerticesForHandle(viewport!, handle); },
	mirrorMove(handle, offset) {
		if (!viewport) throw new Error('Mirror candidate viewport is missing.');
		viewport.setOccurrenceTransforms(offset ? new Map([[handle, offset]]) : new Map());
		mirrorOffset = offset ? [...offset] as [number, number, number] : [0, 0, 0];
		return api.mirrorState();
	},
	mirrorState() { return mirrorState(viewport!, oracleViewport!, oracleInputScene!); },
	setPose(position, target) {
		if (!viewport) throw new Error('No viewport is mounted.');
		viewport.setCameraPose({ position: new Vector3(...position), target: new Vector3(...target) });
		return api.pose();
	},
	setOrthographic() {
		const live = requireInternalViewport();
		const position = live.rendererHost.camera.position.clone();
		const target = live.rendererHost.controls.target.clone();
		const camera = new OrthographicCamera(-12, 12, 8, -8, 0.001, 10000);
		camera.position.copy(position);
		camera.up.set(0, 1, 0);
		camera.lookAt(target);
		live.rendererHost.setCamera(camera);
		viewport!.setCameraPose({ position, target });
		return api.snapshot();
	},
	pose() { return snapshotPose(); },
	observation() { return observeViewport(); },
	beginOrbit() {
		if (!viewport) throw new Error('No viewport is mounted.');
		const before = snapshotPose();
		const snapshot = viewport.beginCameraDrag('orbit');
		const after = snapshotPose();
		return { before, after, snapshot: sanitizeSnapshot(snapshot) };
	},
	centerHit() {
		const live = requireInternalViewport();
		live.rendererHost.camera.updateMatrixWorld(true);
		const raycaster = new Raycaster();
		raycaster.setFromCamera(new Vector2(0, 0), live.rendererHost.camera);
		instrumentedQuery(raycaster);
		return instrumentation?.lastHit ?? null;
	},
	dispatchWheel(deltaY, clientX, clientY) {
		if (!lastCanvas) throw new Error('No viewport canvas is mounted.');
		const rect = lastCanvas.getBoundingClientRect();
		const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: clientX ?? rect.left + rect.width / 2, clientY: clientY ?? rect.top + rect.height / 2, deltaY, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
		lastCanvas.dispatchEvent(event);
		return { prevented: event.defaultPrevented, pose: snapshotPose(), hit: instrumentation?.lastHit ?? null };
	},
	dispatchWheelBurst(count, deltaY, clientX, clientY) {
		const steps: Array<{ before: [number, number, number]; after: [number, number, number]; hit: QueryHit | null; elapsedMs: number }> = [];
		for (let index = 0; index < count; index += 1) {
			const beforePose = snapshotPose();
			if (!beforePose) throw new Error('No camera pose is available for the wheel burst.');
			const before = beforePose.position as [number, number, number];
			const started = performance.now();
			api.dispatchWheel(deltaY, clientX, clientY);
			const afterPose = snapshotPose();
			if (!afterPose) throw new Error('No camera pose is available after the wheel burst event.');
			const after = afterPose.position as [number, number, number];
			steps.push({ before, after, hit: instrumentation?.lastHit ?? null, elapsedMs: performance.now() - started });
		}
		return { steps, state: api.snapshot() };
	},
	walkThroughExterior(maxEvents = 80) { return walkThroughWall(true, maxEvents); },
	walkThroughDoorway(maxEvents = 80) { return walkThroughWall(false, maxEvents); },
	measureWheelBurst(count = 40, deltaY = -100) {
		const live = requireInternalViewport();
		const rect = live.canvas.getBoundingClientRect();
		const clientX = rect.left + rect.width / 2;
		const clientY = rect.top + rect.height / 2;
		const eventMs: number[] = [];
		for (let index = 0; index < count; index += 1) {
			const start = performance.now();
			api.dispatchWheel(deltaY, clientX, clientY);
			const elapsed = performance.now() - start;
			if (index >= 20) eventMs.push(elapsed);
		}
		const queryMs = instrumentation?.queryMs.slice(-count) ?? [];
		return { count, warmedEvents: Math.min(20, count), measuredEvents: eventMs, queryEvents: queryMs, state: api.snapshot() };
	},
	verifyDoorOpening() {
		if (!currentFixture?.result || currentFixture.id !== 'S2-new') throw new Error('S2-new must be loaded before checking its doorway.');
		const result = currentFixture.result;
		const activeScene = result.scenes.find((scene: any) => scene.id === result.activeSceneId) ?? result.scenes.find((scene: any) => scene.isActiveAtExport) ?? null;
		const live = requireInternalViewport();
		const cutterVisible = live.meshRecords.some((record) => record.sourceMeshIndex === 25 && record.navigationVisible);
		const frameVisible = live.meshRecords.some((record) => record.sourceMeshIndex === 26 && record.navigationVisible && record.visibleOccurrenceIndices.size > 0);
		return {
			fixture: { id: currentFixture.id, bytes: currentFixture.sourceBytes, sha256: currentFixture.sha256 },
			workerLifecycle: currentFixture.workerLifecycle ?? null,
			activeSceneId: activeScene?.id ?? null,
			effectiveHiddenNodeIndices: activeScene?.visibility.hiddenNodeIndices ?? [],
			cutterVisible, frameVisible,
			frameSources: live.meshRecords.filter((record) => record.sourceMeshIndex === 26).map((record) => ({ sourceMeshIndex: record.sourceMeshIndex, definitionIndex: record.definitionIndex, navigationVisible: record.navigationVisible, visibleOccurrences: [...record.visibleOccurrenceIndices] })),
			openingHit: api.centerHit(),
			observation: observeViewport()
		};
	},
	waitFrames,
	dispose() { return disposeViewport(); },
	disposeAndVerifyPostInput() {
		const disposedViewport = viewport;
		const canvas = lastCanvas;
		if (!disposedViewport || !canvas) return { disposed: false };
		const before = snapshotPose();
		const live = requireInternalViewport();
		const activeInstrumentation = instrumentation;
		const capturesBefore = live.automaticNavigation.capturedPointers.size;
		const countsBefore = activeInstrumentation ? { ...activeInstrumentation.counts } : null;
		disposeViewport();
		const after = { position: disposedViewport.getCameraPose().position.toArray(), target: disposedViewport.getCameraPose().target.toArray() };
		const capturesAfter = live.automaticNavigation.capturedPointers.size;
		const countsAfterDispose = activeInstrumentation ? { ...activeInstrumentation.counts } : null;
		const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 400, clientY: 300, deltaY: -100 });
		canvas.dispatchEvent(wheel);
		const pointer = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 123, pointerType: 'mouse', button: 1, buttons: 4 });
		canvas.dispatchEvent(pointer);
		const countsAfterInput = activeInstrumentation ? { ...activeInstrumentation.counts } : null;
		return {
			disposed: true, before, after, capturesBefore, capturesAfter, canvasConnectedAfter: canvas.isConnected,
			postDisposeWheelPrevented: wheel.defaultPrevented, postDisposePointerPrevented: pointer.defaultPrevented,
			postDisposeCanvasCaptured: canvas.hasPointerCapture(123), countsBefore, countsAfterDispose, countsAfterInput
		};
	},
	snapshot() {
		const live = viewport ? requireInternalViewport() : null;
		return {
			fixture: currentFixture ? { id: currentFixture.id, bytes: currentFixture.sourceBytes ?? null, sha256: currentFixture.sha256 ?? null } : null,
			workerLifecycle: currentFixture?.workerLifecycle ?? null,
			pose: snapshotPose(), observation: observeViewport(),
			currentDragSnapshot: instrumentation?.currentDrag ?? null,
			sanitizedNavigationHit: instrumentation?.lastHit ?? null,
			gestureCounts: {
				...(instrumentation?.counts ?? { begins: 0, drags: 0, ends: 0, zooms: 0 }),
				activePointers: live?.automaticNavigation.pointers.size ?? 0,
				activeCaptures: live?.automaticNavigation.capturedPointers.size ?? 0
			},
			queryTimingsMs: [...(instrumentation?.queryMs ?? [])],
			sourceLabels: currentFixture?.sourceLabels ?? null
		};
	}
};

window.__viewerRecovery = api;
void waitFrames(1).then(() => { api.ready = true; setStatus('Isolated viewport harness ready'); });
window.addEventListener('pagehide', () => disposeViewport(), { once: true });

async function replaceViewport(scene: PreparedRuntimeGeometryScene, appearance?: any, scenes: any[] = [], activeSceneId?: string, clipPlanes?: any[], encodingProfile?: 'exact' | 'research' | 'visual') {
	disposeViewport();
	const host = document.querySelector<HTMLElement>('#viewer');
	if (!host) throw new Error('Harness viewer host is missing.');
	const next = await PreparedSceneViewport.mount(host, {
		scene, appearance, scenes, activeSceneId, clipPlanes, encodingProfile, editorMode: false
	}, '?renderer=webgl2');
	viewport = next;
	lastCanvas = requireInternalViewport().canvas;
	viewport.setDisplayState({ faceStyle: 'shaded-textures', effects: { xray: false, ambientOcclusion: false } });
	instrument(next);
}

async function loadPinnedRawFixture(id: FixtureId) {
	const pin = fixturePins[id];
	const response = await fetch(`/__fixture__/${encodeURIComponent(id)}`, { cache: 'no-store' });
	if (!response.ok) throw new Error(`${id} raw oracle request returned ${response.status}.`);
	const buffer = await response.arrayBuffer();
	const sha256 = await digestSha256(buffer);
	if (buffer.byteLength !== pin.bytes || sha256 !== pin.sha256) throw new Error(`${id} raw oracle fixture identity mismatch: ${buffer.byteLength}/${sha256}.`);
	const sourceName = `PROJECT SBOOST ${id === 'S1-new' ? '1' : '2'}.skp`;
	return new BomcLoader().load(buffer, sourceName, { prepareSolid: false });
}

function rawSourceSummary(id: FixtureId, loaded: any) {
	return {
		fixture: { id, bytes: fixturePins[id].bytes, sha256: fixturePins[id].sha256 },
		counts: loaded.counts, modelName: loaded.modelName, activeSceneId: loaded.activeSceneId,
		scenes: loaded.scenes.map((scene: any) => ({ id: scene.id, hiddenNodeIndices: scene.visibility.hiddenNodeIndices ?? [], visibilitySignature: scene.visibilitySignature })),
		groups: loaded.preparedRuntimeScene.groups.length, meshes: loaded.preparedRuntimeScene.meshes.length,
		materials: loaded.appearance.materials.map((material: any, index: number) => ({ index, id: material.id, baseColorRgba: material.baseColorRgba ?? null, opacity: material.opacity, textureAsset: material.textureAsset ?? null }))
	};
}

function replaceVisibleOracleInstancedDraws() {
	if (!oracleViewport || !oracleInputScene) throw new Error('Raw oracle viewport is not mounted.');
	const live = requireInternalFor(oracleViewport);
	live.scene3d.updateMatrixWorld(true);
	const expected: Array<{ record: MeshRecordView; recordIndex: number; localOccurrenceIndex: number }> = [];
	for (let recordIndex = 0; recordIndex < live.meshRecords.length; recordIndex += 1) {
		const record = live.meshRecords[recordIndex]!;
		record.mesh.updateWorldMatrix(true, false);
		oracleBaseMeshes.push(record.mesh);
		for (let occurrence = 0; occurrence < record.mesh.count; occurrence += 1) {
			if (!record.visibleOccurrenceIndices.has(occurrence) || !isObjectVisibleInScene(record.mesh, live.scene3d)) continue;
			const sourceOrdinal = record.sourceOccurrenceIndices[occurrence];
			if (!Number.isSafeInteger(sourceOrdinal) || sourceOrdinal! < 0) throw new Error(`Oracle source provenance is missing for record ${recordIndex}, occurrence ${occurrence}.`);
			const instance = new Matrix4();
			record.mesh.getMatrixAt(occurrence, instance);
			const ordinary = new Mesh(record.mesh.geometry, record.mesh.material);
			ordinary.matrixAutoUpdate = false;
			ordinary.matrix.multiplyMatrices(record.mesh.matrixWorld, instance);
			ordinary.matrixWorldNeedsUpdate = true;
			ordinary.frustumCulled = record.mesh.frustumCulled;
			ordinary.renderOrder = record.mesh.renderOrder;
			ordinary.userData = { ...record.mesh.userData, ordinaryOracleOccurrence: occurrence, occurrenceHandle: record.occurrenceHandles?.[occurrence] ?? null, sourceOccurrenceIndex: sourceOrdinal };
			live.scene3d.add(ordinary);
			oracleDraws.push({ mesh: ordinary, sourceRecord: record, recordIndex, localOccurrenceIndex: occurrence, parent: live.scene3d });
			expected.push({ record, recordIndex, localOccurrenceIndex: occurrence });
		}
		record.mesh.visible = false;
	}
	const expectedKeys = expected.map(({ recordIndex, localOccurrenceIndex }) => `${recordIndex}:${localOccurrenceIndex}`);
	const actualKeys = oracleDraws.map(({ recordIndex, localOccurrenceIndex }) => `${recordIndex}:${localOccurrenceIndex}`);
	const actualKeySet = new Set(actualKeys);
	if (actualKeySet.size !== actualKeys.length || expectedKeys.length !== actualKeys.length || expectedKeys.some((key) => !actualKeySet.has(key))) {
		throw new Error(`Ordinary oracle clone provenance mismatch: expected ${expectedKeys.length}, received ${actualKeys.length}.`);
	}
	for (const row of oracleDraws) if (row.mesh.parent !== live.scene3d || row.sourceRecord.sourceOccurrenceIndices[row.localOccurrenceIndex] !== row.mesh.userData.sourceOccurrenceIndex) {
		throw new Error(`Ordinary oracle clone lost its source record/occurrence mapping at ${row.recordIndex}:${row.localOccurrenceIndex}.`);
	}
	live.scene3d.updateMatrixWorld(true);
	live.rendererHost.renderNow();
}

function disposeOracle() {
	const errors: unknown[] = [];
	try { restoreDoorLineVisibility(); } catch (error) { errors.push(error); }
	const ownedViewport = oracleViewport;
	if (ownedViewport) {
		const live = requireInternalFor(ownedViewport);
		for (const row of oracleDraws) {
			try { row.mesh.parent?.remove(row.mesh); }
			catch (error) { errors.push(error); }
		}
		oracleDraws = [];
		oracleBaseMeshes = [];
		oracleViewport = null;
		try { ownedViewport.dispose(); } catch (error) { errors.push(error); }
		if (live.scene3d.children.some((child) => child instanceof Mesh && child.userData.ordinaryOracleOccurrence !== undefined)) {
			errors.push(new Error('Ordinary oracle clones remained attached after removal.'));
		}
	} else {
		oracleDraws = [];
		oracleBaseMeshes = [];
	}
	oracleResult = null;
	oracleInputScene = null;
	if (errors.length) throw new AggregateError(errors, 'Ordinary oracle disposal failed.');
}

function isObjectVisibleInScene(object: Object3D, scene: Scene) {
	let cursor: Object3D | null = object;
	while (cursor) {
		if (!cursor.visible) return false;
		if (cursor === scene) return true;
		cursor = cursor.parent;
	}
	return false;
}

function probeOrdinaryOracleVisibility() {
	if (!oracleViewport || !oracleInputScene) throw new Error('Prepare the ordinary oracle before probing its draw visibility.');
	const live = requireInternalFor(oracleViewport);
	const sourcePath = '0/49/48/47/46/44';
	const row = oracleDraws.find((candidate) => hierarchyPath(oracleInputScene!, candidate.sourceRecord.occurrenceHierarchyIndices?.[candidate.localOccurrenceIndex]) === sourcePath && isObjectVisibleInScene(candidate.mesh, live.scene3d));
	if (!row) throw new Error(`No visible ordinary frame draw has required source path ${sourcePath}.`);
	const mesh = row.mesh;
	const parent = mesh.parent;
	if (!parent) throw new Error('The ordinary oracle frame draw is detached before the visibility control.');
	const childIndex = parent.children.indexOf(mesh);
	const originalVisible = mesh.visible;
	const originalMatrix = mesh.matrix.clone();
	const originalMatrixWorld = mesh.matrixWorld.clone();
	const originalNeedsUpdate = mesh.matrixWorldNeedsUpdate;
	let hiddenVisible = true;
	let detachedVisible = true;
	let restoredVisible = false;
	let parentRestored = false;
	let matrixRestored = false;
	try {
		mesh.visible = false;
		live.rendererHost.renderNow();
		hiddenVisible = isObjectVisibleInScene(mesh, live.scene3d);
		mesh.visible = originalVisible;
		parent.remove(mesh);
		live.rendererHost.renderNow();
		detachedVisible = isObjectVisibleInScene(mesh, live.scene3d);
	} finally {
		if (mesh.parent !== parent) {
			mesh.parent?.remove(mesh);
			parent.add(mesh);
		}
		const currentIndex = parent.children.indexOf(mesh);
		if (currentIndex >= 0 && currentIndex !== childIndex) {
			parent.children.splice(currentIndex, 1);
			parent.children.splice(Math.min(childIndex, parent.children.length), 0, mesh);
		}
		mesh.visible = originalVisible;
		mesh.matrix.copy(originalMatrix);
		mesh.matrixWorld.copy(originalMatrixWorld);
		mesh.matrixWorldNeedsUpdate = originalNeedsUpdate;
		live.scene3d.updateMatrixWorld(true);
		live.rendererHost.renderNow();
		restoredVisible = isObjectVisibleInScene(mesh, live.scene3d);
		parentRestored = mesh.parent === parent && parent.children.indexOf(mesh) === childIndex;
		matrixRestored = mesh.matrix.equals(originalMatrix) && mesh.matrixWorld.equals(originalMatrixWorld);
	}
	return {
		sourcePath, sourceMeshIndex: row.sourceRecord.sourceMeshIndex,
		localOccurrenceIndex: row.localOccurrenceIndex,
		sourceOccurrenceIndex: row.sourceRecord.sourceOccurrenceIndices[row.localOccurrenceIndex],
		originalVisible: true, hiddenVisible, detachedVisible, restoredVisible, parentRestored,
		matrixRestored, visibilityRestored: mesh.visible === originalVisible
	};
}

function requireInternalFor(target: PreparedSceneViewport) { return target as unknown as InternalViewport; }

function observeOracleViewport() {
	if (!oracleViewport) return null;
	const observation = oracleViewport.observe();
	const live = requireInternalFor(oracleViewport);
	return { ...observation, camera: { ...observation.camera, zoom: live.rendererHost.camera.zoom } };
}

async function captureViewportPose(target: PreparedSceneViewport, position: [number, number, number], lookAt: [number, number, number]) {
	target.setCameraPose({ position: new Vector3(...position), target: new Vector3(...lookAt) });
	await waitFrames(2);
	const captured = target.captureWithObservation();
	const camera = captured.observation.camera;
	if (!camera) throw new Error('Viewport observation did not include camera details.');
	return {
		screenshotBase64: captured.screenshot.slice(captured.screenshot.indexOf(',') + 1),
		observation: captured.observation,
		camera: { position: camera.position, target: camera.target, near: camera.near, far: camera.far }
	};
}

function restoreDoorLineVisibility() {
	for (const saved of doorLineVisibility) {
		const live = saved.viewport === viewport || saved.viewport === oracleViewport ? requireInternalFor(saved.viewport) : null;
		if (!live) continue;
		for (let index = 0; index < live.edgeRecords.length; index += 1) live.edgeRecords[index]!.lines.visible = saved.values[index] ?? true;
		live.rendererHost.renderNow();
	}
	doorLineVisibility = [];
}

async function comparePixelCaptures(candidate: string, oracle: string) {
	const decode = async (value: string) => {
		const image = await createImageBitmap(new Blob([Uint8Array.from(atob(value), (character) => character.charCodeAt(0))], { type: 'image/png' }));
		const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
		const context = canvas.getContext('2d', { willReadFrequently: true });
		if (!context) throw new Error('Could not allocate pixel comparison canvas.');
		context.drawImage(image, 0, 0); image.close();
		return { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
	};
	const left = await decode(candidate); const right = await decode(oracle);
	if (left.width !== right.width || left.height !== right.height) throw new Error(`Oracle capture dimensions differ: ${left.width}x${left.height} vs ${right.width}x${right.height}.`);
	let absolute = 0; let overTwo = 0; const pixelCount = left.width * left.height;
	for (let pixel = 0; pixel < pixelCount; pixel += 1) {
		let maxChannelDifference = 0;
		for (let channel = 0; channel < 3; channel += 1) {
			const difference = Math.abs(left.pixels[pixel * 4 + channel]! - right.pixels[pixel * 4 + channel]!);
			absolute += difference / 255;
			maxChannelDifference = Math.max(maxChannelDifference, difference);
		}
		if (maxChannelDifference > 2) overTwo += 1;
	}
	return { width: left.width, height: left.height, normalizedMeanAbsoluteRgb: absolute / (pixelCount * 3), fractionPixelsAnyChannelOverTwo: overTwo / pixelCount };
}

function hierarchyPath(scene: PreparedRuntimeGeometryScene, hierarchyIndex: number | undefined) {
	const hierarchy = scene.occurrenceHierarchy;
	if (!hierarchy || hierarchyIndex === undefined) return null;
	const path: number[] = []; const seen = new Set<number>(); let cursor = hierarchyIndex;
	for (let hops = 0; cursor >= 0; hops += 1) {
		if (hops > hierarchy.parentIndices.length || cursor >= hierarchy.parentIndices.length || seen.has(cursor)) throw new Error(`Occurrence hierarchy has an invalid path at index ${cursor}.`);
		seen.add(cursor); path.push(hierarchy.instanceIndices[cursor]!); cursor = hierarchy.parentIndices[cursor]!;
	}
	return path.reverse().join('/');
}

function materialInventory(materialValue: any) {
	const values = Array.isArray(materialValue) ? materialValue : [materialValue];
	return values.map((material) => ({
		name: material?.name ?? null, side: material?.side ?? null, opacity: material?.opacity ?? null,
		transparent: material?.transparent ?? null, depthTest: material?.depthTest ?? null, depthWrite: material?.depthWrite ?? null,
		map: material?.map ? { name: material.map.name ?? null, width: material.map.image?.width ?? null, height: material.map.image?.height ?? null, colorSpace: material.map.colorSpace ?? null } : null
	}));
}

async function hashArrayView(view: ArrayBufferView | undefined) {
	if (!view) return null;
	const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
	return digestSha256(bytes.slice().buffer);
}

async function inventoryDraws(target: PreparedSceneViewport, scene: PreparedRuntimeGeometryScene, mode: 'candidate-instanced' | 'oracle-ordinary') {
	const live = requireInternalFor(target);
	live.scene3d.updateMatrixWorld(true);
	const requiredPaths = new Set(['0/49/48/47', '0/49/48/47/46/44', '0/49/48/47/46/45']);
	const descriptors: Array<{ record: MeshRecordView; recordIndex: number; occurrence: number; object: Mesh | InstancedMesh; drawKind: 'instanced' | 'ordinary' }> = mode === 'candidate-instanced'
		? live.meshRecords.flatMap((record, recordIndex) => Array.from({ length: record.mesh.count }, (_, occurrence) => ({ record, recordIndex, occurrence, object: record.mesh, drawKind: 'instanced' as const })))
		: oracleDraws.filter((row) => row.parent === live.scene3d).map((row) => ({ record: row.sourceRecord, recordIndex: row.recordIndex, occurrence: row.localOccurrenceIndex, object: row.mesh, drawKind: 'ordinary' as const }));
	const draws: any[] = [];
	const geometryGroups = new Map<string, any>();
	for (const descriptor of descriptors) {
		const { record, occurrence, object, drawKind } = descriptor;
		object.updateWorldMatrix(true, false);
		const geometry = object.geometry;
		const position = geometry.getAttribute('position'); const normal = geometry.getAttribute('normal'); const uv = geometry.getAttribute('uv');
		const index = geometry.index;
		const geometryKey = `${record.geometryGroupIndex}:${geometry.uuid}`;
		const sourceFaces = record.visibleSourceFaceIndicesByTriangle ?? record.sourceFaceIndicesByTriangle ?? record.fullSourceFaceIndicesByTriangle;
		if (!geometryGroups.has(geometryKey)) {
			geometryGroups.set(geometryKey, {
				geometryGroupIndex: record.geometryGroupIndex, sourceMeshIndex: record.sourceMeshIndex, definitionIndex: record.definitionIndex,
				position: position ? { count: position.count, itemSize: position.itemSize, bytes: position.array.byteLength, sha256: await hashArrayView(position.array) } : null,
				normal: normal ? { count: normal.count, itemSize: normal.itemSize, bytes: normal.array.byteLength, sha256: await hashArrayView(normal.array) } : null,
				uv: uv ? { count: uv.count, itemSize: uv.itemSize, bytes: uv.array.byteLength, sha256: await hashArrayView(uv.array) } : null,
				index: index ? { count: index.count, bytes: index.array.byteLength, sha256: await hashArrayView(index.array) } : null,
				sourceFaceIndicesByTriangleSha256: await hashArrayView(sourceFaces)
			});
		}
		const world = drawKind === 'instanced'
			? object.matrixWorld.clone().multiply(instanceMatrixAt(object as InstancedMesh, occurrence))
			: object.matrixWorld.clone();
		const sourcePath = hierarchyPath(scene, record.occurrenceHierarchyIndices?.[occurrence]);
		const worldTriangles: any[] = [];
		if (sourcePath && requiredPaths.has(sourcePath) && position && index) {
			for (let triangle = 0; triangle < index.count / 3; triangle += 1) {
				const vertices = [0, 1, 2].map((corner) => {
					const vertex = index.getX(triangle * 3 + corner);
					return new Vector3(position.getX(vertex), position.getY(vertex), position.getZ(vertex)).applyMatrix4(world).toArray();
				});
				worldTriangles.push({ triangle, sourceFaceIndex: sourceFaces?.[triangle] ?? null, vertices });
			}
		}
		const visible = isObjectVisibleInScene(object, live.scene3d) && (drawKind === 'ordinary' || record.visibleOccurrenceIndices.has(occurrence));
		draws.push({
			drawKind,
		sourceMeshIndex: record.sourceMeshIndex, definitionIndex: record.definitionIndex, geometryGroupIndex: record.geometryGroupIndex,
			occurrence, occurrenceIndex: record.sourceOccurrenceIndices[occurrence] ?? null, occurrenceHandle: record.occurrenceHandles?.[occurrence] ?? null,
			occurrenceHierarchyIndex: record.occurrenceHierarchyIndices?.[occurrence] ?? null, occurrenceInstanceIndex: record.occurrenceInstanceIndices?.[occurrence] ?? null,
			sourcePath, visible, navigationVisible: record.navigationVisible,
			matrix: world.toArray(), determinant: world.determinant(), renderSide: scene.groups[record.geometryGroupIndex]?.renderSide ?? null,
			materialIndex: scene.groups[record.geometryGroupIndex]?.materialIndex ?? null, materialId: record.materialId,
			material: materialInventory(object.material), geometryKey,
			geometryCounts: { vertexCount: position?.count ?? 0, normalCount: normal?.count ?? 0, uvCount: uv?.count ?? 0, indexCount: index?.count ?? 0 },
			sourceFaceIndex: sourceFaces ? sourceFaces[0] ?? null : null,
			worldTriangles
		});
	}
	const paths = [...new Set(draws.map((draw) => draw.sourcePath).filter((sourcePath) => typeof sourcePath === 'string'))].sort();
	const relevantHandles = new Set(draws.filter((draw) => draw.sourcePath && requiredPaths.has(draw.sourcePath)).map((draw) => draw.occurrenceHandle).filter(Boolean));
	const edgeSets = await Promise.all((scene.edgeSets ?? []).map(async (edge) => ({
		sourceMeshIndex: edge.sourceMeshIndex, definitionIndex: edge.definitionIndex, edgeCount: edge.positions.length / 6,
		positionsBytes: edge.positions.byteLength, positionsSha256: await hashArrayView(edge.positions),
		flagsBytes: edge.flags.byteLength, flagsSha256: await hashArrayView(edge.flags),
		matricesBytes: edge.matrices.byteLength, matricesSha256: await hashArrayView(edge.matrices),
		handleCount: edge.occurrenceHandles?.length ?? 0, relevantHandles: (edge.occurrenceHandles ?? []).filter((handle) => relevantHandles.has(handle))
	})));
	return {
		mode, drawKindCounts: { instanced: draws.filter((draw) => draw.drawKind === 'instanced').length, ordinary: draws.filter((draw) => draw.drawKind === 'ordinary').length },
		paths, requiredPathPresence: Object.fromEntries([...requiredPaths].map((sourcePath) => [sourcePath, paths.includes(sourcePath)])),
		draws, geometryGroups: [...geometryGroups.values()], edgeSets,
		camera: { near: live.rendererHost.camera.near, far: live.rendererHost.camera.far }, observation: target.observe()
	};
}

function instanceMatrixAt(mesh: InstancedMesh, occurrence: number) {
	const matrix = new Matrix4();
	mesh.getMatrixAt(occurrence, matrix);
	return matrix;
}

function makeMirrorScene(): PreparedRuntimeGeometryScene {
	const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
	const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
	const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
	const matrices = [
		new Matrix4(),
		new Matrix4().set(-1, 0, 0, 3, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
		new Matrix4().makeScale(2, 0.5, 1).setPosition(6, 0, 0),
		new Matrix4().set(-1, 0.25, 0, 10, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
	];
	const handles = ['positive', 'mirror', 'scale', 'shear-mirror'];
	const matrixRows = Float32Array.from(matrices.flatMap((matrix) => matrix.toArray()));
	const bounds = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number], sphereCenter: [0.5, 0.5, 0] as [number, number, number], sphereRadius: Math.SQRT1_2 };
	const groups = (['front', 'back'] as const).map((side, materialIndex) => ({
		key: 'other' as const, componentId: `mirror-${side}`, sourceMeshIndex: 50, definitionIndex: 0, faceCount: 1,
		indices: new Uint16Array([0, 1, 2, 0, 2, 3]), matrices: new Float32Array(matrixRows), occurrenceHandles: [...handles],
		sourceOccurrenceIndices: new Uint32Array([0, 1, 2, 3]), materialIndex, materialId: `fixture:mirror:${side}`,
		baseColorRgba: side === 'front' ? [1, 0, 0, 1] as [number, number, number, number] : [0, 0, 1, 1] as [number, number, number, number],
		opacity: 1, colorSpace: 'srgb', renderSide: side, sourceFaceIndicesByTriangle: new Uint32Array([100, 100]),
		sourceFrontMaterialIndicesByTriangle: new Uint32Array([0, 0]), sourceBackMaterialIndicesByTriangle: new Uint32Array([1, 1]),
		localBounds: bounds, worldBounds: { min: [0, 0, 0] as [number, number, number], max: [11, 1, 0] as [number, number, number] }, baseY: 0, topY: 1
	}));
	const edgePositions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]);
	const edgeSets = [{ sourceMeshIndex: 50, definitionIndex: 0, key: 'other' as const, positions: edgePositions, flags: new Uint8Array(4), matrices: new Float32Array(matrixRows), occurrenceHandles: [...handles], worldBounds: { min: [0, 0, 0] as [number, number, number], max: [11, 1, 0] as [number, number, number] } }];
	return { meshes: [{ sourceMeshIndex: 50, positions, normals, uvs }], groups, edgeSets, totalUnits: 1, totalTriangles: 16, totalVertices: 16 };
}

async function mountOracleForScene(scene: PreparedRuntimeGeometryScene, appearance: any, scenes: any[] = [], activeSceneId?: string | null, clipPlanes: any[] = [], profile?: 'exact' | 'research' | 'visual') {
	const host = document.querySelector<HTMLElement>('#oracle-viewer');
	if (!host) throw new Error('Ordinary-render oracle host is missing.');
	oracleViewport = await PreparedSceneViewport.mount(host, { scene, appearance, scenes, activeSceneId, clipPlanes, encodingProfile: profile, editorMode: false }, '?renderer=webgl2');
	oracleViewport.setDisplayState({ faceStyle: 'shaded-textures', effects: { xray: false, ambientOcclusion: false } });
	oracleInputScene = scene;
	replaceVisibleOracleInstancedDraws();
}

async function prepareMirrorFixture() {
	disposeViewport();
	const appearance = { materials: [
		{ index: 0, id: 'fixture:mirror:front', baseColorRgba: [1, 0, 0, 1] as [number, number, number, number], opacity: 1, colorSpace: 'srgb' },
		{ index: 1, id: 'fixture:mirror:back', baseColorRgba: [0, 0, 1, 1] as [number, number, number, number], opacity: 1, colorSpace: 'srgb' }
	], assets: [] };
	rawMirrorScene = makeMirrorScene();
	candidateMirrorScene = makeMirrorScene();
	const metrics = prepareApplicationRenderScene(candidateMirrorScene, 'exact');
	const host = document.querySelector<HTMLElement>('#viewer');
	if (!host) throw new Error('Candidate mirror viewport host is missing.');
	viewport = await PreparedSceneViewport.mount(host, { scene: candidateMirrorScene, appearance, editorMode: false, encodingProfile: 'exact' }, '?renderer=webgl2');
	lastCanvas = requireInternalViewport().canvas;
	viewport.setDisplayState({ faceStyle: 'shaded-textures', effects: { xray: false, ambientOcclusion: false } });
	instrument(viewport);
	await mountOracleForScene(rawMirrorScene, appearance);
	await waitFrames(2);
	mirrorOffset = [0, 0, 0];
	return { normalization: metrics, candidateGroups: candidateMirrorScene.groups.length, rawGroups: rawMirrorScene.groups.length };
}

function sampleMirrorCards(target: PreparedSceneViewport, screenshotBase64: string) {
	return sampleImagePoints(screenshotBase64, [
		{ handle: 'positive', point: [0.5, 0.5, 0] }, { handle: 'mirror', point: [2.5, 0.5, 0] },
		{ handle: 'scale', point: [7, 0.25, 0] }, { handle: 'shear-mirror', point: [9.625, 0.5, 0] }
	], target);
}

async function sampleImagePoints(screenshotBase64: string, points: Array<{ handle: string; point: number[] }>, target: PreparedSceneViewport) {
	const data = await imagePixels(screenshotBase64);
	const live = requireInternalFor(target); live.rendererHost.camera.updateMatrixWorld(true);
	return points.map(({ handle, point }) => {
		const projected = new Vector3(point[0], point[1], point[2]).project(live.rendererHost.camera);
		const x = Math.max(0, Math.min(data.width - 1, Math.round((projected.x + 1) * data.width / 2)));
		const y = Math.max(0, Math.min(data.height - 1, Math.round((1 - projected.y) * data.height / 2)));
		const offset = (y * data.width + x) * 4;
		return { handle, x, y, rgba: Array.from(data.pixels.subarray(offset, offset + 4)) };
	});
}

async function imagePixels(screenshotBase64: string) {
	const image = await createImageBitmap(new Blob([Uint8Array.from(atob(screenshotBase64), (character) => character.charCodeAt(0))], { type: 'image/png' }));
	const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
	const context = canvas.getContext('2d', { willReadFrequently: true });
	if (!context) throw new Error('Could not allocate pixel sample canvas.');
	context.drawImage(image, 0, 0); image.close();
	return { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
}

function pickMirrorHandle(target: PreparedSceneViewport, handle: string, localPoint: [number, number, number]) {
	const sourceGroup = rawMirrorScene?.groups.find((group) => group.occurrenceHandles?.includes(handle));
	if (!sourceGroup) throw new Error(`Mirror source occurrence ${handle} is missing.`);
	const occurrence = sourceGroup.occurrenceHandles!.indexOf(handle);
	const matrix = new Matrix4().fromArray(sourceGroup.matrices, occurrence * 16);
	const point = new Vector3(...localPoint).applyMatrix4(matrix).add(new Vector3(...mirrorOffset));
	const live = requireInternalFor(target); live.rendererHost.camera.updateMatrixWorld(true); point.project(live.rendererHost.camera);
	const rect = live.canvas.getBoundingClientRect();
	return target.pickAt(rect.left + (point.x + 1) * rect.width / 2, rect.top + (1 - point.y) * rect.height / 2);
}

function edgeVerticesForHandle(target: PreparedSceneViewport, handle: string) {
	const live = requireInternalFor(target); const result: number[][] = [];
	for (const record of live.edgeRecords) {
		const starts = record.segmentStartsByOccurrence.get(handle) ?? [];
		const positions = record.lines.geometry.getAttribute('position').array;
		for (const start of starts) for (let vertex = 0; vertex < 2; vertex += 1) {
			const offset = (start + vertex) * 3;
			result.push([positions[offset]!, positions[offset + 1]!, positions[offset + 2]!]);
		}
	}
	return result;
}

function mirrorState(candidate: PreparedSceneViewport, ordinary: PreparedSceneViewport, source: PreparedRuntimeGeometryScene) {
	const internal = requireInternalFor(candidate);
	const targetGroups = candidateMirrorScene?.groups ?? [];
	const sourceHashesMatch = JSON.stringify(candidateMirrorScene?.meshes.map((mesh) => ({ positions: Array.from(mesh.positions), normals: Array.from(mesh.normals ?? []), uvs: Array.from(mesh.uvs ?? []) })))
		=== JSON.stringify(rawMirrorScene?.meshes.map((mesh) => ({ positions: Array.from(mesh.positions), normals: Array.from(mesh.normals ?? []), uvs: Array.from(mesh.uvs ?? []) })));
	const edgeSourcesMatch = JSON.stringify(candidateMirrorScene?.edgeSets?.map((edge) => ({ positions: Array.from(edge.positions), flags: Array.from(edge.flags), matrices: Array.from(edge.matrices) })))
		=== JSON.stringify(rawMirrorScene?.edgeSets?.map((edge) => ({ positions: Array.from(edge.positions), flags: Array.from(edge.flags), matrices: Array.from(edge.matrices) })));
	const groups = targetGroups.map((group) => ({
		side: group.renderSide, handles: group.occurrenceHandles, ordinals: Array.from(group.sourceOccurrenceIndices ?? []),
		determinants: Array.from({ length: group.matrices.length / 16 }, (_, row) => new Matrix4().fromArray(group.matrices, row * 16).determinant()),
		indices: Array.from(group.indices), sourceFaces: Array.from(group.sourceFaceIndicesByTriangle ?? []),
		uvs: Array.from(candidateMirrorScene?.meshes.find((mesh) => mesh.sourceMeshIndex === group.sourceMeshIndex)?.uvs ?? []),
		normals: Array.from(candidateMirrorScene?.meshes.find((mesh) => mesh.sourceMeshIndex === group.sourceMeshIndex)?.normals ?? [])
	}));
	return {
		candidateObservation: candidate.observe(), oracleObservation: ordinary.observe(), groups,
		sourcePositionsNormalsUvsUnchanged: sourceHashesMatch, sourceEdgesUnchanged: edgeSourcesMatch,
		sourceEdgeSets: source.edgeSets?.map((edge) => ({ handles: edge.occurrenceHandles, positions: Array.from(edge.positions), flags: Array.from(edge.flags), matrices: Array.from(edge.matrices) })) ?? [],
		anchors: Object.fromEntries(['positive', 'mirror', 'scale', 'shear-mirror'].map((handle) => [handle, candidate.occurrenceAnchor(handle)])),
		visibleDeterminants: internal.meshRecords.flatMap((record) => [...record.visibleOccurrenceIndices].filter((index) => record.mesh.visible).map((index) => new Matrix4().fromArray(record.baseMatrices, index * 16).determinant()))
	};
}

function worldPathSet(scene: PreparedRuntimeGeometryScene) {
	return new Set(scene.groups.flatMap((group) => Array.from(group.occurrenceHierarchyIndices ?? [], (index) => hierarchyPath(scene, index)).filter((path): path is string => path !== null)));
}

async function hashFloatArrays(arrays: Float32Array[]) {
	const totalBytes = arrays.reduce((sum, array) => sum + array.byteLength, 0);
	const joined = new Uint8Array(totalBytes); let offset = 0;
	for (const array of arrays) {
		joined.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offset);
		offset += array.byteLength;
	}
	return digestSha256(joined.buffer);
}

async function summarizeSceneSource(scene: PreparedRuntimeGeometryScene) {
	const meshes = new Map(scene.meshes.map((mesh) => [mesh.sourceMeshIndex, mesh]));
	const faceWeights = new Map<string, number>();
	const occurrenceWeights = new Map<string, number>();
	let worldTriangleCount = 0; let positionValues = 0; let normalValues = 0; let uvValues = 0; let indexedTriangles = 0;
	for (const group of scene.groups) {
		const occurrenceCount = group.matrices.length / 16;
		const triangleCount = group.indices.length / 3;
		worldTriangleCount += triangleCount * occurrenceCount;
		indexedTriangles += triangleCount;
		const mesh = meshes.get(group.sourceMeshIndex);
		const positions = group.batchPositions ?? mesh?.positions;
		const normals = group.batchNormals ?? mesh?.normals;
		const uvs = group.batchUvs ?? mesh?.uvs;
		positionValues += positions?.length ?? 0; normalValues += normals?.length ?? 0; uvValues += uvs?.length ?? 0;
		const identity = `${group.sourceMeshIndex}|${group.materialIndex ?? -1}|${group.renderSide ?? (group.isBackFace ? 'back' : 'double')}`;
		for (const face of group.sourceFaceIndicesByTriangle ?? []) {
			const key = `${identity}|face:${face}`;
			faceWeights.set(key, (faceWeights.get(key) ?? 0) + occurrenceCount);
		}
		const handles = group.occurrenceHandles ?? Array.from({ length: occurrenceCount }, (_, index) => `anonymous:${group.sourceOccurrenceIndices?.[index] ?? index}`);
		for (let index = 0; index < occurrenceCount; index += 1) {
			const ordinal = group.sourceOccurrenceIndices?.[index] ?? index;
			const key = `${identity}|occurrence:${ordinal}:${handles[index]}`;
			occurrenceWeights.set(key, (occurrenceWeights.get(key) ?? 0) + triangleCount);
		}
	}
	const edgeSetFingerprints = await Promise.all((scene.edgeSets ?? []).map(async (edge) => ({
		sourceMeshIndex: edge.sourceMeshIndex, definitionIndex: edge.definitionIndex,
		positions: await hashArrayView(edge.positions), flags: await hashArrayView(edge.flags), matrices: await hashArrayView(edge.matrices),
		handles: edge.occurrenceHandles ?? []
	})));
	return {
		faceWeights: [...faceWeights].sort(([left], [right]) => left.localeCompare(right)),
		occurrenceWeights: [...occurrenceWeights].sort(([left], [right]) => left.localeCompare(right)),
		worldTriangleCount, indexedTriangles, groupCount: scene.groups.length, sourceMeshCount: scene.meshes.length,
		geometryStorage: { positionValues, normalValues, uvValues }, edgeSetFingerprints
	};
}

async function loadS1SourceComparison() {
	if (currentFixture?.id !== 'S1-new' || !currentFixture.result) throw new Error('Load S1-new through the Editor worker before comparing preserved source data.');
	const raw = await loadPinnedRawFixture('S1-new');
	const candidateScene = currentFixture.result.preparedRuntimeScene as PreparedRuntimeGeometryScene;
	const rawScene = raw.preparedRuntimeScene as PreparedRuntimeGeometryScene;
	const [candidateSourceSummary, rawSourceSummaryValue] = await Promise.all([summarizeSceneSource(candidateScene), summarizeSceneSource(rawScene)]);
	const candidateMeshes = new Map(candidateScene.meshes.map((mesh) => [mesh.sourceMeshIndex, mesh]));
	const candidatePreparedArrays = candidateScene.groups.flatMap((group) => {
		const source = candidateMeshes.get(group.sourceMeshIndex);
		return [group.batchPositions ?? source?.positions ?? new Float32Array(), group.batchNormals ?? source?.normals ?? new Float32Array(), group.batchUvs ?? source?.uvs ?? new Float32Array()];
	});
	const [candidateSourceGeometryHash, rawSourceGeometryHash] = await Promise.all([
		hashFloatArrays(candidatePreparedArrays),
		hashFloatArrays(rawScene.meshes.flatMap((mesh) => [mesh.positions, mesh.normals ?? new Float32Array(), mesh.uvs ?? new Float32Array()]))
	]);
	const sceneSemantics = (result: any) => result.scenes.map((row: any) => ({ id: row.id, name: row.name, active: row.isActiveAtExport, signature: row.visibilitySignature, hidden: row.visibility.hiddenNodeIndices ?? [] }));
	const sceneFingerprint = async (value: unknown) => digestSha256(new TextEncoder().encode(JSON.stringify(value)).buffer);
	const [candidateEdgeDataHash, rawEdgeDataHash, candidateSceneHash, rawSceneHash] = await Promise.all([
		sceneFingerprint(candidateSourceSummary.edgeSetFingerprints), sceneFingerprint(rawSourceSummaryValue.edgeSetFingerprints),
		sceneFingerprint(sceneSemantics(currentFixture.result)), sceneFingerprint(sceneSemantics(raw))
	]);
	return {
		fixture: { id: 'S1-new', bytes: currentFixture.sourceBytes, sha256: currentFixture.sha256 },
		workerLifecycle: currentFixture.workerLifecycle, counts: { candidate: currentFixture.result.counts, raw: raw.counts },
		modelName: { candidate: currentFixture.result.modelName, raw: raw.modelName },
		scenes: { candidate: currentFixture.result.scenes.map((row: any) => ({ id: row.id, hidden: row.visibility.hiddenNodeIndices ?? [] })), raw: raw.scenes.map((row: any) => ({ id: row.id, hidden: row.visibility.hiddenNodeIndices ?? [] })) },
		materialAppearanceHashes: { candidate: await digestSha256(new TextEncoder().encode(JSON.stringify(currentFixture.result.appearance.materials)).buffer), raw: await digestSha256(new TextEncoder().encode(JSON.stringify(raw.appearance.materials)).buffer) },
		preparedGeometryHashes: { candidatePreparedBuffers: candidateSourceGeometryHash, rawSourceGeometry: rawSourceGeometryHash },
		sourceSummaries: { candidate: candidateSourceSummary, raw: rawSourceSummaryValue },
		preservation: {
			countsMatch: JSON.stringify(currentFixture.result.counts) === JSON.stringify(raw.counts),
			materialsMatch: await digestSha256(new TextEncoder().encode(JSON.stringify(currentFixture.result.appearance.materials)).buffer) === await digestSha256(new TextEncoder().encode(JSON.stringify(raw.appearance.materials)).buffer),
			sourceFaceWeightsMatch: JSON.stringify(candidateSourceSummary.faceWeights) === JSON.stringify(rawSourceSummaryValue.faceWeights),
			sourceOccurrenceWeightsMatch: JSON.stringify(candidateSourceSummary.occurrenceWeights) === JSON.stringify(rawSourceSummaryValue.occurrenceWeights),
		sourceEdgesMatch: candidateEdgeDataHash === rawEdgeDataHash, sceneVisibilityMatch: candidateSceneHash === rawSceneHash
		},
		transferBytes: currentFixture.result.diagnostics?.workerTransfer?.totalTransferBytes ?? null,
		visibleDeterminants: requireInternalViewport().meshRecords.flatMap((record) => [...record.visibleOccurrenceIndices].filter((index) => record.mesh.visible).map((index) => new Matrix4().fromArray(record.baseMatrices, index * 16).determinant())),
		appearance: observeViewport()?.appearance, draw: observeViewport()?.renderer
	};
}

function instrument(next: PreparedSceneViewport) {
	const live = next as unknown as InternalViewport;
	const counts = { begins: 0, drags: 0, ends: 0, zooms: 0 };
	let currentDrag: Instrumentation['currentDrag'] = null;
	let lastHit: QueryHit | null = null;
	const queryMs: number[] = [];
	const originalQuery = live.navigationQuery.query;
	const queryThis = live.navigationQuery;
	queryThis.query = function (...args: any[]) {
		const start = performance.now();
		const hit = originalQuery.apply(queryThis, args as never) as unknown as RawQueryHit | null;
		queryMs.push(performance.now() - start);
		if (queryMs.length > 1000) queryMs.shift();
		const record = hit ? live.meshRecords[hit.recordIndex] : null;
		lastHit = hit ? {
			point: [...(hit as any).point.toArray()] as [number, number, number],
			distance: hit.distance, recordIndex: hit.recordIndex, instanceIndex: hit.instanceIndex, faceIndex: hit.faceIndex,
			sourceMeshIndex: record?.sourceMeshIndex ?? null
		} : null;
		return hit as never;
	} as NavigationQueryView['query'];
	const originalBegin = next.beginCameraDrag.bind(next);
	const originalDrag = next.dragCamera.bind(next);
	const originalEnd = next.endCameraDrag.bind(next);
	const originalZoom = next.zoomAt.bind(next);
	next.beginCameraDrag = ((tool) => {
		const snapshot = originalBegin(tool);
		counts.begins += 1;
		currentDrag = {
			tool, sceneEpoch: snapshot.sceneEpoch,
			position: snapshot.pose.position.toArray(), target: snapshot.pose.target.toArray(), orbitAnchor: snapshot.orbitAnchor.toArray()
		} as Instrumentation['currentDrag'];
		return snapshot;
	}) as PreparedSceneViewport['beginCameraDrag'];
	next.dragCamera = ((tool, snapshot, dx, dy, height) => {
		counts.drags += 1;
		originalDrag(tool, snapshot, dx, dy, height);
	}) as PreparedSceneViewport['dragCamera'];
	next.endCameraDrag = (() => {
		counts.ends += 1;
		currentDrag = null;
		originalEnd();
	}) as PreparedSceneViewport['endCameraDrag'];
	next.zoomAt = ((x, y, delta) => {
		counts.zooms += 1;
		originalZoom(x, y, delta);
	}) as PreparedSceneViewport['zoomAt'];
	instrumentation = {
		counts, queryMs, get lastHit() { return lastHit; }, set lastHit(value) { lastHit = value; },
		get currentDrag() { return currentDrag; }, set currentDrag(value) { currentDrag = value; },
		restore() {
			queryThis.query = originalQuery;
			next.beginCameraDrag = originalBegin;
			next.dragCamera = originalDrag;
			next.endCameraDrag = originalEnd;
			next.zoomAt = originalZoom;
		}
	};
}

function buildHollowScene(closedExterior: boolean): PreparedRuntimeGeometryScene {
	const surfaces: Array<{ label: string; sourceMeshIndex: number; positions: Float32Array }> = [];
	const addQuad = (label: string, vertices: number[][]) => {
		const sourceMeshIndex = 100 + surfaces.length;
		surfaces.push({ label, sourceMeshIndex, positions: Float32Array.from(vertices.flat()) });
	};
	const addXWall = (label: string, x: number, z0: number, z1: number) => addQuad(label, [[x, 0, z0], [x, 3, z0], [x, 3, z1], [x, 0, z1]]);
	addQuad('floor', [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]]);
	const exteriorSegments = closedExterior ? [[0, 10]] : [[0, 4], [6, 10]];
	for (let index = 0; index < exteriorSegments.length; index += 1) {
		const [z0, z1] = exteriorSegments[index]!;
		addXWall(`outer-front-${index}`, 0, z0!, z1!);
		addXWall(`outer-back-${index}`, 0.05, z0!, z1!);
	}
	addXWall('interior-wall-x5', 5, 0, 10);
	const meshes = surfaces.map((surface) => ({ sourceMeshIndex: surface.sourceMeshIndex, positions: surface.positions }));
	const groups = surfaces.map((surface) => {
		const points: number[][] = [];
		for (let i = 0; i < surface.positions.length; i += 3) points.push([surface.positions[i]!, surface.positions[i + 1]!, surface.positions[i + 2]!]);
		const min = [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]!))) as [number, number, number];
		const max = [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]!))) as [number, number, number];
		const center = min.map((value, axis) => (value + max[axis]!) / 2) as [number, number, number];
		const radius = Math.max(...points.map((point) => Math.hypot(point[0] - center[0], point[1] - center[1], point[2] - center[2])));
		return {
			key: 'walls' as const, componentId: surface.label, sourceMeshIndex: surface.sourceMeshIndex, definitionIndex: 0, faceCount: 2,
			renderSide: 'double' as const,
			indices: new Uint16Array([0, 1, 2, 0, 2, 3]), matrices: Float32Array.from(new Matrix4().elements),
			localBounds: { min, max, sphereCenter: center, sphereRadius: radius }, worldBounds: { min, max },
			baseY: min[1], topY: max[1]
		};
	});
	return { meshes, groups, totalUnits: groups.length, totalTriangles: groups.length * 2, totalVertices: groups.length * 4 };
}

function labelsForHollow(closedExterior: boolean) {
	const scene = buildHollowScene(closedExterior);
	return Object.fromEntries(scene.groups.map((group) => [group.sourceMeshIndex, group.componentId ?? `mesh-${group.sourceMeshIndex}`]));
}

function instrumentedQuery(raycaster: Raycaster) {
	const live = requireInternalViewport();
	live.navigationQuery.query(raycaster, live.meshRecords as never, live.activeClipPlanes as never, 1e-6);
	return instrumentation?.lastHit ?? null;
}

function walkThroughWall(closedExterior: boolean, maxEvents: number) {
	const expectedId = closedExterior ? 'HOLLOW-closed' : 'HOLLOW-open';
	if (currentFixture?.id !== expectedId) throw new Error(`${expectedId} must be initialized before the wheel crossing case.`);
	api.setPose([-5, 1.6, 5], [10, 1.6, 5]);
	const initialHit = api.centerHit() as QueryHit | null;
	const steps: Array<{ index: number; beforeX: number; afterX: number; appliedStep: number; hitBefore: QueryHit | null; hitAfter: QueryHit | null; eventMs: number }> = [];
	let transition: { index: number; cameraX: number; hit: QueryHit | null } | null = null;
	for (let index = 0; index < Math.min(80, maxEvents); index += 1) {
		const before = viewport!.getCameraPose().position;
		const started = performance.now();
		const eventState = api.dispatchWheel(-100) as { hit: QueryHit | null };
		const after = viewport!.getCameraPose().position;
		const afterHit = api.centerHit() as QueryHit | null;
		const appliedStep = before.distanceTo(after);
		steps.push({ index: index + 1, beforeX: before.x, afterX: after.x, appliedStep, hitBefore: eventState.hit, hitAfter: afterHit, eventMs: performance.now() - started });
		if (after.x > 0 && afterHit && currentFixture?.sourceLabels?.[afterHit.sourceMeshIndex!] === 'interior-wall-x5') {
			transition = { index: index + 1, cameraX: after.x, hit: afterHit };
			break;
		}
	}
	return { initialHit, steps, transition, state: api.snapshot() };
}

function sanitizeSnapshot(snapshot: CameraDragSnapshot) {
	return { position: snapshot.pose.position.toArray(), target: snapshot.pose.target.toArray(), orbitAnchor: snapshot.orbitAnchor.toArray(), sceneEpoch: snapshot.sceneEpoch };
}

function snapshotPose() {
	if (!viewport) return null;
	const pose: CameraPose = viewport.getCameraPose();
	return { position: pose.position.toArray(), target: pose.target.toArray() };
}

function observeViewport() {
	if (!viewport) return null;
	const observation = viewport.observe();
	const live = requireInternalViewport();
	return { ...observation, camera: { ...observation.camera, zoom: live.rendererHost.camera.zoom } };
}

function requireInternalViewport() {
	if (!viewport) throw new Error('No viewport is mounted.');
	return viewport as unknown as InternalViewport;
}

function disposeViewport() {
	const hadViewport = Boolean(viewport || oracleViewport);
	restoreDoorLineVisibility();
	if (viewport) {
	instrumentation?.restore();
	viewport.dispose();
	viewport = null;
	instrumentation = null;
	}
	disposeOracle();
	lastCanvas = null;
	currentFixture = null;
	candidateMirrorScene = null;
	rawMirrorScene = null;
	mirrorOffset = [0, 0, 0];
	return hadViewport;
}

async function waitFrames(count = 2) {
	for (let index = 0; index < count; index += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function setStatus(value: string) { if (status) status.textContent = value; }

async function digestSha256(buffer: ArrayBuffer) {
	const bytes = await crypto.subtle.digest('SHA-256', buffer);
	return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
