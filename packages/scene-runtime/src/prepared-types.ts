import type { BufferGeometry, Matrix4 } from 'three';
import type { OccurrenceHierarchy, PartKey } from '@sibambo/contracts';

export type RuntimeGeometryGroup = {
	key: PartKey;
	componentId?: string;
	baseColor?: string;
	materialName?: string;
	textureName?: string;
	materialId?: string;
	baseColorRgba?: [number, number, number, number];
	opacity?: number;
	colorSpace?: string;
	isBackFace?: boolean;
	materialIndex?: number;
	explicitMaterialIndex?: number;
	inheritedMaterialIndex?: number;
	textureAsset?: string;
	textureWidthM?: number;
	textureHeightM?: number;
	renderSide?: 'front' | 'back' | 'double';
	geometry: BufferGeometry;
	matrices: Matrix4[];
	occurrencePaths: string[];
	sourceMeshIndex: number;
	definitionIndex: number;
	faceCount: number;
	visibleSceneSignatures?: string[];
	baseY: number;
	topY: number;
};

export type PreparedRuntimeGeometryMesh = {
	sourceMeshIndex: number;
	positions: Float32Array;
	normals?: Float32Array;
	uvs?: Float32Array;
	groups?: PreparedRuntimeGeometryGroup[];
};

export const SOURCE_EDGE_HIDDEN = 1;
export const SOURCE_EDGE_SOFT = 2;
export const SOURCE_EDGE_SMOOTH = 4;

export type PreparedRuntimeEdgeSet = {
	sourceMeshIndex: number;
	definitionIndex: number;
	key: PartKey;
	positions: Float32Array;
	flags: Uint8Array;
	matrices: Float32Array;
	occurrenceHandles?: string[];
	occurrenceDefinitionIds?: string[];
	occurrenceInstanceIds?: string[];
	occurrenceHierarchyDepths?: Uint16Array;
	occurrenceInstanceIndices?: Uint32Array | number[];
	occurrenceTagIndices?: Int32Array | number[];
	occurrenceHierarchyIndices?: Uint32Array;
	worldBounds: { min: [number, number, number]; max: [number, number, number] };
	incidentFaceIndicesByEdge?: Uint32Array[];
	visibleSceneSignatures?: string[];
};

export type PreparedRuntimeGeometryGroup = Omit<RuntimeGeometryGroup, 'geometry' | 'matrices' | 'occurrencePaths'> & {
	indices: Uint16Array | Uint32Array;
	solidIndices?: Uint16Array | Uint32Array;
	solidSourceTriangleIndices?: Uint32Array;
	batchPositions?: Float32Array;
	batchNormals?: Float32Array;
	batchUvs?: Float32Array;
	matrices: Float32Array;
	occurrenceHandles?: string[];
	occurrenceDefinitionIds?: string[];
	occurrenceInstanceIds?: string[];
	occurrenceHierarchyDepths?: Uint16Array;
	occurrenceInstanceIndices?: Uint32Array | number[];
	occurrenceTagIndices?: Int32Array | number[];
	occurrenceHierarchyIndices?: Uint32Array;
	/** Original row ordinals carried through derived renderer partitions. */
	sourceOccurrenceIndices?: Uint32Array;
	sourceFaceIndicesByTriangle?: Uint32Array;
	sourceTagIndicesByTriangle?: Uint32Array;
	sourceFrontMaterialIndicesByTriangle?: Uint32Array;
	sourceBackMaterialIndicesByTriangle?: Uint32Array;
	sourceFaceAreasByTriangle?: Float32Array;
	fallbackText?: string;
	localBounds: { min: [number, number, number]; max: [number, number, number]; sphereCenter: [number, number, number]; sphereRadius: number };
	worldBounds: { min: [number, number, number]; max: [number, number, number] };
};

export type PreparedRuntimeGeometryScene = {
	meshes: PreparedRuntimeGeometryMesh[];
	groups: PreparedRuntimeGeometryGroup[];
	edgeSets?: PreparedRuntimeEdgeSet[];
	solidEdgeSets?: PreparedRuntimeEdgeSet[];
	occurrenceHierarchy?: OccurrenceHierarchy;
	totalUnits: number;
	totalTriangles?: number;
	totalVertices?: number;
	surfaceBatching?: { sourceGroupCount: number; compactVertexCount: number; typedArrayBytes: number; preparationMs: number };
	solidCoplanarResolution?: {
		preparationMs: number;
		exactEquivalentBefore: number;
		exactEquivalentAfter: number;
		shellSuppressions: number;
		trianglePairSuppressions?: number;
		patchUnionSuppressions?: number;
		ambiguousConflicts: number;
		fullTriangles: number;
		solidTriangles: number;
		planeBuckets?: number;
		shellPatches?: number;
		patchTriangles?: number;
		candidatesEvaluated?: number;
		coverageP50?: number;
		coverageP95?: number;
		patchBuildMs?: number;
		coverageMs?: number;
		sourceEdgeSegments?: number;
		hardSourceEdgeSegments?: number;
		solidEdgeSegments?: number;
		edgesSuppressedBySolidOwnership?: number;
		exactWorldDuplicateSegments?: number;
		fullVisibleFastPath?: number;
		fullySuppressedFastPath?: number;
		partialCandidates?: number;
		fullyCoveredSegmentsRemoved?: number;
		partiallyClippedSegments?: number;
		resultingSubsegments?: number;
		adjacencyMs?: number;
		visibilitySummaryMs?: number;
		patchLookupMs?: number;
		clipMs?: number;
		batchMs?: number;
		worldBakeMs?: number;
		totalEdgePrepMs?: number;
		typedArrayBytesFull?: number;
		typedArrayBytesSolid?: number;
	};
	solidCoplanarSuppressions?: Array<{
		reason: 'exact-equivalent-opaque' | 'coplanar-contained-in-opaque-shell' | 'coplanar-shell-patch-union' | 'coplanar-sliver-residual';
		confidence: number;
		overlapRatio: number;
		individualBestCoverage?: number;
		shellTriangleCount?: number;
		winner: { sourceMeshIndex: number; definitionIndex: number; sourceFaceIndex?: number; occurrenceHandle?: string };
		loser: { sourceMeshIndex: number; definitionIndex: number; sourceFaceIndex?: number; occurrenceHandle?: string };
	}>;
};
