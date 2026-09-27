import { describe, expect, test } from 'bun:test';
import { BatchedMesh, BufferGeometry, Float32BufferAttribute, Matrix4, MeshBasicMaterial, Vector3 } from 'three';
import type { PreparedRuntimeGeometryGroup, PreparedRuntimeGeometryScene } from './prepared-types.js';
import {
	BatchVisibilityIndex,
	compactPreparedSurfaceGeometry,
	computeBatchMetrics,
	planPreparedSurfaceBatches,
	preparedRuntimeGroupBuffers,
	preparedSurfaceRenderKey,
	transformedRepresentativeVertex,
	type BatchSemanticRow
} from './surface-batching';

const identity = new Matrix4();
const group = (overrides: Partial<PreparedRuntimeGeometryGroup> = {}): PreparedRuntimeGeometryGroup => ({
	key: 'walls', sourceMeshIndex: 0, definitionIndex: 0, faceCount: 1,
	indices: new Uint16Array([0, 1, 2]), matrices: new Float32Array(identity.elements),
	localBounds: { min: [0, 0, 0], max: [1, 1, 0], sphereCenter: [0.5, 0.5, 0], sphereRadius: 1 },
	worldBounds: { min: [0, 0, 0], max: [1, 1, 0] }, baseY: 0, topY: 1,
	materialIndex: 2, renderSide: 'front', opacity: 1, ...overrides
});

describe('prepared surface batching', () => {
	test('maps multiple geometries and nested affine transforms to the correct BatchedMesh instances', () => {
		const nested = new Matrix4().makeTranslation(4, -2, 3)
			.multiply(new Matrix4().makeRotationY(Math.PI / 2))
			.multiply(new Matrix4().makeScale(-2, 3, 0.5));
		const second = new Matrix4().makeTranslation(-7, 5, 1).multiply(new Matrix4().makeScale(1, 2, 4));
		const scene: PreparedRuntimeGeometryScene = {
			meshes: [
				{ sourceMeshIndex: 0, positions: new Float32Array([1, 2, 3, 0, 0, 0, 1, 0, 0]) },
				{ sourceMeshIndex: 1, positions: new Float32Array([-2, 1, 0, 0, 0, 0, 0, 1, 0]) }
			],
			groups: [group({ matrices: new Float32Array(nested.elements) }), group({ sourceMeshIndex: 1, matrices: new Float32Array(second.elements) })],
			totalUnits: 2
		};
		const [plan] = planPreparedSurfaceBatches(scene);
		expect(plan.rows).toHaveLength(2);
		const mesh = new BatchedMesh(plan.instanceCount, plan.vertexCapacity, plan.indexCapacity, new MeshBasicMaterial());
		const ids: number[] = [];
		for (const row of plan.rows) {
			const source = scene.meshes.find((candidate) => candidate.sourceMeshIndex === row.group.sourceMeshIndex)!;
			const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(source.positions, 3));
			geometry.setIndex([...row.group.indices]);
			const geometryId = mesh.addGeometry(geometry);
			const instanceId = mesh.addInstance(geometryId);
			mesh.setMatrixAt(instanceId, new Matrix4().fromArray(row.group.matrices));
			ids.push(instanceId);
		}
		const actual = new Matrix4();
		mesh.getMatrixAt(ids[0], actual);
		expect(transformedRepresentativeVertex(scene.meshes[0].positions, actual.elements).distanceTo(new Vector3(5.5, 4, 5))).toBeLessThan(1e-6);
		mesh.getMatrixAt(ids[1], actual);
		expect(transformedRepresentativeVertex(scene.meshes[1].positions, actual.elements).distanceTo(new Vector3(-9, 7, 1))).toBeLessThan(1e-6);
		mesh.dispose();
	});

	test('merges compatible material state across different categories and components', () => {
		const base = group({ key: 'walls', componentId: 'wall-1' });
		const diffComponent = group({ key: 'furniture', componentId: 'chair-2' });
		expect(preparedSurfaceRenderKey(diffComponent)).toBe(preparedSurfaceRenderKey(base));

		const scene: PreparedRuntimeGeometryScene = {
			meshes: [{ sourceMeshIndex: 0, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) }],
			groups: [base, diffComponent],
			totalUnits: 2
		};
		const batches = planPreparedSurfaceBatches(scene);
		expect(batches).toHaveLength(1);
		expect(batches[0].rows).toHaveLength(2);
		expect(batches[0].instanceCount).toBe(2);
	});

	test('splits batches when visual rendering properties differ', () => {
		const base = group();
		expect(preparedSurfaceRenderKey(group({ sourceMeshIndex: 9, definitionIndex: 7 }))).toBe(preparedSurfaceRenderKey(base));
		expect(preparedSurfaceRenderKey(group({ renderSide: 'back' }))).not.toBe(preparedSurfaceRenderKey(base));
		expect(preparedSurfaceRenderKey(group({ textureAsset: 'other.png' }))).not.toBe(preparedSurfaceRenderKey(base));
		expect(preparedSurfaceRenderKey(group({ opacity: 0.5 }))).not.toBe(preparedSurfaceRenderKey(base));
		expect(preparedSurfaceRenderKey(group({ fallbackText: 'Label' }))).not.toBe(preparedSurfaceRenderKey(base));
		expect(preparedSurfaceRenderKey(group({ baseColorRgba: [1, 0, 0, 1] }))).not.toBe(preparedSurfaceRenderKey(base));
	});

	test('differentiates unpainted fallback geometry by category key', () => {
		const unpaintedWall = group({ materialIndex: undefined, materialId: undefined, materialName: undefined, key: 'walls' });
		const unpaintedRoof = group({ materialIndex: undefined, materialId: undefined, materialName: undefined, key: 'roof' });
		expect(preparedSurfaceRenderKey(unpaintedWall)).not.toBe(preparedSurfaceRenderKey(unpaintedRoof));
	});

	test('BatchVisibilityIndex correctly indexes semantic metadata and occurrence handles', () => {
		const index = new BatchVisibilityIndex();
		const row1: BatchSemanticRow = {
			groupIndex: 0,
			geometryId: 10,
			key: 'walls',
			componentId: 'comp-wall-1',
			sourceMeshIndex: 0,
			definitionIndex: 0,
			startInstanceId: 0,
			instanceCount: 2
		};
		const row2: BatchSemanticRow = {
			groupIndex: 1,
			geometryId: 11,
			key: 'furniture',
			componentId: 'comp-chair-1',
			sourceMeshIndex: 1,
			definitionIndex: 1,
			startInstanceId: 2,
			instanceCount: 1
		};
		index.add(0, row1, ['handle-w1', 'handle-w2']);
		index.add(0, row2, ['handle-c1']);

		expect(index.byPartKey.get('walls')).toEqual([{ batchIndex: 0, startInstanceId: 0, instanceCount: 2, groupIndex: 0 }]);
		expect(index.byPartKey.get('furniture')).toEqual([{ batchIndex: 0, startInstanceId: 2, instanceCount: 1, groupIndex: 1 }]);
		expect(index.byComponentId.get('comp-wall-1')).toEqual([{ batchIndex: 0, startInstanceId: 0, instanceCount: 2, groupIndex: 0 }]);
		expect(index.byOccurrenceHandle.get('handle-w2')).toEqual({ batchIndex: 0, instanceId: 1, groupIndex: 0 });
		expect(index.byOccurrenceHandle.get('handle-c1')).toEqual({ batchIndex: 0, instanceId: 2, groupIndex: 1 });
	});

	test('selective instance visibility via BatchedMesh.setVisibleAt operates without rebuilds', () => {
		const mesh = new BatchedMesh(4, 12, 12, new MeshBasicMaterial());
		const geo1 = mesh.addGeometry(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)));
		const geo2 = mesh.addGeometry(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 2, 0], 3)));

		const inst1 = mesh.addInstance(geo1);
		const inst2 = mesh.addInstance(geo1);
		const inst3 = mesh.addInstance(geo2);
		const inst4 = mesh.addInstance(geo2);

		// Hide inst1 and inst3
		mesh.setVisibleAt(inst1, false);
		mesh.setVisibleAt(inst3, false);

		expect(mesh.getVisibleAt(inst1)).toBe(false);
		expect(mesh.getVisibleAt(inst2)).toBe(true);
		expect(mesh.getVisibleAt(inst3)).toBe(false);
		expect(mesh.getVisibleAt(inst4)).toBe(true);

		mesh.dispose();
	});

	test('computeBatchMetrics correctly analyzes batch aggregation and percentiles', () => {
		const scene: PreparedRuntimeGeometryScene = {
			meshes: [
				{ sourceMeshIndex: 0, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
				{ sourceMeshIndex: 1, positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]) }
			],
			groups: [
				group({ key: 'walls', materialIndex: 1 }),
				group({ key: 'doors', materialIndex: 1 }),
				group({ key: 'roof', materialIndex: 2 })
			],
			totalUnits: 3
		};
		const batches = planPreparedSurfaceBatches(scene);
		expect(batches).toHaveLength(2); // material 1 has 2 rows, material 2 has 1 row
		const metrics = computeBatchMetrics(batches);
		expect(metrics.batchCount).toBe(2);
		expect(metrics.singletonBatches).toBe(1);
		expect(metrics.splits.materials).toBe(2);
	});

	test('worker compaction keeps only referenced vertices and remaps indices', () => {
		const scene: PreparedRuntimeGeometryScene = {
			meshes: [{ sourceMeshIndex: 0, positions: new Float32Array([9, 9, 9, 1, 0, 0, 0, 1, 0, 0, 0, 1]) }],
		groups: [group({ indices: new Uint16Array([1, 3, 2]), solidIndices: new Uint16Array([3, 2, 1]) })], totalUnits: 1
		};
		const metrics = compactPreparedSurfaceGeometry(scene);
		expect(metrics.compactVertexCount).toBe(3);
		expect([...scene.groups[0].indices]).toEqual([0, 1, 2]);
		expect([...scene.groups[0].solidIndices!]).toEqual([1, 2, 0]);
		expect([...scene.groups[0].batchPositions!]).toEqual([1, 0, 0, 0, 0, 1, 0, 1, 0]);
		expect(scene.meshes[0].positions).toHaveLength(0);
		const buffers = preparedRuntimeGroupBuffers(scene.groups[0], scene.meshes[0]);
		expect(buffers.positions!).toBe(scene.groups[0].batchPositions!);
		expect(buffers.positions!.length).toBe(9);
		expect(buffers.normals).toBeUndefined();
		expect(buffers.uvs).toBeUndefined();
	});
});
