import type { CleanMaterialRuntime, PartKey, RenderFaceRecord, SceneProfile, ClipPlaneRecord, LoadProgress } from '@sibambo/contracts';
import type { PreparedRuntimeGeometryScene } from '@sibambo/scene-runtime/types';
import type { GeometryPreparationProgress } from '@sibambo/scene-runtime';

export const BOMC_MAGIC = new Uint8Array([0x42, 0x4f, 0x4d, 0x43, 0x0d, 0x0a, 0x1a, 0x0a]);
export const BOMC_ENDIAN_MARKER = 0x01020304;
export const BOMC_COMPACT_DIRECTORY = 0x10;

export const BOMC_SECTION = {
	MODEL: 1,
	STRINGS: 2,
	MATERIALS: 3,
	TAGS: 4,
	MESHES: 5,
	FACES: 6,
	POSITIONS: 7,
	TOPOLOGY: 8,
	NORMALS: 9,
	UVS: 10,
	DEFINITIONS: 11,
	INSTANCES: 12,
	TRANSFORMS: 13,
	VISUAL_EDGES: 14,
	TEXTURE_TABLE: 15,
	TEXTURE_BLOBS: 16,
	COVERAGE: 17,
	FALLBACK: 18,
	SCENES: 19,
	ENCODING_CONTRACT: 20,
	CLIP_PLANES: 21,
	DEBUG: 240
} as const;

export type BomcEncodingContract = {
	schemaVersion: number;
	profile: 'exact' | 'research' | 'visual';
	sourceSizeRequired: boolean;
	sourceSkpBytes: number;
	preferredRatio: number | null;
	hardRatio: number | null;
	targetBytes: number;
	positionMaxErrorM: number | 'semantic_policy';
	normalMaxErrorDeg: number | 'semantic_policy';
	uvMaxError: number | 'semantic_policy';
	transformMaxError: number;
	texturePolicy: 'pixel_lossless' | 'perceptual_bounded' | 'web_aggressive_bounded';
	semanticExact: boolean;
	sceneExact: boolean;
	protectedTopologyExact: boolean;
	encoderRevision: number;
};

export const BOMC_FLAGS = {
	PROFILE_MASK: 0x0001,
	PROFILE_PRODUCTION: 0x0000,
	PROFILE_DEBUG: 0x0001,
	STRICT_SIZE_GATE_PASSED: 0x0002,
	TEXTURE_OPTIMIZED: 0x0004,
	PROGRESSIVE_STREAMABLE: 0x0008,
	FLAG_SCOPE_ACTIVE: 0x0100,
	FLAG_SCOPE_ALL: 0x0200,
	FLAG_HAS_SCENES: 0x0400
} as const;

export type BomcSectionDescriptor = {
	index: number;
	type: number;
	codec: number;
	flags: number;
	offset: number;
	storedLength: number;
	rawLength: number;
	count: number;
	crc32: number;
};

export type BomcHeader = {
	major: number;
	minor: number;
	flags: number;
	sectionCount: number;
	directoryOffset: number;
	directoryEntryBytes: 24 | 40;
};

export type BomcSectionMetric = BomcSectionDescriptor & {
	inflateMs: number;
	loaded: boolean;
};

export type GeometryTransferStats = {
	originalBufferCount: number;
	originalBufferBytes: number;
	packedBufferCount: number;
	packedBufferBytes: number;
	packedSmallOriginalCount: number;
	copiedBytes: number;
	paddingBytes: number;
	packingMs: number;
};

export type BomcWorkerTransferDiagnostics = {
	version: 'bomc-packed-full-result-1';
	geometry: GeometryTransferStats;
	assetBufferCount: number;
	assetBytes: number;
	totalTransferBufferCount: number;
	totalTransferBytes: number;
	totalPackingMs: number;
};

export type BomcDiagnostics = {
	version: string;
	profile: 'production' | 'debug';
	sourceFileBytes: number;
	storedSectionBytes: number;
	inflatedTemporaryBytes: number;
	finalTypedArrayBytes: number;
	threeGeometryBytes: number;
	texturePayloadBytes: number;
	definitions: number;
	instances: number;
	triangles: number;
	materials: number;
	textures: number;
	visualEdges: number;
	visibility: {
		totalFaces: number;
		hiddenFlagFaces: number;
		taggedFaces: number;
		facesOnInvisibleTags: number;
		renderedFaces: number;
		renderedFacesOnInvisibleTags: number;
		legacyRenderedFacesOnInvisibleTags: number;
		invisibleFacesByTag: Array<{ tagIndex: number; tagName?: string; faceCount: number; triangleCount: number }>;
		invisibleFacesByMaterial: Array<{ materialIndex: number; faceCount: number; triangleCount: number }>;
		invisibleFacesByMesh: Array<{ meshIndex: number; definitionIndex: number; faceCount: number; triangleCount: number }>;
	};
	triangleOwnership: {
		sourceFaces: number;
		renderVisibleFaces: number;
		frontOnlyFaces: number;
		frontBackFaces: number;
		explicitBackMaterialFaces: number;
		backUvOnlyFaces: number;
		frontDefinitionTriangles: number;
		backDefinitionTriangles: number;
		frontOccurrenceTriangles: number;
		backOccurrenceTriangles: number;
		hiddenFaces: number;
		invisibleTagFaces: number;
		opaqueOccurrenceTriangles: number;
		transparentOccurrenceTriangles: number;
		fallbackTriangles: number;
		renderGroups: number;
	};
	backfaceLeak: {
		explicitFrontMaterialFaces: number;
		explicitBackMaterialFaces: number;
		frontOnlyAppearanceFaces: number;
		frontOnlyFacesRenderedFrontSide: number;
		frontOnlyFacesRenderedDoubleSide: number;
		pickedBackFacingFrontMaterialTriangles: number;
		estimatedBackfaceMaterialLeakTriangles: number;
		byMaterial: Array<{ materialIndex: number; materialName?: string; faceCount: number; triangleCount: number }>;
		byDefinition: Array<{ definitionIndex: number; faceCount: number; triangleCount: number }>;
		bySourceMesh: Array<{ sourceMeshIndex: number; faceCount: number; triangleCount: number }>;
		byPartKey: Array<{ partKey: PartKey; faceCount: number; triangleCount: number }>;
	};
	coplanar?: {
		trianglesInspected: number;
		exactDuplicates: number;
		nearCoplanarCandidates: number;
		samePlaneDifferentMaterialCandidates: number;
	};
	triangleVerticesMissingUv: number;
	textureMetrics: BomcTextureMetric[];
	coverage: BomcCoverage;
	occurrences: {
		hierarchyNodeCount: number;
		renderOccurrenceCount: number;
		hierarchyTypedArrayBytes: number;
		legacyAncestryElementCount: number;
		legacyNestedArrayCount: number;
	};
	sectionMetrics: BomcSectionMetric[];
	timings: {
		coreMetadataReadyMs?: number;
		geometryReadyMs?: number;
		firstRenderableMs?: number;
		firstTextureReadyMs?: number;
		allTexturesReadyMs?: number;
		fileReadMs?: number;
		workerDecodeMs?: number;
		headerMs: number;
		directoryMs: number;
		inflateMs: number;
		metadataMs: number;
		analyticalDecodeMs: number;
		definitionDecodeMs: number;
		triangulationMs: number;
		collectOccurrencesMs: number;
		buildRuntimeMs: number;
		solidResolverMs: number;
		solidCoplanarResolutionMs?: number;
		deferredSolidReadyMs?: number;
		surfaceBatchingMs?: number;
		workerTransferMs?: number;
		viewerChunkImportMs?: number;
		gpuSurfaceUploadMs?: number;
		gpuEdgeUploadMs?: number;
		modelLoadStartedAtMs?: number;
		modelFirstValidFrameMs?: number;
		instanceConstructionMs: number;
		textureTableMs: number;
		roomDetectionMs?: number;
		firstVisibleFrameMs?: number;
		totalReadyMs: number;
	};
	provenance?: BomcProvenance;
	encodingContract?: BomcEncodingContract;
	workerTransfer?: BomcWorkerTransferDiagnostics;
};

export type ProgressiveBomcCallbacks = {
	onCoreMetadataReady?: (metadata: { counts: AdaptedBomcResult['counts']; encodingContract?: BomcEncodingContract; sourceFileName?: string }) => void;
	onGeometryReady?: (preparedRuntimeScene: PreparedRuntimeGeometryScene, faces: RenderFaceRecord[]) => void;
	onSolidPreparationProgress?: (progress: GeometryPreparationProgress) => void;
	onFirstRenderable?: (result: AdaptedBomcResult) => void;
	onTextureReady?: (asset: { path: string; bytes: Uint8Array }, progress: { loaded: number; total: number }) => void;
	onAllTexturesReady?: (assets: Array<{ path: string; bytes: Uint8Array }>) => void;
	onComplete?: (result: AdaptedBomcResult) => void;
	isCancelled?: () => boolean;
};

export type E4WorkerProgress = LoadProgress<
	'metadata' | 'textures' | 'geometry' | 'complete' | 'resolving-solid-surfaces' | 'building-solid-edges' | 'batching',
	'stage' | 'asset' | 'patch' | 'unit' | 'group'
>;

export type BomcProvenance = {
	path: string | null;
	sha256: string;
	bytes: number;
	frontTriangleCount: number;
	backTriangleCount: number;
	totalOccurrenceTriangles: number;
	backUvOnlyFaceCount: number;
	isNewProducerFixture: boolean;
	timestamp: string;
};

export type BomcTextureMetric = {
	materialIndex: number;
	materialId: string;
	materialName?: string;
	textureAsset: string;
	textureWidthM: number;
	textureHeightM: number;
	minU: number | null;
	maxU: number | null;
	minV: number | null;
	maxV: number | null;
	uvSpanU: number;
	uvSpanV: number;
	facesUsingMaterial: number;
	triangleVertices: number;
	triangleVerticesWithValidUv: number;
	triangleVerticesMissingUv: number;
};

export type BomcCoverage = {
	eligible: number;
	analytical: number;
	visualRetained: number;
	fallback: number;
	excluded: number;
	unaccounted: number;
};

export type BomcAppearance = {
	materials: CleanMaterialRuntime[];
	assets: Array<{ path: string; bytes: Uint8Array }>;
};

export type AdaptedBomcResult = {
	version: string;
	profile: 'production' | 'debug';
	sourceFileName?: string;
	modelName?: string;
	faces: RenderFaceRecord[];
	preparedRuntimeScene: PreparedRuntimeGeometryScene;
	appearance: BomcAppearance;
	bounds: {
		min: { x: number; y: number; z: number };
		max: { x: number; y: number; z: number };
		size: { x: number; y: number; z: number };
		center: { x: number; y: number; z: number };
	};
	materialRows: Array<{ name: string; color: string; reflectance: string }>;
	counts: {
		materials: number;
		tags: number;
		meshes: number;
		faces: number;
		definitions: number;
		instances: number;
		transforms: number;
		textures: number;
		edges: number;
	};
	scenes: SceneProfile[];
	activeSceneId?: string;
	clipPlanes?: ClipPlaneRecord[];
	encodingContract?: BomcEncodingContract;
	diagnostics: BomcDiagnostics;
};
