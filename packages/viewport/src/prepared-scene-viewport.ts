import {
	BufferAttribute,
	BufferGeometry,
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
import { MaterialStateManager, type ViewMode } from './material-state.js';
import type { RendererBackendName, ViewerRenderer } from './renderer-backend.js';
import { ViewportRendererHost } from './renderer-host.js';
import { renderProfilePolicy, resolveRenderProfile } from './render-profile.js';
import { RuntimeAssetResolver } from './runtime-asset-resolver.js';
import { RuntimeMaterialCache } from './source-material-cache.js';
import { buildPreparedInstancedSurfaceGroups } from './prepared-surface.js';
import { SceneVisibilityIndex } from './scene-visibility.js';
import { sourceEdgeMaterialDescriptor } from './source-edge-style.js';
import { bomcClipPlaneToThreePlane, resolveSceneClipPlanes } from './scene-clip-program.js';
import { applyInstancedMeshVisibility, applyMaterialClipPlanes, disposeInstancedMesh, isPointClipped, isReadyAfterRenderedFrame, prepareIndexedGeometry } from './viewport-render-state.js';
import { filterTrianglesBySourceFaces, partitionOccurrenceSourceFaces, resolveSourceFaceIndex } from './source-face-filter.js';
import { shouldRenderSourceEdge } from './scene-visibility.js';

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
};

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
type EdgeRecord = { lines: LineSegments; visibleSceneSignatures?: string[] };

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
	private fittedBounds: ViewportBounds = { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };
	private get camera() { return this.rendererHost.camera; }
	private get controls() { return this.rendererHost.controls; }
	private get viewMode() { return this.rendererHost.viewMode; }

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
		this.assetResolver.onTextureSettled(({ path }) => {
			this.settledTextures.add(path);
			for (const record of this.meshRecords) {
				const material = this.materialState.materialFor(record.materialId, this.viewMode);
				this.applyClipPlanesToMaterial(material);
				record.mesh.material = material;
			}
			this.renderOnce();
		});

		for (const asset of input.appearance?.assets ?? []) this.assetResolver.registerAsset(asset.path, asset.bytes);
		this.buildMeshes();
		this.fit();
		const selectedScene = input.scenes?.find((scene) => scene.id === input.activeSceneId) ?? input.scenes?.find((scene) => scene.isActiveAtExport);
		if (selectedScene) this.setScene(selectedScene);
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
		this.rendererHost.setViewMode(mode);
		this.materialState.applyMode(mode);
		this.applyGeometryMode();
		this.applySourceFaceFilter();
		this.rebuildSourceEdges();
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

	fit() {
		let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
		for (const group of this.input.scene.groups) {
			const world = group.worldBounds;
			minX = Math.min(minX, world.min[0]); minY = Math.min(minY, world.min[1]); minZ = Math.min(minZ, world.min[2]);
			maxX = Math.max(maxX, world.max[0]); maxY = Math.max(maxY, world.max[1]); maxZ = Math.max(maxZ, world.max[2]);
		}
		if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) { minX = minY = minZ = -1; maxX = maxY = maxZ = 1; }
		this.fittedBounds = { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
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
			appearance: { viewMode: this.viewMode, failedDecodePaths: textureStats.failedDecodePaths, missingAssetPaths: textureStats.missingAssetPaths, unsupportedTexturePaths: textureStats.unsupportedTexturePaths },
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
		this.canvas.removeEventListener('click', this.handleClick);
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
			const occurrenceCount = Math.floor(edgeSet.matrices.length / 16);
			for (let edgeIndex = 0; edgeIndex < edgeSet.positions.length / 6; edgeIndex++) {
				if (!shouldRenderSourceEdge(edgeSet.flags[edgeIndex], this.activeScene, this.activeSceneSignature, edgeSet.visibleSceneSignatures)) continue;
				const localA = new Vector3(edgeSet.positions[edgeIndex * 6], edgeSet.positions[edgeIndex * 6 + 1], edgeSet.positions[edgeIndex * 6 + 2]);
				const localB = new Vector3(edgeSet.positions[edgeIndex * 6 + 3], edgeSet.positions[edgeIndex * 6 + 4], edgeSet.positions[edgeIndex * 6 + 5]);
				for (let occurrence = 0; occurrence < occurrenceCount; occurrence++) {
					if (!this.occurrenceVisible(edgeSet.occurrenceHierarchyIndices?.[occurrence], edgeSet.occurrenceInstanceIndices?.[occurrence], edgeSet.occurrenceTagIndices?.[occurrence], compiled, edgeSet.occurrenceHandles?.[occurrence], visibilityIndex)) continue;
					const matrix = new Matrix4().fromArray(edgeSet.matrices, occurrence * 16);
					const a = localA.clone().applyMatrix4(matrix); const b = localB.clone().applyMatrix4(matrix);
					coordinates.push(a.x, a.y, a.z, b.x, b.y, b.z);
				}
			}
			if (coordinates.length === 0) continue;
			const geometry = new BufferGeometry();
			geometry.setAttribute('position', new Float32BufferAttribute(coordinates, 3));
			const material = new LineBasicMaterial(sourceEdgeMaterialDescriptor(this.viewMode));
			this.applyClipPlanesToMaterial(material);
			const edges = new LineSegments(geometry, material);
			edges.renderOrder = 2;
			this.scene3d.add(edges);
			this.edgeRecords.push({ lines: edges, visibleSceneSignatures: edgeSet.visibleSceneSignatures });
		}
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
			const material = this.materialState.materialFor(record.materialId, this.viewMode);
			this.applyClipPlanesToMaterial(material);
			record.mesh.material = material;
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
			record.mesh.visible = !isBaseHiddenForIsolation && signatureVisible && record.baseIndices.length > 0 && record.visibleOccurrenceCount > 0;
		}
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

	private renderOnce() { if (!this.disposed) this.rendererHost.renderNow(); }
	private disposeOverlay(object: Object3D) {
		object.traverse((child) => {
			const renderable = child as Object3D & { geometry?: BufferGeometry; material?: Material | Material[] };
			renderable.geometry?.dispose();
			if (Array.isArray(renderable.material)) for (const material of renderable.material) material.dispose();
			else renderable.material?.dispose();
		});
	}
	private checkReady() {
		if (this.readyAtMs !== null) return;
		const pending = [...this.requestedTextures].filter((path) => !this.settledTextures.has(path)).length;
		if (!isReadyAfterRenderedFrame(this.firstFrameAtMs !== null, pending)) return;
		this.readyAtMs = performance.now();
		this.onReady?.(this.observe());
	}

	private handleClick = (event: MouseEvent) => {
		if (!this.onPick) return;
		const rect = this.canvas.getBoundingClientRect();
		this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
		this.raycaster.setFromCamera(this.pointer, this.camera);
		const records = new Map(this.meshRecords.map((record) => [record.mesh, record]));
		const hit = this.raycaster.intersectObjects(this.meshRecords.map((record) => record.mesh), false)
			.find((candidate) => {
				const record = records.get(candidate.object as InstancedMesh);
				return Boolean(record && record.mesh.visible && !isPointClipped(candidate.point, this.activeClipPlanes)
					&& (candidate.instanceId === undefined || record.visibleOccurrenceIndices.has(candidate.instanceId)));
			});
		if (!hit) return;
		const record = records.get(hit.object as InstancedMesh);
		if (!record) return;
		const triangleIndex = hit.faceIndex ?? null;
		const sourceFaceIndex = resolveSourceFaceIndex(triangleIndex, record.visibleSourceFaceIndicesByTriangle ?? record.sourceFaceIndicesByTriangle);
		this.onPick({
			sourceMeshIndex: record.sourceMeshIndex,
			definitionIndex: record.definitionIndex,
			occurrenceIndex: typeof hit.instanceId === 'number' ? record.sourceOccurrenceIndices[hit.instanceId] ?? null : null,
			occurrenceHandle: typeof hit.instanceId === 'number' ? record.occurrenceHandles?.[hit.instanceId] ?? null : null,
			triangleIndex,
			sourceFaceIndex
		});
	};
}

function point(value: Vector3) { return { x: value.x, y: value.y, z: value.z }; }
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
