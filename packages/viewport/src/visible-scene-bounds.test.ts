import { describe, expect, test } from 'bun:test';
import { BoxGeometry, InstancedMesh, Matrix4, MeshBasicMaterial } from 'three';
import { visibleSceneBounds } from './visible-scene-bounds';

describe('visible scene fit bounds', () => {
	test('uses active visible instances and ignores hidden scene outliers', () => {
		const geometry = new BoxGeometry(2, 2, 2);
		const mesh = new InstancedMesh(geometry, new MeshBasicMaterial(), 2);
		mesh.setMatrixAt(0, new Matrix4().makeTranslation(3, 0, 0));
		mesh.setMatrixAt(1, new Matrix4().makeTranslation(1000, 0, 0));
		mesh.count = 2;
		const bounds = visibleSceneBounds([{ mesh, visibleOccurrenceIndices: new Set([0]) }]);
		expect(bounds).toEqual({ min: { x: 2, y: -1, z: -1 }, max: { x: 4, y: 1, z: 1 } });

		mesh.visible = false;
		expect(visibleSceneBounds([{ mesh, visibleOccurrenceIndices: new Set([1]) }])).toBeNull();
		geometry.dispose();
		mesh.material.dispose();
	});
});
