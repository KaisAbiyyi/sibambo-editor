import { Box3, Plane, Ray, Vector3 } from 'three';
import type { RenderFaceRecord as FaceRecord } from '@sibambo/contracts';
import type { EditablePlanarFace, EditorPlane, EditorPoint, EditorSelectionHit } from './EditorState';
import { createPlane, planeCoordinates } from './geometry/editable-geometry';

type PickFace = { source: FaceRecord; box: Box3; plane: Plane; editorPlane: EditorPlane };

export class SelectionManager {
	private readonly faces: PickFace[];

	constructor(faces: FaceRecord[]) {
		this.faces = faces
			.filter((face) => face.vertices.length >= 3 && face.normal && ['walls', 'floor', 'ceiling', 'roof'].includes(face.partKey))
			.map((source) => {
				const normal = new Vector3(source.normal.x, source.normal.y, source.normal.z).normalize();
				const origin = point(source.vertices[0]);
				return {
					source,
					box: new Box3(
						new Vector3(source.bounds.min.x, source.bounds.min.y, source.bounds.min.z),
						new Vector3(source.bounds.max.x, source.bounds.max.y, source.bounds.max.z)
					).expandByScalar(0.025),
					plane: new Plane().setFromNormalAndCoplanarPoint(normal, origin),
					editorPlane: createPlane(tuple(origin), tuple(normal))
				};
			});
	}

	pickImported(ray: Ray): EditorSelectionHit | null {
		let best: EditorSelectionHit | null = null;
		const intersection = new Vector3();
		for (const candidate of this.faces) {
			if (!ray.intersectsBox(candidate.box) || !ray.intersectPlane(candidate.plane, intersection)) continue;
			const distance = ray.origin.distanceTo(intersection);
			if (best && distance >= best.distance) continue;
			const candidatePoint = tuple(intersection);
			if (!inside(candidate.source, candidate.editorPlane, candidatePoint)) continue;
			const face: EditablePlanarFace = {
				id: `editable-source-${candidate.source.id}`,
				kind: 'face', shape: 'derived', plane: candidate.editorPlane,
				outer: candidate.source.vertices.map((value) => [value.x, value.y, value.z] as EditorPoint),
				holes: candidate.source.holes.map((hole) => hole.map((value) => [value.x, value.y, value.z] as EditorPoint)),
				color: '#9b1c31', sourceSurfaceId: candidate.source.id
			};
			best = { point: candidatePoint, plane: candidate.editorPlane, face, distance, imported: true };
		}
		return best;
	}
}

export function groundHit(ray: Ray): EditorSelectionHit | null {
	const plane = createPlane([0, 0, 0], [0, 1, 0], [1, 0, 0]);
	const intersection = ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), new Vector3());
	if (!intersection) return null;
	const pointValue = tuple(intersection);
	return {
		point: pointValue, plane,
		face: { id: 'editable-ground-reference', kind: 'face', shape: 'derived', plane, outer: [], holes: [], color: '#9b1c31' },
		distance: ray.origin.distanceTo(intersection), imported: false
	};
}

function inside(face: FaceRecord, plane: EditorPlane, candidate: EditorPoint) {
	const point2d = planeCoordinates(plane, candidate);
	if (!pointInRing(point2d, face.vertices.map((value) => planeCoordinates(plane, [value.x, value.y, value.z])))) return false;
	return !face.holes.some((hole) => pointInRing(point2d, hole.map((value) => planeCoordinates(plane, [value.x, value.y, value.z]))));
}

function pointInRing(pointValue: [number, number], ring: Array<[number, number]>) {
	let inside = false;
	for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
		const [x1, y1] = ring[index]; const [x2, y2] = ring[previous];
		if ((y1 > pointValue[1]) !== (y2 > pointValue[1]) && pointValue[0] < (x2 - x1) * (pointValue[1] - y1) / (y2 - y1 || 1e-12) + x1) inside = !inside;
	}
	return inside;
}

function point(value: { x: number; y: number; z: number }) { return new Vector3(value.x, value.y, value.z); }
function tuple(value: Vector3): EditorPoint { return [value.x, value.y, value.z]; }
