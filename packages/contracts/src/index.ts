import type { Point3 } from './runtime.js';

export type {
	Bounds3,
	CleanMaterialRuntime,
	EngineFormat,
	EngineId,
	DisplayState,
	EncodingProfile,
	FaceSourceIdentity,
	FaceStyle,
	GeometryOrientation,
	LoadProgress,
	OccurrenceHierarchy,
	PartKey,
	Point3,
	PreparedBufferDescriptor,
	RenderFaceRecord,
	ResearchProvenance,
	SurfaceKey,
	SourceIdentity,
	ViewEffects,
	ViewMode,
	WorkerEnvelope
} from './runtime.js';
export type {
	ClipPlaneRecord,
	SceneCamera,
	SceneProfile,
	SceneSectionState,
	SceneVisibility
} from './scene.js';

/** Renderer-neutral, serializable observations. Application measurements stay with their owner. */
export type RendererObservation = {
	backend: string;
	viewport: { width: number; height: number; pixelRatio: number };
	camera?: { position: Point3; target: Point3; up: Point3; fov: number; near: number; far: number; projection?: 'perspective' | 'orthographic'; orthographicHeight?: number };
	scene?: { meshCount: number; instanceCount: number; uniqueTriangles: number };
	renderer?: { initializationMs: number; render: { calls: number | null; triangles: number | null }; memory: { geometries: number | null; textures: number | null } };
	resources?: { jsHeapBytes: number | null; totalGpuMemoryBytes: number | null };
	appearance?: { viewMode: string; failedDecodePaths: string[]; missingAssetPaths: string[]; unsupportedTexturePaths: string[] };
	geometryCount: number | null;
	textureCount: number | null;
	drawCallCount: number | null;
	triangleCount: number | null;
	firstFrameAtMs: number | null;
	readyAtMs: number | null;
};
