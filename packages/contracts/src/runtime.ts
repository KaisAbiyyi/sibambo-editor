export type EngineId = 'e1' | 'e2' | 'e3' | 'e4';
export type EngineFormat = 'tiered-json' | 'canonical-v3' | 'cleanpkg' | 'bomc-1.2';

export type ResearchProvenance = {
	schema: 'sibambo-research-provenance-v1';
	engine: EngineId;
	artifact: { sha256: string; bytes: number; format: EngineFormat; profile: string };
	producer: { commitSha?: string; sourceTreeSha256?: string; label: string };
	model: { id: string; sourceSha256?: string; sourceBytes?: number };
	capture: { id: string; exportedAt: string; evidence: string; method: 'operator-attested' | 'exporter-capture' };
};

export type Point3 = { x: number; y: number; z: number };
export type Bounds3 = { min: Point3; max: Point3; size: Point3; center: Point3 };
export type GeometryOrientation = 'horizontal' | 'vertical' | 'sloped';
export type ViewMode = 'solid' | 'xray' | 'wireframe';
export type EncodingProfile = 'exact' | 'research' | 'visual';

export type SurfaceKey =
	| 'wall_x_pos' | 'wall_x_neg' | 'wall_y_pos' | 'wall_y_neg' | 'floor' | 'ceiling' | 'roof_slope'
	| 'door' | 'window' | 'structure' | 'furniture' | 'other';
export type PartKey =
	| 'roof' | 'walls' | 'floor' | 'ceiling' | 'doors' | 'windows' | 'openings' | 'structure' | 'foundation' | 'furniture' | 'other';

/** Geometry and source appearance fields emitted by importers; semantic analysis remains caller-owned. */
export type RenderFaceRecord = {
	id: string;
	name: string;
	path: string;
	surface: SurfaceKey;
	partKey: PartKey;
	areaM2: number;
	vertices: Point3[];
	holes: Point3[][];
	center: Point3;
	bounds: Bounds3;
	normal: Point3;
	dominantOrientation: GeometryOrientation;
	color?: string;
	textureName?: string;
	sourceFaceIds?: string[];
	semanticLabel?: string;
	semanticSource?: string;
	semanticRole?: string;
	classificationPolicy?: string;
	sourceCount?: number;
	/** Native face-table index used by scene visibility overrides. */
	sourceFaceIndex?: number;
	instanceIndex?: number;
	tagIndex?: number;
	occurrenceHierarchyIndex?: number;
};

export type CleanMaterialRuntime = {
	index: number;
	id: string;
	name?: string;
	baseColorRgba?: [number, number, number, number];
	opacity: number;
	colorSpace: string;
	textureAsset?: string;
	textureWidthM?: number;
	textureHeightM?: number;
};

export type OccurrenceHierarchy = {
	parentIndices: Int32Array;
	instanceIndices: Uint32Array;
	tagIndices: Int32Array;
};

/** Stable imported-source identity. It does not carry application or review state. */
export type SourceIdentity = {
	format: string;
	modelId: string;
	sourceSha256?: string;
	sourceBytes?: number;
};

export type FaceSourceIdentity = {
	faceId: string;
	definitionId?: string | null;
	instancePath?: readonly string[];
	triangleRange?: { start: number; count: number } | null;
};

export type PreparedBufferDescriptor = {
	key: string;
	role: 'position' | 'normal' | 'uv' | 'index' | 'color' | 'edge' | 'other';
	arrayType: 'float32' | 'float64' | 'uint16' | 'uint32' | 'int32' | 'uint8';
	itemSize: number;
	count: number;
	byteLength: number;
	transferable: boolean;
};

export type LoadProgress<TStage extends string = string, TUnit extends string = string> = {
	stage: TStage;
	completed: number;
	total: number;
	message: string;
	unit: TUnit;
};

/** Structured-clone-safe worker envelope; payload ownership is explicit at the caller. */
export type WorkerEnvelope<TType extends string, TPayload> = {
	type: TType;
	requestId: string;
	payload: TPayload;
};
