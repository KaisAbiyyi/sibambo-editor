import { describe, expect, test } from 'bun:test';
import type { PreparedRuntimeGeometryGroup, PreparedRuntimeGeometryScene } from './prepared-types.js';
import { prepareApplicationRenderScene, type ApplicationPreparationProgress } from './application-preparation.js';

function group(): PreparedRuntimeGeometryGroup {
	return {
		key: 'walls', sourceMeshIndex: 0, definitionIndex: 0, faceCount: 1,
		indices: new Uint16Array([0, 1, 2]), matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
		localBounds: { min: [0, 0, 0], max: [1, 1, 0], sphereCenter: [0.5, 0.5, 0], sphereRadius: 1 },
		worldBounds: { min: [0, 0, 0], max: [1, 1, 0] }, baseY: 0, topY: 1
	};
}

function scene(groupCount = 1): PreparedRuntimeGeometryScene {
	return {
		meshes: [{ sourceMeshIndex: 0, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) }],
		groups: Array.from({ length: groupCount }, group),
		totalUnits: groupCount
	};
}

describe('app E4 render preparation', () => {
	test('skips destructive Solid preparation for Exact while keeping full geometry', () => {
		const source = scene();
		const result = prepareApplicationRenderScene(source, 'exact');

		expect(result.solidCoplanarResolutionMs).toBeUndefined();
		expect(source.groups[0].solidIndices).toBeUndefined();
		expect(source.groups[0].indices).toEqual(new Uint16Array([0, 1, 2]));
	});

	test('prepares non-Exact Solid buffers and returns timing evidence', () => {
		const source = scene();
		const result = prepareApplicationRenderScene(source, 'research');

		expect(result.solidCoplanarResolutionMs).toBeGreaterThanOrEqual(0);
		expect(source.solidCoplanarResolution).toBeDefined();
	});

	test('compacts large prepared surface sets and reports progress', () => {
		const source = scene(1001);
		const progress: ApplicationPreparationProgress[] = [];
		const result = prepareApplicationRenderScene(source, 'exact', (entry) => progress.push(entry));

		expect(result.surfaceBatching?.sourceGroupCount).toBe(1001);
		expect(source.groups[0].batchPositions).toEqual(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
		expect(source.meshes[0].positions).toHaveLength(0);
		expect(progress.at(-1)).toMatchObject({ phase: 'batching', completed: 1001, total: 1001 });
	});
});
