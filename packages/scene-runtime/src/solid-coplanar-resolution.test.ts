import { describe, expect, test } from 'bun:test';
import type { PreparedRuntimeGeometryGroup, PreparedRuntimeGeometryScene } from './prepared-types.js';
import { prepareSolidCoplanarScene } from './solid-coplanar-resolution.js';

const identity = [
	1, 0, 0, 0,
	0, 1, 0, 0,
	0, 0, 1, 0,
	0, 0, 0, 1
];
const reflectedAt = (x: number) => [
	-1, 0, 0, 0,
	0, 1, 0, 0,
	0, 0, 1, 0,
	x, 0, 0, 1
];

function wallGroup(): PreparedRuntimeGeometryGroup {
	return {
		key: 'walls', sourceMeshIndex: 0, definitionIndex: 0, faceCount: 2,
		indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
		matrices: new Float32Array(identity),
		occurrenceHandles: ['wall-0'],
		occurrenceDefinitionIds: ['wall-definition'],
		occurrenceInstanceIds: ['wall-instance'],
		occurrenceHierarchyDepths: new Uint16Array([0]),
		occurrenceInstanceIndices: new Uint32Array([0]),
		occurrenceTagIndices: new Int32Array([-1]),
		occurrenceHierarchyIndices: new Uint32Array([0]),
		sourceOccurrenceIndices: new Uint32Array([5]),
		sourceFaceIndicesByTriangle: new Uint32Array([0, 0]),
		sourceFaceAreasByTriangle: new Float32Array([0.5, 0.5]),
		localBounds: { min: [0, 0, 0], max: [1, 1, 0], sphereCenter: [0.5, 0.5, 0], sphereRadius: 1 },
		worldBounds: { min: [0, 0, 0], max: [1, 1, 0] }, baseY: 0, topY: 1
	};
}

function candidateGroup(withSourceOrdinals = true): PreparedRuntimeGeometryGroup {
	return {
		key: 'furniture', sourceMeshIndex: 1, definitionIndex: 1, faceCount: 1,
		indices: new Uint16Array([0, 1, 2]),
		matrices: new Float32Array([...reflectedAt(1), ...reflectedAt(3)]),
		occurrenceHandles: ['candidate-near', 'candidate-far'],
		occurrenceDefinitionIds: ['candidate-definition-near', 'candidate-definition-far'],
		occurrenceInstanceIds: ['candidate-instance-near', 'candidate-instance-far'],
		occurrenceHierarchyDepths: new Uint16Array([1, 1]),
		occurrenceInstanceIndices: [11, 12],
		occurrenceTagIndices: new Int32Array([-1, 7]),
		occurrenceHierarchyIndices: new Uint32Array([21, 22]),
		...(withSourceOrdinals ? { sourceOccurrenceIndices: new Uint32Array([17, 29]) } : {}),
		sourceFaceIndicesByTriangle: new Uint32Array([1]),
		sourceFaceAreasByTriangle: new Float32Array([0.02]),
		localBounds: { min: [0.1, 0.1, 0], max: [0.3, 0.3, 0], sphereCenter: [0.2, 0.2, 0], sphereRadius: 0.2 },
		worldBounds: { min: [0.7, 0.1, 0], max: [2.9, 0.3, 0] }, baseY: 0.1, topY: 0.3
	};
}

function splitScene(withSourceOrdinals = true): PreparedRuntimeGeometryScene {
	return {
		meshes: [
			{ sourceMeshIndex: 0, positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]) },
			{ sourceMeshIndex: 1, positions: new Float32Array([0.1, 0.1, 0, 0.3, 0.1, 0, 0.1, 0.3, 0]) }
		],
		groups: [wallGroup(), candidateGroup(withSourceOrdinals)],
		totalUnits: 3
	};
}

function candidatePartitions(scene: PreparedRuntimeGeometryScene) {
	return scene.groups.filter((group) => group.sourceMeshIndex === 1);
}

describe('solid occurrence row partitioning', () => {
	test('a genuine suppression split preserves every occurrence column and original source ordinal', () => {
		const scene = splitScene();
		prepareSolidCoplanarScene(scene);

		const partitions = candidatePartitions(scene);
		expect(partitions).toHaveLength(2);
		const byOrdinal = new Map(partitions.map((group) => [group.sourceOccurrenceIndices?.[0], group]));
		const suppressed = byOrdinal.get(17)!;
		const retained = byOrdinal.get(29)!;
		expect(suppressed).toBeDefined();
		expect(retained).toBeDefined();
		expect(suppressed.solidIndices).toHaveLength(0);
		expect(retained.solidIndices).toEqual(new Uint16Array([0, 1, 2]));
		expect(suppressed.occurrenceHandles).toEqual(['candidate-near']);
		expect(retained.occurrenceHandles).toEqual(['candidate-far']);
		expect(suppressed.occurrenceDefinitionIds).toEqual(['candidate-definition-near']);
		expect(retained.occurrenceDefinitionIds).toEqual(['candidate-definition-far']);
		expect(suppressed.occurrenceInstanceIds).toEqual(['candidate-instance-near']);
		expect(retained.occurrenceInstanceIds).toEqual(['candidate-instance-far']);
		expect(suppressed.occurrenceHierarchyDepths).toEqual(new Uint16Array([1]));
		expect(retained.occurrenceHierarchyDepths).toEqual(new Uint16Array([1]));
		expect(suppressed.occurrenceInstanceIndices).toEqual([11]);
		expect(retained.occurrenceInstanceIndices).toEqual([12]);
		expect(suppressed.occurrenceTagIndices).toEqual(new Int32Array([-1]));
		expect(retained.occurrenceTagIndices).toEqual(new Int32Array([7]));
		expect(suppressed.occurrenceHierarchyIndices).toEqual(new Uint32Array([21]));
		expect(retained.occurrenceHierarchyIndices).toEqual(new Uint32Array([22]));
		expect(suppressed.matrices).toEqual(new Float32Array(reflectedAt(1)));
		expect(retained.matrices).toEqual(new Float32Array(reflectedAt(3)));
	});

	test('derived partitions synthesize stable source ordinals only when the source column is absent', () => {
		const scene = splitScene(false);
		prepareSolidCoplanarScene(scene);
		const ordinals = candidatePartitions(scene).map((group) => group.sourceOccurrenceIndices?.[0]).sort((a, b) => (a ?? 0) - (b ?? 0));
		expect(ordinals).toEqual([0, 1]);
	});

	test('rejects a short occurrence column before publishing any derived groups', () => {
		const scene = splitScene();
		const originalGroups = scene.groups;
		(scene.groups[1] as PreparedRuntimeGeometryGroup).occurrenceDefinitionIds = ['only-one'];
		expect(() => prepareSolidCoplanarScene(scene)).toThrow(/Prepared solid invalid: group 1: occurrenceDefinitionIds length 1 does not match matrix rows 2\./);
		expect(scene.groups).toBe(originalGroups);
	});

	test('rejects unknown occurrence metadata instead of silently dropping it', () => {
		const scene = splitScene();
		(scene.groups[1] as PreparedRuntimeGeometryGroup & { occurrenceMystery?: number[] }).occurrenceMystery = [1, 2];
		expect(() => prepareSolidCoplanarScene(scene)).toThrow(/Prepared solid invalid: group 1: unknown occurrence row field occurrenceMystery\./);
	});
});
