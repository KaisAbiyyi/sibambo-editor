export type {
	PreparedRuntimeEdgeSet,
	PreparedRuntimeGeometryGroup,
	PreparedRuntimeGeometryMesh,
	PreparedRuntimeGeometryScene,
	RuntimeGeometryGroup
} from './prepared-types.js';
export { SOURCE_EDGE_HIDDEN, SOURCE_EDGE_SMOOTH, SOURCE_EDGE_SOFT } from './prepared-types.js';
export { resolveFaceRenderPasses, normalizeRuntimeAppearance, runtimeTextureForDisplay, classifySourceFaceCameraSide } from './runtime-appearance.js';
export { prepareSolidCoplanarScene } from './solid-coplanar-resolution.js';
export type { GeometryPreparationProgress } from './solid-coplanar-resolution.js';
export { shouldPrepareSuppressedSolidGeometry, shouldUseSuppressedSolidGeometry } from './solid-geometry-policy.js';
export { createQuantizedCoplanarDiagnostics } from './viewer-performance.js';
export type { CoplanarDiagnostics } from './viewer-performance.js';
export { prepareApplicationRenderScene } from './application-preparation.js';
export type { ApplicationEncodingProfile, ApplicationPreparationMetrics, ApplicationPreparationProgress } from './application-preparation.js';
export { triangleIndexArray } from './triangle-index-width.js';
export {
	BatchVisibilityIndex,
	compactPreparedSurfaceGeometry,
	computeBatchMetrics,
	planPreparedSurfaceBatches,
	preparedRuntimeGroupBuffers,
	preparedSurfaceRenderKey,
	shouldCompactPreparedSurfaceGeometry,
	transformedRepresentativeVertex
} from './surface-batching.js';
export type { BatchSemanticRow, BatchMetrics, PreparedSurfaceBatch, PreparedSurfaceBatchRow } from './surface-batching.js';
