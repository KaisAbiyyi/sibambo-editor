import { describe, expect, test } from 'bun:test';
import type { Face, Mesh } from '@sibambo/bomc-document';
import { preparePolygon } from '../../src/lib/authoring/polygon.js';
import { buildAuthoringTopology } from '../../src/lib/authoring/topology.js';

function face(id: string, outer: number[], triangles: number[], normal: [number, number, number] = [0, 1, 0]): Face {
	return {
		id,
		outer,
		holes: [],
		triangles,
		normal,
		frontMaterialId: 'material',
		backMaterialId: null,
		hidden: false,
		surfaceCode: 0,
		roleCode: 0,
		label: null
	};
}

describe('authoring polygon and topology', () => {
	test('triangulates triangle, quad and concave simple loops deterministically', () => {
		for (const points of [
			[[0, 0, 0], [2, 0, 0], [0, 0, 2]],
			[[0, 0, 0], [3, 0, 0], [3, 0, 2], [0, 0, 2]],
			[[0, 0, 0], [3, 0, 0], [3, 0, 3], [1.5, 0, 1.5], [0, 0, 3]]
		] as const) {
			const first = preparePolygon(points);
			const second = preparePolygon(points);
			expect(first).toEqual(second);
			expect(first.triangles).toHaveLength((points.length - 2) * 3);
			expect(first.normal).toEqual([0, 1, 0]);
		}
	});

	test('normalizes rotated start and reversed winding to the same canonical polygon', () => {
		const base = [[0, 0, 0], [4, 0, 0], [4, 0, 3], [0, 0, 3]] as const;
		const rotated = [[4, 0, 3], [0, 0, 3], [0, 0, 0], [4, 0, 0]] as const;
		const reversed = [[0, 0, 0], [0, 0, 3], [4, 0, 3], [4, 0, 0]] as const;
		expect(preparePolygon(rotated)).toEqual(preparePolygon(base));
		expect(preparePolygon(reversed)).toEqual(preparePolygon(base));
	});

	test('rejects self-intersection, repeated vertex, tiny edge, nonplanar point and zero area', () => {
		for (const points of [
			[[0, 0, 0], [2, 0, 2], [0, 0, 2], [2, 0, 0]],
			[[0, 0, 0], [2, 0, 0], [0, 0, 0], [0, 0, 2]],
			[[0, 0, 0], [1e-7, 0, 0], [0, 0, 2]],
			[[0, 0, 0], [2, 0, 0], [2, 1e-4, 2], [0, 0, 2]],
			[[0, 0, 0], [1, 0, 0], [2, 0, 0]]
		] as const) expect(() => preparePolygon(points)).toThrow();
	});

	test('accepts a shared edge and derives stable adjacency independent of face order', () => {
		const mesh: Mesh = {
			id: 'mesh',
			definitionId: 'definition',
			positions: [0, 0, 0, 2, 0, 0, 0, 0, 2, 2, 0, 2],
			faces: [
				face('face-b', [1, 3, 2], [1, 3, 2]),
				face('face-a', [0, 1, 2], [0, 1, 2])
			]
		};
		const topology = buildAuthoringTopology(mesh);
		expect(topology.edges.get('1:2')?.faceIds).toEqual(['face-a', 'face-b']);
		expect(topology.adjacentFaceIds.get('face-a')).toEqual(['face-b']);
		expect(topology.adjacentFaceIds.get('face-b')).toEqual(['face-a']);
	});

	test('rejects an edge incident to three faces', () => {
		const mesh: Mesh = {
			id: 'mesh',
			definitionId: 'definition',
			positions: [0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 0, -1, 2],
			faces: [
				face('a', [0, 1, 2], [0, 1, 2]),
				face('b', [1, 0, 3], [1, 0, 3]),
				face('c', [0, 1, 4], [0, 1, 4])
			]
		};
		expect(() => buildAuthoringTopology(mesh)).toThrow(/non-manifold/i);
	});

	test('admits only the bounded nested Push/Pull three-face junction pattern', () => {
		const mesh: Mesh = {
			id: 'mesh',
			definitionId: 'definition',
			positions: [
				1, 0, 1, 3, 0, 1, 3, 0, 3, 1, 0, 3,
				0, 0, 0, 4, 0, 0, 4, 0, 4, 0, 0, 4,
				1, 1, 1, 3, 1, 1
			],
			faces: [
				{ ...face('base-ring', [4, 5, 6, 7], []), holes: [[0, 1, 2, 3]] },
				face('child', [0, 1, 2, 3], []),
				face('reveal', [0, 1, 9, 8], [], [0, 0, 1])
			]
		};
		const topology = buildAuthoringTopology(mesh);
		expect(topology.edges.get('0:1')?.faceIds).toEqual(['base-ring', 'child', 'reveal']);
		expect(topology.adjacentFaceIds.get('child')).toContain('base-ring');
		expect(topology.adjacentFaceIds.get('child')).toContain('reveal');
	});

	test('admits a nested reveal continuation only on opposite sides of the base ring', () => {
		const mesh: Mesh = {
			id: 'mesh', definitionId: 'definition',
			positions: [
				1, 0, 1, 3, 0, 1, 3, 0, 3, 1, 0, 3,
				0, 0, 0, 4, 0, 0, 4, 0, 4, 0, 0, 4,
				1, 1, 1, 3, 1, 1, 1, -1, 1, 3, -1, 1
			],
			faces: [
				{ ...face('base-ring', [4, 5, 6, 7], []), holes: [[0, 1, 2, 3]] },
				face('upper-reveal', [0, 1, 9, 8], [], [0, 0, 1]),
				face('lower-reveal', [0, 1, 11, 10], [], [0, 0, -1])
			]
		};
		expect(buildAuthoringTopology(mesh).edges.get('0:1')?.faceIds).toEqual(['base-ring', 'lower-reveal', 'upper-reveal']);
		const split: Mesh = { ...mesh, positions: [...mesh.positions, 2, 0, 1], faces: mesh.faces.map(face => ({
			...face, outer: face.outer.flatMap(vertex => vertex === 0 ? [0, 12] : [vertex]),
			holes: face.holes.map(ring => ring.flatMap(vertex => vertex === 0 ? [0, 12] : [vertex]))
		})) };
		expect(buildAuthoringTopology(split).edges.get('0:12')?.faceIds).toEqual(['base-ring', 'lower-reveal', 'upper-reveal']);
		const bent = [...split.positions]; bent[37] = 0.3;
		expect(() => buildAuthoringTopology({ ...split, positions: bent })).toThrow(/unsupported three-face/);
		const sameSidePositions = [...mesh.positions];
		sameSidePositions[31] = 0.5; sameSidePositions[34] = 0.5;
		expect(() => buildAuthoringTopology({ ...mesh, positions: sameSidePositions })).toThrow(/unsupported three-face/);
		const overlappingPositions = [...mesh.positions];
		overlappingPositions[34] = 0.5;
		expect(() => buildAuthoringTopology({ ...mesh, positions: overlappingPositions })).toThrow(/unsupported three-face/);
		const skewPositions = [...mesh.positions];
		skewPositions[32] = 1.5;
		expect(() => buildAuthoringTopology({ ...mesh, positions: skewPositions })).toThrow(/unsupported three-face/);
		expect(() => buildAuthoringTopology({ ...mesh, faces: [...mesh.faces, face('extra', [0, 1, 2], [])] })).toThrow(/more than three/);
	});
});
