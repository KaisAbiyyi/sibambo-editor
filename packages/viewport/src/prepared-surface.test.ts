import { describe, expect, test } from 'bun:test';
import { Matrix4, MeshBasicMaterial } from 'three';
import { buildPreparedInstancedSurfaceGroups, createPreparedInstancedSurface } from './prepared-surface.js';

describe('prepared runtime surface composition', () => {
	test('shares indexed geometry and instanced world bounds while leaving material ownership with the caller', () => {
		const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
		const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
		const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
		const indices = new Uint16Array([0, 1, 2]);
		const material = new MeshBasicMaterial();
		const { geometry, fullIndex, mesh } = createPreparedInstancedSurface({
			positions, normals, uvs, indices, material, instanceCount: 2,
			localBounds: { min: [0, 0, 0], max: [1, 1, 0], sphereCenter: [0.5, 0.5, 0], sphereRadius: Math.SQRT1_2 },
			worldBounds: { min: [-2, -1, 0], max: [4, 3, 2] }
		});

		expect(geometry.getAttribute('position').array).toEqual(positions);
		expect(geometry.getAttribute('normal').array).toEqual(normals);
		expect(geometry.getAttribute('uv').array).toEqual(uvs);
		expect(geometry.index).toBe(fullIndex);
		expect(fullIndex.array).toEqual(indices);
		expect(geometry.boundingBox?.min.toArray()).toEqual([0, 0, 0]);
		expect(geometry.boundingBox?.max.toArray()).toEqual([1, 1, 0]);
		expect(geometry.boundingSphere?.center.toArray()).toEqual([0.5, 0.5, 0]);
		expect(geometry.boundingSphere?.radius).toBeCloseTo(Math.SQRT1_2);
		expect(mesh.geometry).toBe(geometry);
		expect(mesh.material).toBe(material);
		expect(mesh.count).toBe(2);
		expect(mesh.frustumCulled).toBe(true);
		expect(mesh.boundingBox?.min.toArray()).toEqual([-2, -1, 0]);
		expect(mesh.boundingBox?.max.toArray()).toEqual([4, 3, 2]);
		expect(mesh.boundingSphere?.center.toArray()).toEqual([1, 1, 1]);

		geometry.dispose();
		mesh.dispose();
		material.dispose();
	});

	test('builds prepared groups in source order with caller-owned buffers and materials', () => {
		const bounds = {
			localBounds: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number], sphereCenter: [0.5, 0.5, 0] as [number, number, number], sphereRadius: Math.SQRT1_2 },
			worldBounds: { min: [-2, -1, 0] as [number, number, number], max: [4, 3, 2] as [number, number, number] }
		};
		const groups = [
			{ id: 'first', sourceMeshIndex: 2, indices: new Uint16Array([0, 1, 2]), matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1]), ...bounds },
			{ id: 'second', sourceMeshIndex: 1, indices: new Uint16Array([2, 1, 0]), matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -3, 2, 1, 1]), ...bounds }
		];
		const sourceRows = [
			{ sourceMeshIndex: 1, positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), uvs: new Float32Array([0, 0, 1, 0, 0, 1]) },
			{ sourceMeshIndex: 2, positions: new Float32Array([0, 0, 0, 3, 0, 0, 0, 3, 0]), normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), uvs: new Float32Array([0, 0, 0.5, 0, 0, 0.5]) }
		];
		const calls: string[] = [];
		const buildResults = [...buildPreparedInstancedSurfaceGroups({
			groups,
			findSource: (group: typeof groups[number]) => {
				calls.push(`source:${group.id}`);
				return sourceRows.find((source) => source.sourceMeshIndex === group.sourceMeshIndex);
			},
			resolveBuffers: (group: typeof groups[number], source: typeof sourceRows[number]) => {
				calls.push(`buffers:${group.id}`);
				return group.id === 'first'
					? { positions: new Float32Array([0, 0, 0, 5, 0, 0, 0, 5, 0]), normals: source.normals, uvs: source.uvs }
					: { positions: source.positions, normals: source.normals, uvs: source.uvs };
			},
			resolveMaterial: (group: typeof groups[number], groupIndex: number) => {
				calls.push(`material:${group.id}:${groupIndex}`);
				return new MeshBasicMaterial({ color: group.id === 'first' ? '#ff0000' : '#00ff00' });
			},
			populateMatrices: true
		})];

		expect(buildResults.map((result) => [result.group.id, result.groupIndex])).toEqual([['first', 0], ['second', 1]]);
		expect(calls).toEqual([
			'source:first', 'buffers:first', 'material:first:0',
			'source:second', 'buffers:second', 'material:second:1'
		]);
		expect(buildResults[0].geometry.getAttribute('position').array).toEqual(new Float32Array([0, 0, 0, 5, 0, 0, 0, 5, 0]));
		expect(buildResults[0].geometry.getAttribute('normal').array).toEqual(sourceRows[1].normals);
		expect(buildResults[0].geometry.getAttribute('uv').array).toEqual(sourceRows[1].uvs);
		expect(buildResults[0].fullIndex.array).toEqual(new Uint16Array([0, 1, 2]));
		expect(buildResults[0].geometry.boundingBox?.min.toArray()).toEqual([0, 0, 0]);
		expect(buildResults[0].geometry.boundingBox?.max.toArray()).toEqual([1, 1, 0]);
		expect(buildResults[0].mesh.boundingBox?.min.toArray()).toEqual([-2, -1, 0]);
		expect(buildResults[0].mesh.boundingBox?.max.toArray()).toEqual([4, 3, 2]);
		expect((buildResults[0].material as MeshBasicMaterial).color.getHexString()).toBe('ff0000');
		expect((buildResults[1].material as MeshBasicMaterial).color.getHexString()).toBe('00ff00');
		const firstMatrix = new Matrix4();
		buildResults[0].mesh.getMatrixAt(0, firstMatrix);
		expect(firstMatrix.toArray()).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1]);
		const secondMatrix = new Matrix4();
		buildResults[1].mesh.getMatrixAt(0, secondMatrix);
		expect(secondMatrix.toArray()).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -3, 2, 1, 1]);

		for (const result of buildResults) {
			result.geometry.dispose();
			result.mesh.dispose();
			(result.material as MeshBasicMaterial).dispose();
		}
	});

	test('checks cancellation before resolving the next group and yields lazily', () => {
		const groups = ['first', 'second'].map((id) => ({
			id,
			sourceMeshIndex: id === 'first' ? 1 : 2,
			indices: new Uint16Array([0, 1, 2]),
			matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
			localBounds: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number], sphereCenter: [0.5, 0.5, 0] as [number, number, number], sphereRadius: Math.SQRT1_2 },
			worldBounds: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number] }
		}));
		const source = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) };
		const calls: string[] = [];
		const iterator = buildPreparedInstancedSurfaceGroups({
			groups,
			shouldContinue: (groupIndex) => {
				calls.push(`active:${groupIndex}`);
				return groupIndex === 0;
			},
			findSource: (group) => {
				calls.push(`source:${group.id}`);
				return source;
			},
			resolveBuffers: () => ({ positions: source.positions }),
			resolveMaterial: () => new MeshBasicMaterial()
		});

		const first = iterator.next();
		expect(first.done).toBe(false);
		expect(first.value?.group.id).toBe('first');
		expect(calls).toEqual(['active:0', 'source:first']);
		const stopped = iterator.next();
		expect(stopped.done).toBe(true);
		expect(calls).toEqual(['active:0', 'source:first', 'active:1']);
		first.value?.geometry.dispose();
		first.value?.mesh.dispose();
		(first.value?.material as MeshBasicMaterial | undefined)?.dispose();
	});
});
