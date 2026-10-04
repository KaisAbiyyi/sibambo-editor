import { Matrix4, OrthographicCamera, PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';
import type { PreparedRuntimeGeometryScene } from '@sibambo/scene-runtime/types';
import { PreparedSceneViewport, type CameraDragSnapshot, type CameraPose } from '@sibambo/viewport';
import { loadE4InWorker } from '../../../apps/editor/src/lib/e4-worker-client.js';

type FixtureId = 'S1-new' | 'S2-new' | 'S2-jcm';
type QueryHit = { point: [number, number, number]; distance: number; recordIndex: number; instanceIndex: number; faceIndex: number; sourceMeshIndex: number | null };
type RawQueryHit = { point: Vector3; distance: number; recordIndex: number; instanceIndex: number; faceIndex: number };
type MeshRecordView = { mesh: { userData: Record<string, unknown> }; sourceMeshIndex: number; definitionIndex: number; navigationVisible: boolean; visibleOccurrenceIndices: Set<number>; occurrenceHandles?: string[]; sourceOccurrenceIndices: number[] };
type NavigationQueryView = { query: (...args: any[]) => RawQueryHit | null };
type InternalViewport = {
	navigationQuery: NavigationQueryView;
	meshRecords: MeshRecordView[];
	activeClipPlanes: Array<{ }>; // The test delegate passes these through without editing them.
	canvas: HTMLCanvasElement;
	rendererHost: {
		camera: PerspectiveCamera | OrthographicCamera;
		controls: { target: Vector3 };
		setCamera(camera: PerspectiveCamera | OrthographicCamera): void;
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
			disposed: true, before, after, capturesBefore, capturesAfter,
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
	if (!viewport) return false;
	instrumentation?.restore();
	viewport.dispose();
	viewport = null;
	instrumentation = null;
	return true;
}

async function waitFrames(count = 2) {
	for (let index = 0; index < count; index += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function setStatus(value: string) { if (status) status.textContent = value; }

async function digestSha256(buffer: ArrayBuffer) {
	const bytes = await crypto.subtle.digest('SHA-256', buffer);
	return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
