import { describe, expect, test } from 'bun:test';
import type { PreparedRuntimeGeometryGroup, PreparedRuntimeGeometryScene } from './prepared-types.js';
import { prepareApplicationRenderScene, type ApplicationEncodingProfile } from './application-preparation.js';

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

function determinant(matrices: Float32Array) {
	const a = matrices[0]!; const b = matrices[1]!; const c = matrices[2]!;
	const d = matrices[4]!; const e = matrices[5]!; const f = matrices[6]!;
	const g = matrices[8]!; const h = matrices[9]!; const i = matrices[10]!;
	return a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
}

function expectCandidateRow(
	group: PreparedRuntimeGeometryGroup,
	expected: {
		handle: string; definitionId: string; instanceId: string; instanceIndex: number;
		tagIndex: number; hierarchyIndex: number; sourceOrdinal: number;
	}
) {
	expect(group.matrices).toHaveLength(16);
	expect(determinant(group.matrices)).toBeGreaterThan(0);
	expect(group.occurrenceHandles).toEqual([expected.handle]);
	expect(group.occurrenceDefinitionIds).toEqual([expected.definitionId]);
	expect(group.occurrenceInstanceIds).toEqual([expected.instanceId]);
	expect(group.occurrenceHierarchyDepths).toEqual(new Uint16Array([1]));
	expect(group.occurrenceInstanceIndices).toEqual([expected.instanceIndex]);
	expect(group.occurrenceTagIndices).toEqual(new Int32Array([expected.tagIndex]));
	expect(group.occurrenceHierarchyIndices).toEqual(new Uint32Array([expected.hierarchyIndex]));
	expect(group.sourceOccurrenceIndices).toEqual(new Uint32Array([expected.sourceOrdinal]));
}

function expectNear(group: PreparedRuntimeGeometryGroup, sourceOrdinal = 17) {
	expectCandidateRow(group, {
		handle: 'candidate-near', definitionId: 'candidate-definition-near', instanceId: 'candidate-instance-near',
		instanceIndex: 11, tagIndex: -1, hierarchyIndex: 21, sourceOrdinal
	});
}

function expectFar(group: PreparedRuntimeGeometryGroup, sourceOrdinal = 29) {
	expectCandidateRow(group, {
		handle: 'candidate-far', definitionId: 'candidate-definition-far', instanceId: 'candidate-instance-far',
		instanceIndex: 12, tagIndex: 7, hierarchyIndex: 22, sourceOrdinal
	});
}

describe('application preparation occurrence-row integration', () => {
	test('Exact skips Solid suppression but still partitions reflected rows without metadata loss', () => {
		const source = splitScene();
		const candidate = source.groups[1]!;
		candidate.matrices = new Float32Array([...identity, ...reflectedAt(3)]);

		const result = prepareApplicationRenderScene(source, 'exact');

		expect(result.solidCoplanarResolutionMs).toBeUndefined();
		expect(source.solidCoplanarResolution).toBeUndefined();
		expect(result.mirroredInstancing).toMatchObject({ mirroredOccurrenceCount: 1, splitGroupCount: 1 });
		const partitions = candidatePartitions(source);
		expect(partitions).toHaveLength(2);
		const byOrdinal = new Map(partitions.map((group) => [group.sourceOccurrenceIndices?.[0], group]));
		const near = byOrdinal.get(17)!;
		const far = byOrdinal.get(29)!;
		expectNear(near);
		expectFar(far);
		expect(near.solidIndices).toBeUndefined();
		expect(far.solidIndices).toBeUndefined();
		expect(near.indices).toEqual(new Uint16Array([0, 1, 2]));
		expect(far.indices).toEqual(new Uint16Array([0, 2, 1]));
	});

	for (const profile of ['research', 'visual'] as const satisfies readonly ApplicationEncodingProfile[]) {
		test(`${profile} carries a genuine Solid suppression split through reflected-instancing normalization`, () => {
			const source = splitScene();
			const result = prepareApplicationRenderScene(source, profile);

			expect(result.solidCoplanarResolutionMs).toBeGreaterThanOrEqual(0);
			expect(source.solidCoplanarResolution).toBeDefined();
			expect(result.mirroredInstancing).toMatchObject({ mirroredOccurrenceCount: 2 });
			const partitions = candidatePartitions(source);
			expect(partitions).toHaveLength(2);
			const byOrdinal = new Map(partitions.map((group) => [group.sourceOccurrenceIndices?.[0], group]));
			const suppressed = byOrdinal.get(17)!;
			const retained = byOrdinal.get(29)!;
			expectNear(suppressed);
			expectFar(retained);
			expect(suppressed.solidIndices).toHaveLength(0);
			expect(suppressed.solidSourceTriangleIndices).toHaveLength(0);
			expect(retained.solidIndices).toEqual(new Uint16Array([0, 2, 1]));
			expect(retained.solidSourceTriangleIndices).toEqual(new Uint32Array([0]));

			const groupsAfterFirstPass = source.groups;
			const repeated = prepareApplicationRenderScene(source, profile);
			expect(repeated.solidCoplanarResolutionMs).toBe(source.solidCoplanarResolution!.preparationMs);
			expect(repeated.mirroredInstancing?.mirroredOccurrenceCount).toBe(0);
			expect(source.groups).toBe(groupsAfterFirstPass);
		});
	}

	test('derived Research partitions synthesize source ordinals while absent optional row columns remain absent', () => {
		const source = splitScene(false);
		const candidate = source.groups[1]!;
		candidate.occurrenceHandles = undefined;
		candidate.occurrenceDefinitionIds = undefined;
		candidate.occurrenceInstanceIds = undefined;
		candidate.occurrenceInstanceIndices = undefined;
		candidate.occurrenceTagIndices = undefined;
		candidate.occurrenceHierarchyIndices = undefined;

		prepareApplicationRenderScene(source, 'research');

		const partitions = candidatePartitions(source).sort((left, right) => left.sourceOccurrenceIndices![0]! - right.sourceOccurrenceIndices![0]!);
		expect(partitions).toHaveLength(2);
		expect(partitions.map((group) => group.sourceOccurrenceIndices?.[0])).toEqual([0, 1]);
		for (const partition of partitions) {
			expect(partition.occurrenceHandles).toBeUndefined();
			expect(partition.occurrenceDefinitionIds).toBeUndefined();
			expect(partition.occurrenceInstanceIds).toBeUndefined();
			expect(partition.occurrenceInstanceIndices).toBeUndefined();
			expect(partition.occurrenceTagIndices).toBeUndefined();
			expect(partition.occurrenceHierarchyIndices).toBeUndefined();
			expect(partition.occurrenceHierarchyDepths).toEqual(new Uint16Array([1]));
			expect(determinant(partition.matrices)).toBeGreaterThan(0);
		}
	});

	const malformedRows: Array<{
		name: string;
		apply: (group: PreparedRuntimeGeometryGroup) => void;
	}> = [
		{ name: 'occurrenceDefinitionIds', apply: (group) => { group.occurrenceDefinitionIds = ['only-one']; } },
		{ name: 'occurrenceInstanceIds', apply: (group) => { group.occurrenceInstanceIds = ['only-one']; } },
		{ name: 'occurrenceHierarchyDepths', apply: (group) => { group.occurrenceHierarchyDepths = new Uint16Array([1]); } },
		{ name: 'occurrenceInstanceIndices', apply: (group) => { group.occurrenceInstanceIndices = [11]; } },
		{ name: 'occurrenceTagIndices', apply: (group) => { group.occurrenceTagIndices = new Int32Array([-1]); } },
		{ name: 'occurrenceHierarchyIndices', apply: (group) => { group.occurrenceHierarchyIndices = new Uint32Array([21]); } }
	];

	for (const malformed of malformedRows) {
		test(`Research rejects short ${malformed.name} before publishing prepared groups`, () => {
			const source = splitScene();
			const originalGroups = source.groups;
			malformed.apply(source.groups[1]!);
			expect(() => prepareApplicationRenderScene(source, 'research')).toThrow(
				new RegExp(`Prepared solid invalid: group 1: ${malformed.name} length 1 does not match matrix rows 2\\.`)
			);
			expect(source.groups).toBe(originalGroups);
			expect(source.solidCoplanarResolution).toBeUndefined();
		});
	}
});
