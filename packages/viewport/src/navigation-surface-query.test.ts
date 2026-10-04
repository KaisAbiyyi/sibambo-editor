import { describe, expect, test } from 'bun:test';
import { FrontSide, BufferGeometry, Float32BufferAttribute, Group, InstancedMesh, Matrix4, MeshBasicMaterial, Plane, Raycaster, Vector3 } from 'three';
import { NavigationSurfaceQuery, type NavigationSurfaceRecord } from './navigation-surface-query.js';

function makeRecord(options: { x?: number; z?: number; count?: number; visible?: number[]; navigationVisible?: boolean; indexed?: boolean } = {}) {
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 0, 1, 0], 3));
	if (options.indexed !== false) geometry.setIndex([0, 1, 2]);
	geometry.computeBoundingSphere();
	const material = new MeshBasicMaterial({ side: FrontSide });
	const mesh = new InstancedMesh(geometry, material, options.count ?? 1);
	for (let index = 0; index < mesh.count; index += 1) {
		mesh.setMatrixAt(index, new Matrix4().makeTranslation(index ? 4 : 0, 0, 0));
	}
	mesh.instanceMatrix.needsUpdate = true;
	mesh.position.set(options.x ?? 0, 0, options.z ?? 0);
	mesh.updateMatrixWorld(true);
	return {
		record: { mesh, navigationVisible: options.navigationVisible ?? true, visibleOccurrenceIndices: new Set(options.visible ?? Array.from({ length: mesh.count }, (_, i) => i)) } as NavigationSurfaceRecord,
		geometry,
		material
	};
}

function ray(x = 0, z = 5, direction = new Vector3(0, 0, -1)) {
	return new Raycaster(new Vector3(x, 0, z), direction);
}

describe('NavigationSurfaceQuery', () => {
	test('returns the nearest double-sided indexed source hit without changing display material', () => {
		const near = makeRecord({ z: 0 });
		const far = makeRecord({ z: -2 });
		const query = new NavigationSurfaceQuery();
		const hit = query.query(ray(), [near.record, far.record], [], 1e-6);
		expect(hit).toMatchObject({ recordIndex: 0, instanceIndex: 0, faceIndex: 0, distance: 5 });
		expect(hit?.point.toArray()).toEqual([0, 0, 0]);
		const backHit = query.query(ray(0, -2, new Vector3(0, 0, 1)), [near.record], [], 1e-6);
		expect(backHit?.faceIndex).toBe(0);
		expect((near.record.mesh.material as MeshBasicMaterial).side).toBe(FrontSide);
		query.dispose();
		near.geometry.dispose(); near.material.dispose(); far.geometry.dispose(); far.material.dispose();
	});

	test('respects current parent and instance transforms plus occurrence visibility', () => {
		const item = makeRecord({ count: 2, visible: [0] });
		const group = new Group();
		group.position.x = 2;
		group.add(item.record.mesh);
		group.updateMatrixWorld(true);
		const query = new NavigationSurfaceQuery();
		expect(query.query(ray(6), [item.record], [], 1e-6)).toBeNull();
		(item.record.visibleOccurrenceIndices as Set<number>).clear();
		(item.record.visibleOccurrenceIndices as Set<number>).add(1);
		const hit = query.query(ray(6), [item.record], [], 1e-6);
		expect(hit).toMatchObject({ instanceIndex: 1, distance: 5 });
		expect(hit?.point.x).toBeCloseTo(6, 10);
		query.dispose(); item.geometry.dispose(); item.material.dispose();
	});

	test('rejects hidden, empty-index, clipped, and zero-scale occurrences', () => {
		const hidden = makeRecord({ navigationVisible: false });
		const unindexed = makeRecord({ indexed: false });
		const clipped = makeRecord();
		const zeroScale = makeRecord();
		zeroScale.record.mesh.scale.x = 0;
		zeroScale.record.mesh.updateMatrixWorld(true);
		const query = new NavigationSurfaceQuery();
		expect(query.query(ray(), [hidden.record, unindexed.record], [], 1e-6)).toBeNull();
		expect(query.query(ray(), [clipped.record], [new Plane(new Vector3(0, 0, 1), -1)], 1e-6)).toBeNull();
		expect(query.query(ray(), [zeroScale.record], [], 1e-6)).toBeNull();
		query.dispose();
		for (const item of [hidden, unindexed, clipped, zeroScale]) { item.geometry.dispose(); item.material.dispose(); }
	});

	test('ties use record then instance then face ordering and dispose never owns borrowed geometry', () => {
		const first = makeRecord({ count: 2 });
		const second = makeRecord();
		let geometryDisposed = false;
		first.geometry.addEventListener('dispose', () => geometryDisposed = true);
		const query = new NavigationSurfaceQuery();
		const hit = query.query(ray(), [first.record, second.record], [], 1e-6);
		expect(hit).toMatchObject({ recordIndex: 0, instanceIndex: 0, faceIndex: 0 });
		query.dispose();
		expect(geometryDisposed).toBe(false);
		first.geometry.dispose(); first.material.dispose(); second.geometry.dispose(); second.material.dispose();
	});
});
