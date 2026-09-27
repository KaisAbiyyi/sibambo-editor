import { describe, expect, test } from 'bun:test';
import { Vector3 } from 'three';
import type { EditablePlanarFace, EditorPoint } from '../../../src/lib/editor/EditorState';
import {
	createCircle,
	createPlane,
	createRectangle,
	extrudeFace,
	faceArea,
	triangulateEditableFace,
	triangulateExtrusion
} from '../../../src/lib/editor/geometry/editable-geometry';

describe('editable shape geometry', () => {
	test('creates a correctly wound rectangle on the world XY drawing plane', () => {
		const plane = createPlane([0, 0, 0], [0, 0, 1]);
		const face = createRectangle('rectangle', plane, [0, 0, 0], [3, 4, 0]);
		const geometry = triangulateEditableFace(face);

		expect(faceArea(face)).toBeCloseTo(12, 6);
		expect(geometry.triangleCount).toBe(2);
		expect(triangleNormal(geometry.positions, geometry.indices, 0).z).toBeGreaterThan(0);
	});

	test('keeps an arbitrary-plane rectangle coplanar', () => {
		const plane = createPlane([2, -1, 4], [1, 2, 3], [0, 1, 0]);
		const face = createRectangle('tilted', plane, plane.origin, addScaled(plane.origin, plane.u, 2, plane.v, 5));
		const normal = new Vector3(...plane.normal);
		const origin = new Vector3(...plane.origin);

		for (const point of face.outer) {
			expect(Math.abs(new Vector3(...point).sub(origin).dot(normal))).toBeLessThan(1e-6);
		}
		expect(faceArea(face)).toBeCloseTo(10, 5);
	});

	test('creates a bounded circle with stable winding and useful area', () => {
		const plane = createPlane([1, 2, 3], [0, 1, 0], [1, 0, 0]);
		const face = createCircle('circle', plane, plane.origin, addScaled(plane.origin, plane.u, 2), 32);
		const geometry = triangulateEditableFace(face);

		expect(face.outer).toHaveLength(32);
		// A 32-segment circle is intentionally a lightweight inscribed polygon.
		expect(faceArea(face)).toBeCloseTo(Math.PI * 4, 0);
		expect(geometry.triangleCount).toBe(30);
		expect(triangleNormal(geometry.positions, geometry.indices, 0).dot(new Vector3(...plane.normal))).toBeGreaterThan(0);
	});
});

describe('push/pull geometry', () => {
	const plane = createPlane([0, 0, 0], [0, 0, 1]);
	const rectangle = createRectangle('box', plane, [0, 0, 0], [3, 2, 0]);

	test('creates positive and negative extrusions at the requested signed distance', () => {
		for (const distance of [2.4, -0.35]) {
			const extrusion = extrudeFace(rectangle, distance);
			expect(extrusion).not.toBeNull();
			const geometry = triangulateExtrusion(extrusion!);
			expect(geometry.triangleCount).toBe(12);

			const capStart = rectangle.outer.length * 3;
			for (let index = capStart; index < geometry.positions.length; index += 3) {
				expect(geometry.positions[index + 2]).toBeCloseTo(distance, 5);
			}
		}
	});

	test('uses opposite outward cap winding for negative extrusion', () => {
		const positive = triangulateExtrusion(extrudeFace(rectangle, 1)!);
		const negative = triangulateExtrusion(extrudeFace(rectangle, -1)!);
		const normal = new Vector3(...plane.normal);

		expect(triangleNormal(positive.positions, positive.indices, 0).dot(normal)).toBeLessThan(0);
		expect(triangleNormal(positive.positions, positive.indices, 1).dot(normal)).toBeGreaterThan(0);
		expect(triangleNormal(negative.positions, negative.indices, 0).dot(normal)).toBeGreaterThan(0);
		expect(triangleNormal(negative.positions, negative.indices, 1).dot(normal)).toBeLessThan(0);
	});

	test('zero distance is a no-op', () => {
		expect(extrudeFace(rectangle, 0)).toBeNull();
		expect(extrudeFace(rectangle, 1e-8)).toBeNull();
	});

	test('triangulates a simple concave polygon and all extrusion sides', () => {
		const outer: EditorPoint[] = [[0, 0, 0], [3, 0, 0], [3, 1, 0], [1, 1, 0], [1, 3, 0], [0, 3, 0]];
		const face: EditablePlanarFace = {
			id: 'concave', kind: 'face', shape: 'derived', plane, outer, holes: [], color: '#9b1c31'
		};
		const geometry = triangulateExtrusion(extrudeFace(face, 2)!);
		expect(geometry.triangleCount).toBe(20);
	});
});

function addScaled(origin: EditorPoint, first: EditorPoint, firstScale: number, second: EditorPoint = [0, 0, 0], secondScale = 0): EditorPoint {
	return origin.map((value, index) => value + first[index] * firstScale + second[index] * secondScale) as EditorPoint;
}

function triangleNormal(positions: Float32Array, indices: Uint32Array, triangle: number) {
	const offset = triangle * 3;
	const a = vertex(positions, indices[offset]);
	const b = vertex(positions, indices[offset + 1]);
	const c = vertex(positions, indices[offset + 2]);
	return b.sub(a).cross(c.sub(a)).normalize();
}

function vertex(positions: Float32Array, index: number) {
	return new Vector3(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]);
}
