import { Camera, Matrix4, Raycaster, Vector2, Vector3 } from 'three';
import type { RenderFaceRecord as FaceRecord } from '@sibambo/contracts';
import type { EditablePlanarFace } from '../EditorState';

export type SnapKind = 'endpoint' | 'intersection' | 'midpoint' | 'edge' | 'axis' | 'face';

export type SnapResult = {
	point: Vector3;
	kind: SnapKind;
	label: string;
	snapPointA?: Vector3;
	axisDirection?: Vector3;
	pixelDistance: number;
};

export type ActivePlane = {
	origin: Vector3;
	normal: Vector3;
	u: Vector3;
	v: Vector3;
};

export class SnapManager {
	tolerancePx: number = 10;
	shiftLocked: boolean = false;
	lockedDirection: Vector3 | null = null;

	getPlaneBasis(normal: Vector3, origin: Vector3 = new Vector3()): ActivePlane {
		const norm = normal.clone().normalize();
		let u: Vector3;
		if (Math.abs(norm.z) > 0.9) {
			u = new Vector3(1, 0, 0);
		} else {
			u = new Vector3(-norm.y, norm.x, 0);
			if (u.lengthSq() < 1e-6) u = new Vector3(1, 0, 0);
			else u.normalize();
		}
		const v = new Vector3().crossVectors(norm, u).normalize();
		return { origin, normal: norm, u, v };
	}

	resolveSnap(params: {
		raycaster: Raycaster;
		camera: Camera;
		canvasWidth: number;
		canvasHeight: number;
		pointerPx: Vector2;
		activePlane: ActivePlane;
		editableShapes?: EditablePlanarFace[];
		analyticalFaces?: FaceRecord[];
		referencePointA?: Vector3 | null;
	}): SnapResult | null {
		const { raycaster, camera, canvasWidth, canvasHeight, pointerPx, activePlane, editableShapes = [], analyticalFaces = [], referencePointA } = params;

		const planeHit = new Vector3();
		const planeRay = raycaster.ray;
		const denom = planeRay.direction.dot(activePlane.normal);
		if (Math.abs(denom) < 1e-6) return null;
		const t = activePlane.origin.clone().sub(planeRay.origin).dot(activePlane.normal) / denom;
		if (t < 0) return null;
		planeHit.copy(planeRay.origin).addScaledVector(planeRay.direction, t);

		const projectToPx = (p3: Vector3): Vector2 | null => {
			const proj = p3.clone().project(camera);
			if (proj.z > 1 || proj.z < -1) return null;
			const x = ((proj.x + 1) / 2) * canvasWidth;
			const y = ((-proj.y + 1) / 2) * canvasHeight;
			return new Vector2(x, y);
		};

		const candidateEndpoints: Vector3[] = [];
		const candidateEdges: Array<{ start: Vector3; end: Vector3 }> = [];

		for (const shape of editableShapes) {
			const verts = shape.outer.map(([x, y, z]) => new Vector3(x, y, z));
			for (const vert of verts) {
				candidateEndpoints.push(vert.clone());
			}
			const n = verts.length;
			for (let i = 0; i < n; i++) {
				candidateEdges.push({
					start: verts[i].clone(),
					end: verts[(i + 1) % n].clone()
				});
			}
		}

		for (const face of analyticalFaces) {
			for (const vert of face.vertices) {
				const v3 = new Vector3(vert.x, vert.y, vert.z);
				if (v3.distanceToSquared(planeHit) < 100) {
					candidateEndpoints.push(v3);
				}
			}
			const vertices = face.vertices;
			for (let i = 0; i < vertices.length; i++) {
				const s = new Vector3(vertices[i].x, vertices[i].y, vertices[i].z);
				const e = new Vector3(vertices[(i + 1) % vertices.length].x, vertices[(i + 1) % vertices.length].y, vertices[(i + 1) % vertices.length].z);
				if (s.distanceToSquared(planeHit) < 100) {
					candidateEdges.push({ start: s, end: e });
				}
			}
		}

		const evaluatedCandidates: SnapResult[] = [];

		for (const ep of candidateEndpoints) {
			const px = projectToPx(ep);
			if (!px) continue;
			const dist = pointerPx.distanceTo(px);
			if (dist <= this.tolerancePx) {
				evaluatedCandidates.push({
					point: ep.clone(),
					kind: 'endpoint',
					label: 'Endpoint',
					pixelDistance: dist
				});
			}
		}

		for (const edge of candidateEdges) {
			const mid = edge.start.clone().add(edge.end).multiplyScalar(0.5);
			const px = projectToPx(mid);
			if (!px) continue;
			const dist = pointerPx.distanceTo(px);
			if (dist <= this.tolerancePx) {
				evaluatedCandidates.push({
					point: mid,
					kind: 'midpoint',
					label: 'Midpoint',
					pixelDistance: dist
				});
			}
		}

		for (const edge of candidateEdges) {
			const seg = edge.end.clone().sub(edge.start);
			const lenSq = seg.lengthSq();
			if (lenSq > 1e-6) {
				const factor = Math.max(0, Math.min(1, planeHit.clone().sub(edge.start).dot(seg) / lenSq));
				const closest = edge.start.clone().addScaledVector(seg, factor);
				const px = projectToPx(closest);
				if (px) {
					const dist = pointerPx.distanceTo(px);
					if (dist <= this.tolerancePx) {
						evaluatedCandidates.push({
							point: closest,
							kind: 'edge',
							label: 'On Edge',
							pixelDistance: dist
						});
					}
				}
			}
		}

		if (referencePointA) {
			const delta = planeHit.clone().sub(referencePointA);
			const uComponent = delta.dot(activePlane.u);
			const vComponent = delta.dot(activePlane.v);

			const projU = referencePointA.clone().addScaledVector(activePlane.u, uComponent);
			const pxU = projectToPx(projU);
			if (pxU) {
				const distU = pointerPx.distanceTo(pxU);
				if (distU <= this.tolerancePx) {
					evaluatedCandidates.push({
						point: projU,
						kind: 'axis',
						label: 'On Axis',
						axisDirection: activePlane.u.clone(),
						snapPointA: referencePointA.clone(),
						pixelDistance: distU
					});
				}
			}

			const projV = referencePointA.clone().addScaledVector(activePlane.v, vComponent);
			const pxV = projectToPx(projV);
			if (pxV) {
				const distV = pointerPx.distanceTo(pxV);
				if (distV <= this.tolerancePx) {
					evaluatedCandidates.push({
						point: projV,
						kind: 'axis',
						label: 'On Axis',
						axisDirection: activePlane.v.clone(),
						snapPointA: referencePointA.clone(),
						pixelDistance: distV
					});
				}
			}
		}

		if (this.shiftLocked && this.lockedDirection && referencePointA) {
			const proj = referencePointA.clone().addScaledVector(this.lockedDirection, planeHit.clone().sub(referencePointA).dot(this.lockedDirection));
			return {
				point: proj,
				kind: 'axis',
				label: 'Constrained',
				axisDirection: this.lockedDirection.clone(),
				snapPointA: referencePointA.clone(),
				pixelDistance: 0
			};
		}

		if (evaluatedCandidates.length > 0) {
			const kindWeights: Record<SnapKind, number> = {
				endpoint: 600,
				intersection: 500,
				midpoint: 400,
				edge: 300,
				axis: 200,
				face: 100
			};

			evaluatedCandidates.sort((a, b) => {
				const scoreA = kindWeights[a.kind] - a.pixelDistance * 10;
				const scoreB = kindWeights[b.kind] - b.pixelDistance * 10;
				return scoreB - scoreA;
			});

			return evaluatedCandidates[0];
		}

		const pxFace = projectToPx(planeHit);
		const distFace = pxFace ? pointerPx.distanceTo(pxFace) : 0;
		return {
			point: planeHit,
			kind: 'face',
			label: 'On Face',
			pixelDistance: distFace
		};
	}

	setShiftLock(locked: boolean, direction: Vector3 | null = null) {
		this.shiftLocked = locked;
		this.lockedDirection = direction ? direction.clone().normalize() : null;
	}

	clear() {
		this.shiftLocked = false;
		this.lockedDirection = null;
	}
}
