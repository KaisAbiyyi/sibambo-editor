import { ShapeUtils, Vector2, Vector3 } from 'three';
import type { EditableEntity, EditableExtrusion, EditablePlanarFace, EditorPlane, EditorPoint } from '../EditorState';

export type EditableGeometryData = { positions: Float32Array; indices: Uint32Array; triangleCount: number };

export function createPlane(origin: EditorPoint, normal: EditorPoint, preferredU?: EditorPoint): EditorPlane {
	const n = vector(normal).normalize();
	let u = preferredU ? vector(preferredU) : new Vector3(1, 0, 0);
	u.addScaledVector(n, -u.dot(n));
	if (u.lengthSq() < 1e-8) u = new Vector3(0, 0, 1).addScaledVector(n, -n.z);
	u.normalize();
	const v = n.clone().cross(u).normalize();
	return { origin, normal: tuple(n), u: tuple(u), v: tuple(v) };
}

export function worldPoint(plane: EditorPlane, u: number, v: number): EditorPoint {
	return tuple(vector(plane.origin).addScaledVector(vector(plane.u), u).addScaledVector(vector(plane.v), v));
}

export function planeCoordinates(plane: EditorPlane, point: EditorPoint): [number, number] {
	const delta = vector(point).sub(vector(plane.origin));
	return [delta.dot(vector(plane.u)), delta.dot(vector(plane.v))];
}

export function createRectangle(id: string, plane: EditorPlane, first: EditorPoint, opposite: EditorPoint, color = '#9b1c31'): EditablePlanarFace {
	const [u1, v1] = planeCoordinates(plane, first);
	const [u2, v2] = planeCoordinates(plane, opposite);
	return {
		id, kind: 'face', shape: 'rectangle', plane,
		outer: [worldPoint(plane, u1, v1), worldPoint(plane, u2, v1), worldPoint(plane, u2, v2), worldPoint(plane, u1, v2)],
		holes: [], color
	};
}

export function createCircle(id: string, plane: EditorPlane, center: EditorPoint, edge: EditorPoint, segments = 32, color = '#9b1c31'): EditablePlanarFace {
	const [centerU, centerV] = planeCoordinates(plane, center);
	const [edgeU, edgeV] = planeCoordinates(plane, edge);
	const radius = Math.max(Math.hypot(edgeU - centerU, edgeV - centerV), 0);
	const count = Math.max(12, Math.min(Math.round(segments), 64));
	const outer = Array.from({ length: count }, (_, index) => {
		const angle = index / count * Math.PI * 2;
		return worldPoint(plane, centerU + Math.cos(angle) * radius, centerV + Math.sin(angle) * radius);
	});
	return { id, kind: 'face', shape: 'circle', plane, outer, holes: [], color };
}

export function faceArea(face: EditablePlanarFace) {
	const signed = polygonArea2d(face.outer.map((point) => planeCoordinates(face.plane, point)));
	const holes = face.holes.reduce((sum, hole) => sum + Math.abs(polygonArea2d(hole.map((point) => planeCoordinates(face.plane, point)))), 0);
	return Math.max(0, Math.abs(signed) - holes);
}

export function triangulateEditableFace(face: EditablePlanarFace): EditableGeometryData {
	const rings = [face.outer, ...face.holes];
	const points = rings.flat();
	const contour = face.outer.map((point) => new Vector2(...planeCoordinates(face.plane, point)));
	const holes = face.holes.map((hole) => hole.map((point) => new Vector2(...planeCoordinates(face.plane, point))));
	const sourceIndices = face.outer.map((_, index) => index);
	let offset = face.outer.length;
	for (const hole of face.holes) {
		sourceIndices.push(...hole.map((_, index) => offset + index));
		offset += hole.length;
	}
	const normal = vector(face.plane.normal);
	const indices: number[] = [];
	for (const triangle of ShapeUtils.triangulateShape(contour, holes)) {
		indices.push(...orient(triangle.map((index) => sourceIndices[index]), points, normal));
	}
	return { positions: new Float32Array(points.flat()), indices: new Uint32Array(indices), triangleCount: indices.length / 3 };
}

export function extrudeFace(face: EditablePlanarFace, distance: number): EditableExtrusion | null {
	if (!Number.isFinite(distance) || Math.abs(distance) < 1e-6) return null;
	return { id: face.id, kind: 'extrusion', base: face, distance, color: face.color, sourceSurfaceId: face.sourceSurfaceId };
}

export function extrusionCapFace(extrusion: EditableExtrusion): EditablePlanarFace {
	const normal = vector(extrusion.base.plane.normal);
	const delta = normal.multiplyScalar(extrusion.distance);
	return {
		...extrusion.base,
		id: extrusion.id,
		plane: { ...extrusion.base.plane, origin: tuple(vector(extrusion.base.plane.origin).add(delta)) },
		outer: extrusion.base.outer.map((point) => tuple(vector(point).add(delta))),
		holes: extrusion.base.holes.map((hole) => hole.map((point) => tuple(vector(point).add(delta))))
	};
}

export function triangulateExtrusion(extrusion: EditableExtrusion): EditableGeometryData {
	const face = extrusion.base;
	if (face.holes.length) throw new Error('Push/Pull editor v1 does not extrude holes.');
	const base = face.outer;
	const normal = vector(face.plane.normal);
	const delta = normal.clone().multiplyScalar(extrusion.distance);
	const cap = base.map((point) => tuple(vector(point).add(delta)));
	const points = base.concat(cap);
	const contour = base.map((point) => new Vector2(...planeCoordinates(face.plane, point)));
	const triangles = ShapeUtils.triangulateShape(contour, []);
	const indices: number[] = [];
	const sign = Math.sign(extrusion.distance);
	for (const triangle of triangles) {
		indices.push(...orient(triangle, points, normal.clone().multiplyScalar(-sign)));
		indices.push(...orient(triangle.map((index) => index + base.length), points, normal.clone().multiplyScalar(sign)));
	}
	for (let index = 0; index < base.length; index += 1) {
		const next = (index + 1) % base.length;
		if (sign > 0) indices.push(index, next, base.length + next, index, base.length + next, base.length + index);
		else indices.push(index, base.length + index, base.length + next, index, base.length + next, next);
	}
	return { positions: new Float32Array(points.flat()), indices: new Uint32Array(indices), triangleCount: indices.length / 3 };
}

export function dimensions(face: EditablePlanarFace) {
	if (face.shape === 'circle') {
		const [cu, cv] = planeCoordinates(face.plane, face.plane.origin);
		const [eu, ev] = planeCoordinates(face.plane, face.outer[0]);
		return { radius: Math.hypot(eu - cu, ev - cv) };
	}
	const coordinates = face.outer.map((point) => planeCoordinates(face.plane, point));
	return {
		width: Math.max(...coordinates.map(([u]) => u)) - Math.min(...coordinates.map(([u]) => u)),
		height: Math.max(...coordinates.map(([, v]) => v)) - Math.min(...coordinates.map(([, v]) => v))
	};
}

export function translateFace(face: EditablePlanarFace, delta: EditorPoint): EditablePlanarFace {
	const d = vector(delta);
	return {
		...face,
		plane: {
			...face.plane,
			origin: tuple(vector(face.plane.origin).add(d))
		},
		outer: face.outer.map((point) => tuple(vector(point).add(d))),
		holes: face.holes.map((hole) => hole.map((point) => tuple(vector(point).add(d))))
	};
}

export function translateEntity(entity: EditableEntity, delta: EditorPoint): EditableEntity {
	if (entity.kind === 'face') {
		return translateFace(entity, delta);
	}
	return {
		...entity,
		base: translateFace(entity.base, delta)
	};
}

function orient(indices: number[], points: EditorPoint[], normal: Vector3): [number, number, number] {
	const [a, b, c] = indices;
	const dot = vector(points[b]).sub(vector(points[a])).cross(vector(points[c]).sub(vector(points[a]))).dot(normal);
	return dot < 0 ? [a, c, b] : [a, b, c];
}

function polygonArea2d(points: Array<[number, number]>) {
	return points.reduce((sum, point, index) => {
		const next = points[(index + 1) % points.length];
		return sum + point[0] * next[1] - next[0] * point[1];
	}, 0) / 2;
}

function vector(point: EditorPoint) { return new Vector3(point[0], point[1], point[2]); }
function tuple(point: Vector3): EditorPoint { return [point.x, point.y, point.z]; }
