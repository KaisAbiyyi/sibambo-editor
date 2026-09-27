import { Matrix4, Vector3 } from 'three';
import type { PartKey } from '@sibambo/contracts';
import type { PreparedRuntimeGeometryGroup, PreparedRuntimeGeometryMesh, PreparedRuntimeGeometryScene } from './prepared-types.js';

export type PreparedSurfaceBatchRow = {
	groupIndex: number;
	group: PreparedRuntimeGeometryGroup;
};

export type PreparedSurfaceBatch = {
	key: string;
	category?: PartKey;
	rows: PreparedSurfaceBatchRow[];
	instanceCount: number;
	vertexCapacity: number;
	indexCapacity: number;
};

export type BatchSemanticRow = {
	groupIndex: number;
	geometryId: number;
	key: PartKey;
	componentId?: string;
	sourceMeshIndex: number;
	definitionIndex: number;
	startInstanceId: number;
	instanceCount: number;
	occurrenceInstanceIndices?: number[] | Uint32Array;
	occurrenceTagIndices?: number[] | Int32Array;
	occurrenceHierarchyIndices?: Uint32Array;
	originalMatrices?: Float32Array;
};

export type BatchVisibilityLocation = {
	batchIndex: number;
	startInstanceId: number;
	instanceCount: number;
	groupIndex: number;
};

/** Selects the compact group-local buffers when worker compaction released the source mesh buffers. */
export function preparedRuntimeGroupBuffers(group: PreparedRuntimeGeometryGroup, source: PreparedRuntimeGeometryMesh) {
	return {
		positions: group.batchPositions ?? source.positions,
		normals: group.batchNormals ?? source.normals,
		uvs: group.batchUvs ?? source.uvs
	};
}

export class BatchVisibilityIndex {
	readonly byPartKey = new Map<PartKey, BatchVisibilityLocation[]>();
	readonly byComponentId = new Map<string, BatchVisibilityLocation[]>();
	readonly byDefinitionIndex = new Map<number, BatchVisibilityLocation[]>();
	readonly byOccurrenceHandle = new Map<string, { batchIndex: number; instanceId: number; groupIndex: number }>();

	add(batchIndex: number, row: BatchSemanticRow, handles?: readonly (string | undefined)[]) {
		const loc: BatchVisibilityLocation = {
			batchIndex,
			startInstanceId: row.startInstanceId,
			instanceCount: row.instanceCount,
			groupIndex: row.groupIndex
		};
		const keyList = this.byPartKey.get(row.key) || [];
		keyList.push(loc);
		this.byPartKey.set(row.key, keyList);

		if (row.componentId) {
			const compList = this.byComponentId.get(row.componentId) || [];
			compList.push(loc);
			this.byComponentId.set(row.componentId, compList);
		}

		const defKey = row.definitionIndex;
		const defList = this.byDefinitionIndex.get(defKey) || [];
		defList.push(loc);
		this.byDefinitionIndex.set(defKey, defList);

		if (handles) {
			for (let i = 0; i < handles.length; i += 1) {
				const handle = handles[i];
				if (handle) {
					this.byOccurrenceHandle.set(handle, {
						batchIndex,
						instanceId: row.startInstanceId + i,
						groupIndex: row.groupIndex
					});
				}
			}
		}
	}
}

export type BatchMetrics = {
	batchCount: number;
	singletonBatches: number;
	geometryEntries: {
		min: number;
		median: number;
		p95: number;
		max: number;
	};
	instanceEntries: {
		min: number;
		median: number;
		p95: number;
		max: number;
	};
	splits: {
		materials: number;
		textures: number;
		sides: number;
		opacityModes: number;
		semanticPartKeySplits: number;
		componentIdSplits: number;
	};
};

export function computeBatchMetrics(batches: readonly PreparedSurfaceBatch[]): BatchMetrics {
	const geometryCounts = batches.map((batch) => batch.rows.length).sort((a, b) => a - b);
	const instanceCounts = batches.map((batch) => batch.instanceCount).sort((a, b) => a - b);
	const materials = new Set<string>();
	const textures = new Set<string>();
	const sides = new Set<string>();
	const opacities = new Set<string>();

	for (const batch of batches) {
		for (const { group } of batch.rows) {
			const mat = group.materialIndex ?? group.materialId ?? group.materialName ?? '';
			materials.add(String(mat));
			textures.add(group.textureAsset ?? group.textureName ?? '');
			sides.add(group.renderSide ?? (group.isBackFace ? 'back' : 'double'));
			opacities.add((group.opacity ?? group.baseColorRgba?.[3] ?? 1) < 1 ? 'transparent' : 'opaque');
		}
	}

	const percentileValue = (arr: number[], p: number) => {
		if (!arr.length) return 0;
		const index = Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)));
		return arr[index];
	};

	return {
		batchCount: batches.length,
		singletonBatches: geometryCounts.filter((count) => count === 1).length,
		geometryEntries: {
			min: geometryCounts[0] ?? 0,
			median: percentileValue(geometryCounts, 0.5),
			p95: percentileValue(geometryCounts, 0.95),
			max: geometryCounts[geometryCounts.length - 1] ?? 0
		},
		instanceEntries: {
			min: instanceCounts[0] ?? 0,
			median: percentileValue(instanceCounts, 0.5),
			p95: percentileValue(instanceCounts, 0.95),
			max: instanceCounts[instanceCounts.length - 1] ?? 0
		},
		splits: {
			materials: materials.size,
			textures: textures.size,
			sides: sides.size,
			opacityModes: opacities.size,
			semanticPartKeySplits: 0,
			componentIdSplits: 0
		}
	};
}

function tupleKey(values?: readonly number[]) {
	return values ? values.join(',') : '';
}

/** Only renderer state that genuinely requires a distinct surface pass belongs here. */
export function preparedSurfaceRenderKey(group: PreparedRuntimeGeometryGroup) {
	const opacityMode = (group.opacity ?? group.baseColorRgba?.[3] ?? 1) < 1 ? 'transparent' : 'opaque';
	const materialIdentity = group.materialIndex ?? group.materialId ?? group.materialName ?? '';
	// Authored materials already carry the final source appearance. Category is
	// only a material discriminator for unpainted fallback geometry.
	const fallbackCategory = materialIdentity === '' ? group.key : '';
	return [
		fallbackCategory,
		group.fallbackText ? `fallback:${group.fallbackText}` : '',
		materialIdentity,
		group.textureAsset ?? group.textureName ?? '',
		group.renderSide ?? (group.isBackFace ? 'back' : 'double'),
		opacityMode,
		group.opacity ?? '',
		tupleKey(group.baseColorRgba),
		group.baseColor ?? '',
		group.colorSpace ?? ''
	].join('|');
}

export function planPreparedSurfaceBatches(scene: PreparedRuntimeGeometryScene): PreparedSurfaceBatch[] {
	const meshes = new Map(scene.meshes.map((mesh) => [mesh.sourceMeshIndex, mesh]));
	const batches = new Map<string, PreparedSurfaceBatch>();
	for (const [groupIndex, group] of scene.groups.entries()) {
		const source = meshes.get(group.sourceMeshIndex);
		if (!source) throw new Error(`Prepared mesh ${group.sourceMeshIndex} is missing.`);
		const key = preparedSurfaceRenderKey(group);
		const batch = batches.get(key) || {
			key,
			category: group.key,
			rows: [],
			instanceCount: 0,
			vertexCapacity: 0,
			indexCapacity: 0
		};
		batch.rows.push({ groupIndex, group });
		batch.instanceCount += group.matrices.length / 16;
		batch.vertexCapacity += (group.batchPositions || source.positions).length / 3;
		batch.indexCapacity += group.indices.length;
		batches.set(key, batch);
	}
	return [...batches.values()];
}

export function shouldCompactPreparedSurfaceGeometry(scene: PreparedRuntimeGeometryScene): boolean {
	if (scene.groups.length > 1_000) return true;
	const meshes = new Map(scene.meshes.map((m) => [m.sourceMeshIndex, m]));
	let totalMeshVertices = 0;
	for (const m of scene.meshes) totalMeshVertices += m.positions.length / 3;
	let totalUncompactedUploadVertices = 0;
	for (const g of scene.groups) {
		const m = meshes.get(g.sourceMeshIndex);
		if (m) totalUncompactedUploadVertices += m.positions.length / 3;
	}
	return totalUncompactedUploadVertices > totalMeshVertices * 1.5 && totalUncompactedUploadVertices > 10_000;
}

/** Compacts each material partition in the worker before BatchedMesh upload. */
export function compactPreparedSurfaceGeometry(
	scene: PreparedRuntimeGeometryScene,
	onProgress?: (completed: number, total: number) => void
) {
	const started = performance.now();
	const meshes = new Map(scene.meshes.map((mesh) => [mesh.sourceMeshIndex, mesh]));
	let compactVertexCount = 0;
	let typedArrayBytes = 0;
	let lastBatchProgressMs = performance.now();
	for (let groupIdx = 0; groupIdx < scene.groups.length; groupIdx += 1) {
		const group = scene.groups[groupIdx];
		const nowTime = performance.now();
		if (onProgress && (nowTime - lastBatchProgressMs >= 40 || groupIdx === scene.groups.length - 1)) {
			lastBatchProgressMs = nowTime;
			onProgress(groupIdx + 1, scene.groups.length);
		}
		const source = meshes.get(group.sourceMeshIndex);
		if (!source) throw new Error(`Prepared mesh ${group.sourceMeshIndex} is missing.`);
		const remap = new Map<number, number>();
		const oldIndices = group.indices;
		const IndexArray = oldIndices instanceof Uint32Array ? Uint32Array : Uint16Array;
		const nextIndices = new IndexArray(oldIndices.length);
		for (let index = 0; index < oldIndices.length; index += 1) {
			const sourceIndex = oldIndices[index];
			let nextIndex = remap.get(sourceIndex);
			if (nextIndex === undefined) {
				nextIndex = remap.size;
				remap.set(sourceIndex, nextIndex);
			}
			nextIndices[index] = nextIndex;
		}
		const positions = new Float32Array(remap.size * 3);
		const normals = source.normals ? new Float32Array(remap.size * 3) : undefined;
		const uvs = source.uvs ? new Float32Array(remap.size * 2) : undefined;
		for (const [sourceIndex, nextIndex] of remap) {
			positions.set(source.positions.subarray(sourceIndex * 3, sourceIndex * 3 + 3), nextIndex * 3);
			if (normals && source.normals) normals.set(source.normals.subarray(sourceIndex * 3, sourceIndex * 3 + 3), nextIndex * 3);
			if (uvs && source.uvs) uvs.set(source.uvs.subarray(sourceIndex * 2, sourceIndex * 2 + 2), nextIndex * 2);
		}
		group.indices = nextIndices;
		if (group.solidIndices) {
			const solidIndices = new IndexArray(group.solidIndices.length);
			for (let index = 0; index < group.solidIndices.length; index += 1) {
				const mapped = remap.get(group.solidIndices[index]);
				if (mapped === undefined) throw new Error(`Solid index ${group.solidIndices[index]} is absent from full geometry.`);
				solidIndices[index] = mapped;
			}
			group.solidIndices = solidIndices;
		}
		group.batchPositions = positions;
		group.batchNormals = normals;
		group.batchUvs = uvs;
		compactVertexCount += remap.size;
		typedArrayBytes += nextIndices.byteLength + (group.solidIndices?.byteLength || 0) + (group.solidSourceTriangleIndices?.byteLength || 0)
			+ positions.byteLength + (normals?.byteLength || 0) + (uvs?.byteLength || 0) + group.matrices.byteLength
			+ (group.occurrenceHierarchyDepths?.byteLength || 0) + (group.sourceFaceAreasByTriangle?.byteLength || 0)
			+ (group.sourceFaceIndicesByTriangle?.byteLength || 0);
	}
	for (const mesh of scene.meshes) {
		mesh.positions = new Float32Array(0);
		mesh.normals = undefined;
		mesh.uvs = undefined;
	}
	scene.surfaceBatching = { sourceGroupCount: scene.groups.length, compactVertexCount, typedArrayBytes, preparationMs: performance.now() - started };
	return scene.surfaceBatching;
}

export function transformedRepresentativeVertex(position: ArrayLike<number>, matrix: ArrayLike<number>) {
	return new Vector3(position[0], position[1], position[2]).applyMatrix4(new Matrix4().fromArray(matrix as ArrayLike<number>));
}
