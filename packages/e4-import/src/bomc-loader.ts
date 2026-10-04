import { Box3, Matrix4, Sphere, Vector3 } from 'three';
import type { Bounds3, ClipPlaneRecord, PartKey, Point3, RenderFaceRecord as FaceRecord, SceneProfile, SurfaceKey } from '@sibambo/contracts';
import type { PreparedRuntimeEdgeSet, PreparedRuntimeGeometryGroup, PreparedRuntimeGeometryMesh, PreparedRuntimeGeometryScene } from '@sibambo/scene-runtime/types';
import { resolveFaceRenderPasses, createQuantizedCoplanarDiagnostics, prepareSolidCoplanarScene, shouldPrepareSuppressedSolidGeometry } from '@sibambo/scene-runtime';
import { assertBomcArrayBytes, assertBomcCount, assertExpectedBomcCount, BomcBinaryReader } from './binary-reader';
import { BomcContainer } from './container';
import { decodeNormalSection, decodePositionBlock, decodeTopologyBlock, decodeTransformSection, decodeUvBlock } from './codecs';
import { decodeBomcJcmToPng, digestSha256 } from './jpeg-color-map';
import { colorizeRgba } from './semantic-colorize';
import { defaultImagePixelCodec, type ImagePixelCodec, type PixelFrame, type SemanticImageMedia } from './image-pixel-codec';
import { BOMC_SECTION, type AdaptedBomcResult, type BomcCoverage, type BomcEncodingContract, type BomcSemanticMaterialDiagnostics, type BomcTextureMetric, type ProgressiveBomcCallbacks } from './types';

const REQUIRED_SECTIONS = [
	BOMC_SECTION.MODEL, BOMC_SECTION.STRINGS, BOMC_SECTION.DEFINITIONS,
	BOMC_SECTION.INSTANCES, BOMC_SECTION.TRANSFORMS, BOMC_SECTION.COVERAGE
];
const AXIS_TO_THREE = new Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
const AXIS_FROM_THREE = AXIS_TO_THREE.clone().invert();
const MISSING = 0xffffffff;

type ModelRecord = {
	profile: 'production' | 'debug'; rootNode: number; bounds: number[]; counts: AdaptedBomcResult['counts'];
	sourceFile?: string; modelName?: string;
};
type MaterialRecord = {
	name?: string; displayName?: string; rgba: [number, number, number, number]; opacity: number;
	texture: number; textureWidthM: number; textureHeightM: number;
	semantic?: { materialType: 0 | 1 | 2; colorizeMode: 0 | 1 | 2; deltas: [number, number, number]; outputRgbaSha256: string };
	renderTextureAsset?: string;
};
type TagRecord = { name?: string; visible: boolean };
type MeshRow = {
	definition: number; vertexCount: number; faceStart: number; faceCount: number; edgeStart: number; edgeCount: number;
	positionOffset: number; positionLength: number; topologyOffset: number; topologyLength: number; uvOffset: number; uvLength: number;
};
type FaceRow = {
	globalIndex: number; surfaceCode: number; flags: number; roleCode: number; frontMaterial: number; backMaterial: number;
	tag: number; label?: string; loopLengths: number[]; triangleCount: number; outer: Uint32Array; holes: Uint32Array[];
	triangles: Uint32Array; normal: [number, number, number]; frontUvs?: Float32Array; backUvs?: Float32Array;
};
type EdgeRecord = { globalIndex: number; first: number; second: number; flags: number; tag: number };
type MeshRecord = { row: MeshRow; positions: Float32Array; faces: FaceRow[]; edges: EdgeRecord[] };
type DefinitionRecord = { name?: string; kind: number; mesh: number; nodes: number[] };
type InstanceRecord = {
	name?: string; kind: number; owner: number; definition: number; transform: number; material: number; tag: number;
	visible: boolean; fallback: boolean; roleCode: number; label?: string;
};
type TextureRecord = { media: number; sourceMedia: number; encodedHashVerified: boolean; width: number; height: number; hash: string; bytes: Uint8Array; assetPath: string; payloadByteLength: number };
type FallbackRecord = { instance: number; kind: number; position: [number, number, number]; width: number; height: number; texture: number; text?: string };
type Occurrence = {
	matrix: Matrix4;
	material: number;
	handle: string;
	hierarchyDepth: number;
	instanceIndex?: number;
	definitionId: string;
	instanceId: string;
	tagIndex?: number;
	hierarchyIndex: number;
	semanticRoleCode: number;
	semanticLabel?: string;
};
type SceneVisibilitySets = {
	hiddenFaceIndices: Set<number>;
	visibleFaceIndices: Set<number>;
	hiddenEdgeIndices: Set<number>;
	visibleEdgeIndices: Set<number>;
	hiddenTagIndices: Set<number>;
	visibleTagIndices: Set<number>;
};
type SceneVisibilityIndex = {
	byScene: WeakMap<SceneProfile, SceneVisibilitySets>;
	bySignature: Map<string, SceneProfile>;
	hasFaceOverrides: boolean;
};

function isActiveSemanticMaterial(material: MaterialRecord) {
	return material.semantic?.materialType === 2 && (material.semantic.colorizeMode === 1 || material.semantic.colorizeMode === 2);
}

export function bomcRenderVertexKey(
	sourceIndex: number,
	side: 'front' | 'back',
	uv: [number, number] | undefined,
	normal: [number, number, number]
) {
	const sign = side === 'front' ? 1 : -1;
	return `${side}:${sourceIndex}:${uv?.[0] ?? 0}:${uv?.[1] ?? 0}:${normal[0] * sign}:${normal[1] * sign}:${normal[2] * sign}`;
}

export function resolveBomcEffectiveMaterial(explicitMaterial: number, inheritedOccurrenceMaterial: number) {
	return explicitMaterial !== MISSING ? explicitMaterial : inheritedOccurrenceMaterial;
}

export function isBomcFaceRenderVisible(
	face: Pick<FaceRow, 'flags' | 'tag'>,
	tags: readonly Pick<TagRecord, 'visible'>[]
) {
	return (face.flags & 1) === 0 && (face.tag === MISSING || tags[face.tag]?.visible !== false);
}

export function isBomcEdgeRenderVisible(
	edge: Pick<EdgeRecord, 'flags' | 'tag'>,
	tags: readonly Pick<TagRecord, 'visible'>[]
) {
	return (edge.flags & 7) === 0 && (edge.tag === MISSING || tags[edge.tag]?.visible !== false);
}

export class BomcLoader {
	async load(
		buffer: ArrayBuffer,
		sourceName = 'model.bomc',
		options: { prepareSolid?: boolean; callbacks?: ProgressiveBomcCallbacks } = {}
	): Promise<AdaptedBomcResult> {
		const callbacks = options.callbacks;
		const totalStarted = performance.now();
		if (callbacks?.isCancelled?.()) throw new Error('BOMC load cancelled');
		const container = new BomcContainer(buffer);
		for (const type of REQUIRED_SECTIONS) if (!container.has(type)) throw new Error(`BOMC invalid: missing section ${type}.`);

		const metadataStarted = performance.now();
		const strings = await decodeReleased(container, BOMC_SECTION.STRINGS, decodeStrings);
		const model = await decodeReleased(container, BOMC_SECTION.MODEL, (bytes) => decodeModel(bytes, strings));
		validateCountedSections(container, model.counts);
		let materialSectionVersion: 1 | 2 | null = null;
		const materials = container.has(BOMC_SECTION.MATERIALS) ? await decodeReleased(container, BOMC_SECTION.MATERIALS, (bytes) => {
			if (bytes[0] === 1 || bytes[0] === 2) materialSectionVersion = bytes[0];
			return decodeMaterials(bytes, strings, model.counts.materials);
		}) : [];
		const tags = container.has(BOMC_SECTION.TAGS) ? await decodeReleased(container, BOMC_SECTION.TAGS, (bytes) => decodeTags(bytes, strings, model.counts.tags)) : [];
		const definitions = await decodeReleased(container, BOMC_SECTION.DEFINITIONS, (bytes) => decodeDefinitions(bytes, strings, model.counts.definitions));
		const instances = await decodeReleased(container, BOMC_SECTION.INSTANCES, (bytes) => decodeInstances(bytes, strings, model.counts.instances));
		const { transforms } = await decodeReleased(container, BOMC_SECTION.TRANSFORMS, (bytes) => decodeTransformSection(bytes, model.counts.transforms));
		for (let index = 0; index < instances.length; index += 1) {
			const owner = instances[index].owner;
			if (owner !== MISSING) {
				assertIndex(owner, definitions.length, `instance ${index} owner`);
				definitions[owner].nodes.push(index);
			}
		}
		const encodingContract = container.has(BOMC_SECTION.ENCODING_CONTRACT)
			? await decodeReleased(container, BOMC_SECTION.ENCODING_CONTRACT, decodeEncodingContract)
			: undefined;
		const metadataMs = performance.now() - metadataStarted;
		const coreMetadataReadyMs = performance.now() - totalStarted;
		callbacks?.onCoreMetadataReady?.({ counts: model.counts, encodingContract, sourceFileName: model.sourceFile });

		if (callbacks?.isCancelled?.()) throw new Error('BOMC load cancelled');

		const analyticalStarted = performance.now();
		const meshRows = container.has(BOMC_SECTION.MESHES) ? await decodeReleased(container, BOMC_SECTION.MESHES, (bytes) => decodeMeshes(bytes, model.counts.meshes)) : [];
		const faceRows = container.has(BOMC_SECTION.FACES) ? await decodeReleased(container, BOMC_SECTION.FACES, (bytes) => decodeFaces(bytes, strings, model.counts.faces)) : [];
		const normals = container.has(BOMC_SECTION.NORMALS) ? (await decodeReleased(container, BOMC_SECTION.NORMALS, (bytes) => decodeNormalSection(bytes, model.counts.faces))).normals : new Float32Array(0);
		if (normals.length !== faceRows.length * 3) throw new Error('BOMC invalid: normal count does not match faces.');
		const coverage = await decodeReleased(container, BOMC_SECTION.COVERAGE, decodeCoverage);
		const analyticalDecodeMs = performance.now() - analyticalStarted;

		const definitionStarted = performance.now();
		const positionSection = await container.load(BOMC_SECTION.POSITIONS, model.counts.meshes > 0) || new Uint8Array(0);
		const topologySection = await container.load(BOMC_SECTION.TOPOLOGY, model.counts.meshes > 0) || new Uint8Array(0);
		const uvSection = await container.load(BOMC_SECTION.UVS, false) || new Uint8Array(0);
		let meshes: MeshRecord[];
		try {
			meshes = decodeGeometry(meshRows, faceRows, normals, positionSection, topologySection, uvSection);
		} finally {
			container.release(BOMC_SECTION.POSITIONS);
			container.release(BOMC_SECTION.TOPOLOGY);
			container.release(BOMC_SECTION.UVS);
		}
		if (container.has(BOMC_SECTION.VISUAL_EDGES)) await decodeReleased(container, BOMC_SECTION.VISUAL_EDGES, (bytes) => decodeEdges(bytes, meshRows, meshes, tags.length, model.counts.edges));
		const definitionDecodeMs = performance.now() - definitionStarted;
		const geometryReadyMs = performance.now() - totalStarted;

		if (callbacks?.isCancelled?.()) throw new Error('BOMC load cancelled');

		const textureStarted = performance.now();
		let textures: TextureRecord[] = [];
		let firstTextureReadyMs: number | undefined;
		if (container.has(BOMC_SECTION.TEXTURE_TABLE)) {
			const table = await container.load(BOMC_SECTION.TEXTURE_TABLE) as Uint8Array;
			const blobs = await container.load(BOMC_SECTION.TEXTURE_BLOBS) as Uint8Array;
			try {
				textures = await decodeTextures(table, blobs, { isCancelled: callbacks?.isCancelled, expectedCount: model.counts.textures });
			} finally {
				container.release(BOMC_SECTION.TEXTURE_TABLE);
				container.release(BOMC_SECTION.TEXTURE_BLOBS);
			}
		}
		const textureTableMs = performance.now() - textureStarted;
		const fallback = container.has(BOMC_SECTION.FALLBACK)
			? await decodeReleased(container, BOMC_SECTION.FALLBACK, (bytes) => decodeFallback(bytes, strings))
			: [];

		validateReferences(model, materials, tags, meshes, definitions, instances, transforms, textures, coverage, fallback);
		const semanticResult = await hydrateSemanticMaterials(materials, textures, { isCancelled: callbacks?.isCancelled });
		const textureAssets = [...textures.map((texture) => ({ path: texture.assetPath, bytes: texture.bytes })), ...semanticResult.assets];
		for (let index = 0; index < textureAssets.length; index += 1) {
			if (callbacks?.isCancelled?.()) throw new Error('BOMC load cancelled');
			if (firstTextureReadyMs === undefined) firstTextureReadyMs = performance.now() - totalStarted;
			callbacks?.onTextureReady?.(textureAssets[index], { loaded: index + 1, total: textureAssets.length });
			if (callbacks?.isCancelled?.()) throw new Error('BOMC load cancelled');
		}
		const allTexturesReadyMs = performance.now() - totalStarted;
		const instanceStarted = performance.now();
		const collectOccurrencesStarted = performance.now();
		const occurrences = collectOccurrences(model.rootNode, definitions, instances, transforms, tags, container.has(BOMC_SECTION.SCENES));
		const collectOccurrencesMs = performance.now() - collectOccurrencesStarted;
		const buildRuntimeStarted = performance.now();
		let clipPlanes: ClipPlaneRecord[] = [];
		if (container.has(BOMC_SECTION.CLIP_PLANES)) {
			clipPlanes = await decodeReleased(container, BOMC_SECTION.CLIP_PLANES, (bytes) => decodeClipPlanes(bytes, strings));
		}
		let scenes: SceneProfile[] = [];
		let sceneSectionVersion: number | null = null;
		if (container.has(BOMC_SECTION.SCENES)) {
			scenes = await decodeReleased(container, BOMC_SECTION.SCENES, (bytes) => {
				sceneSectionVersion = bytes[0] ?? null;
				return decodeScenes(bytes, strings, tags, instances, faceRows.length, meshes.reduce((sum, mesh) => sum + mesh.edges.length, 0), clipPlanes);
			});
		} else scenes = syntheticDefaultScenes(tags, instances);
		const sceneVisibilityIndex = createSceneVisibilityIndex(scenes);
		const edgeAdjacencyByMesh = buildRuntimeEdgeAdjacencies(meshes, occurrences.meshes);
		const fallbackMaterialBase = materials.length;
		const runtimeMaterials: MaterialRecord[] = materials.concat(fallback.map((record, index) => ({
			name: record.kind === 4 ? `BOMC image fallback ${index + 1}` : `BOMC text fallback ${index + 1}`,
			displayName: record.text,
			rgba: [255, 255, 255, 255],
			opacity: 1,
			texture: record.texture,
			textureWidthM: Math.max(record.width, 0.001),
			textureHeightM: Math.max(record.height, 0.001)
		})));
		const { scene, faces, bounds, typedArrayBytes, triangulationMs, textureMetrics, visibilityMetrics, triangleOwnership, backfaceLeak, coplanar } = buildRuntime(meshes, definitions, occurrences.meshes, occurrences.instances, runtimeMaterials, fallback, instances, textures, fallbackMaterialBase, tags, scenes, sceneVisibilityIndex, edgeAdjacencyByMesh);
		const buildRuntimeMs = performance.now() - buildRuntimeStarted;
		scene.occurrenceHierarchy = occurrences.hierarchy;
		const solidResolverStarted = performance.now();
		if (shouldPrepareSuppressedSolidGeometry(options.prepareSolid, encodingContract?.profile)) {
			prepareSolidCoplanarScene(scene, 0.00003, undefined, callbacks?.onSolidPreparationProgress);
		}
		const solidResolverMs = performance.now() - solidResolverStarted;
		const instanceConstructionMs = performance.now() - instanceStarted;
		const firstRenderableMs = performance.now() - totalStarted;

		if (callbacks?.isCancelled?.()) throw new Error('BOMC load cancelled');
		callbacks?.onGeometryReady?.(scene, faces);
		if (callbacks?.isCancelled?.()) throw new Error('BOMC load cancelled');

		const appearance = {
			materials: runtimeMaterials.map((material, index) => ({
				index,
				id: `bomc-material-${index}`,
				name: material.displayName || material.name,
				baseColorRgba: material.rgba.map((value) => value / 255) as [number, number, number, number],
				opacity: material.opacity,
				colorSpace: 'srgb',
				textureAsset: materialTexturePath(material, textures),
				textureWidthM: material.textureWidthM,
				textureHeightM: material.textureHeightM
			})),
			assets: textureAssets
		};
		const totalReadyMs = performance.now() - totalStarted;
		const frontTriangleCount = scene.groups
			.filter((g) => g.renderSide !== 'back')
			.reduce((sum, g) => sum + (g.indices.length / 3) * Math.max(g.matrices.length / 16, 1), 0);
		const backTriangleCount = scene.groups
			.filter((g) => g.renderSide === 'back')
			.reduce((sum, g) => sum + (g.indices.length / 3) * Math.max(g.matrices.length / 16, 1), 0);
		const totalOccurrenceTriangles = scene.totalTriangles || frontTriangleCount + backTriangleCount;
		const backUvOnlyFaceCount = 0;
		const isNewProducerFixture = backTriangleCount < frontTriangleCount * 0.5;

		let sha256 = '';
		if (typeof crypto !== 'undefined' && crypto.subtle) {
			try {
				const hashBuf = await crypto.subtle.digest('SHA-256', buffer);
				sha256 = Array.from(new Uint8Array(hashBuf))
					.map((b) => b.toString(16).padStart(2, '0'))
					.join('');
			} catch {
				sha256 = '';
			}
		}

		const provenance = {
			path: sourceName,
			sha256,
			bytes: buffer.byteLength,
			frontTriangleCount,
			backTriangleCount,
			totalOccurrenceTriangles,
			backUvOnlyFaceCount,
			isNewProducerFixture,
			timestamp: new Date().toISOString()
		};

		const inflatedTemporaryBytes = container.metrics.filter((metric) => metric.loaded && metric.codec === 1).reduce((sum, metric) => sum + metric.rawLength, 0);
		const texturePayloadBytes = textures.reduce((sum, texture) => sum + texture.payloadByteLength, 0);
		const diagnostics = {
			version: `${container.header.major}.${container.header.minor}`,
			profile: model.profile,
			sourceFileBytes: buffer.byteLength,
			storedSectionBytes: container.metrics.reduce((sum, metric) => sum + metric.storedLength, 0),
			inflatedTemporaryBytes,
			finalTypedArrayBytes: typedArrayBytes,
			threeGeometryBytes: scene.meshes.reduce((sum, mesh) => sum + mesh.positions.byteLength + (mesh.normals?.byteLength || 0) + (mesh.uvs?.byteLength || 0), 0) + scene.groups.reduce((sum, group) => sum + group.indices.byteLength + (group.solidIndices?.byteLength || 0) + (group.solidSourceTriangleIndices?.byteLength || 0) + group.matrices.byteLength + (group.occurrenceHierarchyDepths?.byteLength || 0) + (group.sourceFaceAreasByTriangle?.byteLength || 0) + (group.sourceFaceIndicesByTriangle?.byteLength || 0), 0) + (scene.edgeSets || []).reduce((sum, edgeSet) => sum + edgeSet.positions.byteLength + edgeSet.flags.byteLength + edgeSet.matrices.byteLength, 0),
			texturePayloadBytes,
			definitions: definitions.length,
			instances: instances.length,
			triangles: scene.totalTriangles || 0,
			materials: materials.length,
			textures: textures.length,
			visualEdges: meshes.reduce((sum, mesh) => sum + mesh.edges.filter((edge) => isBomcEdgeRenderVisible(edge, tags)).length, 0),
			visibility: visibilityMetrics,
			triangleOwnership,
			backfaceLeak,
			triangleVerticesMissingUv: textureMetrics.reduce((sum, metric) => sum + metric.triangleVerticesMissingUv, 0),
			textureMetrics,
			coverage,
			occurrences: {
				hierarchyNodeCount: occurrences.hierarchy.parentIndices.length,
				renderOccurrenceCount: [...occurrences.meshes.values()].reduce((sum, rows) => sum + rows.length, 0),
				hierarchyTypedArrayBytes: occurrences.hierarchy.parentIndices.byteLength + occurrences.hierarchy.instanceIndices.byteLength + occurrences.hierarchy.tagIndices.byteLength,
				legacyAncestryElementCount: 0,
				legacyNestedArrayCount: 0
			},
			provenance,
			encodingContract,
			semanticMaterials: { ...semanticResult.diagnostics, sectionVersion: materialSectionVersion },
			sectionMetrics: container.metrics.map((metric) => ({ ...metric })),
			timings: {
				coreMetadataReadyMs,
				geometryReadyMs,
				firstRenderableMs,
				firstTextureReadyMs,
				allTexturesReadyMs,
				headerMs: container.headerMs,
				directoryMs: container.directoryMs,
				inflateMs: container.metrics.reduce((sum, metric) => sum + metric.inflateMs, 0),
				metadataMs,
				analyticalDecodeMs,
				definitionDecodeMs,
				triangulationMs,
				collectOccurrencesMs,
				buildRuntimeMs,
				solidResolverMs,
				instanceConstructionMs,
				textureTableMs,
				totalReadyMs
			}
		};
		if (import.meta.env.DEV) console.info('[bomc metrics]', diagnostics);

		const activeSceneId = (scenes.find((s) => s.isActiveAtExport) || scenes[0])?.id;

		if (typeof window !== 'undefined' && import.meta.env.DEV) {
			const scope = (container.header.flags & 0x0100) !== 0
				? 'active'
				: (container.header.flags & 0x0200) !== 0
					? 'all'
					: 'legacy';
			(window as typeof window & { __SIBAMBO_BOMC_SCENES__?: unknown }).__SIBAMBO_BOMC_SCENES__ = {
				containerVersion: `${container.header.major}.${container.header.minor}`,
				profileFlags: container.header.flags,
				scope,
				sceneSectionPresent: container.has(BOMC_SECTION.SCENES),
				sceneSectionVersion,
				sceneCount: scenes.length,
				activeSceneId,
				sceneNames: scenes.map((s) => s.name),
				visibilitySignatures: scenes.map((s) => s.visibilitySignature),
				uniqueVisibilitySignatureCount: new Set(scenes.map((s) => s.visibilitySignature)).size,
				scenes: scenes.map((s) => ({
					id: s.id,
					name: s.name,
					isActiveAtExport: s.isActiveAtExport,
					visibilitySignature: s.visibilitySignature,
					visibleTagCount: s.visibility.visibleTagIndices?.length ?? s.visibility.visibleTagIds.length,
					hiddenTagCount: s.visibility.hiddenTagIndices?.length ?? s.visibility.hiddenTagIds.length,
					visibleNodeOverrideCount: s.visibility.visibleNodeIndices?.length ?? s.visibility.visibleNodeOverrides.length,
					hiddenNodeOverrideCount: s.visibility.hiddenNodeIndices?.length ?? s.visibility.hiddenNodeOverrides.length,
					resolvedVisibleNodeOverrideCount: s.visibility.resolvedVisibleNodeOverrideCount ?? s.visibility.visibleNodeIndices?.length ?? 0,
					resolvedHiddenNodeOverrideCount: s.visibility.resolvedHiddenNodeOverrideCount ?? s.visibility.hiddenNodeIndices?.length ?? 0,
					unresolvedVisibleNodeOverrides: s.visibility.unresolvedVisibleNodeOverrides ?? [],
					unresolvedHiddenNodeOverrides: s.visibility.unresolvedHiddenNodeOverrides ?? [],
					useCamera: s.useCamera,
					projection: s.camera.projection,
					storesTagVisibility: s.storesTagVisibility,
					storesHiddenObjects: s.storesHiddenObjects,
					storesHiddenGeometry: s.storesHiddenGeometry,
					storesSectionPlanes: s.storesSectionPlanes,
					sectionRenderingSupport: s.sectionState.renderingSupport
				}))
			};
		}

		const adaptedResult: AdaptedBomcResult = {
			version: diagnostics.version,
			profile: diagnostics.profile,
			sourceFileName: model.sourceFile || sourceName,
			modelName: model.modelName,
			faces,
			preparedRuntimeScene: scene,
			appearance,
			bounds,
			materialRows: runtimeMaterials.map((material) => ({
				name: material.displayName || material.name || 'Unnamed',
				color: `#${material.rgba.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}`,
				reflectance: '0.5'
			})),
			counts: model.counts,
			scenes,
			activeSceneId,
			clipPlanes,
			encodingContract,
			diagnostics
		};

		if (callbacks?.isCancelled?.()) throw new Error('BOMC load cancelled');
		callbacks?.onFirstRenderable?.(adaptedResult);
		if (callbacks?.isCancelled?.()) throw new Error('BOMC load cancelled');
		if (appearance.assets.length > 0) {
			if (callbacks?.isCancelled?.()) throw new Error('BOMC load cancelled');
			callbacks?.onAllTexturesReady?.(appearance.assets);
			if (callbacks?.isCancelled?.()) throw new Error('BOMC load cancelled');
		}
		if (callbacks?.isCancelled?.()) throw new Error('BOMC load cancelled');
		callbacks?.onComplete?.(adaptedResult);

		return adaptedResult;
	}
}

async function decodeReleased<T>(container: BomcContainer, type: number, decode: (bytes: Uint8Array) => T | Promise<T>): Promise<T> {
	const bytes = (await container.load(type)) as Uint8Array;
	try {
		return await decode(bytes);
	} finally {
		container.release(type);
	}
}

function validateCountedSections(container: BomcContainer, counts: AdaptedBomcResult['counts']) {
	const requirements: Array<[number, number[]]> = [
		[counts.materials, [BOMC_SECTION.MATERIALS]],
		[counts.tags, [BOMC_SECTION.TAGS]],
		[counts.meshes, [BOMC_SECTION.MESHES, BOMC_SECTION.POSITIONS, BOMC_SECTION.TOPOLOGY]],
		[counts.faces, [BOMC_SECTION.FACES, BOMC_SECTION.NORMALS]],
		[counts.textures, [BOMC_SECTION.TEXTURE_TABLE, BOMC_SECTION.TEXTURE_BLOBS]],
		[counts.edges, [BOMC_SECTION.VISUAL_EDGES]]
	];
	for (const [count, types] of requirements) {
		if (count > 0) for (const type of types) if (!container.has(type)) throw new Error(`BOMC invalid: missing section ${type} for nonzero count.`);
	}
	if (container.has(BOMC_SECTION.TEXTURE_TABLE) !== container.has(BOMC_SECTION.TEXTURE_BLOBS)) {
		throw new Error('BOMC invalid: texture table/blob sections must appear together.');
	}
}

export function decodeStrings(bytes: Uint8Array) {
	const reader = new BomcBinaryReader(bytes);
	if (reader.readUint8() !== 1 || reader.readUint8() !== 0 || reader.readUint8() !== 0 || reader.readUint8() !== 0) throw new Error('BOMC invalid: string section header.');
	const count = reader.readCount('string');
	const dataSize = reader.readUint32();
	const offsetCount = count + 1;
	const offsetBytes = assertBomcArrayBytes(offsetCount, 1, 4, 'string offsets') * 4;
	if (offsetBytes + dataSize !== reader.remaining) throw new Error('BOMC invalid: string table byte count.');
	const offsets = new Uint32Array(offsetCount);
	for (let index = 0; index <= count; index += 1) offsets[index] = reader.readUint32();
	if (offsets[0] !== 0 || offsets[count] !== dataSize) throw new Error('BOMC invalid: string offsets boundary.');
	for (let index = 1; index <= count; index += 1) if (offsets[index] < offsets[index - 1]) throw new Error('BOMC invalid: string offsets are not monotonic.');
	const data = reader.readBytes(dataSize, 'string data');
	reader.finish('string section');
	const decoder = new TextDecoder('utf-8', { fatal: true });
	return Array.from({ length: count }, (_, index) => decoder.decode(data.subarray(offsets[index], offsets[index + 1])));
}

export function decodeModel(bytes: Uint8Array, strings: string[]): ModelRecord {
	const reader = new BomcBinaryReader(bytes);
	if (reader.readUint8() !== 1) throw new Error('BOMC invalid: model section version.');
	const profileCode = reader.readUint8();
	const stringWidth = reader.readUint8();
	const coordinateFlags = reader.readUint8();
	if ((coordinateFlags & 1) === 0 || ((coordinateFlags >> 1) & 3) !== 2) throw new Error('BOMC invalid: unsupported coordinate system; expected right-handed +Z up.');
	const rootNode = reader.readUint32();
	const bounds = Array.from({ length: 6 }, () => reader.readFloat64());
	const countValues = Array.from({ length: 9 }, () => reader.readUint32());
	countValues.forEach((count, index) => assertBomcCount(count, `model ${['material', 'tag', 'mesh', 'face', 'definition', 'instance', 'transform', 'texture', 'edge'][index]}`));
	const source = reader.readIndices(stringWidth, 2);
	reader.finish('model section');
	const names = source.values;
	return {
		profile: profileCode === 2 ? 'debug' : 'production', rootNode, bounds,
		counts: {
			materials: countValues[0], tags: countValues[1], meshes: countValues[2], faces: countValues[3],
			definitions: countValues[4], instances: countValues[5], transforms: countValues[6], textures: countValues[7], edges: countValues[8]
		},
		sourceFile: names[0] === MISSING ? undefined : stringAt(strings, names[0]),
		modelName: names[1] === MISSING ? undefined : stringAt(strings, names[1])
	};
}

export function decodeMaterials(bytes: Uint8Array, strings: string[], expectedCount?: number) {
	const reader = new BomcBinaryReader(bytes);
	const version = reader.readUint8();
	if (version !== 1 && version !== 2) throw new Error('BOMC invalid: material section version.');
	const stringWidth = reader.readUint8();
	const textureWidth = reader.readUint8();
	if (reader.readUint8() !== 0) throw new Error('BOMC invalid: material section reserved field.');
	const count = reader.readCount('material');
	assertExpectedBomcCount(count, expectedCount, 'material');
	if (![1, 2, 4].includes(stringWidth) || ![1, 2, 4].includes(textureWidth)) throw new Error('BOMC invalid: adaptive-width code.');
	const rowBytes = stringWidth * 2 + 4 + 2 + textureWidth + 8 + (version === 2 ? 58 : 0);
	assertBomcArrayBytes(count, 1, rowBytes, 'material');
	if (reader.remaining !== count * rowBytes) throw new Error('BOMC invalid: material section byte count.');
	const names = reader.readIndices(stringWidth, count);
	const displayNames = reader.readIndices(stringWidth, count);
	const colors = reader.readBytes(count * 4);
	const opacities = Array.from({ length: count }, () => reader.readUint16());
	const textures = reader.readIndices(textureWidth, count);
	const widths = Array.from({ length: count }, () => reader.readFloat32());
	const heights = Array.from({ length: count }, () => reader.readFloat32());
	const materialTypes = version === 2 ? Array.from({ length: count }, () => reader.readUint8()) : [];
	const colorizeModes = version === 2 ? Array.from({ length: count }, () => reader.readUint8()) : [];
	const deltas = version === 2
		? Array.from({ length: count }, () => [reader.readFloat64(), reader.readFloat64(), reader.readFloat64()] as [number, number, number])
		: [];
	const outputHashes = version === 2 ? Array.from({ length: count }, () => bytesToHex(reader.readBytes(32))) : [];
	reader.finish('material section');
	return Array.from({ length: count }, (_, index): MaterialRecord => {
		const record: MaterialRecord = {
			name: names.values[index] === MISSING ? undefined : stringAt(strings, names.values[index]),
			displayName: displayNames.values[index] === MISSING ? undefined : stringAt(strings, displayNames.values[index]),
			rgba: [colors[index * 4], colors[index * 4 + 1], colors[index * 4 + 2], colors[index * 4 + 3]],
			opacity: opacities[index] / 65535,
			texture: textures.values[index], textureWidthM: widths[index], textureHeightM: heights[index]
		};
		if (version === 2) {
			const materialType = materialTypes[index];
			const colorizeMode = colorizeModes[index];
			if (materialType !== 0 && materialType !== 1 && materialType !== 2) throw new Error(`BOMC invalid: material ${index} type code.`);
			if (colorizeMode !== 0 && colorizeMode !== 1 && colorizeMode !== 2) throw new Error(`BOMC invalid: material ${index} colorize mode code.`);
			const [h, l, s] = deltas[index];
			const outputRgbaSha256 = outputHashes[index];
			const active = materialType === 2 && (colorizeMode === 1 || colorizeMode === 2);
			if (active) {
				if (record.texture === MISSING) throw new Error(`BOMC invalid: semantic material ${index} texture reference is missing.`);
				if (/^0+$/.test(outputRgbaSha256)) throw new Error(`BOMC invalid: semantic material ${index} output RGBA hash is zero.`);
				if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(s) || h < -360 || h > 360 || l < -1 || l > 1 || s < -1 || s > 1) {
					throw new Error(`BOMC invalid: semantic material ${index} HLS deltas.`);
				}
			}
			record.semantic = { materialType, colorizeMode, deltas: [h, l, s], outputRgbaSha256 };
		}
		return record;
	});
}

function decodeTags(bytes: Uint8Array, strings: string[], expectedCount?: number) {
	const reader = new BomcBinaryReader(bytes);
	if (reader.readUint8() !== 1) throw new Error('BOMC invalid: tag section version.');
	const width = reader.readUint8();
	if (reader.readUint16() !== 0) throw new Error('BOMC invalid: tag section reserved fields.');
	if (![1, 2, 4].includes(width)) throw new Error('BOMC invalid: adaptive-width code.');
	const count = reader.readCount('tag');
	assertExpectedBomcCount(count, expectedCount, 'tag');
	if (count * width + Math.ceil(count / 8) !== reader.remaining) throw new Error('BOMC invalid: tag section byte count.');
	const names = reader.readIndices(width, count);
	const visibility = reader.readBytes(Math.ceil(count / 8));
	reader.finish('tag section');
	return Array.from({ length: count }, (_, index): TagRecord => ({
		name: names.values[index] === MISSING ? undefined : stringAt(strings, names.values[index]),
		visible: (visibility[Math.floor(index / 8)] & (1 << (index % 8))) !== 0
	}));
}

function decodeMeshes(bytes: Uint8Array, expectedCount?: number) {
	const reader = new BomcBinaryReader(bytes);
	if (reader.readUint8() !== 1) throw new Error('BOMC invalid: mesh section version.');
	const width = reader.readUint8();
	if (reader.readUint16() !== 0) throw new Error('BOMC invalid: mesh section reserved fields.');
	const count = reader.readCount('mesh');
	assertExpectedBomcCount(count, expectedCount, 'mesh');
	if (![1, 2, 4].includes(width)) throw new Error('BOMC invalid: adaptive-width code.');
	reader.assertRemainingCount(count, width + 44, 'mesh');
	const definitions = reader.readIndices(width, count, true).values;
	const columns = Array.from({ length: 11 }, () => Array.from({ length: count }, () => reader.readUint32()));
	reader.finish('mesh section');
	return Array.from({ length: count }, (_, index): MeshRow => ({
		definition: definitions[index], vertexCount: columns[0][index], faceStart: columns[1][index], faceCount: columns[2][index],
		edgeStart: columns[3][index], edgeCount: columns[4][index], positionOffset: columns[5][index], positionLength: columns[6][index],
		topologyOffset: columns[7][index], topologyLength: columns[8][index], uvOffset: columns[9][index], uvLength: columns[10][index]
	}));
}

function decodeFaces(bytes: Uint8Array, strings: string[], expectedCount?: number) {
	const reader = new BomcBinaryReader(bytes);
	if (reader.readUint8() !== 1) throw new Error('BOMC invalid: face section version.');
	const materialWidth = reader.readUint8();
	const tagWidth = reader.readUint8();
	const stringWidth = reader.readUint8();
	const count = reader.readCount('face');
	assertExpectedBomcCount(count, expectedCount, 'face');
	const totalLoops = reader.readCount('face loop');
	const loopCountBytes = reader.readUint32();
	const triangleCountBytes = reader.readUint32();
	const loopLengthBytes = reader.readUint32();
	if (![1, 2, 4].includes(materialWidth) || ![1, 2, 4].includes(tagWidth) || ![1, 2, 4].includes(stringWidth)) {
		throw new Error('BOMC invalid: adaptive-width code.');
	}
	const tableBytes = count * (3 + 2 * materialWidth + tagWidth + stringWidth) + loopCountBytes + triangleCountBytes + loopLengthBytes;
	if (!Number.isSafeInteger(tableBytes) || tableBytes !== reader.remaining) throw new Error('BOMC invalid: face section byte count.');
	const surface = reader.readBytes(count);
	const flags = reader.readBytes(count);
	const roles = reader.readBytes(count);
	const front = reader.readIndices(materialWidth, count).values;
	const back = reader.readIndices(materialWidth, count).values;
	const tags = reader.readIndices(tagWidth, count).values;
	const labels = reader.readIndices(stringWidth, count).values;
	const loopCounts = decodeVaruintColumn(reader.readBytes(loopCountBytes), count, 'face loop counts');
	const triangleCounts = decodeVaruintColumn(reader.readBytes(triangleCountBytes), count, 'face triangle counts');
	const loopLengths = decodeVaruintColumn(reader.readBytes(loopLengthBytes), totalLoops, 'face loop lengths');
	reader.finish('face section');
	let declaredLoopCount = 0;
	for (const value of loopCounts) {
		declaredLoopCount += value;
		if (!Number.isSafeInteger(declaredLoopCount) || declaredLoopCount > totalLoops) throw new Error('BOMC invalid: face loop counts exceed the loop table.');
	}
	if (declaredLoopCount !== totalLoops) throw new Error('BOMC invalid: face loop counts do not consume the loop table.');
	let loopCursor = 0;
	return Array.from({ length: count }, (_, index): FaceRow => {
		const lengths = loopLengths.slice(loopCursor, loopCursor + loopCounts[index]);
		loopCursor += loopCounts[index];
		return {
			globalIndex: index, surfaceCode: surface[index], flags: flags[index], roleCode: roles[index], frontMaterial: front[index], backMaterial: back[index],
			tag: tags[index], label: labels[index] === MISSING ? undefined : stringAt(strings, labels[index]), loopLengths: lengths,
			triangleCount: triangleCounts[index], outer: new Uint32Array(0), holes: [], triangles: new Uint32Array(0), normal: [0, 0, 0]
		};
	});
}

function decodeDefinitions(bytes: Uint8Array, strings: string[], expectedCount?: number) {
	const reader = new BomcBinaryReader(bytes);
	if (reader.readUint8() !== 1) throw new Error('BOMC invalid: definition section version.');
	const stringWidth = reader.readUint8();
	const meshWidth = reader.readUint8();
	if (reader.readUint8() !== 0) throw new Error('BOMC invalid: definition section reserved field.');
	const count = reader.readCount('definition');
	assertExpectedBomcCount(count, expectedCount, 'definition');
	if (![1, 2, 4].includes(stringWidth) || ![1, 2, 4].includes(meshWidth)) throw new Error('BOMC invalid: adaptive-width code.');
	if (count * (stringWidth + meshWidth + 1) !== reader.remaining) throw new Error('BOMC invalid: definition section byte count.');
	const names = reader.readIndices(stringWidth, count).values;
	const kinds = reader.readBytes(count);
	const meshes = reader.readIndices(meshWidth, count).values;
	reader.finish('definition section');
	return Array.from({ length: count }, (_, index): DefinitionRecord => ({ name: names[index] === MISSING ? undefined : stringAt(strings, names[index]), kind: kinds[index], mesh: meshes[index], nodes: [] }));
}

function decodeInstances(bytes: Uint8Array, strings: string[], expectedCount?: number) {
	const reader = new BomcBinaryReader(bytes);
	if (reader.readUint8() !== 1) throw new Error('BOMC invalid: instance section version.');
	const stringWidth = reader.readUint8(), definitionWidth = reader.readUint8(), transformWidth = reader.readUint8();
	const materialWidth = reader.readUint8(), tagWidth = reader.readUint8();
	if (reader.readUint16() !== 0) throw new Error('BOMC invalid: instance section reserved fields.');
	const count = reader.readCount('instance');
	assertExpectedBomcCount(count, expectedCount, 'instance');
	const widths = [stringWidth, definitionWidth, transformWidth, materialWidth, tagWidth];
	if (widths.some((width) => ![1, 2, 4].includes(width))) throw new Error('BOMC invalid: adaptive-width code.');
	const minimumRowBytes = stringWidth * 2 + definitionWidth * 2 + transformWidth + materialWidth + tagWidth + 3;
	if (count * minimumRowBytes !== reader.remaining) throw new Error('BOMC invalid: instance section byte count.');
	const names = reader.readIndices(stringWidth, count).values;
	const kinds = reader.readBytes(count);
	const owners = reader.readIndices(definitionWidth, count).values;
	const definitions = reader.readIndices(definitionWidth, count).values;
	const transforms = reader.readIndices(transformWidth, count, true).values;
	const materials = reader.readIndices(materialWidth, count).values;
	const tags = reader.readIndices(tagWidth, count).values;
	const flags = reader.readBytes(count);
	const roles = reader.readBytes(count);
	const labels = reader.readIndices(stringWidth, count).values;
	reader.finish('instance section');
	return Array.from({ length: count }, (_, index): InstanceRecord => ({
		name: names[index] === MISSING ? undefined : stringAt(strings, names[index]), kind: kinds[index], owner: owners[index], definition: definitions[index],
		transform: transforms[index], material: materials[index], tag: tags[index], visible: (flags[index] & 1) !== 0, fallback: (flags[index] & 2) !== 0,
		roleCode: roles[index], label: labels[index] === MISSING ? undefined : stringAt(strings, labels[index])
	}));
}

function decodeGeometry(meshRows: MeshRow[], faces: FaceRow[], normals: Float32Array, positionSection: Uint8Array, topologySection: Uint8Array, uvSection: Uint8Array) {
	let totalVertices = 0;
	let totalTopologyIndices = 0;
	let totalUvPairs = 0;
	for (let meshIndex = 0; meshIndex < meshRows.length; meshIndex += 1) {
		const row = meshRows[meshIndex];
		assertBomcCount(row.vertexCount, `mesh ${meshIndex} vertex`);
		if (!Number.isSafeInteger(row.faceStart + row.faceCount) || row.faceStart + row.faceCount > faces.length) throw new Error(`BOMC invalid: mesh ${meshIndex} face range.`);
		const localFaces = faces.slice(row.faceStart, row.faceStart + row.faceCount);
		const loopIndices = localFaces.reduce((sum, face) => sum + face.loopLengths.reduce((loopSum, length) => loopSum + length, 0), 0);
		const triangleIndices = localFaces.reduce((sum, face) => sum + face.triangleCount, 0);
		const uvPairs = localFaces.reduce((sum, face) => sum + face.loopLengths.reduce((loopSum, length) => loopSum + length, 0) * (((face.flags & 4) !== 0 ? 1 : 0) + ((face.flags & 8) !== 0 ? 1 : 0)), 0);
		totalVertices += row.vertexCount;
		totalTopologyIndices += loopIndices + triangleIndices;
		totalUvPairs += uvPairs;
		if (!Number.isSafeInteger(totalVertices) || !Number.isSafeInteger(totalTopologyIndices) || !Number.isSafeInteger(totalUvPairs)) {
			throw new Error('BOMC invalid: aggregate mesh counts exceed the safe integer range.');
		}
	}
	return meshRows.map((row, meshIndex): MeshRecord => {
		const localFaces = faces.slice(row.faceStart, row.faceStart + row.faceCount);
		const expectedLoopIndices = localFaces.reduce((sum, face) => sum + face.loopLengths.reduce((loopSum, length) => loopSum + length, 0), 0);
		const expectedTriangleIndices = localFaces.reduce((sum, face) => sum + face.triangleCount, 0);
		const positions = decodePositionBlock(sliceBlock(positionSection, row.positionOffset, row.positionLength, 'position'), row.vertexCount).positions;
		if (positions.length !== row.vertexCount * 3) throw new Error(`BOMC invalid: mesh ${meshIndex} vertex count.`);
		const topology = decodeTopologyBlock(sliceBlock(topologySection, row.topologyOffset, row.topologyLength, 'topology'), expectedLoopIndices, expectedTriangleIndices);
		if (localFaces.length !== row.faceCount) throw new Error(`BOMC invalid: mesh ${meshIndex} face range.`);
		let loopCursor = 0;
		let triangleCursor = 0;
		for (let localIndex = 0; localIndex < localFaces.length; localIndex += 1) {
			const face = localFaces[localIndex];
			const loops = face.loopLengths.map((length) => {
				const values = topology.loops.slice(loopCursor, loopCursor + length);
				if (values.length !== length) throw new Error(`BOMC invalid: mesh ${meshIndex} loop range.`);
				loopCursor += length;
				return values;
			});
			face.outer = loops.shift() || new Uint32Array(0);
			face.holes = loops;
			face.triangles = topology.triangles.slice(triangleCursor, triangleCursor + face.triangleCount);
			if (face.triangles.length !== face.triangleCount || face.triangles.length % 3 !== 0) throw new Error(`BOMC invalid: mesh ${meshIndex} triangle range.`);
			triangleCursor += face.triangleCount;
			face.normal = [normals[(row.faceStart + localIndex) * 3], normals[(row.faceStart + localIndex) * 3 + 1], normals[(row.faceStart + localIndex) * 3 + 2]];
			for (const vertex of [...face.outer, ...face.holes.flatMap((hole) => [...hole]), ...face.triangles]) assertIndex(vertex, row.vertexCount, `mesh ${meshIndex} topology`);
		}
		if (loopCursor !== topology.loops.length || triangleCursor !== topology.triangles.length) throw new Error(`BOMC invalid: mesh ${meshIndex} topology consumption mismatch.`);
		if (row.uvLength > 0) {
			const expectedUvPairs = localFaces.reduce((sum, face) => sum + face.loopLengths.reduce((loopSum, length) => loopSum + length, 0) * (((face.flags & 4) !== 0 ? 1 : 0) + ((face.flags & 8) !== 0 ? 1 : 0)), 0);
			assignUvs(localFaces, decodeUvBlock(sliceBlock(uvSection, row.uvOffset, row.uvLength, 'UV'), expectedUvPairs).uvs, meshIndex);
		}
		else if (localFaces.some((face) => (face.flags & 12) !== 0)) throw new Error(`BOMC invalid: mesh ${meshIndex} declares missing UV data.`);
		return { row, positions, faces: localFaces, edges: [] };
	});
}

function assignUvs(faces: FaceRow[], values: Float32Array, meshIndex: number) {
	let cursor = 0;
	for (const face of faces) {
		for (const side of ['front', 'back'] as const) {
			const present = side === 'front' ? (face.flags & 4) !== 0 : (face.flags & 8) !== 0;
			if (!present) continue;
			const scalarCount = face.loopLengths.reduce((sum, length) => sum + length * 2, 0);
			const uv = values.slice(cursor, cursor + scalarCount);
			if (uv.length !== scalarCount) throw new Error(`BOMC invalid: mesh ${meshIndex} UV range.`);
			cursor += scalarCount;
			if (side === 'front') face.frontUvs = uv;
			else face.backUvs = uv;
		}
	}
	if (cursor !== values.length) throw new Error(`BOMC invalid: mesh ${meshIndex} UV consumption mismatch.`);
}

export function decodeEdges(bytes: Uint8Array, meshRows: MeshRow[], meshes: MeshRecord[], tagCount: number, expectedCount?: number) {
	const reader = new BomcBinaryReader(bytes);
	if (reader.readUint8() !== 1) throw new Error('BOMC invalid: edge section version.');
	const tagWidth = reader.readUint8();
	if (reader.readUint16() !== 0) throw new Error('BOMC invalid: edge section reserved fields.');
	const count = reader.readCount('visual edge');
	assertExpectedBomcCount(count, expectedCount, 'visual edge');
	const endpointLength = reader.readUint32();
	const tags = reader.readIndices(tagWidth, count).values;
	const flags = reader.readBytes(count);
	const endpoints = new BomcBinaryReader(reader.readBytes(endpointLength));
	reader.finish('edge section');
	if (count * 2 > endpoints.remaining) throw new Error('BOMC invalid: visual edge endpoint count exceeds encoded payload.');
	const records: EdgeRecord[] = new Array(count);
	for (let index = 0; index < count; index += 1) {
		if (tags[index] !== MISSING) assertIndex(tags[index], tagCount, `edge ${index} tag`);
		const first = endpoints.readVaruint();
		const second = endpoints.readVaruint();
		records[index] = { globalIndex: index, first, second, flags: flags[index], tag: tags[index] };
	}
	endpoints.finish('visual edge endpoint');
	for (let index = 0; index < meshRows.length; index += 1) {
		const row = meshRows[index];
		const local = records.slice(row.edgeStart, row.edgeStart + row.edgeCount);
		if (local.length !== row.edgeCount) throw new Error(`BOMC invalid: mesh ${index} edge range.`);
		meshes[index].edges = local;
		for (const edge of meshes[index].edges) {
			assertIndex(edge.first, row.vertexCount, `mesh ${index} edge`);
			assertIndex(edge.second, row.vertexCount, `mesh ${index} edge`);
		}
	}
}

export async function decodeTextures(tableBytes: Uint8Array, blobBytes: Uint8Array, options: { isCancelled?: () => boolean; expectedCount?: number } = {}) {
	const reader = new BomcBinaryReader(tableBytes);
	const tableVersion = reader.readUint8();
	if (![1, 2].includes(tableVersion) || reader.readUint8() !== 0 || reader.readUint8() !== 0 || reader.readUint8() !== 0) throw new Error('BOMC invalid: texture table header.');
	const count = reader.readCount('texture');
	assertExpectedBomcCount(count, options.expectedCount, 'texture');
	reader.assertRemainingCount(count, 57, 'texture');
	const media = reader.readBytes(count);
	const widths = Array.from({ length: count }, () => reader.readUint32());
	const heights = Array.from({ length: count }, () => reader.readUint32());
	const hashes = Array.from({ length: count }, () => bytesToHex(reader.readBytes(32)));
	const offsets = Array.from({ length: count }, () => reader.readUint64('texture blob offset'));
	const lengths = Array.from({ length: count }, () => reader.readUint64('texture blob length'));
	reader.finish('texture table');
	const records: TextureRecord[] = [];
	for (let index = 0; index < count; index += 1) {
		if (options.isCancelled?.()) throw new Error('BOMC load cancelled');
		if (media[index] < 1 || media[index] > 6) throw new Error(`BOMC invalid: texture ${index} media type.`);
		if (media[index] === 6 && tableVersion !== 2) throw new Error(`BOMC invalid: texture ${index} requires table version 2.`);
		const end = offsets[index] + lengths[index];
		if (!Number.isSafeInteger(end) || end > blobBytes.byteLength) throw new Error(`BOMC invalid: texture ${index} outside blob section.`);
		const payloadByteLength = lengths[index];
		const encodedBytes = blobBytes.subarray(offsets[index], end);
		let encodedHashVerified = false;
		if (typeof crypto !== 'undefined' && crypto.subtle) {
			const actual = bytesToHex(await digestSha256(encodedBytes));
			if (options.isCancelled?.()) throw new Error('BOMC load cancelled');
			if (actual !== hashes[index]) throw new Error(`BOMC invalid: texture ${index} hash mismatch.`);
			encodedHashVerified = true;
		}
		if (media[index] === 6) {
			const png = await decodeBomcJcmToPng(encodedBytes, widths[index], heights[index], options);
			const hash = bytesToHex(png.sha256);
			records.push({ media: 1, sourceMedia: media[index], encodedHashVerified, width: widths[index], height: heights[index], hash, bytes: png.bytes,
				assetPath: `bomc/textures/${hash}.png`, payloadByteLength });
		} else {
			const extension = ['bin', 'png', 'jpg', 'webp', 'avif', 'ktx2'][media[index]];
			records.push({ media: media[index], sourceMedia: media[index], encodedHashVerified, width: widths[index], height: heights[index], hash: hashes[index], bytes: encodedBytes,
				assetPath: `bomc/textures/${hashes[index]}.${extension}`, payloadByteLength });
		}
	}
	return records;
}

export async function hydrateSemanticMaterials(
	materials: MaterialRecord[],
	textures: TextureRecord[],
	options: { isCancelled?: () => boolean; codec?: ImagePixelCodec; onMaterialVerified?: (proof: Readonly<BomcSemanticMaterialDiagnostics['materialProofs'][number]>) => void } = {}
): Promise<{ assets: Array<{ path: string; bytes: Uint8Array }>; diagnostics: BomcSemanticMaterialDiagnostics }> {
	const started = performance.now();
	const activeIndices = materials.flatMap((material, index) => isActiveSemanticMaterial(material) ? [index] : []);
	const diagnostics: BomcSemanticMaterialDiagnostics = {
		sectionVersion: materials.some((material) => material.semantic) ? 2 : materials.length ? 1 : null,
		activeCount: activeIndices.length,
		verifiedCount: 0,
		generatedAssetCount: 0,
		generatedPngBytes: 0,
		baseDecodeCount: 0,
		maxLiveBaseFrames: 0,
		maxLiveOutputFrames: 0,
		maxMemoEntries: 0,
		totalMs: 0,
		baseDecodes: [],
		materialProofs: []
	};
	if (!activeIndices.length) {
		diagnostics.totalMs = performance.now() - started;
		return { assets: [], diagnostics };
	}
	if (typeof crypto === 'undefined' || !crypto.subtle) {
		throw new Error('BOMC semantic material SHA-256 is unavailable.');
	}

	const jobsByTexture = new Map<number, number[]>();
	for (const materialIndex of activeIndices) {
		const material = materials[materialIndex];
		const semantic = material.semantic!;
		const textureIndex = material.texture;
		if (textureIndex === MISSING) throw new Error(`BOMC invalid: semantic material ${materialIndex} texture reference is missing.`);
		if (!Number.isSafeInteger(textureIndex) || textureIndex < 0 || textureIndex >= textures.length) {
			throw new Error(`BOMC invalid: semantic material ${materialIndex} texture ${textureIndex} is outside the source texture table.`);
		}
		const texture = textures[textureIndex];
		if (texture.sourceMedia !== 1 && texture.sourceMedia !== 2 && texture.sourceMedia !== 3) {
			throw new Error(`BOMC semantic material ${materialIndex} texture ${textureIndex}: source media ${texture.sourceMedia} is unsupported.`);
		}
		if (!texture.encodedHashVerified) throw new Error(`BOMC semantic material ${materialIndex} texture ${textureIndex}: encoded source hash was not verified.`);
		const pixels = texture.width * texture.height;
		const rgbaBytes = pixels * 4;
		if (!Number.isSafeInteger(texture.width) || texture.width <= 0 || !Number.isSafeInteger(texture.height) || texture.height <= 0 ||
			!Number.isSafeInteger(pixels) || !Number.isSafeInteger(rgbaBytes)) {
			throw new Error(`BOMC semantic material ${materialIndex} texture ${textureIndex}: dimensions or RGBA byte length are invalid.`);
		}
		if ((semantic.colorizeMode !== 1 && semantic.colorizeMode !== 2) || semantic.materialType !== 2 ||
			!/^([0-9a-f]{64})$/.test(semantic.outputRgbaSha256) || /^0+$/.test(semantic.outputRgbaSha256) ||
			semantic.deltas.some((value) => !Number.isFinite(value))) {
			throw new Error(`BOMC invalid: semantic material ${materialIndex} metadata is malformed.`);
		}
		const rows = jobsByTexture.get(textureIndex) || [];
		rows.push(materialIndex);
		jobsByTexture.set(textureIndex, rows);
	}

	const codec = options.codec || defaultImagePixelCodec;
	const generatedAssets: Array<{ path: string; bytes: Uint8Array }> = [];
	const assetByPath = new Map<string, { path: string; bytes: Uint8Array }>();
	const pendingPaths = new Map<number, string>();
	const checkCancelled = () => { if (options.isCancelled?.()) throw new Error('BOMC load cancelled'); };
	const sortedTextureIndices = [...jobsByTexture.keys()].sort((a, b) => a - b);

	for (const textureIndex of sortedTextureIndices) {
		checkCancelled();
		const texture = textures[textureIndex];
		const materialIndices = jobsByTexture.get(textureIndex)!.sort((a, b) => a - b);
		const firstMaterialIndex = materialIndices[0];
		let baseFrame: PixelFrame | undefined;
		const decodeStarted = performance.now();
		try {
			baseFrame = await codec.decode({
				media: texture.sourceMedia as SemanticImageMedia,
				bytes: texture.bytes,
				width: texture.width,
				height: texture.height
			}, options.isCancelled);
			checkCancelled();
			validatePixelFrame(baseFrame, texture.width, texture.height, firstMaterialIndex, textureIndex);
			diagnostics.baseDecodeCount += 1;
			diagnostics.maxLiveBaseFrames = Math.max(diagnostics.maxLiveBaseFrames, 1);
			diagnostics.baseDecodes.push({ textureIndex, sourceMedia: texture.sourceMedia, width: texture.width, height: texture.height, decodeMs: Math.max(0, performance.now() - decodeStarted) });

			for (const materialIndex of materialIndices) {
				checkCancelled();
				const material = materials[materialIndex];
				const semantic = material.semantic!;
				const colorizeStarted = performance.now();
				const transformed = await colorizeRgba(baseFrame.data, texture.width, texture.height, semantic.colorizeMode as 1 | 2, semantic.deltas, { isCancelled: options.isCancelled });
				checkCancelled();
				diagnostics.maxLiveOutputFrames = Math.max(diagnostics.maxLiveOutputFrames, 1);
				diagnostics.maxMemoEntries = Math.max(diagnostics.maxMemoEntries, transformed.maxMemoEntries);
				const colorizeMs = Math.max(0, performance.now() - colorizeStarted);
				const hashStarted = performance.now();
				let actualRgbaSha256: string;
				try {
					actualRgbaSha256 = bytesToHex(await digestSha256(new Uint8Array(transformed.data.buffer, transformed.data.byteOffset, transformed.data.byteLength)));
				} catch (error) {
					checkCancelled();
					throw new Error(`BOMC semantic material ${materialIndex} texture ${textureIndex}: RGBA hash failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				checkCancelled();
				const hashMs = Math.max(0, performance.now() - hashStarted);
				if (actualRgbaSha256 !== semantic.outputRgbaSha256) {
					throw new Error(`BOMC semantic material ${materialIndex} texture ${textureIndex}: RGBA hash mismatch; expected ${semantic.outputRgbaSha256}, actual ${actualRgbaSha256}.`);
				}
				const assetPath = `bomc/textures/semantic-${actualRgbaSha256}-${texture.width}x${texture.height}.png`;
				let encodeMs = 0;
				let reusedAsset = true;
				if (!assetByPath.has(assetPath)) {
					reusedAsset = false;
					const encodeStarted = performance.now();
					let bytes: Uint8Array;
					try {
						bytes = await codec.encodePng({ width: texture.width, height: texture.height, data: transformed.data }, options.isCancelled);
					} catch (error) {
						checkCancelled();
						throw new Error(`BOMC semantic material ${materialIndex} texture ${textureIndex}: PNG encode failed: ${error instanceof Error ? error.message : String(error)}`);
					}
					checkCancelled();
					if (!bytes.byteLength) throw new Error(`BOMC semantic material ${materialIndex} texture ${textureIndex}: PNG encoder returned an empty asset.`);
					encodeMs = Math.max(0, performance.now() - encodeStarted);
					const asset = { path: assetPath, bytes };
					assetByPath.set(assetPath, asset);
					generatedAssets.push(asset);
					diagnostics.generatedPngBytes += bytes.byteLength;
				}
				pendingPaths.set(materialIndex, assetPath);
				const proof = {
					materialIndex, textureIndex, mode: semantic.colorizeMode as 1 | 2,
					expectedRgbaSha256: semantic.outputRgbaSha256, actualRgbaSha256,
					assetPath, colorizeMs, hashMs, encodeMs, reusedAsset
				};
				diagnostics.materialProofs.push(proof);
				diagnostics.verifiedCount += 1;
				try {
					options.onMaterialVerified?.({ ...proof });
				} catch (error) {
					throw new Error(`BOMC semantic material proof observer failed for material ${materialIndex}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		} catch (error) {
			checkCancelled();
			if (error instanceof Error && error.message.startsWith('BOMC semantic material')) throw error;
			throw new Error(`BOMC semantic material ${firstMaterialIndex} texture ${textureIndex}: image decode failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			baseFrame = undefined;
		}
	}

	checkCancelled();
	for (const [materialIndex, assetPath] of pendingPaths) materials[materialIndex].renderTextureAsset = assetPath;
	diagnostics.generatedAssetCount = generatedAssets.length;
	diagnostics.totalMs = Math.max(0, performance.now() - started);
	return { assets: generatedAssets, diagnostics };
}

function validatePixelFrame(frame: PixelFrame, width: number, height: number, materialIndex: number, textureIndex: number) {
	const pixels = width * height;
	const expectedByteLength = pixels * 4;
	if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(expectedByteLength) || frame.width !== width || frame.height !== height ||
		frame.data.byteLength !== expectedByteLength) {
		throw new Error(`BOMC semantic material ${materialIndex} texture ${textureIndex}: decoded dimensions or RGBA byte length mismatch.`);
	}
}

function decodeCoverage(bytes: Uint8Array): BomcCoverage {
	if (bytes.byteLength !== 24) throw new Error('BOMC invalid: coverage section byte count.');
	const reader = new BomcBinaryReader(bytes);
	const coverage = {
		eligible: reader.readUint32(), analytical: reader.readUint32(), visualRetained: reader.readUint32(),
		fallback: reader.readUint32(), excluded: reader.readUint32(), unaccounted: reader.readUint32()
	};
	if (coverage.eligible !== coverage.analytical + coverage.fallback + coverage.excluded + coverage.unaccounted) throw new Error('BOMC invalid: coverage disposition does not sum to eligible geometry.');
	if (coverage.unaccounted !== 0) throw new Error('BOMC invalid: unaccounted geometry is nonzero.');
	return coverage;
}

export function decodeFallback(bytes: Uint8Array, strings: string[]) {
	const reader = new BomcBinaryReader(bytes);
	if (reader.readUint8() !== 1) throw new Error('BOMC invalid: fallback section version.');
	const instanceWidth = reader.readUint8(), textureWidth = reader.readUint8(), stringWidth = reader.readUint8();
	const count = reader.readCount('fallback');
	const indexWidths = [instanceWidth, textureWidth, stringWidth];
	if (indexWidths.some((width) => ![1, 2, 4].includes(width))) throw new Error('BOMC invalid: adaptive-width code.');
	const minimumRowBytes = instanceWidth + textureWidth + stringWidth + 21;
	if (count * minimumRowBytes !== reader.remaining) throw new Error('BOMC invalid: fallback section byte count.');
	const instances = reader.readIndices(instanceWidth, count, true).values;
	const kinds = reader.readBytes(count);
	const x = Array.from({ length: count }, () => reader.readFloat32());
	const y = Array.from({ length: count }, () => reader.readFloat32());
	const z = Array.from({ length: count }, () => reader.readFloat32());
	const widths = Array.from({ length: count }, () => reader.readFloat32());
	const heights = Array.from({ length: count }, () => reader.readFloat32());
	const textures = reader.readIndices(textureWidth, count).values;
	const texts = reader.readIndices(stringWidth, count).values;
	reader.finish('fallback section');
	return Array.from({ length: count }, (_, index): FallbackRecord => ({
		instance: instances[index], kind: kinds[index], position: [x[index], y[index], z[index]], width: widths[index], height: heights[index],
		texture: textures[index], text: texts[index] === MISSING ? undefined : stringAt(strings, texts[index])
	}));
}

function validateReferences(
	model: ModelRecord, materials: MaterialRecord[], tags: TagRecord[], meshes: MeshRecord[], definitions: DefinitionRecord[],
	instances: InstanceRecord[], transforms: Float64Array, textures: TextureRecord[], coverage: BomcCoverage, fallback: FallbackRecord[]
) {
	const actual = {
		materials: materials.length, tags: tags.length, meshes: meshes.length, faces: meshes.reduce((sum, mesh) => sum + mesh.faces.length, 0),
		definitions: definitions.length, instances: instances.length, transforms: transforms.length / 16, textures: textures.length,
		// Every source edge remains in the prepared contract so the renderer can
		// apply hidden/soft/smooth policy without losing producer semantics.
		edges: meshes.reduce((sum, mesh) => sum + mesh.row.edgeCount, 0)
	};
	for (const key of Object.keys(model.counts) as Array<keyof typeof actual>) if (model.counts[key] !== actual[key]) throw new Error(`BOMC invalid: ${key} count mismatch.`);
	assertIndex(model.rootNode, instances.length, 'root node');
	if (instances[model.rootNode].kind !== 1) throw new Error('BOMC invalid: root node is not root kind.');
	for (let index = 0; index < meshes.length; index += 1) assertIndex(meshes[index].row.definition, definitions.length, `mesh ${index} definition`);
	let faceIndex = 0;
	let edgeIndex = 0;
	for (const mesh of meshes) {
		for (const face of mesh.faces) {
			if (face.tag !== MISSING) assertIndex(face.tag, tags.length, `face ${faceIndex} tag`);
			faceIndex += 1;
		}
		for (const edge of mesh.edges) {
			if (edge.tag !== MISSING) assertIndex(edge.tag, tags.length, `edge ${edgeIndex} tag`);
			edgeIndex += 1;
		}
	}
	for (let index = 0; index < definitions.length; index += 1) if (definitions[index].mesh !== MISSING) assertIndex(definitions[index].mesh, meshes.length, `definition ${index} mesh`);
	for (let index = 0; index < instances.length; index += 1) {
		const instance = instances[index];
		if (instance.kind >= 1 && instance.kind <= 3) assertIndex(instance.definition, definitions.length, `instance ${index} definition`);
		assertIndex(instance.transform, transforms.length / 16, `instance ${index} transform`);
		if (instance.material !== MISSING) assertIndex(instance.material, materials.length, `instance ${index} material`);
		if (instance.tag !== MISSING) assertIndex(instance.tag, tags.length, `instance ${index} tag`);
	}
	for (let index = 0; index < materials.length; index += 1) {
		if (materials[index].texture === MISSING) continue;
		if (isActiveSemanticMaterial(materials[index]) && materials[index].texture >= textures.length) {
			throw new Error(`BOMC invalid: semantic material ${index} texture ${materials[index].texture} is outside the source texture table.`);
		}
		assertIndex(materials[index].texture, textures.length, `material ${index} texture`);
	}
	for (let index = 0; index < fallback.length; index += 1) {
		assertIndex(fallback[index].instance, instances.length, `fallback ${index} instance`);
		if (fallback[index].texture !== MISSING) assertIndex(fallback[index].texture, textures.length, `fallback ${index} texture`);
		if (instances[fallback[index].instance].kind !== fallback[index].kind) throw new Error(`BOMC invalid: fallback ${index} kind does not match instance.`);
	}
	void coverage;
}

function collectOccurrences(rootIndex: number, definitions: DefinitionRecord[], instances: InstanceRecord[], transforms: Float64Array, tags: TagRecord[], hasScenes = false) {
	const result = new Map<number, Occurrence[]>();
	const instanceOccurrences = new Map<number, Matrix4[]>();
	const parentIndices: number[] = [];
	const instanceIndices: number[] = [];
	const tagIndices: number[] = [];
	const definitionStack: number[] = [];
	const activeDefinitions = new Set<number>();
	const transformAt = (index: number) => new Matrix4().fromArray(transforms, index * 16);
	type InheritedFrame = {
		parent: Matrix4;
		inheritedMaterial: number;
		parentHierarchyIndex: number;
		inheritedRoleCode: number;
		inheritedLabel?: string;
	};
	type TraversalFrame = (
		{ kind: 'visit'; instanceIndex: number } & InheritedFrame
	) | (
		{ kind: 'visit-children'; children: number[]; childIndex: number } & InheritedFrame
	) | { kind: 'leave-definition'; definitionIndex: number };
	const frames: TraversalFrame[] = [{
		kind: 'visit', instanceIndex: rootIndex, parent: new Matrix4(), inheritedMaterial: MISSING,
		parentHierarchyIndex: -1, inheritedRoleCode: 0
	}];
	while (frames.length > 0) {
		const frame = frames.pop()!;
		if (frame.kind === 'leave-definition') {
			definitionStack.pop();
			activeDefinitions.delete(frame.definitionIndex);
			continue;
		}
		if (frame.kind === 'visit-children') {
			if (frame.childIndex + 1 < frame.children.length) frames.push({ ...frame, childIndex: frame.childIndex + 1 });
			frames.push({
				kind: 'visit', instanceIndex: frame.children[frame.childIndex], parent: frame.parent,
				inheritedMaterial: frame.inheritedMaterial, parentHierarchyIndex: frame.parentHierarchyIndex,
				inheritedRoleCode: frame.inheritedRoleCode, inheritedLabel: frame.inheritedLabel
			});
			continue;
		}
		const { instanceIndex, parent, inheritedMaterial, parentHierarchyIndex, inheritedRoleCode, inheritedLabel } = frame;
		const instance = instances[instanceIndex];
		if (!instance) continue;
		if (!hasScenes && (!instance.visible || (instance.tag !== MISSING && tags[instance.tag]?.visible === false))) continue;
		const hierarchyIndex = parentIndices.length;
		parentIndices.push(parentHierarchyIndex);
		instanceIndices.push(instanceIndex);
		tagIndices.push(instance.tag !== MISSING ? instance.tag : -1);
		const worldSource = parent.clone().multiply(transformAt(instance.transform));
		const worldThree = AXIS_TO_THREE.clone().multiply(worldSource).multiply(AXIS_FROM_THREE);
		const knownOccurrences = instanceOccurrences.get(instanceIndex);
		const instanceSequence = knownOccurrences?.length || 0;
		if (knownOccurrences) knownOccurrences.push(worldThree);
		else instanceOccurrences.set(instanceIndex, [worldThree]);
		const material = instance.material !== MISSING ? instance.material : inheritedMaterial;
		const inferredRole = instance.roleCode || semanticRoleFromText(`${instance.label || ''} ${instance.name || ''}`);
		const semanticRoleCode = inferredRole || inheritedRoleCode;
		const semanticLabel = instance.label || inheritedLabel;
		if (instance.definition === MISSING) continue;
		const definitionIndex = instance.definition;
		if (activeDefinitions.has(definitionIndex)) throw new Error(`BOMC invalid: recursive definition cycle ${[...definitionStack, definitionIndex].join(' -> ')}.`);
		const definition = definitions[definitionIndex];
		if (!definition) throw new Error(`BOMC invalid: missing definition ${definitionIndex}.`);
		if (definition.mesh !== MISSING) {
			const list = result.get(definition.mesh) || [];
			list.push({
				matrix: worldThree,
				material,
				handle: `bomc:runtime:instance:${instanceIndex}:${instanceSequence}`,
				definitionId: definitions[definitionIndex]?.name ? `def:${definitions[definitionIndex].name}` : `def:${definitionIndex}`,
				instanceId: instance.name || instance.label ? (String(instance.name || instance.label).startsWith('node:') ? String(instance.name || instance.label) : `node:${instance.name || instance.label}`) : `node:${instanceIndex}`,
				hierarchyDepth: definitionStack.length,
				instanceIndex,
				tagIndex: instance.tag,
				hierarchyIndex,
				semanticRoleCode,
				semanticLabel
			});
			result.set(definition.mesh, list);
		}
		definitionStack.push(definitionIndex);
		activeDefinitions.add(definitionIndex);
		frames.push({ kind: 'leave-definition', definitionIndex });
		if (definition.nodes.length > 0) {
			frames.push({
				kind: 'visit-children', children: definition.nodes, childIndex: 0, parent: worldSource,
				inheritedMaterial: material, parentHierarchyIndex: hierarchyIndex,
				inheritedRoleCode: semanticRoleCode, inheritedLabel: semanticLabel
			});
		}
	}
	return {
		meshes: result,
		instances: instanceOccurrences,
		hierarchy: {
			parentIndices: Int32Array.from(parentIndices),
			instanceIndices: Uint32Array.from(instanceIndices),
			tagIndices: Int32Array.from(tagIndices)
		}
	};
}

function buildRuntimeEdgeAdjacencies(meshes: MeshRecord[], occurrences: Map<number, Occurrence[]>) {
	const adjacencyByMesh = new Map<number, Uint32Array[]>();
	for (let meshIndex = 0; meshIndex < meshes.length; meshIndex += 1) {
		if (!meshes[meshIndex].edges.length || !(occurrences.get(meshIndex)?.length)) continue;
		adjacencyByMesh.set(meshIndex, buildMeshEdgeAdjacency(meshes[meshIndex], meshes[meshIndex].edges));
	}
	return adjacencyByMesh;
}

export function createSceneVisibilityIndex(scenes: SceneProfile[]): SceneVisibilityIndex {
	const byScene = new WeakMap<SceneProfile, SceneVisibilitySets>();
	const bySignature = new Map<string, SceneProfile>();
	let hasFaceOverrides = false;
	for (const scene of scenes) {
		const visibility = scene.visibility;
		const hiddenFaceIndices = new Set(visibility.hiddenFaceIndices || []);
		const visibleFaceIndices = new Set(visibility.visibleFaceIndices || []);
		const hiddenEdgeIndices = new Set(visibility.hiddenEdgeIndices || []);
		const visibleEdgeIndices = new Set(visibility.visibleEdgeIndices || []);
		byScene.set(scene, {
			hiddenFaceIndices, visibleFaceIndices, hiddenEdgeIndices, visibleEdgeIndices,
			hiddenTagIndices: new Set(visibility.hiddenTagIndices || []),
			visibleTagIndices: new Set(visibility.visibleTagIndices || [])
		});
		if (hiddenFaceIndices.size > 0 || visibleFaceIndices.size > 0) hasFaceOverrides = true;
		// The legacy edge code resolves a duplicate signature to the first scene.
		if (!bySignature.has(scene.visibilitySignature)) bySignature.set(scene.visibilitySignature, scene);
	}
	return { byScene, bySignature, hasFaceOverrides };
}

function primitiveVisibleForScene(
	kind: 'face' | 'edge',
	index: number,
	baseHidden: boolean,
	tagIndex: number,
	tags: TagRecord[],
	scene: SceneProfile,
	sceneVisibilityIndex: SceneVisibilityIndex
) {
	const indexedVisibility = sceneVisibilityIndex.byScene.get(scene);
	if (!indexedVisibility) throw new Error('BOMC invalid: scene visibility index is missing.');
	const hidden = kind === 'face' ? indexedVisibility.hiddenFaceIndices : indexedVisibility.hiddenEdgeIndices;
	const shown = kind === 'face' ? indexedVisibility.visibleFaceIndices : indexedVisibility.visibleEdgeIndices;
	let primitiveVisible = !baseHidden;
	if (hidden.has(index)) primitiveVisible = false;
	else if (shown.has(index)) primitiveVisible = true;
	if (!primitiveVisible) return false;
	if (tagIndex !== MISSING) {
		let tagVisible = tags[tagIndex]?.visible !== false;
		if (scene.storesTagVisibility) {
			if (indexedVisibility.hiddenTagIndices.has(tagIndex)) tagVisible = false;
			else if (indexedVisibility.visibleTagIndices.has(tagIndex)) tagVisible = true;
		}
		if (!tagVisible) return false;
	}
	return true;
}

function primitiveSceneSignatures(
	kind: 'face' | 'edge',
	index: number,
	baseHidden: boolean,
	tagIndex: number,
	tags: TagRecord[],
	scenes: SceneProfile[],
	sceneVisibilityIndex: SceneVisibilityIndex
): string[] | undefined | null {
	if (!scenes.length) return baseHidden || (tagIndex !== MISSING && tags[tagIndex]?.visible === false) ? null : undefined;
	if (kind === 'edge' && scenes.every((scene) => scene.source === 'legacy-synthetic')) {
		return tagIndex !== MISSING && tags[tagIndex]?.visible === false ? null : undefined;
	}
	const visible: string[] = [];
	for (const scene of scenes) {
		if (!primitiveVisibleForScene(kind, index, baseHidden, tagIndex, tags, scene, sceneVisibilityIndex)) continue;
		visible.push(scene.visibilitySignature);
	}
	if (!visible.length) return null;
	return visible.length === scenes.length ? undefined : visible;
}

function buildRuntime(
	meshes: MeshRecord[], definitions: DefinitionRecord[], occurrences: Map<number, Occurrence[]>, instanceOccurrences: Map<number, Matrix4[]>, materials: MaterialRecord[],
	fallback: FallbackRecord[], instances: InstanceRecord[], textures: TextureRecord[], fallbackMaterialBase: number, tags: TagRecord[], scenes: SceneProfile[],
	sceneVisibilityIndex: SceneVisibilityIndex, edgeAdjacencyByMesh: Map<number, Uint32Array[]>
) {
	const started = performance.now();
	const preparedMeshes: PreparedRuntimeGeometryMesh[] = [];
	const preparedGroups: PreparedRuntimeGeometryGroup[] = [];
	const preparedEdgeSets: PreparedRuntimeEdgeSet[] = [];
	const analyticalFaces: FaceRecord[] = [];
	const worldBox = new Box3();
	let typedArrayBytes = 0;
	let totalTriangles = 0;
	let triangulationMs = 0;
	const textureMetricByMaterial = new Map<number, BomcTextureMetric>();
	const coplanarDiagnostics = import.meta.env.DEV ? createQuantizedCoplanarDiagnostics() : undefined;
	const visibilityMetrics = collectBomcVisibilityMetrics(meshes, tags, occurrences);
	const triangleOwnership = {
		sourceFaces: visibilityMetrics.totalFaces,
		renderVisibleFaces: visibilityMetrics.renderedFaces,
		frontOnlyFaces: 0,
		frontBackFaces: 0,
		explicitBackMaterialFaces: 0,
		backUvOnlyFaces: 0,
		frontDefinitionTriangles: 0,
		backDefinitionTriangles: 0,
		frontOccurrenceTriangles: 0,
		backOccurrenceTriangles: 0,
		hiddenFaces: visibilityMetrics.hiddenFlagFaces,
		invisibleTagFaces: visibilityMetrics.facesOnInvisibleTags,
		opaqueOccurrenceTriangles: 0,
		transparentOccurrenceTriangles: 0,
		fallbackTriangles: 0,
		renderGroups: 0
	};
	const backfaceLeak = {
		explicitFrontMaterialFaces: 0,
		explicitBackMaterialFaces: 0,
		frontOnlyAppearanceFaces: 0,
		frontOnlyFacesRenderedFrontSide: 0,
		frontOnlyFacesRenderedDoubleSide: 0,
		pickedBackFacingFrontMaterialTriangles: 0,
		estimatedBackfaceMaterialLeakTriangles: 0,
		byMaterial: [] as Array<{ materialIndex: number; materialName?: string; faceCount: number; triangleCount: number }>,
		byDefinition: [] as Array<{ definitionIndex: number; faceCount: number; triangleCount: number }>,
		bySourceMesh: [] as Array<{ sourceMeshIndex: number; faceCount: number; triangleCount: number }>,
		byPartKey: [] as Array<{ partKey: PartKey; faceCount: number; triangleCount: number }>
	};

	for (let meshIndex = 0; meshIndex < meshes.length; meshIndex += 1) {
		const mesh = meshes[meshIndex];
		const meshOccurrences = occurrences.get(meshIndex) || [];
		if (!meshOccurrences.length) continue;
		const renderStarted = performance.now();
		const renderPositions: number[] = [];
		const renderNormals: number[] = [];
		const renderUvs: number[] = [];
		const renderVertexByKey = new Map<string, number>();
		type Partition = {
			key: PartKey;
			side: 'front' | 'back' | 'double';
			explicitMaterial: number;
			indices: number[];
			faceCount: number;
			minU: number | null;
			maxU: number | null;
			minV: number | null;
			maxV: number | null;
			triangleVertices: number;
			triangleVerticesWithValidUv: number;
			triangleVerticesMissingUv: number;
			sourceFaceIndicesByTriangle: number[];
			sourceTagIndicesByTriangle: number[];
			sourceFrontMaterialIndicesByTriangle: number[];
			sourceBackMaterialIndicesByTriangle: number[];
			sourceFaceAreasByTriangle: number[];
			visibleSceneSignatures?: string[];
		};
		const partitions = new Map<string, Partition>();
		const vertexFor = (face: FaceRow, side: 'front' | 'back', sourceIndex: number, uv?: [number, number]) => {
			// Face identity is deliberately absent. Adjacent faces share a render
			// vertex whenever side, UV and normal/hard-shading attributes agree.
			const normalSign = side === 'front' ? 1 : -1;
			const key = bomcRenderVertexKey(sourceIndex, side, uv, face.normal);
			const known = renderVertexByKey.get(key);
			if (known !== undefined) return known;
			const index = renderPositions.length / 3;
			renderPositions.push(mesh.positions[sourceIndex * 3], mesh.positions[sourceIndex * 3 + 2], -mesh.positions[sourceIndex * 3 + 1]);
			renderNormals.push(face.normal[0] * normalSign, face.normal[2] * normalSign, -face.normal[1] * normalSign);
			renderUvs.push(uv?.[0] ?? 0, uv?.[1] ?? 0);
			renderVertexByKey.set(key, index);
			return index;
		};
		for (const face of mesh.faces) {
			const visibleSceneSignatures = primitiveSceneSignatures('face', face.globalIndex, (face.flags & 1) !== 0, face.tag, tags, scenes, sceneVisibilityIndex);
			if (visibleSceneSignatures === null || face.triangles.length === 0) continue;
			const faceTriangles = face.triangles.length / 3;
			if (coplanarDiagnostics) {
				const pointAt = (sourceIndex: number) => ({
					x: mesh.positions[sourceIndex * 3],
					y: mesh.positions[sourceIndex * 3 + 1],
					z: mesh.positions[sourceIndex * 3 + 2]
				});
				for (let index = 0; index < face.triangles.length; index += 3) {
					coplanarDiagnostics.add(
						pointAt(face.triangles[index]),
						pointAt(face.triangles[index + 1]),
						pointAt(face.triangles[index + 2]),
						face.frontMaterial
					);
				}
			}
			triangleOwnership.frontDefinitionTriangles += faceTriangles;
			triangleOwnership.frontOccurrenceTriangles += faceTriangles * meshOccurrences.length;
			if (face.frontMaterial !== MISSING) backfaceLeak.explicitFrontMaterialFaces += 1;
			if (face.backMaterial !== MISSING || face.backUvs) {
				triangleOwnership.frontBackFaces += 1;
				triangleOwnership.backDefinitionTriangles += faceTriangles;
				triangleOwnership.backOccurrenceTriangles += faceTriangles * meshOccurrences.length;
				if (face.backMaterial !== MISSING) triangleOwnership.explicitBackMaterialFaces += 1;
				else triangleOwnership.backUvOnlyFaces += 1;
			} else triangleOwnership.frontOnlyFaces += 1;
			const partKey = partKeyForSurface(face.surfaceCode, face.roleCode);
			const passes = resolveFaceRenderPasses({
				frontMaterial: face.frontMaterial !== MISSING ? face.frontMaterial : undefined,
				backMaterial: face.backMaterial !== MISSING ? face.backMaterial : undefined,
				frontUv: Boolean(face.frontUvs),
				backUv: Boolean(face.backUvs),
				neutralBackFallback: true
			});
			const frontOnlyAppearance = face.frontMaterial !== MISSING && face.backMaterial === MISSING && !face.backUvs;
			if (frontOnlyAppearance) {
				backfaceLeak.frontOnlyAppearanceFaces += 1;
				if (passes[0].renderSide === 'front') backfaceLeak.frontOnlyFacesRenderedFrontSide += 1;
				else {
					backfaceLeak.frontOnlyFacesRenderedDoubleSide += 1;
					backfaceLeak.estimatedBackfaceMaterialLeakTriangles += faceTriangles * meshOccurrences.length;
				}
			}
			if (face.backMaterial !== MISSING) backfaceLeak.explicitBackMaterialFaces += 1;
			const sides = passes.map((pass) => ({
				side: pass.sourceSide,
				material: pass.materialIndex ?? MISSING,
				uv: pass.uvSide === 'front' ? face.frontUvs : pass.uvSide === 'back' ? face.backUvs : undefined,
				renderSide: pass.renderSide
			}));
			for (const side of sides) {
				const primitiveSignature = visibleSceneSignatures?.join('|') || '*';
				const partitionId = `${partKey}:${side.renderSide}:${side.material}:${primitiveSignature}`;
				let partition = partitions.get(partitionId);
				if (!partition) {
					partition = {
						key: partKey, side: side.renderSide, explicitMaterial: side.material, indices: [], faceCount: 0,
						minU: null, maxU: null, minV: null, maxV: null,
						triangleVertices: 0, triangleVerticesWithValidUv: 0, triangleVerticesMissingUv: 0,
						sourceFaceIndicesByTriangle: [], sourceTagIndicesByTriangle: [],
						sourceFrontMaterialIndicesByTriangle: [], sourceBackMaterialIndicesByTriangle: [], sourceFaceAreasByTriangle: [],
						visibleSceneSignatures
					};
					partitions.set(partitionId, partition);
				}
				const uvInspection = inspectBomcFaceUvs([face.outer, ...face.holes], face.triangles, side.uv);
				const uvByVertex = uvInspection.uvByVertex;
				partition.minU = minNullable(partition.minU, uvInspection.minU);
				partition.maxU = maxNullable(partition.maxU, uvInspection.maxU);
				partition.minV = minNullable(partition.minV, uvInspection.minV);
				partition.maxV = maxNullable(partition.maxV, uvInspection.maxV);
				partition.triangleVertices += uvInspection.triangleVertices;
				partition.triangleVerticesWithValidUv += uvInspection.triangleVerticesWithValidUv;
				partition.triangleVerticesMissingUv += uvInspection.triangleVerticesMissingUv;
				const sourceFaceArea = triangleAreaSum(face.triangles, mesh.positions);
				for (let index = 0; index < face.triangles.length; index += 3) {
					const a = vertexFor(face, side.side, face.triangles[index], uvByVertex.get(face.triangles[index]));
					const b = vertexFor(face, side.side, face.triangles[index + 1], uvByVertex.get(face.triangles[index + 1]));
					const c = vertexFor(face, side.side, face.triangles[index + 2], uvByVertex.get(face.triangles[index + 2]));
					partition.indices.push(a, b, c);
					partition.sourceFaceIndicesByTriangle.push(face.globalIndex);
					partition.sourceTagIndicesByTriangle.push(face.tag);
					partition.sourceFrontMaterialIndicesByTriangle.push(face.frontMaterial);
					partition.sourceBackMaterialIndicesByTriangle.push(face.backMaterial);
					partition.sourceFaceAreasByTriangle.push(sourceFaceArea);
				}
				partition.faceCount += 1;
			}
		}
		triangulationMs += performance.now() - renderStarted;

		const positions = new Float32Array(renderPositions);
		const normals = new Float32Array(renderNormals);
		const uvs = new Float32Array(renderUvs);
		const sourceMeshIndex = preparedMeshes.length;
		preparedMeshes.push({ sourceMeshIndex, positions, normals, uvs });
		typedArrayBytes += positions.byteLength + normals.byteLength + uvs.byteLength;
		const localBox = boxFromPositions(positions);
		const sphere = localBox.getBoundingSphere(new Sphere());
		for (const partition of partitions.values()) {
			const byMaterial = new Map<number, Occurrence[]>();
			for (const occurrence of meshOccurrences) {
				const effective = resolveBomcEffectiveMaterial(partition.explicitMaterial, occurrence.material);
				const bucket = byMaterial.get(effective) || [];
				bucket.push(occurrence);
				byMaterial.set(effective, bucket);
			}
			for (const [materialIndex, materialOccurrences] of byMaterial) {
				const matrices = new Float32Array(materialOccurrences.length * 16);
				const groupWorldBox = new Box3();
				for (let index = 0; index < materialOccurrences.length; index += 1) {
					materialOccurrences[index].matrix.toArray(matrices, index * 16);
					const instanceBox = localBox.clone().applyMatrix4(materialOccurrences[index].matrix);
					groupWorldBox.union(instanceBox);
					worldBox.union(instanceBox);
				}
				const indices = positions.length / 3 <= 0xffff ? new Uint16Array(partition.indices) : new Uint32Array(partition.indices);
				const material = materialIndex !== MISSING ? materials[materialIndex] : undefined;
				if (material && material.texture !== MISSING) {
					const occurrenceCount = materialOccurrences.length;
					const metric = textureMetricByMaterial.get(materialIndex) || {
						materialIndex,
						materialId: `bomc-material-${materialIndex}`,
						materialName: material.displayName || material.name,
						textureAsset: materialTexturePath(material, textures) || `missing-texture-${material.texture}`,
						textureWidthM: material.textureWidthM,
						textureHeightM: material.textureHeightM,
						minU: null, maxU: null, minV: null, maxV: null,
						uvSpanU: 0, uvSpanV: 0,
						facesUsingMaterial: 0,
						triangleVertices: 0,
						triangleVerticesWithValidUv: 0,
						triangleVerticesMissingUv: 0
					} satisfies BomcTextureMetric;
					metric.minU = minNullable(metric.minU, partition.minU);
					metric.maxU = maxNullable(metric.maxU, partition.maxU);
					metric.minV = minNullable(metric.minV, partition.minV);
					metric.maxV = maxNullable(metric.maxV, partition.maxV);
					metric.uvSpanU = metric.minU === null || metric.maxU === null ? 0 : metric.maxU - metric.minU;
					metric.uvSpanV = metric.minV === null || metric.maxV === null ? 0 : metric.maxV - metric.minV;
					metric.facesUsingMaterial += partition.faceCount * occurrenceCount;
					metric.triangleVertices += partition.triangleVertices * occurrenceCount;
					metric.triangleVerticesWithValidUv += partition.triangleVerticesWithValidUv * occurrenceCount;
					metric.triangleVerticesMissingUv += partition.triangleVerticesMissingUv * occurrenceCount;
					textureMetricByMaterial.set(materialIndex, metric);
				}
				const group: PreparedRuntimeGeometryGroup = {
					key: partition.key, sourceMeshIndex, definitionIndex: mesh.row.definition, faceCount: partition.faceCount,
					visibleSceneSignatures: partition.visibleSceneSignatures,
					indices, matrices, occurrenceHandles: materialOccurrences.map((occurrence) => occurrence.handle),
					occurrenceDefinitionIds: materialOccurrences.map((occurrence) => occurrence.definitionId),
					occurrenceInstanceIds: materialOccurrences.map((occurrence) => occurrence.instanceId),
					occurrenceHierarchyDepths: Uint16Array.from(materialOccurrences.map((occurrence) => occurrence.hierarchyDepth)),
					occurrenceInstanceIndices: Uint32Array.from(materialOccurrences.map((occurrence) => occurrence.instanceIndex ?? 0)),
					occurrenceTagIndices: Int32Array.from(materialOccurrences.map((occurrence) => occurrence.tagIndex ?? -1)),
					occurrenceHierarchyIndices: Uint32Array.from(materialOccurrences.map((occurrence) => occurrence.hierarchyIndex)),
					materialIndex: material ? materialIndex : undefined,
					materialId: material ? `bomc-material-${materialIndex}` : undefined,
					materialName: material?.displayName || material?.name,
					baseColorRgba: material ? material.rgba.map((value) => value / 255) as [number, number, number, number] : undefined,
					opacity: material?.opacity, colorSpace: 'srgb',
					textureAsset: materialTexturePath(material, textures),
					textureWidthM: material?.textureWidthM,
					textureHeightM: material?.textureHeightM,
					renderSide: partition.side, isBackFace: partition.side === 'back',
					sourceFaceIndicesByTriangle: Uint32Array.from(partition.sourceFaceIndicesByTriangle),
					sourceTagIndicesByTriangle: import.meta.env.DEV ? Uint32Array.from(partition.sourceTagIndicesByTriangle) : undefined,
					sourceFrontMaterialIndicesByTriangle: import.meta.env.DEV ? Uint32Array.from(partition.sourceFrontMaterialIndicesByTriangle) : undefined,
					sourceBackMaterialIndicesByTriangle: import.meta.env.DEV ? Uint32Array.from(partition.sourceBackMaterialIndicesByTriangle) : undefined,
					sourceFaceAreasByTriangle: Float32Array.from(partition.sourceFaceAreasByTriangle),
					localBounds: { min: tuple(localBox.min), max: tuple(localBox.max), sphereCenter: tuple(sphere.center), sphereRadius: sphere.radius },
					worldBounds: { min: tuple(groupWorldBox.min), max: tuple(groupWorldBox.max) },
					baseY: groupWorldBox.min.y, topY: groupWorldBox.max.y
				};
				preparedGroups.push(group);
				typedArrayBytes += indices.byteLength + matrices.byteLength;
				const occurrenceTriangles = indices.length / 3 * materialOccurrences.length;
				totalTriangles += occurrenceTriangles;
				if ((material?.opacity ?? 1) < 1) triangleOwnership.transparentOccurrenceTriangles += occurrenceTriangles;
				else triangleOwnership.opaqueOccurrenceTriangles += occurrenceTriangles;
			}
		}

		const edgeSets = buildPreparedEdgeSets(mesh, sourceMeshIndex, meshOccurrences, localBox, tags, scenes, sceneVisibilityIndex, edgeAdjacencyByMesh.get(meshIndex) || []);
		for (const edgeSet of edgeSets) {
			preparedEdgeSets.push(edgeSet);
			typedArrayBytes += edgeSet.positions.byteLength + edgeSet.flags.byteLength + edgeSet.matrices.byteLength;
		}

		for (const occurrence of meshOccurrences) appendAnalyticalFaces(analyticalFaces, mesh, occurrence, materials);
	}

	appendFallbackGeometry(preparedMeshes, preparedGroups, fallback, instances, instanceOccurrences, textures, fallbackMaterialBase, worldBox, (bytes) => { typedArrayBytes += bytes; });
	triangleOwnership.fallbackTriangles = preparedGroups
		.filter((group) => group.definitionIndex === -1)
		.reduce((sum, group) => sum + group.indices.length / 3 * group.matrices.length / 16, 0);
	triangleOwnership.renderGroups = preparedGroups.length;
	const bounds = boundsFromBox(worldBox);
	const scene: PreparedRuntimeGeometryScene = {
		meshes: preparedMeshes, groups: preparedGroups, edgeSets: preparedEdgeSets,
		totalUnits: preparedGroups.reduce((sum, group) => sum + group.matrices.length / 16, 0),
		totalTriangles, totalVertices: preparedMeshes.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0)
	};
	void definitions;
	void started;
	return {
		scene, faces: analyticalFaces, bounds, typedArrayBytes, triangulationMs,
		textureMetrics: [...textureMetricByMaterial.values()], visibilityMetrics, triangleOwnership, backfaceLeak,
		coplanar: coplanarDiagnostics?.finish()
	};
}

function triangleAreaSum(indices: ArrayLike<number>, positions: ArrayLike<number>) {
	let area = 0;
	const a = new Vector3(); const b = new Vector3(); const c = new Vector3();
	for (let index = 0; index < indices.length; index += 3) {
		a.fromArray(positions, indices[index] * 3);
		b.fromArray(positions, indices[index + 1] * 3);
		c.fromArray(positions, indices[index + 2] * 3);
		area += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
	}
	return area;
}

function materialTexturePath(material: MaterialRecord | undefined, textures: readonly TextureRecord[]) {
	if (!material || material.texture === MISSING) return undefined;
	return material.renderTextureAsset ?? textures[material.texture]?.assetPath;
}

function collectBomcVisibilityMetrics(meshes: MeshRecord[], tags: TagRecord[], occurrences: Map<number, Occurrence[]>) {
	const byTag = new Map<string, { tagIndex: number; tagName?: string; faceCount: number; triangleCount: number }>();
	const byMaterial = new Map<number, { materialIndex: number; faceCount: number; triangleCount: number }>();
	const byMesh = new Map<number, { meshIndex: number; definitionIndex: number; faceCount: number; triangleCount: number }>();
	let totalFaces = 0;
	let hiddenFlagFaces = 0;
	let taggedFaces = 0;
	let facesOnInvisibleTags = 0;
	let renderedFaces = 0;
	let renderedFacesOnInvisibleTags = 0;
	for (let meshIndex = 0; meshIndex < meshes.length; meshIndex += 1) {
		const mesh = meshes[meshIndex];
		const occurs = (occurrences.get(meshIndex)?.length || 0) > 0;
		for (const face of mesh.faces) {
			totalFaces += 1;
			if ((face.flags & 1) !== 0) hiddenFlagFaces += 1;
			if (face.tag !== MISSING) taggedFaces += 1;
			const invisibleTag = face.tag !== MISSING && tags[face.tag]?.visible === false;
			if (invisibleTag) {
				facesOnInvisibleTags += 1;
				const triangles = face.triangles.length / 3;
				const tagKey = String(face.tag);
				const tagRow = byTag.get(tagKey) || { tagIndex: face.tag, tagName: tags[face.tag]?.name, faceCount: 0, triangleCount: 0 };
				tagRow.faceCount += 1; tagRow.triangleCount += triangles; byTag.set(tagKey, tagRow);
				const materialRow = byMaterial.get(face.frontMaterial) || { materialIndex: face.frontMaterial, faceCount: 0, triangleCount: 0 };
				materialRow.faceCount += 1; materialRow.triangleCount += triangles; byMaterial.set(face.frontMaterial, materialRow);
				const meshRow = byMesh.get(meshIndex) || { meshIndex, definitionIndex: mesh.row.definition, faceCount: 0, triangleCount: 0 };
				meshRow.faceCount += 1; meshRow.triangleCount += triangles; byMesh.set(meshIndex, meshRow);
			}
			if (occurs && face.triangles.length > 0 && isBomcFaceRenderVisible(face, tags)) renderedFaces += 1;
			if (occurs && face.triangles.length > 0 && invisibleTag && (face.flags & 1) === 0) renderedFacesOnInvisibleTags += 1;
		}
	}
	return {
		totalFaces, hiddenFlagFaces, taggedFaces, facesOnInvisibleTags, renderedFaces,
		// This is the legacy renderer's would-have-rendered count. The corrected
		// renderer always excludes these faces from its partitions.
		renderedFacesOnInvisibleTags: 0,
		legacyRenderedFacesOnInvisibleTags: renderedFacesOnInvisibleTags,
		invisibleFacesByTag: [...byTag.values()].sort((a, b) => b.faceCount - a.faceCount),
		invisibleFacesByMaterial: [...byMaterial.values()].sort((a, b) => b.faceCount - a.faceCount),
		invisibleFacesByMesh: [...byMesh.values()].sort((a, b) => b.faceCount - a.faceCount)
	};
}

function appendAnalyticalFaces(target: FaceRecord[], mesh: MeshRecord, occurrence: Occurrence, materials: MaterialRecord[]) {
	const excludedBranchRoles = new Set([14, 15, 16, 17, 18]);
	if (excludedBranchRoles.has(occurrence.semanticRoleCode)) return;
	for (const face of mesh.faces) {
		const effectiveRoleCode = face.roleCode || occurrence.semanticRoleCode;
		const effectiveSurfaceCode = face.surfaceCode || semanticRoleToSurface(effectiveRoleCode);
		// Preserve only explicit BOMC stair-role evidence from structure surface 15
		// for Rooms opening review; this does not admit code 15 to general analysis.
		const isStairReviewEvidence = effectiveRoleCode === 13 && effectiveSurfaceCode === 15;
		if (excludedBranchRoles.has(effectiveRoleCode) || (!isAnalyticalSurface(effectiveSurfaceCode) && !isStairReviewEvidence) || face.outer.length < 3 || (face.flags & 1) !== 0) continue;
		const points = [...face.outer].map((index) => transformSourcePoint(mesh.positions, index, occurrence.matrix));
		const holes = face.holes.map((hole) => [...hole].map((index) => transformSourcePoint(mesh.positions, index, occurrence.matrix)));
		// Match the room foundation's established evidence floor (0.35 m²). Tiny
		// trim/tile polygons stay in the visual TypedArrays but do not become a
		// second giant analytical object graph.
		const areaM2 = polygonArea(points) - holes.reduce((sum, hole) => sum + polygonArea(hole), 0);
		if (!Number.isFinite(areaM2) || areaM2 < 0.35) continue;
		const bounds = points.concat(...holes).reduce((box, point) => box.expandByPoint(new Vector3(point.x, point.y, point.z)), new Box3());
		const sourceNormal = new Vector3(face.normal[0], face.normal[2], -face.normal[1]);
		const normal = sourceNormal.transformDirection(occurrence.matrix);
		const surface = surfaceKeyForCode(effectiveSurfaceCode, normal);
		const materialIndex = face.frontMaterial !== MISSING ? face.frontMaterial : occurrence.material;
		const material = materialIndex !== MISSING ? materials[materialIndex] : undefined;
		const id = `bomc:runtime:surface:${face.globalIndex}:${occurrence.handle}`;
		target.push({
			id, name: face.label || occurrence.semanticLabel || `BOMC surface ${face.globalIndex + 1}`, path: id, surface, partKey: partKeyForSurface(effectiveSurfaceCode, effectiveRoleCode),
			areaM2: Math.max(areaM2, 0), vertices: points, holes,
			color: material ? `#${material.rgba.slice(0, 3).map((value) => value.toString(16).padStart(2, '0')).join('')}` : undefined,
			textureName: material?.texture !== MISSING ? `bomc-texture-${material?.texture}` : undefined,
			center: pointFromVector(bounds.getCenter(new Vector3())), bounds: boundsFromBox(bounds), normal: pointFromVector(normal),
			dominantOrientation: dominantOrientation(normal), semanticLabel: face.label || occurrence.semanticLabel, semanticRole: semanticRoleName(effectiveRoleCode),
			semanticSource: face.roleCode ? 'bomc-production-column' : occurrence.semanticRoleCode ? 'bomc-occurrence-ancestry' : 'geometry-only', classificationPolicy: 'bomc_surface_enum', sourceCount: 1,
			sourceFaceIndex: face.globalIndex,
				instanceIndex: occurrence.instanceIndex,
				tagIndex: face.tag !== MISSING ? face.tag : occurrence.tagIndex,
				occurrenceHierarchyIndex: occurrence.hierarchyIndex
		});
	}
}

function appendFallbackGeometry(
	meshes: PreparedRuntimeGeometryMesh[], groups: PreparedRuntimeGeometryGroup[], fallback: FallbackRecord[], instances: InstanceRecord[],
	instanceOccurrences: Map<number, Matrix4[]>, textures: TextureRecord[], fallbackMaterialBase: number, worldBox: Box3, addBytes: (bytes: number) => void
) {
	for (let index = 0; index < fallback.length; index += 1) {
		const record = fallback[index];
		const worlds = instanceOccurrences.get(record.instance) || [];
		if (!worlds.length || !instances[record.instance]?.visible) continue;
		const local = new Matrix4().makeTranslation(record.position[0], record.position[2], -record.position[1]).scale(new Vector3(Math.max(record.width, 0.001), Math.max(record.height, 0.001), 1));
		const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
		const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
		const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
		const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
		const matrixBuffer = new Float32Array(worlds.length * 16);
		const localBox = boxFromPositions(positions);
		const groupBox = new Box3();
		for (let occurrence = 0; occurrence < worlds.length; occurrence += 1) {
			const matrix = worlds[occurrence].clone().multiply(local);
			matrix.toArray(matrixBuffer, occurrence * 16);
			groupBox.union(localBox.clone().applyMatrix4(matrix));
		}
		worldBox.union(groupBox);
		const sphere = localBox.getBoundingSphere(new Sphere());
		const sourceMeshIndex = meshes.length;
		meshes.push({ sourceMeshIndex, positions, normals, uvs });
		groups.push({
			key: 'other', sourceMeshIndex, definitionIndex: -1, faceCount: 1, indices, matrices: matrixBuffer,
			occurrenceHandles: worlds.map((_, occurrence) => `bomc:runtime:fallback:${index}:${occurrence}`), materialId: `bomc-fallback-${index}`,
			materialIndex: fallbackMaterialBase + index,
			materialName: record.kind === 4 ? 'BOMC image fallback' : 'BOMC text fallback',
			textureAsset: record.texture !== MISSING ? textures[record.texture]?.assetPath : undefined,
			textureWidthM: Math.max(record.width, 0.001), textureHeightM: Math.max(record.height, 0.001),
			fallbackText: record.kind === 5 ? record.text : undefined,
			renderSide: 'double', localBounds: { min: tuple(localBox.min), max: tuple(localBox.max), sphereCenter: tuple(sphere.center), sphereRadius: sphere.radius },
			worldBounds: { min: tuple(groupBox.min), max: tuple(groupBox.max) }, baseY: groupBox.min.y, topY: groupBox.max.y
		});
		addBytes(positions.byteLength + normals.byteLength + uvs.byteLength + indices.byteLength + matrixBuffer.byteLength);
	}
}

export function inspectBomcFaceUvs(
	loops: readonly Uint32Array[],
	triangles: Uint32Array,
	values?: Float32Array
) {
	const uvByVertex = new Map<number, [number, number]>();
	let minU = Infinity;
	let maxU = -Infinity;
	let minV = Infinity;
	let maxV = -Infinity;
	let cursor = 0;
	for (const loop of loops) {
		for (const vertex of loop) {
			const u = values?.[cursor];
			const v = values?.[cursor + 1];
			if (u !== undefined && v !== undefined && Number.isFinite(u) && Number.isFinite(v)) {
				if (!uvByVertex.has(vertex)) uvByVertex.set(vertex, [u, v]);
				minU = Math.min(minU, u);
				maxU = Math.max(maxU, u);
				minV = Math.min(minV, v);
				maxV = Math.max(maxV, v);
			}
			cursor += 2;
		}
	}
	let triangleVerticesWithValidUv = 0;
	for (const vertex of triangles) if (uvByVertex.has(vertex)) triangleVerticesWithValidUv += 1;
	return {
		uvByVertex,
		minU: Number.isFinite(minU) ? minU : null,
		maxU: Number.isFinite(maxU) ? maxU : null,
		minV: Number.isFinite(minV) ? minV : null,
		maxV: Number.isFinite(maxV) ? maxV : null,
		uvSpan: {
			u: Number.isFinite(minU) ? maxU - minU : 0,
			v: Number.isFinite(minV) ? maxV - minV : 0
		},
		triangleVertices: triangles.length,
		triangleVerticesWithValidUv,
		triangleVerticesMissingUv: triangles.length - triangleVerticesWithValidUv
	};
}

function minNullable(left: number | null, right: number | null) {
	return left === null ? right : right === null ? left : Math.min(left, right);
}

function maxNullable(left: number | null, right: number | null) {
	return left === null ? right : right === null ? left : Math.max(left, right);
}

function buildEdgePositions(mesh: MeshRecord, edges: EdgeRecord[]) {
	const result = new Float32Array(edges.length * 6);
	for (let index = 0; index < edges.length; index += 1) {
		const { first, second } = edges[index];
		result.set([mesh.positions[first * 3], mesh.positions[first * 3 + 2], -mesh.positions[first * 3 + 1]], index * 6);
		result.set([mesh.positions[second * 3], mesh.positions[second * 3 + 2], -mesh.positions[second * 3 + 1]], index * 6 + 3);
	}
	return result;
}

export function buildMeshEdgeAdjacency(mesh: MeshRecord, visibleEdges: EdgeRecord[]): Uint32Array[] {
	const edgeToFaces = new Map<string, Set<number>>();
	for (const face of mesh.faces) {
		const faceIdx = face.globalIndex;
		const outer = face.outer;
		for (let i = 0; i < outer.length; i += 1) {
			const u = outer[i];
			const v = outer[(i + 1) % outer.length];
			const k = u < v ? `${u},${v}` : `${v},${u}`;
			let faces = edgeToFaces.get(k);
			if (!faces) { faces = new Set<number>(); edgeToFaces.set(k, faces); }
			faces.add(faceIdx);
		}
		for (const hole of face.holes) {
			for (let i = 0; i < hole.length; i += 1) {
				const u = hole[i];
				const v = hole[(i + 1) % hole.length];
				const k = u < v ? `${u},${v}` : `${v},${u}`;
				let faces = edgeToFaces.get(k);
				if (!faces) { faces = new Set<number>(); edgeToFaces.set(k, faces); }
				faces.add(faceIdx);
			}
		}
		for (let i = 0; i < face.triangles.length; i += 3) {
			const t0 = face.triangles[i], t1 = face.triangles[i + 1], t2 = face.triangles[i + 2];
			const pairs: [number, number][] = [[t0, t1], [t1, t2], [t2, t0]];
			for (const [u, v] of pairs) {
				const k = u < v ? `${u},${v}` : `${v},${u}`;
				let faces = edgeToFaces.get(k);
				if (!faces) { faces = new Set<number>(); edgeToFaces.set(k, faces); }
				faces.add(faceIdx);
			}
		}
	}

	return visibleEdges.map((edge) => {
		const k = edge.first < edge.second ? `${edge.first},${edge.second}` : `${edge.second},${edge.first}`;
		const faces = edgeToFaces.get(k);
		return faces && faces.size > 0 ? Uint32Array.from(faces) : new Uint32Array(0);
	});
}

function buildPreparedEdgeSets(
	mesh: MeshRecord,
	sourceMeshIndex: number,
	occurrences: Occurrence[],
	localBox: Box3,
	tags: TagRecord[],
	scenes: SceneProfile[],
	sceneVisibilityIndex: SceneVisibilityIndex,
	adjacency: Uint32Array[]
): PreparedRuntimeEdgeSet[] {
	if (!mesh.edges.length || !occurrences.length) return [];
	const faceByGlobalIndex = new Map(mesh.faces.map((face) => [face.globalIndex, face]));
	const hasFaceSceneOverrides = sceneVisibilityIndex.hasFaceOverrides;
	const bySignature = new Map<string, { edges: EdgeRecord[]; incident: Uint32Array[]; signatures?: string[] }>();
	for (let index = 0; index < mesh.edges.length; index += 1) {
		const edge = mesh.edges[index];
		let signatures = primitiveSceneSignatures('edge', edge.globalIndex, (edge.flags & 1) !== 0, edge.tag, tags, scenes, sceneVisibilityIndex);
		if (signatures !== null && hasFaceSceneOverrides && scenes.length && adjacency[index]?.length) {
			const allowed = (signatures || scenes.map((scene) => scene.visibilitySignature)).filter((signature) => {
				const scene = sceneVisibilityIndex.bySignature.get(signature);
				return Boolean(scene) && adjacency[index].some((faceIndex) => {
					const face = faceByGlobalIndex.get(faceIndex);
					return face ? primitiveVisibleForScene('face', face.globalIndex, (face.flags & 1) !== 0, face.tag, tags, scene!, sceneVisibilityIndex) : true;
				});
			});
			signatures = allowed.length === scenes.length ? undefined : allowed.length ? allowed : null;
		}
		if (signatures === null) continue;
		const signatureKey = signatures?.join('|') || '*';
		const bucket = bySignature.get(signatureKey) || { edges: [], incident: [], signatures };
		bucket.edges.push(edge);
		bucket.incident.push(adjacency[index]);
		bySignature.set(signatureKey, bucket);
	}
	if (!bySignature.size) return [];
	const matrices = new Float32Array(occurrences.length * 16);
	const worldBox = new Box3();
	for (let index = 0; index < occurrences.length; index += 1) {
		occurrences[index].matrix.toArray(matrices, index * 16);
		worldBox.union(localBox.clone().applyMatrix4(occurrences[index].matrix));
	}
	const partCounts = new Map<PartKey, number>();
	for (const face of mesh.faces) {
		const key = partKeyForSurface(face.surfaceCode, face.roleCode);
		partCounts.set(key, (partCounts.get(key) || 0) + 1);
	}
	const key = [...partCounts].sort((left, right) => right[1] - left[1])[0]?.[0] || 'other';
	return [...bySignature.values()].map((bucket) => ({
		sourceMeshIndex,
		definitionIndex: mesh.row.definition,
		key,
		positions: buildEdgePositions(mesh, bucket.edges),
		flags: Uint8Array.from(bucket.edges, (edge) => edge.flags),
		matrices,
		occurrenceHandles: occurrences.map((occurrence) => occurrence.handle),
		occurrenceDefinitionIds: occurrences.map((occurrence) => occurrence.definitionId),
		occurrenceInstanceIds: occurrences.map((occurrence) => occurrence.instanceId),
		occurrenceHierarchyDepths: Uint16Array.from(occurrences.map((occurrence) => occurrence.hierarchyDepth)),
		occurrenceInstanceIndices: Uint32Array.from(occurrences.map((occ) => occ.instanceIndex ?? 0)),
		occurrenceTagIndices: Int32Array.from(occurrences.map((occ) => occ.tagIndex ?? -1)),
		occurrenceHierarchyIndices: Uint32Array.from(occurrences.map((occ) => occ.hierarchyIndex)),
		worldBounds: { min: tuple(worldBox.min), max: tuple(worldBox.max) },
		incidentFaceIndicesByEdge: bucket.incident,
		visibleSceneSignatures: bucket.signatures
	}));
}

function transformSourcePoint(positions: Float32Array, index: number, matrix: Matrix4): Point3 {
	return pointFromVector(new Vector3(positions[index * 3], positions[index * 3 + 2], -positions[index * 3 + 1]).applyMatrix4(matrix));
}

function polygonArea(points: Point3[]) {
	if (points.length < 3) return 0;
	let x = 0, y = 0, z = 0;
	for (let index = 0; index < points.length; index += 1) {
		const current = points[index], next = points[(index + 1) % points.length];
		x += (current.y - next.y) * (current.z + next.z);
		y += (current.z - next.z) * (current.x + next.x);
		z += (current.x - next.x) * (current.y + next.y);
	}
	return Math.hypot(x, y, z) * 0.5;
}

function surfaceKeyForCode(code: number, normal: Vector3): SurfaceKey {
	if (code === 1 || code === 12) {
		if (Math.abs(normal.x) >= Math.abs(normal.z)) return normal.x >= 0 ? 'wall_x_pos' : 'wall_x_neg';
		return normal.z >= 0 ? 'wall_y_pos' : 'wall_y_neg';
	}
	if (code === 2 || code === 11) return 'floor';
	if (code === 3) return 'ceiling';
	if (code >= 4 && code <= 6) return 'roof_slope';
	if (code === 8) return 'window';
	if (code === 9) return 'door';
	if (code === 13 || code === 14) return 'structure';
	return 'other';
}

function partKeyForSurface(code: number, role: number): PartKey {
	const effective = code || semanticRoleToSurface(role);
	if (effective === 1 || effective === 12) return 'walls';
	if (effective === 2 || effective === 11) return 'floor';
	if (effective === 3) return 'ceiling';
	if (effective >= 4 && effective <= 6) return 'roof';
	if (effective === 7) return 'openings';
	if (effective === 8) return 'windows';
	if (effective === 9) return 'doors';
	if (effective === 13 || effective === 14 || effective === 10 || effective === 15) return 'structure';
	return 'other';
}

function semanticRoleToSurface(role: number) {
	return role >= 1 && role <= 4 ? role : role === 5 ? 7 : role === 6 ? 8 : role === 7 ? 9 : role === 9 ? 11 : role === 10 ? 12 : role === 11 ? 13 : role === 12 ? 14 : role === 13 ? 15 : role === 19 || role === 20 ? 13 : role === 21 || role === 22 || role === 23 ? 1 : 0;
}

function semanticRoleName(role: number) {
	return ['unknown', 'wall', 'floor', 'ceiling', 'roof', 'opening', 'window', 'door', 'railing', 'room', 'facade', 'column', 'beam', 'stair', 'furniture', 'fixture', 'site', 'landscape', 'equipment', 'foundation', 'structure', 'room_boundary', 'exterior_wall', 'interior_wall'][role] || 'unknown';
}

function semanticRoleFromText(value: string) {
	const text = value.toLowerCase();
	if (/(?:furniture|mebel|perabot|kursi|meja|sofa|bed|kasur|lemari|cabinet)/.test(text)) return 14;
	if (/(?:fixture|sanitary|toilet|sink|wastafel)/.test(text)) return 15;
	if (/(?:halaman|site|landscape|taman|paving|jalan)/.test(text)) return 16;
	if (/(?:equipment|mep|plumbing|electrical)/.test(text)) return 18;
	if (/(?:dinding|wall)/.test(text)) return 1;
	if (/(?:plat|lantai|floor)/.test(text)) return 2;
	if (/(?:ceiling|plafon)/.test(text)) return 3;
	if (/(?:atap|roof)/.test(text)) return 4;
	if (/(?:pintu|door)/.test(text)) return 7;
	if (/(?:jendela|window)/.test(text)) return 6;
	if (/(?:kusen|opening)/.test(text)) return 5;
	return 0;
}

function isAnalyticalSurface(code: number) {
	// Code 0 is still part of BOMC's analytical FACES table. It means semantic
	// type unknown, not visual-only; the geometry foundation may classify a
	// meaningful large vertical polygon as a wall from strict geometry evidence.
	return code === 0 || code >= 1 && code <= 9 || code === 11;
}

function dominantOrientation(normal: Vector3): FaceRecord['dominantOrientation'] {
	if (Math.abs(normal.y) > 0.999) return 'horizontal';
	if (Math.abs(normal.y) < 0.01) return 'vertical';
	return 'sloped';
}

function decodeVaruintColumn(bytes: Uint8Array, count: number, label: string) {
	assertBomcCount(count, label);
	if (count > bytes.byteLength) throw new Error(`BOMC invalid: ${label} count exceeds encoded payload.`);
	assertBomcArrayBytes(count, 1, 4, label);
	const reader = new BomcBinaryReader(bytes);
	const result = Array.from({ length: count }, () => reader.readVaruint());
	reader.finish(label);
	return result;
}

function sliceBlock(section: Uint8Array, offset: number, length: number, label: string) {
	if (!Number.isSafeInteger(offset + length) || offset < 0 || length < 0 || offset + length > section.byteLength) throw new Error(`BOMC invalid: ${label} block outside section.`);
	return section.subarray(offset, offset + length);
}

function stringAt(strings: string[], index: number) {
	assertIndex(index, strings.length, 'string');
	return strings[index];
}

function assertIndex(index: number, count: number, label: string) {
	if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`BOMC invalid: ${label} reference.`);
}

function bytesToHex(bytes: Uint8Array) { return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join(''); }

function boxFromPositions(positions: Float32Array) {
	const box = new Box3();
	for (let index = 0; index < positions.length; index += 3) box.expandByPoint(new Vector3(positions[index], positions[index + 1], positions[index + 2]));
	if (box.isEmpty()) box.set(new Vector3(), new Vector3());
	return box;
}

function tuple(vector: Vector3): [number, number, number] { return [vector.x, vector.y, vector.z]; }
function pointFromVector(vector: Vector3): Point3 { return { x: vector.x, y: vector.y, z: vector.z }; }
function boundsFromBox(box: Box3): Bounds3 {
	if (box.isEmpty()) box.set(new Vector3(), new Vector3());
	const size = box.getSize(new Vector3());
	const center = box.getCenter(new Vector3());
	return { min: pointFromVector(box.min), max: pointFromVector(box.max), size: pointFromVector(size), center: pointFromVector(center) };
}

export function resolveBomcSceneNodeVisibility(
	instances: readonly { readonly visible: boolean }[],
	visibleNodeIndices: readonly number[],
	hiddenNodeIndices: readonly number[]
) {
	const visible = new Set(visibleNodeIndices);
	const hidden = new Set(hiddenNodeIndices);
	for (let index = 0; index < instances.length; index += 1) {
		if (instances[index]?.visible === false && !visible.has(index)) hidden.add(index);
	}
	return [...hidden].sort((left, right) => left - right);
}

export function decodeScenes(
	bytes: Uint8Array,
	strings: string[],
	tags: TagRecord[],
	instances: InstanceRecord[],
	faceCount?: number,
	edgeCount?: number,
	clipPlanes: ClipPlaneRecord[] = []
): SceneProfile[] {
	if (!bytes || bytes.byteLength === 0) return [];
	const reader = new BomcBinaryReader(bytes);
	const version = reader.readUint8();
	if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) {
		throw new Error(`BOMC invalid: scenes section version ${version} unsupported.`);
	}
	const tagCount = reader.readUint8();
	const scenesCount = reader.readCount('scene');

	const tagBitsetBytes = Math.ceil(tagCount / 8);
	const scenes: SceneProfile[] = [];
	const seenIds = new Set<string>();
	let clipPlaneIndicesById: Map<string, number[]> | undefined;
	const ensureClipPlaneIndex = () => {
		if (clipPlaneIndicesById) return clipPlaneIndicesById;
		clipPlaneIndicesById = new Map<string, number[]>();
		const add = (id: string, index: number) => {
			const rows = clipPlaneIndicesById!.get(id) || [];
			rows.push(index);
			clipPlaneIndicesById!.set(id, rows);
		};
		for (let index = 0; index < clipPlanes.length; index += 1) {
			const plane = clipPlanes[index];
			add(plane.stableId, index);
			if (plane.sourcePersistentId !== plane.stableId) add(plane.sourcePersistentId, index);
		}
		return clipPlaneIndicesById;
	};
	const resolveActiveClipPlanes = (indices: number[], ids: string[]) => {
		if (indices.length > 0) return indices.map((index) => clipPlanes[index]).filter(Boolean);
		if (ids.length === 0) return [];
		const index = ensureClipPlaneIndex();
		const uniqueIds = new Set(ids);
		const matches = new Set<number>();
		for (const id of uniqueIds) for (const clipIndex of index.get(id) || []) matches.add(clipIndex);
		return [...matches].sort((left, right) => left - right).map((clipIndex) => clipPlanes[clipIndex]);
	};

	const tagStableIds: string[] = [];
	if (version >= 3) {
		for (let i = 0; i < tagCount; i++) {
			const strIdx = reader.readVaruint();
			assertIndex(strIdx, strings.length, `tag ${i} stable id`);
			tagStableIds.push(strings[strIdx] || '');
		}
	}
	const readOverrideCount = (label: string, minimumBytesPerEntry = 1) => {
		const count = reader.readVaruintCount(label);
		reader.assertRemainingCount(count, minimumBytesPerEntry, label);
		return count;
	};
	const minimumSceneCountFields = 2 + (version >= 2 ? 2 : 0) + (version >= 4 ? 10 : 0) + (version >= 5 ? 1 : 0);
	reader.assertRemainingCount(scenesCount, 68 + tagBitsetBytes + minimumSceneCountFields, 'scene');

	for (let s = 0; s < scenesCount; s++) {
		const idIdx = reader.readUint32();
		const nameIdx = reader.readUint32();
		const descIdx = reader.readUint32();
		const sigIdx = reader.readUint32();
		const flags = reader.readUint32();

		assertIndex(idIdx, strings.length, `scene ${s} id`);
		assertIndex(nameIdx, strings.length, `scene ${s} name`);
		assertIndex(descIdx, strings.length, `scene ${s} description`);
		assertIndex(sigIdx, strings.length, `scene ${s} visibility signature`);

		const eyeX = reader.readFloat32();
		const eyeY = reader.readFloat32();
		const eyeZ = reader.readFloat32();

		const tgtX = reader.readFloat32();
		const tgtY = reader.readFloat32();
		const tgtZ = reader.readFloat32();

		const upX = reader.readFloat32();
		const upY = reader.readFloat32();
		const upZ = reader.readFloat32();

		const fovOrHeight = reader.readFloat32();
		const aspectRatio = reader.readFloat32();
		const transTime = reader.readFloat32();

		if (![eyeX, eyeY, eyeZ, tgtX, tgtY, tgtZ, upX, upY, upZ, fovOrHeight, aspectRatio, transTime].every(Number.isFinite)) {
			throw new Error(`BOMC invalid: scene ${s} camera values must be finite numbers.`);
		}

		const isActive = (flags & 0x01) !== 0;
		const useCamera = (flags & 0x02) !== 0;
		const storesTags = (flags & 0x04) !== 0;
		const storesObjects = (flags & 0x08) !== 0;
		const storesGeometry = (flags & 0x10) !== 0;
		const storesSections = (flags & 0x20) !== 0;
		const isPersp = (flags & 0x40) !== 0;
		const fovIsHeight = (flags & 0x80) !== 0;
		const is2d = (flags & 0x100) !== 0;
		const sectionCutsDisplayed = (flags & 0x200) !== 0;
		const sectionPlanesDisplayed = (flags & 0x400) !== 0;

		const bitset = reader.readBytes(tagBitsetBytes);
		const visibleTagIndices: number[] = [];
		const hiddenTagIndices: number[] = [];
		for (let i = 0; i < tagCount; i++) {
			const byteIdx = Math.floor(i / 8);
			const bitIdx = i % 8;
			if ((bitset[byteIdx] & (1 << bitIdx)) !== 0) {
				visibleTagIndices.push(i);
			} else {
				hiddenTagIndices.push(i);
			}
		}

		const hiddenNodesCount = readOverrideCount(`scene ${s} hidden node`, version >= 3 ? 2 : 1);
		const hiddenNodeIndices: number[] = [];
		const resolvedHiddenNodeIds: string[] = [];
		for (let i = 0; i < hiddenNodesCount; i++) {
			const nodeIdx = reader.readVaruint();
			assertIndex(nodeIdx, instances.length, `scene ${s} hidden node`);
			hiddenNodeIndices.push(nodeIdx);
			if (version >= 3) {
				const strIdx = reader.readVaruint();
				assertIndex(strIdx, strings.length, `scene ${s} hidden node stable id`);
				resolvedHiddenNodeIds.push(strings[strIdx] || '');
			}
		}

		const visibleNodesCount = readOverrideCount(`scene ${s} visible node`, version >= 3 ? 2 : 1);
		const visibleNodeIndices: number[] = [];
		const resolvedVisibleNodeIds: string[] = [];
		for (let i = 0; i < visibleNodesCount; i++) {
			const nodeIdx = reader.readVaruint();
			assertIndex(nodeIdx, instances.length, `scene ${s} visible node`);
			visibleNodeIndices.push(nodeIdx);
			if (version >= 3) {
				const strIdx = reader.readVaruint();
				assertIndex(strIdx, strings.length, `scene ${s} visible node stable id`);
				resolvedVisibleNodeIds.push(strings[strIdx] || '');
			}
		}

		const unresolvedHiddenOverrides: string[] = [];
		const unresolvedVisibleOverrides: string[] = [];

		if (version >= 2) {
			const unresolvedHiddenCount = readOverrideCount(`scene ${s} unresolved hidden node`);
			for (let i = 0; i < unresolvedHiddenCount; i++) {
				const strIdx = reader.readVaruint();
				assertIndex(strIdx, strings.length, `scene ${s} unresolved hidden node`);
				unresolvedHiddenOverrides.push(strings[strIdx] || '');
			}

			const unresolvedVisibleCount = readOverrideCount(`scene ${s} unresolved visible node`);
			for (let i = 0; i < unresolvedVisibleCount; i++) {
				const strIdx = reader.readVaruint();
				assertIndex(strIdx, strings.length, `scene ${s} unresolved visible node`);
				unresolvedVisibleOverrides.push(strings[strIdx] || '');
			}
		}

		const primitive = {
			hiddenFaceIndices: [] as number[], visibleFaceIndices: [] as number[],
			hiddenEdgeIndices: [] as number[], visibleEdgeIndices: [] as number[],
			hiddenFaceOverrides: [] as string[], visibleFaceOverrides: [] as string[],
			hiddenEdgeOverrides: [] as string[], visibleEdgeOverrides: [] as string[],
			unresolvedHiddenFaceOverrides: [] as string[], unresolvedVisibleFaceOverrides: [] as string[],
			unresolvedHiddenEdgeOverrides: [] as string[], unresolvedVisibleEdgeOverrides: [] as string[],
			unresolvedPrimitiveOverrides: [] as string[], activeSectionPlaneIds: [] as string[]
		};
		const activeClipPlaneIndices: number[] = [];
		if (version >= 4) {
			const readPrimitiveRows = (indices: number[], ids: string[], unresolved: string[], limit: number | undefined, label: string) => {
				const count = readOverrideCount(`scene ${s} ${label}`, 2);
				for (let i = 0; i < count; i++) {
					const index = reader.readVaruint();
					if (limit !== undefined) assertIndex(index, limit, `scene ${s} ${label}`);
					const strIdx = reader.readVaruint();
					assertIndex(strIdx, strings.length, `scene ${s} ${label} stable id`);
					indices.push(index);
					ids.push(strings[strIdx] || '');
				}
				const unresolvedCount = readOverrideCount(`scene ${s} unresolved ${label}`);
				for (let i = 0; i < unresolvedCount; i++) {
					const strIdx = reader.readVaruint();
					assertIndex(strIdx, strings.length, `scene ${s} unresolved ${label}`);
					const id = strings[strIdx] || '';
					ids.push(id);
					unresolved.push(id);
				}
			};
			readPrimitiveRows(primitive.hiddenFaceIndices, primitive.hiddenFaceOverrides, primitive.unresolvedHiddenFaceOverrides, faceCount, 'hidden face');
			readPrimitiveRows(primitive.visibleFaceIndices, primitive.visibleFaceOverrides, primitive.unresolvedVisibleFaceOverrides, faceCount, 'visible face');
			readPrimitiveRows(primitive.hiddenEdgeIndices, primitive.hiddenEdgeOverrides, primitive.unresolvedHiddenEdgeOverrides, edgeCount, 'hidden edge');
			readPrimitiveRows(primitive.visibleEdgeIndices, primitive.visibleEdgeOverrides, primitive.unresolvedVisibleEdgeOverrides, edgeCount, 'visible edge');
			const unresolvedPrimitiveCount = readOverrideCount(`scene ${s} unresolved primitive`);
			for (let i = 0; i < unresolvedPrimitiveCount; i++) {
				const strIdx = reader.readVaruint();
				assertIndex(strIdx, strings.length, `scene ${s} unresolved primitive`);
				primitive.unresolvedPrimitiveOverrides.push(strings[strIdx] || '');
			}
			const sectionCount = readOverrideCount(`scene ${s} section plane`);
			for (let i = 0; i < sectionCount; i++) {
				const strIdx = reader.readVaruint();
				assertIndex(strIdx, strings.length, `scene ${s} section plane`);
				primitive.activeSectionPlaneIds.push(strings[strIdx] || '');
			}
			if (version >= 5) {
				const clipCount = readOverrideCount(`scene ${s} active clip plane`);
				for (let i = 0; i < clipCount; i++) {
					const clipIndex = reader.readVaruint();
					assertIndex(clipIndex, clipPlanes.length, `scene ${s} active clip plane`);
					activeClipPlaneIndices.push(clipIndex);
				}
			}
		}

		const visibleTagIds = visibleTagIndices.map((i) =>
			version >= 3 && tagStableIds[i] ? tagStableIds[i] : (tags[i]?.name || `tag:${i}`)
		);
		const hiddenTagIds = hiddenTagIndices.map((i) =>
			version >= 3 && tagStableIds[i] ? tagStableIds[i] : (tags[i]?.name || `tag:${i}`)
		);
		const visibleNodeOverrides = [
			...(version >= 3
				? resolvedVisibleNodeIds
				: visibleNodeIndices.map((i) => instances[i]?.name || instances[i]?.label || `node:${i}`)),
			...unresolvedVisibleOverrides
		];
		const hiddenNodeOverrides = [
			...(version >= 3
				? resolvedHiddenNodeIds
				: hiddenNodeIndices.map((i) => instances[i]?.name || instances[i]?.label || `node:${i}`)),
			...unresolvedHiddenOverrides
		];
		const effectiveHiddenNodeIndices = resolveBomcSceneNodeVisibility(instances, visibleNodeIndices, hiddenNodeIndices);

		const stableId = strings[idIdx] || `scene:doc:${nameIdx}`;
		if (seenIds.has(stableId)) {
			throw new Error(`BOMC invalid: duplicate scene stable ID '${stableId}'.`);
		}
		seenIds.add(stableId);

		const name = strings[nameIdx] || `Scene ${s + 1}`;
		const description = strings[descIdx] || '';
		const signature = strings[sigIdx] || '';

		const { activeSectionPlaneIds, ...primitiveVisibility } = primitive;
		const hasSectionCuts = activeClipPlaneIndices.length > 0 || activeSectionPlaneIds.length > 0;
		const activeRecords = resolveActiveClipPlanes(activeClipPlaneIndices, activeSectionPlaneIds);
		const hasUnsupportedScope = activeRecords.some((plane) => Boolean(plane.ownerDefinitionId || plane.ownerInstanceId));
		scenes.push({
			id: stableId,
			name,
			description,
			isActiveAtExport: isActive,
			source: 'sketchup-page',
			sourceBinding: {
				provider: 'sketchup',
				persistentId: stableId.replace(/^scene:doc:/, '')
			},
			camera: {
				projection: isPersp ? 'perspective' : 'orthographic',
				eyeM: [eyeX, eyeY, eyeZ],
				targetM: [tgtX, tgtY, tgtZ],
				up: [upX, upY, upZ],
				fieldOfViewDegrees: isPersp ? fovOrHeight : null,
				fovIsHeight,
				orthographicHeightM: !isPersp ? fovOrHeight : null,
				aspectRatio,
				is2d
			},
			useCamera,
			transitionTimeSeconds: transTime,
			visibility: {
				visibleTagIds,
				hiddenTagIds,
				visibleNodeOverrides,
				hiddenNodeOverrides,
				visibleTagIndices,
				hiddenTagIndices,
				visibleNodeIndices,
				hiddenNodeIndices: effectiveHiddenNodeIndices,
				sourceVisibleNodeOverrideCount: visibleNodeIndices.length + unresolvedVisibleOverrides.length,
				sourceHiddenNodeOverrideCount: hiddenNodeIndices.length + unresolvedHiddenOverrides.length,
				resolvedVisibleNodeOverrideCount: visibleNodeIndices.length,
				resolvedHiddenNodeOverrideCount: hiddenNodeIndices.length,
				unresolvedVisibleNodeOverrides: unresolvedVisibleOverrides,
				unresolvedHiddenNodeOverrides: unresolvedHiddenOverrides,
				...primitiveVisibility,
				resolvedVisiblePrimitiveOverrideCount: primitive.visibleFaceIndices.length + primitive.visibleEdgeIndices.length,
				resolvedHiddenPrimitiveOverrideCount: primitive.hiddenFaceIndices.length + primitive.hiddenEdgeIndices.length,
				unresolvedPrimitiveOverrideCount: primitive.unresolvedVisibleFaceOverrides.length + primitive.unresolvedHiddenFaceOverrides.length + primitive.unresolvedVisibleEdgeOverrides.length + primitive.unresolvedHiddenEdgeOverrides.length + primitive.unresolvedPrimitiveOverrides.length
			},
			storesTagVisibility: storesTags,
			storesHiddenObjects: storesObjects,
			storesHiddenGeometry: storesGeometry,
			storesSectionPlanes: storesSections,
			sectionState: {
				activeSectionPlaneIds,
				activeClipPlaneIndices,
				sectionCutsDisplayed,
				sectionPlanesDisplayed,
				renderingSupport: version >= 5 && sectionCutsDisplayed && hasSectionCuts && storesSections && !hasUnsupportedScope ? 'full' : 'metadata-only'
			},
			visibilitySignature: signature
		});
	}

	reader.finish('scenes section');
	return scenes;
}

export function decodeClipPlanes(bytes: Uint8Array, strings: string[]): ClipPlaneRecord[] {
	if (!bytes || bytes.byteLength < 8) return [];
	const reader = new BomcBinaryReader(bytes);
	const version = reader.readUint8();
	reader.readUint8();
	reader.readUint8();
	reader.readUint8();
	if (version !== 1) throw new Error(`BOMC invalid: unsupported clip plane version ${version}.`);
	const count = reader.readCount('clip plane');
	reader.assertRemainingCount(count, 80, 'clip plane');
	const planes: ClipPlaneRecord[] = [];
	for (let i = 0; i < count; i++) {
		const stableIdx = reader.readUint32();
		const pidIdx = reader.readUint32();
		const originM: [number, number, number] = [reader.readFloat64(), reader.readFloat64(), reader.readFloat64()];
		const normal: [number, number, number] = [reader.readFloat64(), reader.readFloat64(), reader.readFloat64()];
		const planeConstant = reader.readFloat64();
		const keepSide = reader.readUint8();
		const defIdx = reader.readUint32();
		const instIdx = reader.readUint32();
		const flags = reader.readUint32();
		reader.readUint8();
		reader.readUint8();
		reader.readUint8();

		planes.push({
			index: i,
			stableId: stringAt(strings, stableIdx) || `section:${i}`,
			sourcePersistentId: stringAt(strings, pidIdx) || `${i}`,
			originM,
			normal,
			planeConstant,
			keepSide,
			ownerDefinitionId: defIdx !== MISSING ? stringAt(strings, defIdx) : null,
			ownerInstanceId: instIdx !== MISSING ? stringAt(strings, instIdx) : null,
			flags
		});
	}
	reader.finish('clip planes section');
	return planes;
}

function syntheticDefaultScenes(tags: TagRecord[], instances: InstanceRecord[]): SceneProfile[] {
	const visibleTagIndices: number[] = [];
	const hiddenTagIndices: number[] = [];
	tags.forEach((t, i) => {
		if (t.visible !== false) visibleTagIndices.push(i);
		else hiddenTagIndices.push(i);
	});

	const visibleTagIds = visibleTagIndices.map((i) => tags[i]?.name || `tag:${i}`);
	const hiddenTagIds = hiddenTagIndices.map((i) => tags[i]?.name || `tag:${i}`);

	return [
		{
			id: 'scene:doc:default',
			name: 'Default Scene',
			description: '',
			isActiveAtExport: true,
			source: 'legacy-synthetic',
			sourceBinding: {
				provider: 'bomc',
				persistentId: 'legacy_synthetic'
			},
			camera: {
				projection: 'perspective',
				eyeM: [10, -10, 10],
				targetM: [0, 0, 0],
				up: [0, 0, 1],
				fieldOfViewDegrees: 35,
				orthographicHeightM: null,
				aspectRatio: 0
			},
			useCamera: false,
			transitionTimeSeconds: 0,
			visibility: {
				visibleTagIds,
				hiddenTagIds,
				visibleNodeOverrides: [],
				hiddenNodeOverrides: [],
				visibleTagIndices,
				hiddenTagIndices,
				visibleNodeIndices: [],
				hiddenNodeIndices: []
			},
			storesTagVisibility: true,
			storesHiddenObjects: true,
			storesHiddenGeometry: false,
			storesSectionPlanes: false,
			sectionState: {
				activeSectionPlaneIds: [],
				renderingSupport: 'none'
			},
			visibilitySignature: 'legacy_synthetic_default'
		}
	];
}

function decodeEncodingContract(bytes: Uint8Array): BomcEncodingContract {
	if (bytes.byteLength !== 76) {
		throw new Error(`BOMC invalid: encoding contract size ${bytes.byteLength} != 76.`);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const schemaVersion = view.getUint16(0, true);
	if (schemaVersion !== 1) {
		throw new Error(`BOMC invalid: unsupported encoding contract schema version ${schemaVersion}.`);
	}

	const profileEnum = view.getUint8(2);
	const profileMap: Record<number, 'exact' | 'research' | 'visual'> = {
		1: 'exact',
		2: 'research',
		3: 'visual'
	};
	const profile = profileMap[profileEnum];
	if (!profile) {
		throw new Error(`BOMC invalid: unknown encoding contract profile enum ${profileEnum}.`);
	}

	const sourceSizeRequired = view.getUint8(3) === 1;
	const sourceSkpBytes = Number(view.getBigUint64(4, true));
	const preferredRatioRaw = view.getFloat64(12, true);
	const preferredRatio = preferredRatioRaw === 0 ? null : preferredRatioRaw;
	const hardRatioRaw = view.getFloat64(20, true);
	const hardRatio = hardRatioRaw === 0 ? null : hardRatioRaw;
	const targetBytes = Number(view.getBigUint64(28, true));

	const posErrorRaw = view.getFloat64(36, true);
	const positionMaxErrorM: number | 'semantic_policy' = posErrorRaw < 0 ? 'semantic_policy' : posErrorRaw;

	const normErrorRaw = view.getFloat64(44, true);
	const normalMaxErrorDeg: number | 'semantic_policy' = normErrorRaw < 0 ? 'semantic_policy' : normErrorRaw;

	const uvErrorRaw = view.getFloat64(52, true);
	const uvMaxError: number | 'semantic_policy' = uvErrorRaw < 0 ? 'semantic_policy' : uvErrorRaw;

	const transformMaxError = view.getFloat64(60, true);

	const texPolicyEnum = view.getUint8(68);
	const texPolicyMap: Record<number, 'pixel_lossless' | 'perceptual_bounded' | 'web_aggressive_bounded'> = {
		1: 'pixel_lossless',
		2: 'perceptual_bounded',
		3: 'web_aggressive_bounded'
	};
	const texturePolicy = texPolicyMap[texPolicyEnum];
	if (!texturePolicy) {
		throw new Error(`BOMC invalid: unknown encoding contract texture policy enum ${texPolicyEnum}.`);
	}

	const semanticExact = view.getUint8(69) === 1;
	const sceneExact = view.getUint8(70) === 1;
	const protectedTopologyExact = view.getUint8(71) === 1;
	const encoderRevision = view.getUint32(72, true);

	return {
		schemaVersion,
		profile,
		sourceSizeRequired,
		sourceSkpBytes,
		preferredRatio,
		hardRatio,
		targetBytes,
		positionMaxErrorM,
		normalMaxErrorDeg,
		uvMaxError,
		transformMaxError,
		texturePolicy,
		semanticExact,
		sceneExact,
		protectedTopologyExact,
		encoderRevision
	};
}
