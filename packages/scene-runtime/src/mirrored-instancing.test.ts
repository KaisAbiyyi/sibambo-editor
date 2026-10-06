import { describe, expect, test } from 'bun:test';
import type { PreparedRuntimeGeometryGroup, PreparedRuntimeGeometryScene } from './prepared-types.js';
import { normalizePreparedMirroredInstances } from './mirrored-instancing.js';

function group(matrices = new Float32Array([
	1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
	-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1
])): PreparedRuntimeGeometryGroup {
	const occurrenceCount = matrices.length / 16;
	return {
		key: 'walls', sourceMeshIndex: 0, definitionIndex: 0, faceCount: 1,
		indices: new Uint16Array([0, 1, 2]), solidIndices: new Uint16Array([0, 1, 2]), solidSourceTriangleIndices: new Uint32Array([0]),
		matrices, occurrenceHandles: ['positive', 'mirrored'].slice(0, occurrenceCount), occurrenceDefinitionIds: ['d0', 'd1'].slice(0, occurrenceCount), occurrenceInstanceIds: ['i0', 'i1'].slice(0, occurrenceCount),
		occurrenceHierarchyDepths: new Uint16Array([1, 2].slice(0, occurrenceCount)), occurrenceInstanceIndices: new Uint32Array([7, 9].slice(0, occurrenceCount)),
		occurrenceTagIndices: new Int32Array([-1, 3].slice(0, occurrenceCount)), occurrenceHierarchyIndices: new Uint32Array([4, 8].slice(0, occurrenceCount)), sourceOccurrenceIndices: new Uint32Array([11, 19].slice(0, occurrenceCount)),
		sourceFaceIndicesByTriangle: new Uint32Array([2]), sourceTagIndicesByTriangle: new Uint32Array([0]),
		sourceFrontMaterialIndicesByTriangle: new Uint32Array([1]), sourceBackMaterialIndicesByTriangle: new Uint32Array([2]), sourceFaceAreasByTriangle: new Float32Array([0.5]),
		localBounds: { min: [0, 0, 0], max: [1, 1, 0], sphereCenter: [0.5, 0.5, 0], sphereRadius: 1 },
		worldBounds: { min: [0, 0, 0], max: [5, 1, 0] }, baseY: 0, topY: 1
	};
}

function scene(groupValue = group()): PreparedRuntimeGeometryScene {
	return { meshes: [{ sourceMeshIndex: 0, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), uvs: new Float32Array([0, 0, 1, 0, 0, 1]) }], groups: [groupValue], totalUnits: 1 };
}

function determinant(matrix: Float32Array, offset: number) {
	const a = matrix[offset]!; const b = matrix[offset + 1]!; const c = matrix[offset + 2]!;
	const d = matrix[offset + 4]!; const e = matrix[offset + 5]!; const f = matrix[offset + 6]!;
	const g = matrix[offset + 8]!; const h = matrix[offset + 9]!; const i = matrix[offset + 10]!;
	return a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
}

function world(matrix: Float32Array, point: readonly number[], offset = 0) {
	return [
		matrix[offset]! * point[0]! + matrix[offset + 4]! * point[1]! + matrix[offset + 8]! * point[2]! + matrix[offset + 12]!,
		matrix[offset + 1]! * point[0]! + matrix[offset + 5]! * point[1]! + matrix[offset + 9]! * point[2]! + matrix[offset + 13]!,
		matrix[offset + 2]! * point[0]! + matrix[offset + 6]! * point[1]! + matrix[offset + 10]! * point[2]! + matrix[offset + 14]!
	];
}

describe('prepared reflected-instancing normalization', () => {
	test('partitions a mixed draw while preserving world positions, winding, sides, UVs, and source ordinals', () => {
		const input = scene();
		const before = {
			matrices: new Float32Array(input.groups[0]!.matrices), indices: new Uint16Array(input.groups[0]!.indices),
			solid: new Uint16Array(input.groups[0]!.solidIndices!), positions: new Float32Array(input.meshes[0]!.positions),
			normals: new Float32Array(input.meshes[0]!.normals!), uvs: new Float32Array(input.meshes[0]!.uvs!)
		};
		const result = normalizePreparedMirroredInstances(input);
		expect(result).toMatchObject({ inputGroupCount: 1, outputGroupCount: 2, splitGroupCount: 1, mirroredOccurrenceCount: 1 });
		const [positive, mirrored] = input.groups;
		expect(determinant(positive!.matrices, 0)).toBeGreaterThan(0);
		expect(determinant(mirrored!.matrices, 0)).toBeGreaterThan(0);
		expect(mirrored!.indices).toEqual(new Uint16Array([0, 2, 1]));
		expect(mirrored!.solidIndices).toEqual(new Uint16Array([0, 2, 1]));
		expect(mirrored!.solidSourceTriangleIndices).toEqual(new Uint32Array([0]));
		expect(mirrored!.sourceOccurrenceIndices).toEqual(new Uint32Array([19]));
		expect(mirrored!.occurrenceHandles).toEqual(['mirrored']);
		expect(mirrored!.occurrenceDefinitionIds).toEqual(['d1']);
		expect(mirrored!.occurrenceInstanceIds).toEqual(['i1']);
		expect(mirrored!.occurrenceInstanceIndices).toEqual(new Uint32Array([9]));
		expect(mirrored!.occurrenceTagIndices).toEqual(new Int32Array([3]));
		expect(mirrored!.sourceFaceIndicesByTriangle).toBe(input.groups[0]!.sourceFaceIndicesByTriangle);
		expect(mirrored!.batchPositions).toEqual(new Float32Array([-0, 0, 0, -1, 0, 0, -0, 1, 0]));
		expect(mirrored!.batchNormals).toEqual(new Float32Array([-0, 0, 1, -0, 0, 1, -0, 0, 1]));
		expect(mirrored!.batchUvs).toBe(input.meshes[0]!.uvs);
		expect(mirrored!.localBounds).toEqual({ min: [-1, 0, 0], max: [-0, 1, 0], sphereCenter: [-0.5, 0.5, 0], sphereRadius: 1 });
		for (const point of [[0, 0, 0], [1, 0, 0], [0, 1, 0]]) {
			const reflectedLocal = [-point[0]!, point[1]!, point[2]!];
			expect(world(mirrored!.matrices, reflectedLocal).map((value, axis) => Math.abs(value - world(before.matrices, point, 16)[axis]!) < 1e-7)).toEqual([true, true, true]);
		}
		expect(input.meshes[0]!.positions).toEqual(before.positions);
		expect(input.meshes[0]!.normals).toEqual(before.normals);
		expect(input.meshes[0]!.uvs).toEqual(before.uvs);
		expect(input.groups[0]!.matrices).not.toBe(before.matrices);
		expect(before.indices).toEqual(new Uint16Array([0, 1, 2]));
		expect(before.solid).toEqual(new Uint16Array([0, 1, 2]));
	});

	test('keeps all-positive, all-mirrored, and empty occurrence groups bounded to two partitions', () => {
		const positive = scene(group(new Float32Array([1, 0, 0, 0, 0, 2, 0, 0, 0, 0.5, 1, 0, 2, 0, 0, 1])));
		const positiveGroup = positive.groups[0];
		expect(normalizePreparedMirroredInstances(positive).outputGroupCount).toBe(1);
		expect(positive.groups[0]).toBe(positiveGroup);
		const negative = scene(group(new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1])));
		expect(normalizePreparedMirroredInstances(negative).outputGroupCount).toBe(1);
		expect(determinant(negative.groups[0]!.matrices, 0)).toBeGreaterThan(0);
		const emptyGroup = group(new Float32Array(0));
		const empty = scene(emptyGroup);
		expect(normalizePreparedMirroredInstances(empty).outputGroupCount).toBe(1);
		expect(empty.groups[0]).toBe(emptyGroup);
	});

	test('is idempotent, does not expand occurrences, and publishes nothing after malformed groups', () => {
		const input = scene();
		normalizePreparedMirroredInstances(input);
		const groups = input.groups;
		const repeated = normalizePreparedMirroredInstances(input);
		expect(input.groups).toBe(groups);
		expect(repeated.mirroredOccurrenceCount).toBe(0);
		expect(input.groups.reduce((sum, value) => sum + value.matrices.length / 16, 0)).toBe(2);
		const original = scene();
		const prior = original.groups;
		const malformed = group();
		malformed.indices = new Uint16Array([0, 1, 99]);
		original.groups = [group(), malformed];
		const before = original.groups;
		expect(() => normalizePreparedMirroredInstances(original)).toThrow();
		expect(original.groups).toBe(before);
		expect(prior).not.toBe(before);
	});
});
