import {
	BufferAttribute,
	BufferGeometry,
	Box3,
	Box3Helper,
	Color,
	Float32BufferAttribute,
	InstancedMesh,
	LineBasicMaterial,
	LineSegments,
	Matrix4,
	Material,
	MeshStandardMaterial,
	OrthographicCamera,
	Object3D,
	Plane,
	PerspectiveCamera,
	Raycaster,
	Scene,
	Vector2,
	Vector3,
	WebGLRenderer
} from 'three';
import type { CleanMaterialRuntime, RendererObservation } from '@sibambo/contracts';
import type { ClipPlaneRecord, SceneProfile } from '@sibambo/contracts';
import type { PreparedRuntimeGeometryScene } from '@sibambo/scene-runtime/types';
import { shouldUseSuppressedSolidGeometry } from '@sibambo/scene-runtime';
import { createFallbackTextMaterial } from './fallback-text.js';
import {
	MaterialStateManager,
	displayStateFromLegacyMode,
	legacyViewModeFromDisplayState,
	normalizeDisplayState,
	withFaceStyle,
	withViewEffects,
	type DisplayState,
	type FaceStyle,
	type ViewEffects,
	type ViewMode
} from './material-state.js';
import type { RendererBackendName, ViewerRenderer } from './renderer-backend.js';
import { ViewportRendererHost } from './renderer-host.js';
import { renderProfilePolicy, resolveRenderProfile } from './render-profile.js';
import { RuntimeAssetResolver } from './runtime-asset-resolver.js';
import { RuntimeMaterialCache } from './source-material-cache.js';
import { buildPreparedInstancedSurfaceGroups } from './prepared-surface.js';
import { groundedCameraPose, orbitCameraDrag, panCameraDrag, type CameraPose, type NavigationTool } from './camera-navigation.js';
import { SceneVisibilityIndex } from './scene-visibility.js';
import { sourceEdgeMaterialDescriptor } from './source-edge-style.js';
import { bomcClipPlaneToThreePlane, resolveSceneClipPlanes } from './scene-clip-program.js';
import { applyInstancedMeshVisibility, applyMaterialClipPlanes, disposeInstancedMesh, isPointClipped, isReadyAfterRenderedFrame, prepareIndexedGeometry, refreshInstancedMeshBounds } from './viewport-render-state.js';
import { filterTrianglesBySourceFaces, partitionOccurrenceSourceFaces, resolveSourceFaceIndex } from './source-face-filter.js';
import { shouldRenderSourceEdge } from './scene-visibility.js';
import { visibleSceneBounds } from './visible-scene-bounds.js';

export type ViewportBounds = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
export type ViewportSourceFaceReference = { sourceFaceIndex: number; occurrenceHandle?: string };

export type PreparedSceneViewportInput = {
	scene: PreparedRuntimeGeometryScene;
	appearance?: { materials?: CleanMaterialRuntime[]; assets?: Array<{ path: string; bytes: Uint8Array }> };
	scenes?: SceneProfile[];
	activeSceneId?: string | null;
	clipPlanes?: ClipPlaneRecord[];
	encodingProfile?: 'exact' | 'research' | 'visual';
	editorMode?: boolean;
};

export type ViewportPick = {
	sourceMeshIndex: number;
	definitionIndex: number;
	occurrenceIndex: number | null;
	occurrenceHandle: string | null;
	triangleIndex: number | null;
	sourceFaceIndex: number | null;
	point: [number, number, number];
};
export type ViewportOccurrenceTranslation = readonly [number, number, number];

type MeshRecord = {
	mesh: InstancedMesh;
	materialId: string;
	sourceMeshIndex: number;
	definitionIndex: number;
	baseIndices: Uint16Array | Uint32Array;
	fullIndices: Uint16Array | Uint32Array;
	solidIndices?: Uint16Array | Uint32Array;
	fullSourceFaceIndicesByTriangle?: Uint32Array;
	solidSourceTriangleIndices?: Uint32Array;
	fullSourceTagIndicesByTriangle?: Uint32Array;
	baseSourceTriangleIndices?: Uint32Array;
	sourceFaceIndicesByTriangle?: Uint32Array;
	sourceTagIndicesByTriangle?: Uint32Array;
	baseMatrices: Float32Array;
	occurrenceHandles?: string[];
	occurrenceDefinitionIds?: string[];
	occurrenceInstanceIds?: string[];
	occurrenceHierarchyIndices?: Uint32Array;
	occurrenceInstanceIndices?: Uint32Array | number[];
	occurrenceTagIndices?: Int32Array | number[];
	visibleOccurrenceIndices: Set<number>;
	geometryGroupIndex: number;
	visibleSourceFaceIndicesByTriangle?: Uint32Array;
	visibleOccurrenceCount: number;
	visibleSceneSignatures?: string[];
	sourceOccurrenceIndices: number[];
	computeNormalsFromSource: boolean;
};
type EdgeRecord = {
	lines: LineSegments;
	visibleSceneSignatures?: string[];
	basePositions: Float32Array;
	segmentStartsByOccurrence: Map<string, number[]>;
};

/** App-neutral prepared-scene viewport. Domain overlays and mutable editor tools remain caller-owned. */
export class PreparedSceneViewport {
	private readonly scene3d: Scene;
	private readonly renderer: ViewerRenderer;
	private readonly canvas: HTMLCanvasElement;
	private readonly rendererHost: ViewportRendererHost;
	private readonly materialState = new MaterialStateManager();
	private readonly assetResolver = new RuntimeAssetResolver();
	private readonly materialCache: RuntimeMaterialCache;
	private readonly fallbackTextTextures = new Set<import('three').CanvasTexture>();
	private readonly fallbackTextMaterials = new Set<MeshStandardMaterial>();
	private readonly meshRecords: MeshRecord[] = [];
	private readonly baseMeshRecords: MeshRecord[] = [];
	private readonly filteredMeshRecords: MeshRecord[] = [];
	private readonly edgeRecords: EdgeRecord[] = [];
	private readonly selectionHelpers: Box3Helper[] = [];
	private navigationAxes: LineSegments | null = null;
	private readonly domainOverlays = new Map<string, Object3D>();
	private readonly requestedTextures = new Set<string>();
	private readonly settledTextures = new Set<string>();
	private readonly raycaster = new Raycaster();
	private readonly pointer = new Vector2();
	private disposed = false;
	private activeSceneSignature: string | null = null;
	private activeScene: SceneProfile | null = null;
	private activeClipPlanes: Plane[] = [];
	private activeSourceFaceFilter: readonly ViewportSourceFaceReference[] | null = null;
	private activeOccurrenceHandles = new Set<string>();
	private sourceFaceFilterAllowsAllOccurrences = false;
	private firstFrameAtMs: number | null = null;
	private readyAtMs: number | null = null;
	private backend: RendererBackendName;
	private readonly rendererInitializationMs: number;
	private pixelRatio = 1;
	private onPick?: (pick: ViewportPick) => void;
	private onReady?: (observation: RendererObservation) => void;
	private readonly occurrenceTranslations = new Map<string, ViewportOccurrenceTranslation>();
	private occurrencePreview: { handle: string; translation: ViewportOccurrenceTranslation } | null = null;
	private selectedOccurrences = new Set<string>();
	private initialFitHandle = 0;
	private initialFitComplete = false;
	private fittedBounds: ViewportBounds = { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };
	private get camera() { return this.rendererHost.camera; }
	private get controls() { return this.rendererHost.controls; }
	private get displayState() { return this.rendererHost.displayState; }
	private get viewMode() { return legacyViewModeFromDisplayState(this.displayState); }

	private constructor(
		private readonly input: PreparedSceneViewportInput,
		rendererHost: ViewportRendererHost
	) {
		this.rendererHost = rendererHost;
		this.renderer = rendererHost.renderer;
		this.scene3d = rendererHost.scene;
		this.materialCache = new RuntimeMaterialCache(input.appearance?.materials ?? [], this.assetResolver);
		this.canvas = rendererHost.canvas;
		this.backend = rendererHost.backend;
		this.rendererInitializationMs = rendererHost.initializationMs;
		this.pixelRatio = rendererHost.pixelRatio;
		rendererHost.setFrameHandlers(
			undefined,
			() => {
				if (this.firstFrameAtMs === null) this.firstFrameAtMs = performance.now();
				this.checkReady();
			}
		);
		this.canvas.addEventListener('click', this.handleClick);
		this.canvas.addEventListener('wheel', this.handleWheel, { capture: true, passive: false });
		this.assetResolver.onTextureSettled(({ path }) => {
			this.settledTextures.add(path);
			for (const record of this.meshRecords) {
				const material = this.materialState.materialFor(record.materialId, this.displayState, false, this.isDenseScene());
				this.applyClipPlanesToMaterial(material);
				record.mesh.material = material;
			}
			this.renderOnce();
		});

		for (const asset of input.appearance?.assets ?? []) this.assetResolver.registerAsset(asset.path, asset.bytes);
		this.buildMeshes();
		this.createNavigationAxes();
		const selectedScene = input.scenes?.find((scene) => scene.id === input.activeSceneId) ?? input.scenes?.find((scene) => scene.isActiveAtExport);
		if (selectedScene) this.setScene(selectedScene);
		rendererHost.setResizeHandler(() => {
			if (this.initialFitComplete && this.selectedOccurrences.size) this.refreshSelectionHelpers();
		});
		this.fitWhenLaidOut(!(selectedScene?.useCamera && selectedScene.camera));
	}

	static async mount(host: HTMLElement, input: PreparedSceneViewportInput, search = window.location.search): Promise<PreparedSceneViewport> {
		const executableCuts = [...(input.scenes ?? [])].some((scene) => scene.sectionState?.sectionCutsDisplayed && scene.sectionState.renderingSupport === 'full');
		const params = new URLSearchParams(search);
		if (executableCuts) params.set('renderer', 'webgl2');
		const rendererSearch = executableCuts ? `?${params.toString()}` : search;
		const profile = resolveRenderProfile(search);
		const rendererHost = await ViewportRendererHost.mount(host, {
			search: rendererSearch,
			maxPixelRatio: renderProfilePolicy(profile).maxPixelRatio
		});
		return new PreparedSceneViewport(input, rendererHost);
	}

	setViewMode(mode: ViewMode) {
		this.setDisplayState(displayStateFromLegacyMode(mode));
	}

	getDisplayState(): DisplayState {
		return normalizeDisplayState(this.displayState);
	}

	setFaceStyle(faceStyle: FaceStyle) {
		this.setDisplayState(withFaceStyle(this.displayState, faceStyle));
	}

	setViewEffects(effects: Partial<ViewEffects>) {
		this.setDisplayState(withViewEffects(this.displayState, effects));
	}

	setDisplayState(state: DisplayState) {
		const previousMode = this.viewMode;
		const previousSuppressed = shouldUseSuppressedSolidGeometry({ viewMode: previousMode, editorMode: this.input.editorMode ?? false, encodingProfile: this.input.encodingProfile });
		const next = normalizeDisplayState(state);
		this.rendererHost.setDisplayState(next);
		this.materialState.applyDisplayState(next);
		const nextSuppressed = shouldUseSuppressedSolidGeometry({ viewMode: this.viewMode, editorMode: this.input.editorMode ?? false, encodingProfile: this.input.encodingProfile });
		if (previousSuppressed !== nextSuppressed) {
			this.applyGeometryMode();
			this.applySourceFaceFilter();
			this.rebuildSourceEdges();
		} else {
			this.applyMaterialState();
			this.applySourceEdgeStyle();
			this.refreshVisibility();
		}
		this.renderOnce();
	}

	setSceneSignature(signature: string | null) {
		this.setScene(signature ? this.input.scenes?.find((scene) => scene.visibilitySignature === signature) ?? null : null);
	}

	setScene(scene: SceneProfile | null) {
		this.activeScene = scene;
		this.activeSceneSignature = scene?.visibilitySignature ?? null;
		this.rendererHost.applySceneCamera(scene);
		this.applyClipPlanes(scene);
		this.refreshVisibility();
		const visibleBounds = visibleSceneBounds(this.meshRecords);
		if (visibleBounds) this.fittedBounds = visibleBounds;
		this.refreshNavigationAxes();
		this.rendererHost.updateClipRange(this.fittedBounds);
		this.rebuildSourceEdges();
		this.renderOnce();
	}

	/** Filter displayed triangles to source faces selected by the current domain workflow. */
	setSourceFaceFilter(sourceFaces: readonly ViewportSourceFaceReference[] | null) {
		this.activeSourceFaceFilter = sourceFaces;
		this.activeOccurrenceHandles = new Set((sourceFaces ?? []).flatMap((reference) => reference.occurrenceHandle ? [reference.occurrenceHandle] : []));
		this.sourceFaceFilterAllowsAllOccurrences = sourceFaces?.some((reference) => reference.occurrenceHandle === undefined) ?? false;
		this.applySourceFaceFilter();
		this.rebuildSourceEdges();
		this.renderOnce();
	}

	/**
	 * Attach a caller-built Three.js overlay under an app-owned key. The viewport
	 * owns and disposes the attached object tree; callers must pass dedicated objects.
	 */
	setDomainOverlay(key: string, overlay: Object3D | null) {
		const previous = this.domainOverlays.get(key);
		if (previous) {
			this.scene3d.remove(previous);
			this.disposeOverlay(previous);
			this.domainOverlays.delete(key);
		}
		if (overlay) {
			this.domainOverlays.set(key, overlay);
			this.scene3d.add(overlay);
		}
		this.renderOnce();
	}

	setOnPick(handler?: (pick: ViewportPick) => void) { this.onPick = handler; }
	setOnReady(handler?: (observation: RendererObservation) => void) { this.onReady = handler; if (this.readyAtMs !== null) handler?.(this.observe()); }
	setOrbitControlsEnabled(enabled: boolean) { this.rendererHost.setOrbitControlsEnabled(enabled); }
	getCameraPose(): CameraPose { return { position: this.camera.position.clone(), target: this.controls.target.clone() }; }
	setCameraPose(pose: CameraPose) {
		// Editor camera navigation owns the pose directly. The controls target is the
		// persistent orbit anchor: orbit rotates around it, while pan/zoom translate
		// camera and anchor together. Avoid OrbitControls.update() here because it can
		// emit another change/render while a pointer gesture is already driving frames.
		this.camera.position.copy(pose.position);
		this.controls.target.copy(pose.target);
		this.camera.lookAt(pose.target);
		this.camera.updateMatrixWorld();
		this.rendererHost.updateClipRange(this.fittedBounds);
	}
	dragCamera(tool: NavigationTool, start: CameraPose, deltaX: number, deltaY: number, viewportHeight: number) {
		this.setCameraPose(tool === 'orbit'
			? orbitCameraDrag(start, deltaX, deltaY)
			: panCameraDrag(this.camera, start, deltaX, deltaY, viewportHeight));
	}
	moveDeltaForScreenDrag(deltaX: number, deltaY: number, viewportHeight: number): [number, number, number] {
		const direction = this.controls.target.clone().sub(this.camera.position).normalize();
		const right = new Vector3().crossVectors(direction, this.camera.up).normalize();
		const up = new Vector3().crossVectors(right, direction).normalize();
		const distance = this.camera.position.distanceTo(this.controls.target);
		const verticalSpan = this.camera instanceof PerspectiveCamera
			? 2 * Math.tan(this.camera.fov * Math.PI / 360) * distance
			: this.camera instanceof OrthographicCamera ? Math.abs(this.camera.top - this.camera.bottom) / Math.max(this.camera.zoom, 0.0001) : 2;
		const worldPerPixel = verticalSpan / Math.max(viewportHeight, 1);
		return right.multiplyScalar(deltaX * worldPerPixel).add(up.multiplyScalar(-deltaY * worldPerPixel)).toArray() as [number, number, number];
	}
	zoomAt(clientX: number, clientY: number, deltaY: number) {
		const rect = this.canvas.getBoundingClientRect();
		if (!rect.width || !rect.height || !Number.isFinite(deltaY) || deltaY === 0) return;
		this.pointer.set((clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
		this.raycaster.setFromCamera(this.pointer, this.camera);
		const viewDirection = this.controls.target.clone().sub(this.camera.position).normalize();
		const targetPlane = new Plane().setFromNormalAndCoplanarPoint(viewDirection, this.controls.target);
		const planeAnchor = this.raycaster.ray.intersectPlane(targetPlane, new Vector3());
		if (this.camera instanceof OrthographicCamera) {
			if (!planeAnchor) return;
			const factor = Math.exp(Math.max(-240, Math.min(240, deltaY)) * 0.0018);
			const shift = planeAnchor.clone().sub(this.controls.target).multiplyScalar(1 - factor);
			this.camera.position.add(shift);
			this.controls.target.add(shift);
			this.camera.zoom = Math.max(1e-8, Math.min(1e8, this.camera.zoom / factor));
			this.camera.updateProjectionMatrix();
		} else {
			const surface = this.cursorSurfaceHit();
			const span = this.modelSpan();
			const targetDistance = Math.max(this.camera.position.distanceTo(this.controls.target), span * 0.001);
			const anchorDistance = surface?.distance ?? (planeAnchor ? this.camera.position.distanceTo(planeAnchor) : targetDistance);
			const wheelMagnitude = Math.max(0.08, Math.min(2.5, Math.abs(deltaY) / 100));
			// The floor term deliberately prevents asymptotic convergence at a picked surface:
			// repeated zoom-in steps eventually cross it, matching a camera dolly rather than a finite lens zoom.
			const step = Math.max(anchorDistance * 0.18, span * 0.0005, 0.0005) * wheelMagnitude;
			const direction = this.raycaster.ray.direction.clone().normalize();
			const travel = direction.multiplyScalar((deltaY < 0 ? 1 : -1) * step);
			this.camera.position.add(travel);
			this.controls.target.add(travel);
		}
		const grounded = groundedCameraPose({ position: this.camera.position, target: this.controls.target });
		this.camera.position.copy(grounded.position);
		this.controls.target.copy(grounded.target);
		this.camera.lookAt(grounded.target);
		this.camera.updateMatrixWorld();
		this.rendererHost.updateClipRange(this.fittedBounds);
	}
	pickAt(clientX: number, clientY: number): ViewportPick | null {
		const rect = this.canvas.getBoundingClientRect();
		if (!rect.width || !rect.height) return null;
		this.pointer.set((clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
		this.raycaster.setFromCamera(this.pointer, this.camera);
		const records = new Map(this.meshRecords.map((record) => [record.mesh, record]));
		const hit = this.raycaster.intersectObjects(this.meshRecords.map((record) => record.mesh), false)
			.find((candidate) => {
				const record = records.get(candidate.object as InstancedMesh);
				return Boolean(record && record.mesh.visible && !isPointClipped(candidate.point, this.activeClipPlanes)
					&& (candidate.instanceId === undefined || record.visibleOccurrenceIndices.has(candidate.instanceId)));
			});
		if (!hit) return null;
		const record = records.get(hit.object as InstancedMesh);
		if (!record) return null;
		const triangleIndex = hit.faceIndex ?? null;
		return {
			sourceMeshIndex: record.sourceMeshIndex,
			definitionIndex: record.definitionIndex,
			occurrenceIndex: typeof hit.instanceId === 'number' ? record.sourceOccurrenceIndices[hit.instanceId] ?? null : null,
			occurrenceHandle: typeof hit.instanceId === 'number' ? record.occurrenceHandles?.[hit.instanceId] ?? null : null,
			triangleIndex,
			sourceFaceIndex: resolveSourceFaceIndex(triangleIndex, record.visibleSourceFaceIndicesByTriangle ?? record.sourceFaceIndicesByTriangle),
			point: [hit.point.x, hit.point.y, hit.point.z]
		};
	}
	hasOccurrence(occurrenceHandle: string) {
		return this.baseMeshRecords.some((record) => record.occurrenceHandles?.includes(occurrenceHandle));
	}
	occurrenceAnchor(occurrenceHandle: string): [number, number, number] | null {
		const bounds = this.occurrenceBounds(occurrenceHandle, false);
		if (!bounds || bounds.isEmpty()) return null;
		const center = bounds.getCenter(new Vector3());
		return [center.x, center.y, center.z];
	}
	focusOccurrence(occurrenceHandle: string) {
		const bounds = this.occurrenceBounds(occurrenceHandle, true);
		if (!bounds || bounds.isEmpty()) return false;
		const center = bounds.getCenter(new Vector3());
		const offset = this.camera.position.clone().sub(this.controls.target);
		this.setCameraPose({ position: center.clone().add(offset), target: center });
		return true;
	}
	selectOccurrencesInRect(startX: number, startY: number, endX: number, endY: number) {
		const leftToRight = endX >= startX;
		const selection = normalizeRect(startX, startY, endX, endY);
		const canvasRect = this.canvas.getBoundingClientRect();
		const selected = new Set<string>();
		for (const [handle, bounds] of this.visibleOccurrenceBounds()) {
			const screen = projectBounds(bounds, this.camera, canvasRect);
			if (leftToRight
				? screen.left >= selection.left && screen.right <= selection.right && screen.top >= selection.top && screen.bottom <= selection.bottom
				: screen.right >= selection.left && screen.left <= selection.right && screen.bottom >= selection.top && screen.top <= selection.bottom) selected.add(handle);
		}
		return [...selected];
	}
	setSelectedOccurrences(occurrenceHandles: readonly string[]) {
		this.selectedOccurrences = new Set(occurrenceHandles.filter((handle) => this.hasOccurrence(handle)));
		this.refreshSelectionHelpers();
		this.renderOnce();
	}
	setOccurrenceTransforms(transforms: ReadonlyMap<string, ViewportOccurrenceTranslation>) {
		const previous = new Map(this.occurrenceTranslations);
		this.occurrenceTranslations.clear();
		for (const [handle, translation] of transforms) {
			if (this.hasOccurrence(handle) && translation.every(Number.isFinite)) this.occurrenceTranslations.set(handle, [...translation] as ViewportOccurrenceTranslation);
		}
		const changed = new Set([...previous.keys(), ...this.occurrenceTranslations.keys()]);
		this.applyOccurrenceTransforms(changed);
	}
	setOccurrencePreview(occurrenceHandle: string | null, translation?: ViewportOccurrenceTranslation | null) {
		const previousHandle = this.occurrencePreview?.handle;
		this.occurrencePreview = occurrenceHandle && translation && this.hasOccurrence(occurrenceHandle)
			? { handle: occurrenceHandle, translation: [...translation] as ViewportOccurrenceTranslation } : null;
		const changed = new Set([previousHandle, this.occurrencePreview?.handle].filter((handle): handle is string => !!handle));
		this.applyOccurrenceTransforms(changed);
	}

	fit() {
		const bounds = visibleSceneBounds(this.meshRecords);
		this.fittedBounds = bounds ?? { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };
		this.refreshNavigationAxes();
		this.focusBounds(this.fittedBounds);
	}

	focusBounds(bounds: ViewportBounds) {
		this.rendererHost.focusBounds(bounds);
		this.renderOnce();
	}

	view(name: 'top' | 'front' | 'iso') {
		this.rendererHost.view(this.fittedBounds, name);
		this.renderOnce();
	}

	capture() {
		return this.captureWithObservation().screenshot;
	}

	captureWithObservation() {
		// The browser does not preserve the WebGL drawing buffer between composites.
		// Render synchronously immediately before reading it.
		const screenshot = this.rendererHost.capturePng();
		if (this.firstFrameAtMs === null) this.firstFrameAtMs = performance.now();
		this.checkReady();
		return { screenshot, observation: this.observe() };
	}
	observe(): RendererObservation {
		const info = 'info' in this.renderer ? (this.renderer as WebGLRenderer).info : null;
		const textureStats = this.assetResolver.getStats();
		const visibleRecords = this.meshRecords.filter((record) => record.mesh.visible);
		const groupTriangles = visibleRecords.reduce((sum, record) => sum + ((record.mesh.geometry.index?.count ?? 0) / 3) * record.visibleOccurrenceCount, 0);
		return {
			backend: this.backend,
			viewport: { width: this.canvas.width, height: this.canvas.height, pixelRatio: this.pixelRatio },
			camera: { position: point(this.camera.position), target: point(this.controls.target), up: point(this.camera.up), fov: this.camera instanceof PerspectiveCamera ? this.camera.fov : 0, near: this.camera.near, far: this.camera.far, projection: this.camera instanceof PerspectiveCamera ? 'perspective' : 'orthographic', orthographicHeight: this.camera instanceof OrthographicCamera ? this.camera.top - this.camera.bottom : undefined },
			scene: { meshCount: visibleRecords.length, instanceCount: visibleRecords.reduce((sum, record) => sum + record.visibleOccurrenceCount, 0), uniqueTriangles: groupTriangles },
			renderer: { initializationMs: this.rendererInitializationMs, render: { calls: info?.render.calls ?? null, triangles: info?.render.triangles ?? null }, memory: { geometries: info?.memory.geometries ?? null, textures: info?.memory.textures ?? null } },
			resources: { jsHeapBytes: (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize ?? null, totalGpuMemoryBytes: null },
			appearance: {
				viewMode: this.viewMode,
				faceStyle: this.displayState.faceStyle,
				effects: { ...this.displayState.effects },
				ambientOcclusionSupported: this.rendererHost.supportsAmbientOcclusion,
				photorealFallback: this.displayState.faceStyle === 'photoreal' && !this.hasNativePbr(),
				failedDecodePaths: textureStats.failedDecodePaths,
				missingAssetPaths: textureStats.missingAssetPaths,
				unsupportedTexturePaths: textureStats.unsupportedTexturePaths
			},
			geometryCount: info?.memory.geometries ?? null,
			textureCount: info?.memory.textures ?? null,
			drawCallCount: info?.render.calls ?? null,
			triangleCount: info?.render.triangles ?? null,
			firstFrameAtMs: this.firstFrameAtMs,
			readyAtMs: this.readyAtMs
		};
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		if (this.initialFitHandle) cancelAnimationFrame(this.initialFitHandle);
		this.initialFitHandle = 0;
		this.canvas.removeEventListener('click', this.handleClick);
		this.canvas.removeEventListener('wheel', this.handleWheel, true);
		this.clearSelectionHelpers();
		for (const record of new Set([...this.baseMeshRecords, ...this.filteredMeshRecords])) {
			this.scene3d.remove(record.mesh);
			disposeInstancedMesh(record.mesh);
		}
		for (const overlay of this.domainOverlays.values()) this.disposeOverlay(overlay);
		this.domainOverlays.clear();
		this.materialState.dispose();
		this.materialCache.dispose();
		for (const material of this.fallbackTextMaterials) material.dispose();
		this.fallbackTextMaterials.clear();
		for (const texture of this.fallbackTextTextures) texture.dispose();
		this.fallbackTextTextures.clear();
		for (const child of [...this.scene3d.children]) {
			if (child instanceof LineSegments) { child.geometry.dispose(); (child.material as LineBasicMaterial).dispose(); }
			this.scene3d.remove(child);
		}
		this.assetResolver.dispose();
		this.rendererHost.dispose();
	}

	private buildMeshes() {
		const sourceMeshes = new Map(this.input.scene.meshes.map((mesh) => [mesh.sourceMeshIndex, mesh]));
		for (const surface of buildPreparedInstancedSurfaceGroups({
			groups: this.input.scene.groups,
			findSource: (group) => sourceMeshes.get(group.sourceMeshIndex),
			resolveBuffers: (group, source) => ({
				positions: group.batchPositions ?? source.positions,
				normals: group.batchNormals ?? source.normals,
				uvs: group.batchUvs ?? source.uvs
			}),
			includeGroup: (group, _source, buffers) => buffers.positions.length >= 9 && group.indices.length >= 3,
			resolveMaterial: (group, groupIndex) => {
				const side = group.renderSide ?? 'double';
				const material = group.fallbackText
					? this.createFallbackTextMaterial(group.fallbackText)
					: this.materialCache.get(group.materialIndex, side, {
						index: group.materialIndex ?? -1,
						id: group.materialId ?? group.key,
						name: group.materialName,
						baseColor: group.baseColor,
						baseColorRgba: group.baseColorRgba,
						opacity: group.opacity,
						colorSpace: group.colorSpace ?? 'srgb',
						textureAsset: group.textureAsset
					});
				const texturePath = group.textureAsset ?? this.input.appearance?.materials?.[group.materialIndex ?? -1]?.textureAsset;
				if (texturePath && this.assetResolver.hasAsset(texturePath) && !texturePath.toLowerCase().endsWith('.ktx2')) this.requestedTextures.add(texturePath);
				this.materialState.register(`material:${groupIndex}`, material, group.key);
				return material;
			},
			skipEmptyInstances: true,
			populateMatrices: true
		})) {
			const { group, groupIndex, material, mesh } = surface;
			const materialId = `material:${groupIndex}`;
			mesh.userData.sourceMeshIndex = group.sourceMeshIndex;
			mesh.userData.definitionIndex = group.definitionIndex;
			this.scene3d.add(mesh);
			const record: MeshRecord = {
				mesh, materialId, sourceMeshIndex: group.sourceMeshIndex, definitionIndex: group.definitionIndex,
				baseIndices: group.indices, fullIndices: group.indices, solidIndices: group.solidIndices,
				baseSourceTriangleIndices: group.solidSourceTriangleIndices,
				fullSourceFaceIndicesByTriangle: group.sourceFaceIndicesByTriangle,
				solidSourceTriangleIndices: group.solidSourceTriangleIndices,
				fullSourceTagIndicesByTriangle: group.sourceTagIndicesByTriangle,
				sourceFaceIndicesByTriangle: group.sourceFaceIndicesByTriangle,
				sourceTagIndicesByTriangle: group.sourceTagIndicesByTriangle,
				baseMatrices: group.matrices.slice(), occurrenceHandles: group.occurrenceHandles,
				occurrenceDefinitionIds: group.occurrenceDefinitionIds, occurrenceInstanceIds: group.occurrenceInstanceIds,
				occurrenceHierarchyIndices: group.occurrenceHierarchyIndices,
				occurrenceInstanceIndices: group.occurrenceInstanceIndices, occurrenceTagIndices: group.occurrenceTagIndices,
				visibleOccurrenceIndices: new Set(Array.from({ length: surface.instanceCount }, (_, index) => index)), geometryGroupIndex: groupIndex,
				visibleOccurrenceCount: surface.instanceCount, visibleSceneSignatures: group.visibleSceneSignatures,
				sourceOccurrenceIndices: Array.from({ length: surface.instanceCount }, (_, index) => index),
				computeNormalsFromSource: !(surface.buffers.normals?.length === surface.buffers.positions.length)
			};
			this.baseMeshRecords.push(record);
			this.meshRecords.push(record);
		}
		this.applyGeometryMode();
		this.applyClipPlanes(this.activeScene);
		this.rebuildSourceEdges();
	}

	private rebuildSourceEdges() {
		for (const record of this.edgeRecords) {
			this.scene3d.remove(record.lines); record.lines.geometry.dispose(); (record.lines.material as LineBasicMaterial).dispose();
		}
		this.edgeRecords.length = 0;
		if (this.activeSourceFaceFilter !== null) return;
		const suppress = shouldUseSuppressedSolidGeometry({ viewMode: this.viewMode, editorMode: this.input.editorMode ?? false, encodingProfile: this.input.encodingProfile });
		const edgeSets = suppress ? this.input.scene.solidEdgeSets ?? this.input.scene.edgeSets ?? [] : this.input.scene.edgeSets ?? [];
		const visibilityIndex = this.activeScene ? new SceneVisibilityIndex(this.activeScene) : null;
		const compiled = visibilityIndex && this.input.scene.occurrenceHierarchy ? visibilityIndex.compileOccurrenceVisibility(this.input.scene.occurrenceHierarchy) : null;
		for (const edgeSet of edgeSets) {
			if (this.activeSceneSignature && edgeSet.visibleSceneSignatures?.length && !edgeSet.visibleSceneSignatures.includes(this.activeSceneSignature)) continue;
			const coordinates: number[] = [];
			const segmentStartsByOccurrence = new Map<string, number[]>();
			const occurrenceCount = Math.floor(edgeSet.matrices.length / 16);
			for (let edgeIndex = 0; edgeIndex < edgeSet.positions.length / 6; edgeIndex++) {
				if (!shouldRenderSourceEdge(edgeSet.flags[edgeIndex], this.activeScene, this.activeSceneSignature, edgeSet.visibleSceneSignatures)) continue;
				const localA = new Vector3(edgeSet.positions[edgeIndex * 6], edgeSet.positions[edgeIndex * 6 + 1], edgeSet.positions[edgeIndex * 6 + 2]);
				const localB = new Vector3(edgeSet.positions[edgeIndex * 6 + 3], edgeSet.positions[edgeIndex * 6 + 4], edgeSet.positions[edgeIndex * 6 + 5]);
				for (let occurrence = 0; occurrence < occurrenceCount; occurrence++) {
					const handle = edgeSet.occurrenceHandles?.[occurrence];
					if (!this.occurrenceVisible(edgeSet.occurrenceHierarchyIndices?.[occurrence], edgeSet.occurrenceInstanceIndices?.[occurrence], edgeSet.occurrenceTagIndices?.[occurrence], compiled, handle, visibilityIndex)) continue;
					const matrix = new Matrix4().fromArray(edgeSet.matrices, occurrence * 16);
					const a = localA.clone().applyMatrix4(matrix); const b = localB.clone().applyMatrix4(matrix);
					if (handle) {
						const starts = segmentStartsByOccurrence.get(handle) ?? [];
						starts.push(coordinates.length / 3);
						segmentStartsByOccurrence.set(handle, starts);
					}
					coordinates.push(a.x, a.y, a.z, b.x, b.y, b.z);
				}
			}
			if (coordinates.length === 0) continue;
			const geometry = new BufferGeometry();
			geometry.setAttribute('position', new Float32BufferAttribute(coordinates, 3));
			const material = new LineBasicMaterial(sourceEdgeMaterialDescriptor(this.displayState));
			this.applyClipPlanesToMaterial(material);
			const edges = new LineSegments(geometry, material);
			edges.renderOrder = 2;
			this.scene3d.add(edges);
			this.edgeRecords.push({ lines: edges, visibleSceneSignatures: edgeSet.visibleSceneSignatures, basePositions: Float32Array.from(coordinates), segmentStartsByOccurrence });
		}
		this.applyOccurrenceTransforms(new Set([...this.occurrenceTranslations.keys(), ...(this.occurrencePreview ? [this.occurrencePreview.handle] : [])]));
	}

	private applyGeometryMode() {
		const suppress = shouldUseSuppressedSolidGeometry({ viewMode: this.viewMode, editorMode: this.input.editorMode ?? false, encodingProfile: this.input.encodingProfile });
		for (const record of this.baseMeshRecords) {
			const group = this.input.scene.groups[record.geometryGroupIndex];
			const useSolid = suppress && group.solidIndices !== undefined;
			record.baseIndices = useSolid ? group.solidIndices! : record.fullIndices;
			record.baseSourceTriangleIndices = useSolid ? group.solidSourceTriangleIndices : undefined;
			record.sourceFaceIndicesByTriangle = useSolid
				? group.solidSourceTriangleIndices ? Uint32Array.from(group.solidSourceTriangleIndices, (triangle) => group.sourceFaceIndicesByTriangle?.[triangle] ?? 0xffffffff) : undefined
				: record.fullSourceFaceIndicesByTriangle;
			record.sourceTagIndicesByTriangle = useSolid
				? group.solidSourceTriangleIndices ? Uint32Array.from(group.solidSourceTriangleIndices, (triangle) => group.sourceTagIndicesByTriangle?.[triangle] ?? 0xffffffff) : undefined
				: record.fullSourceTagIndicesByTriangle;
			prepareIndexedGeometry(record.mesh.geometry, record.baseIndices, record.computeNormalsFromSource);
			const material = this.materialState.materialFor(record.materialId, this.displayState, false, this.isDenseScene());
			this.applyClipPlanesToMaterial(material);
			record.mesh.material = material;
		}
	}

	private applyMaterialState() {
		for (const record of this.baseMeshRecords) {
			const material = this.materialState.materialFor(record.materialId, this.displayState, false, this.isDenseScene());
			this.applyClipPlanesToMaterial(material);
			record.mesh.material = material;
		}
		for (const record of this.filteredMeshRecords) {
			const material = this.materialState.materialFor(record.materialId, this.displayState, false, this.isDenseScene());
			this.applyClipPlanesToMaterial(material);
			record.mesh.material = material;
		}
	}

	private applySourceEdgeStyle() {
		const descriptor = sourceEdgeMaterialDescriptor(this.displayState);
		for (const record of this.edgeRecords) {
			const material = record.lines.material as LineBasicMaterial;
			material.color.set(descriptor.color);
			material.transparent = descriptor.transparent;
			material.opacity = descriptor.opacity;
			material.depthTest = descriptor.depthTest;
			material.depthWrite = descriptor.depthWrite;
			material.needsUpdate = true;
		}
	}

	private applySourceFaceFilter() {
		for (const record of this.filteredMeshRecords) {
			this.scene3d.remove(record.mesh);
			disposeInstancedMesh(record.mesh);
		}
		this.filteredMeshRecords.length = 0;
		this.meshRecords.length = 0;
		this.meshRecords.push(...this.baseMeshRecords);
		if (this.activeSourceFaceFilter === null) {
			this.refreshVisibility();
			return;
		}
		const partitions = partitionOccurrenceSourceFaces(this.activeSourceFaceFilter);
		const wildcard = partitions.find((partition) => partition.occurrenceHandle === undefined)?.sourceFaceIndices;
		for (const base of this.baseMeshRecords) {
			base.mesh.visible = false;
			const byFaceSet = new Map<string, { faces: ReadonlySet<number>; occurrences: number[] }>();
			for (let occurrence = 0; occurrence < base.mesh.count; occurrence += 1) {
				const handle = base.occurrenceHandles?.[occurrence];
				const faces = partitions.find((partition) => partition.occurrenceHandle === handle)?.sourceFaceIndices ?? wildcard;
				if (!faces) continue;
				const key = [...faces].sort((a, b) => a - b).join(',');
				const partition = byFaceSet.get(key) ?? { faces, occurrences: [] };
				partition.occurrences.push(occurrence);
				byFaceSet.set(key, partition);
			}
			for (const { faces, occurrences } of byFaceSet.values()) {
				const indices = filterTrianglesBySourceFaces(base.baseIndices, base.sourceFaceIndicesByTriangle, faces);
				if (indices.length === 0) continue;
				const selectedFaceMap = base.sourceFaceIndicesByTriangle ? Uint32Array.from(base.sourceFaceIndicesByTriangle.filter((faceIndex) => faces.has(faceIndex))) : undefined;
				const geometry = base.mesh.geometry.clone();
				prepareIndexedGeometry(geometry, indices, base.computeNormalsFromSource);
				const mesh = new InstancedMesh(geometry, base.mesh.material, occurrences.length);
				const matrices = new Float32Array(occurrences.length * 16);
				for (let target = 0; target < occurrences.length; target += 1) {
					const source = occurrences[target];
					const matrix = base.baseMatrices.subarray(source * 16, source * 16 + 16);
					matrices.set(matrix, target * 16);
					mesh.setMatrixAt(target, new Matrix4().fromArray(matrix));
				}
				mesh.instanceMatrix.needsUpdate = true;
				mesh.userData.sourceMeshIndex = base.sourceMeshIndex;
				mesh.userData.definitionIndex = base.definitionIndex;
				this.scene3d.add(mesh);
				const clone: MeshRecord = {
					...base, mesh, baseIndices: indices, baseMatrices: matrices, visibleSourceFaceIndicesByTriangle: selectedFaceMap,
					occurrenceHandles: subset(base.occurrenceHandles, occurrences),
					occurrenceDefinitionIds: subset(base.occurrenceDefinitionIds, occurrences),
					occurrenceInstanceIds: subset(base.occurrenceInstanceIds, occurrences),
					occurrenceHierarchyIndices: subset(base.occurrenceHierarchyIndices, occurrences),
					occurrenceInstanceIndices: subset(base.occurrenceInstanceIndices, occurrences),
					occurrenceTagIndices: subset(base.occurrenceTagIndices, occurrences),
					visibleOccurrenceIndices: new Set(occurrences.map((_, index) => index)),
					sourceOccurrenceIndices: occurrences.map((index) => base.sourceOccurrenceIndices[index]),
					visibleOccurrenceCount: occurrences.length
				};
				this.filteredMeshRecords.push(clone);
				this.meshRecords.push(clone);
			}
		}
		this.refreshVisibility();
	}

	private refreshVisibility() {
		const profile = this.activeScene ? new SceneVisibilityIndex(this.activeScene) : null;
		const compiled = profile && this.input.scene.occurrenceHierarchy ? profile.compileOccurrenceVisibility(this.input.scene.occurrenceHierarchy) : null;
		for (const record of this.meshRecords) {
			const isBaseHiddenForIsolation = this.activeSourceFaceFilter !== null && this.baseMeshRecords.includes(record);
			const signatureVisible = !this.activeSceneSignature || !record.visibleSceneSignatures?.length || record.visibleSceneSignatures.includes(this.activeSceneSignature);
			record.visibleOccurrenceIndices = applyInstancedMeshVisibility(record.mesh, record.baseMatrices, (occurrence) =>
				this.occurrenceVisible(record.occurrenceHierarchyIndices?.[occurrence], record.occurrenceInstanceIndices?.[occurrence], record.occurrenceTagIndices?.[occurrence], compiled, record.occurrenceHandles?.[occurrence], profile)
			);
			record.visibleOccurrenceCount = record.visibleOccurrenceIndices.size;
			record.mesh.visible = this.displayState.faceStyle !== 'wireframe'
				&& !isBaseHiddenForIsolation && signatureVisible && record.baseIndices.length > 0 && record.visibleOccurrenceCount > 0;
		}
		this.applyOccurrenceTransforms(new Set([...this.occurrenceTranslations.keys(), ...(this.occurrencePreview ? [this.occurrencePreview.handle] : [])]));
	}

	private occurrenceVisible(hierarchyIndex?: number, instanceIndex?: number, tagIndex?: number, compiled?: Uint8Array | null, handle?: string, visibilityIndex?: SceneVisibilityIndex | null) {
		if (this.activeSourceFaceFilter !== null) {
			if (!this.sourceFaceFilterAllowsAllOccurrences && (!handle || !this.activeOccurrenceHandles.has(handle))) return false;
		}
		if (!this.activeScene) return true;
		return (visibilityIndex ?? new SceneVisibilityIndex(this.activeScene)).isOccurrenceVisible(instanceIndex, tagIndex, hierarchyIndex, compiled);
	}

	private applyClipPlanes(scene: SceneProfile | null) {
		const active = scene ? resolveSceneClipPlanes(scene, this.input.clipPlanes ?? []) : [];
		this.activeClipPlanes = active.filter((plane) => !plane.ownerDefinitionId && !plane.ownerInstanceId).map((plane) => bomcClipPlaneToThreePlane(plane));
		const renderer = this.renderer as ViewerRenderer & { localClippingEnabled?: boolean };
		if ('localClippingEnabled' in renderer) renderer.localClippingEnabled = this.activeClipPlanes.length > 0;
		for (const entry of this.materialState.originalMaterials.values()) {
			this.applyClipPlanesToMaterial(entry.original);
		}
		for (const material of this.materialState.derivedMaterials.values()) {
			this.applyClipPlanesToMaterial(material);
		}
		for (const record of this.edgeRecords) this.applyClipPlanesToMaterial(record.lines.material as Material);
	}

	private applyClipPlanesToMaterial(material: Material) {
		applyMaterialClipPlanes(material, this.activeClipPlanes);
	}

	private createFallbackTextMaterial(text: string) {
		const created = createFallbackTextMaterial(text);
		this.fallbackTextMaterials.add(created.material);
		if (created.texture) this.fallbackTextTextures.add(created.texture);
		return created.material;
	}

	private createNavigationAxes() {
		const geometry = new BufferGeometry();
		geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(18), 3));
		geometry.setAttribute('color', new Float32BufferAttribute([
			0.86, 0.10, 0.10, 0.86, 0.10, 0.10, // X / red
			0.08, 0.58, 0.22, 0.08, 0.58, 0.22, // Y / green
			0.10, 0.32, 0.95, 0.10, 0.32, 0.95  // Z / blue
		], 3));
		const material = new LineBasicMaterial({
			vertexColors: true,
			transparent: true,
			opacity: 0.82,
			depthTest: false,
			depthWrite: false,
			toneMapped: false
		});
		this.navigationAxes = new LineSegments(geometry, material);
		this.navigationAxes.name = 'sibambo-navigation-axes';
		this.navigationAxes.renderOrder = 40;
		this.scene3d.add(this.navigationAxes);
		this.refreshNavigationAxes();
	}

	private refreshNavigationAxes() {
		if (!this.navigationAxes) return;
		const span = this.modelSpan();
		const maxCoordinate = Math.max(
			Math.abs(this.fittedBounds.min.x), Math.abs(this.fittedBounds.max.x),
			Math.abs(this.fittedBounds.min.y), Math.abs(this.fittedBounds.max.y),
			Math.abs(this.fittedBounds.min.z), Math.abs(this.fittedBounds.max.z)
		);
		const length = Math.max(10, span * 3, maxCoordinate * 1.5);
		// Runtime is Three.js Y-up while SketchUp source semantics are Z-up.
		// Draw source X red on runtime X, source Y green on runtime Z, and source
		// Z blue on runtime Y so the visible guide matches SketchUp conventions.
		const positions = [
			-length, 0, 0, length, 0, 0,
			0, 0, -length, 0, 0, length,
			0, -length, 0, 0, length, 0
		];
		const attribute = this.navigationAxes.geometry.getAttribute('position') as BufferAttribute;
		for (let index = 0; index < positions.length; index += 1) attribute.setX(index, positions[index]);
		attribute.needsUpdate = true;
		this.navigationAxes.geometry.computeBoundingSphere();
	}

	private hasNativePbr() {
		return (this.input.appearance?.materials ?? []).some((material) =>
			material.roughness !== undefined || material.metalness !== undefined
			|| Boolean(material.roughnessTextureAsset || material.metalnessTextureAsset || material.normalTextureAsset || material.occlusionTextureAsset)
		);
	}
	private isDenseScene() {
		return (this.input.scene.totalTriangles ?? 0) > 250_000 || this.input.scene.groups.length > 1_500;
	}
	private modelSpan() {
		return Math.max(
			this.fittedBounds.max.x - this.fittedBounds.min.x,
			this.fittedBounds.max.y - this.fittedBounds.min.y,
			this.fittedBounds.max.z - this.fittedBounds.min.z,
			0.001
		);
	}
	private cursorSurfaceHit() {
		const epsilon = Math.max(this.modelSpan() * 1e-6, 1e-6);
		const visible = this.meshRecords.filter((record) => record.mesh.visible);
		const records = new Map(visible.map((record) => [record.mesh, record]));
		return this.raycaster.intersectObjects(visible.map((record) => record.mesh), false).find((candidate) => {
			const record = records.get(candidate.object as InstancedMesh);
			return Boolean(record && candidate.distance > epsilon && !isPointClipped(candidate.point, this.activeClipPlanes)
				&& (candidate.instanceId === undefined || record.visibleOccurrenceIndices.has(candidate.instanceId)));
		}) ?? null;
	}
	private renderOnce() { if (!this.disposed) this.rendererHost.renderNow(); }
	private fitWhenLaidOut(shouldFit = true) {
		const waitForLayout = () => {
			this.initialFitHandle = 0;
			if (this.disposed) return;
			const { width, height } = this.rendererHost.layoutSize;
			if (width <= 0 || height <= 0) {
				this.initialFitHandle = requestAnimationFrame(waitForLayout);
				return;
			}
			if (shouldFit) this.fit();
			else {
				const visibleBounds = visibleSceneBounds(this.meshRecords);
				if (visibleBounds) this.fittedBounds = visibleBounds;
				this.rendererHost.updateClipRange(this.fittedBounds);
				this.renderOnce();
			}
			this.initialFitComplete = true;
			this.checkReady();
		};
		this.initialFitHandle = requestAnimationFrame(waitForLayout);
	}
	private disposeOverlay(object: Object3D) {
		object.traverse((child) => {
			const renderable = child as Object3D & { geometry?: BufferGeometry; material?: Material | Material[] };
			renderable.geometry?.dispose();
			if (Array.isArray(renderable.material)) for (const material of renderable.material) material.dispose();
			else renderable.material?.dispose();
		});
	}
	private checkReady() {
		if (this.readyAtMs !== null || !this.initialFitComplete) return;
		const pending = [...this.requestedTextures].filter((path) => !this.settledTextures.has(path)).length;
		if (!isReadyAfterRenderedFrame(this.firstFrameAtMs !== null, pending)) return;
		this.readyAtMs = performance.now();
		this.onReady?.(this.observe());
	}

	private handleWheel = (event: WheelEvent) => {
		if (this.disposed) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		this.zoomAt(event.clientX, event.clientY, event.deltaY);
	};

	private handleClick = (event: MouseEvent) => {
		if (!this.onPick) return;
		const pick = this.pickAt(event.clientX, event.clientY);
		if (pick) this.onPick(pick);
	};

	private occurrenceTranslation(handle: string): ViewportOccurrenceTranslation {
		if (this.occurrencePreview?.handle === handle) return this.occurrencePreview.translation;
		return this.occurrenceTranslations.get(handle) ?? [0, 0, 0];
	}

	private occurrenceBounds(handle: string, visibleOnly: boolean) {
		const bounds = new Box3();
		const translation = this.occurrenceTranslation(handle);
		const translate = new Matrix4().makeTranslation(translation[0], translation[1], translation[2]);
		for (const record of this.meshRecords) {
			if (visibleOnly && !record.mesh.visible) continue;
			const indices = record.occurrenceHandles?.flatMap((item, index) => item === handle && (!visibleOnly || record.visibleOccurrenceIndices.has(index)) ? [index] : []) ?? [];
			if (!indices.length) continue;
			if (!record.mesh.geometry.boundingBox) record.mesh.geometry.computeBoundingBox();
			const localBounds = record.mesh.geometry.boundingBox;
			if (!localBounds || localBounds.isEmpty()) continue;
			for (const index of indices) {
				const matrix = new Matrix4().fromArray(record.baseMatrices, index * 16).premultiply(translate);
				bounds.union(localBounds.clone().applyMatrix4(matrix));
			}
		}
		return bounds.isEmpty() ? null : bounds;
	}

	private visibleOccurrenceBounds() {
		const boundsByHandle = new Map<string, Box3>();
		for (const record of this.meshRecords) {
			if (!record.mesh.visible || !record.occurrenceHandles?.length) continue;
			if (!record.mesh.geometry.boundingBox) record.mesh.geometry.computeBoundingBox();
			const localBounds = record.mesh.geometry.boundingBox;
			if (!localBounds || localBounds.isEmpty()) continue;
			for (const index of record.visibleOccurrenceIndices) {
				const handle = record.occurrenceHandles[index] ?? `viewport:anonymous:${record.geometryGroupIndex}:${index}`;
				const translation = this.occurrenceTranslation(handle);
				const transform = new Matrix4().makeTranslation(translation[0], translation[1], translation[2]);
				const matrix = new Matrix4().fromArray(record.baseMatrices, index * 16).premultiply(transform);
				const bounds = boundsByHandle.get(handle) ?? new Box3();
				bounds.union(localBounds.clone().applyMatrix4(matrix));
				boundsByHandle.set(handle, bounds);
			}
		}
		return boundsByHandle;
	}

	private applyOccurrenceTransforms(handles: ReadonlySet<string>) {
		if (!handles.size) return;
		for (const record of this.meshRecords) {
			let changed = false;
			const matrices = record.mesh.instanceMatrix.array as Float32Array;
			for (let index = 0; index < record.mesh.count; index += 1) {
				const handle = record.occurrenceHandles?.[index];
				if (!handle || !handles.has(handle) || !record.visibleOccurrenceIndices.has(index)) continue;
				const translation = this.occurrenceTranslation(handle);
				new Matrix4().fromArray(record.baseMatrices, index * 16)
					.premultiply(new Matrix4().makeTranslation(translation[0], translation[1], translation[2]))
					.toArray(matrices, index * 16);
				changed = true;
			}
			if (changed) {
				record.mesh.instanceMatrix.needsUpdate = true;
				refreshInstancedMeshBounds(record.mesh);
			}
		}
		for (const record of this.edgeRecords) {
			const attribute = record.lines.geometry.getAttribute('position');
			if (!attribute) continue;
			const positions = attribute.array as Float32Array;
			let changed = false;
			for (const handle of handles) {
				const starts = record.segmentStartsByOccurrence.get(handle);
				if (!starts) continue;
				const translation = this.occurrenceTranslation(handle);
				for (const start of starts) {
					for (let vertex = start; vertex < start + 2; vertex += 1) {
						for (let axis = 0; axis < 3; axis += 1) positions[vertex * 3 + axis] = record.basePositions[vertex * 3 + axis] + translation[axis];
					}
				}
				changed = true;
			}
			if (changed) {
				attribute.needsUpdate = true;
				record.lines.geometry.computeBoundingBox();
				record.lines.geometry.computeBoundingSphere();
			}
		}
		this.refreshSelectionHelpers();
		this.renderOnce();
	}

	private refreshSelectionHelpers() {
		this.clearSelectionHelpers();
		for (const handle of this.selectedOccurrences) {
			const bounds = this.occurrenceBounds(handle, true);
			if (!bounds) continue;
			bounds.expandByScalar(Math.max(bounds.getSize(new Vector3()).length() * 0.002, 0.002));
			const helper = new Box3Helper(bounds, new Color('#125dff'));
			helper.renderOrder = 12;
			this.selectionHelpers.push(helper);
			this.scene3d.add(helper);
		}
	}

	private clearSelectionHelpers() {
		for (const helper of this.selectionHelpers) {
			this.scene3d.remove(helper);
			helper.geometry.dispose();
			(helper.material as LineBasicMaterial).dispose();
		}
		this.selectionHelpers.length = 0;
	}
}

function point(value: Vector3) { return { x: value.x, y: value.y, z: value.z }; }
function normalizeRect(x1: number, y1: number, x2: number, y2: number) {
	return { left: Math.min(x1, x2), right: Math.max(x1, x2), top: Math.min(y1, y2), bottom: Math.max(y1, y2) };
}
function projectBounds(bounds: Box3, camera: PerspectiveCamera | OrthographicCamera, canvasRect: DOMRect) {
	const min = bounds.min, max = bounds.max;
	const corners = [
		new Vector3(min.x, min.y, min.z), new Vector3(min.x, min.y, max.z), new Vector3(min.x, max.y, min.z), new Vector3(min.x, max.y, max.z),
		new Vector3(max.x, min.y, min.z), new Vector3(max.x, min.y, max.z), new Vector3(max.x, max.y, min.z), new Vector3(max.x, max.y, max.z)
	].map((corner) => corner.project(camera));
	const xs = corners.map((corner) => canvasRect.left + (corner.x + 1) * canvasRect.width / 2);
	const ys = corners.map((corner) => canvasRect.top + (1 - corner.y) * canvasRect.height / 2);
	return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}
function subset(values: ArrayLike<string | number> | undefined, indices: number[]): any {
	if (!values) return undefined;
	const selected = indices.map((index) => values[index]);
	if (values instanceof Uint32Array) return Uint32Array.from(selected as number[]);
	if (values instanceof Int32Array) return Int32Array.from(selected as number[]);
	if (values instanceof Uint16Array) return Uint16Array.from(selected as number[]);
	if (values instanceof Int16Array) return Int16Array.from(selected as number[]);
	if (values instanceof Uint8Array) return Uint8Array.from(selected as number[]);
	if (Array.isArray(values)) return selected;
	return selected;
}
