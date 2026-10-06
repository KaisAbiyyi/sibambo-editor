export type SolidMaterial = {
	id: string;
	name: string;
	displayName: string | null;
	rgba: readonly [number, number, number, number];
	opacityU16: number;
};

export type Definition = {
	id: string;
	name: string;
	kind: 'model' | 'component' | 'group';
	meshId: string | null;
};

export type Face = {
	id: string;
	outer: readonly number[];
	holes: readonly (readonly number[])[];
	triangles: readonly number[];
	normal: readonly [number, number, number];
	frontMaterialId: string | null;
	backMaterialId: string | null;
	hidden: boolean;
	surfaceCode: number;
	roleCode: number;
	label: string | null;
};

export type Mesh = {
	id: string;
	definitionId: string;
	positions: readonly number[];
	faces: readonly Face[];
};

export type Instance = {
	id: string;
	name: string;
	kind: 'root' | 'component' | 'group';
	ownerDefinitionId: string | null;
	definitionId: string;
	matrix: readonly number[];
	materialId: string | null;
	visible: boolean;
	roleCode: number;
	label: string | null;
};

export type BomcGraph = {
	documentId: string;
	name: string;
	rootDefinitionId: string;
	rootInstanceId: string;
	materials: readonly SolidMaterial[];
	definitions: readonly Definition[];
	meshes: readonly Mesh[];
	instances: readonly Instance[];
};

export type DocumentEdit =
	| { type: 'set-name'; name: string }
	| { type: 'put-material'; value: SolidMaterial }
	| { type: 'put-definition'; value: Definition }
	| { type: 'put-mesh'; value: Mesh }
	| { type: 'put-instance'; value: Instance }
	| { type: 'delete-material'; id: string }
	| { type: 'delete-definition'; id: string }
	| { type: 'delete-mesh'; id: string }
	| { type: 'delete-instance'; id: string };

export type BomcRevisionTokens = {
	name: number;
	strings: number;
	layout: number;
	materials: number;
	definitions: number;
	instances: number;
	transforms: number;
	geometry: number;
};

export type BomcSnapshot = {
	graph: BomcGraph;
	revision: number;
	tokens: BomcRevisionTokens;
};

export type GraphBounds = { min: readonly [number, number, number]; max: readonly [number, number, number] };

export type BomcDocumentErrorCode =
	| 'INVALID_DOCUMENT'
	| 'INVALID_SOURCE'
	| 'UNSUPPORTED_FEATURE'
	| 'BUSY'
	| 'CLOSED'
	| 'ABORTED'
	| 'RESOURCE_LIMIT'
	| 'OBSERVER_ERROR'
	| 'INTERNAL_ERROR';

export type BomcWriteProgress = {
	phase: 'validate' | 'encode' | 'compress' | 'assemble' | 'hash' | 'complete';
	revision: number;
	completedSections: number;
	totalSections: number;
	sectionType?: number;
};

export type BomcWriteStats = {
	encodedSectionTypes: readonly number[];
	reusedSectionTypes: readonly number[];
	compressionAttemptTypes: readonly number[];
	rawSectionBytes: Readonly<Record<number, number>>;
	storedSectionBytes: Readonly<Record<number, number>>;
	totalBytes: number;
	cacheBytes: number;
	knownPeakBinaryBytes: number;
	validationMs: number;
	encodeMs: number;
	compressMs: number;
	assemblyMs: number;
	hashMs: number;
	totalMs: number;
};

export type BomcWriteResult = {
	bytes: Uint8Array;
	sha256: string;
	revision: number;
	profile: 'exact';
	stats: BomcWriteStats;
};

export type CompressionMode = 'auto' | 'store-only';

export type SourceSectionMetadata = Readonly<{
	type: number;
	codec: number;
	flags: number;
	offset: number;
	storedLength: number;
	rawLength: number;
	count: number;
	crc32: number;
	wide: boolean;
}>;
