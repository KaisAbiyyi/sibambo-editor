import { Ray, Vector3 } from 'three';
import type { BomcGraph, Face, Mesh } from '@sibambo/bomc-document';
import { closestAxisParameterToRay } from './axis-drag.js';
import { buildAuthoringTopology } from './topology.js';
import type { AuthoringPoint } from './protocol.js';
import { constructionGuides } from './construction-guides.js';

export const AUTHORING_SNAP_RADIUS_CSS_PX = 10;
export const AUTHORING_AXIS_ANGLE_DEGREES = 8;

export type AuthoringPlane = Readonly<{ origin: AuthoringPoint; normal: AuthoringPoint }>;
export type AuthoringAxis = 'x' | 'y' | 'z';
export type InferenceKind = 'endpoint' | 'edge' | 'closure' | 'face' | 'plane' | 'axis' | 'guide';
export type AuthoringInference = Readonly<{
	point: AuthoringPoint;
	kind: InferenceKind;
	faceId?: string;
	edge?: readonly [number, number];
	vertexIndex?: number;
	axis?: AuthoringAxis;
	plane: AuthoringPlane;
	screenDistancePx: number;
}>;

export type InferenceViewport = {
	rayFromScreen(clientX: number, clientY: number): Ray | null;
	projectWorldToScreen(point: readonly [number, number, number]): { x: number; y: number; inFront: boolean; visible: boolean } | null;
};

export type ResolveInferenceOptions = Readonly<{
	graph: BomcGraph;
	viewport: InferenceViewport;
	clientX: number;
	clientY: number;
	activePlane?: AuthoringPlane | null;
	anchor?: AuthoringPoint | null;
	closurePoint?: AuthoringPoint | null;
	restrictToPlane?: AuthoringPlane | null;
}>;

export type FaceRayHit = Readonly<{
	face: Face;
	point: AuthoringPoint;
	distance: number;
}>;

export type PushPullLevelSnap = Readonly<{
	distance: number;
	inference: AuthoringInference;
}>;

const AXES: readonly Readonly<{ name: AuthoringAxis; vector: AuthoringPoint }>[] = [
	{ name: 'x', vector: [1, 0, 0] },
	{ name: 'y', vector: [0, 1, 0] },
	{ name: 'z', vector: [0, 0, 1] }
];

function codeUnitCompare(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }

function pointAt(mesh: Mesh, vertex: number): AuthoringPoint {
	return [mesh.positions[vertex * 3]!, mesh.positions[vertex * 3 + 1]!, mesh.positions[vertex * 3 + 2]!];
}

function planeForFace(mesh: Mesh, face: Face): AuthoringPlane {
	return Object.freeze({ origin: pointAt(mesh, face.outer[0]!), normal: [face.normal[0], face.normal[1], face.normal[2]] });
}

function subtract(left: AuthoringPoint, right: AuthoringPoint): AuthoringPoint {
	return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function dot(left: AuthoringPoint, right: AuthoringPoint): number {
	return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function distanceToPlane(point: AuthoringPoint, plane: AuthoringPlane): number {
	return Math.abs(dot(subtract(point, plane.origin), plane.normal));
}

function pointAllowed(point: AuthoringPoint, plane?: AuthoringPlane | null): boolean {
	if (!plane) return true;
	const scale = Math.max(1, Math.abs(point[0]), Math.abs(point[1]), Math.abs(point[2]));
	return distanceToPlane(point, plane) <= 1e-9 * scale;
}

function intersectPlane(ray: Ray, plane: AuthoringPlane): AuthoringPoint | null {
	const normal = new Vector3(...plane.normal);
	const denominator = normal.dot(ray.direction);
	if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) return null;
	const origin = new Vector3(...plane.origin);
	const distance = normal.dot(origin.clone().sub(ray.origin)) / denominator;
	if (!Number.isFinite(distance) || distance < 0) return null;
	const point = ray.at(distance, new Vector3());
	return point.toArray().every(Number.isFinite) ? [point.x, point.y, point.z] : null;
}

function nearestAuthoringFaceHitWhere(graph: BomcGraph, ray: Ray, accept: (face: Face) => boolean): FaceRayHit | null {
	const mesh = graph.meshes[0];
	if (!mesh) return null;
	let best: FaceRayHit | null = null;
	for (const face of mesh.faces) {
		if (!accept(face)) continue;
		for (let index = 0; index < face.triangles.length; index += 3) {
			const a = new Vector3(...pointAt(mesh, face.triangles[index]!));
			const b = new Vector3(...pointAt(mesh, face.triangles[index + 1]!));
			const c = new Vector3(...pointAt(mesh, face.triangles[index + 2]!));
			const hit = ray.intersectTriangle(a, b, c, false, new Vector3());
			if (!hit) continue;
			const along = hit.clone().sub(ray.origin).dot(ray.direction);
			if (!Number.isFinite(along) || along < 0) continue;
			const distance = hit.distanceTo(ray.origin);
			if (!best || distance < best.distance - 1e-9
				|| Math.abs(distance - best.distance) <= 1e-9 && codeUnitCompare(face.id, best.face.id) < 0) {
				best = Object.freeze({ face, point: [hit.x, hit.y, hit.z] as AuthoringPoint, distance });
			}
		}
	}
	return best;
}

export function nearestAuthoringFaceHit(graph: BomcGraph, ray: Ray): FaceRayHit | null {
	return nearestAuthoringFaceHitWhere(graph, ray, () => true);
}

export function resolvePushPullLevelSnap(options: Readonly<{
	graph: BomcGraph;
	viewport: InferenceViewport;
	clientX: number;
	clientY: number;
	faceId: string;
}>): PushPullLevelSnap | null {
	if (!Number.isFinite(options.clientX) || !Number.isFinite(options.clientY)) return null;
	const mesh = options.graph.meshes[0];
	const target = mesh?.faces.find((face) => face.id === options.faceId);
	if (!mesh || !target) return null;
	const ray = options.viewport.rayFromScreen(options.clientX, options.clientY);
	if (!ray) return null;
	const hit = nearestAuthoringFaceHitWhere(options.graph, ray, (face) => face.id !== target.id);
	if (!hit || Math.abs(Math.abs(dot(hit.face.normal as AuthoringPoint, target.normal as AuthoringPoint)) - 1) > 1e-9) return null;
	const targetOrigin = pointAt(mesh, target.outer[0]!);
	const candidateOrigin = pointAt(mesh, hit.face.outer[0]!);
	const distance = dot(subtract(candidateOrigin, targetOrigin), target.normal as AuthoringPoint);
	if (!Number.isFinite(distance) || Math.abs(distance) < 1e-6) return null;
	return Object.freeze({
		distance,
		inference: Object.freeze({
			point: hit.point,
			kind: 'face' as const,
			faceId: hit.face.id,
			plane: planeForFace(mesh, hit.face),
			screenDistancePx: 0
		})
	});
}

function screenDistance(viewport: InferenceViewport, point: AuthoringPoint, clientX: number, clientY: number): number | null {
	const projected = viewport.projectWorldToScreen(point);
	if (!projected?.inFront) return null;
	const distance = Math.hypot(projected.x - clientX, projected.y - clientY);
	return Number.isFinite(distance) ? distance : null;
}

function endpointCandidate(options: ResolveInferenceOptions, mesh: Mesh, preferredFaceId: string | null): AuthoringInference | null {
	const vertices = [...new Set(mesh.faces.flatMap((face) => face.outer))].sort((a, b) => a - b);
	let best: AuthoringInference | null = null;
	for (const vertexIndex of vertices) {
		const point = pointAt(mesh, vertexIndex);
		if (!pointAllowed(point, options.restrictToPlane)) continue;
		const distance = screenDistance(options.viewport, point, options.clientX, options.clientY);
		if (distance === null || distance > AUTHORING_SNAP_RADIUS_CSS_PX) continue;
		const incidentFaces = mesh.faces
			.filter((candidate) => [candidate.outer, ...candidate.holes].some((ring) => ring.includes(vertexIndex)))
			.sort((left, right) => codeUnitCompare(left.id, right.id));
		const face = incidentFaces.find((candidate) => candidate.id === preferredFaceId) ?? incidentFaces[0];
		const plane = face ? planeForFace(mesh, face) : options.activePlane ?? { origin: point, normal: [0, 1, 0] };
		if (!best || distance < best.screenDistancePx - 1e-9
			|| Math.abs(distance - best.screenDistancePx) <= 1e-9 && vertexIndex < (best.vertexIndex ?? Number.MAX_SAFE_INTEGER)) {
			best = Object.freeze({ point, kind: 'endpoint', vertexIndex, faceId: face?.id, plane, screenDistancePx: distance });
		}
	}
	return best;
}

function edgeCandidate(options: ResolveInferenceOptions, mesh: Mesh, preferredFaceId: string | null): AuthoringInference | null {
	const topology = buildAuthoringTopology(mesh);
	let best: AuthoringInference | null = null;
	for (const edge of [...topology.edges.values()].sort((a, b) => a.a - b.a || a.b - b.b)) {
		const a = pointAt(mesh, edge.a); const b = pointAt(mesh, edge.b);
		const projectedA = options.viewport.projectWorldToScreen(a); const projectedB = options.viewport.projectWorldToScreen(b);
		if (!projectedA?.inFront || !projectedB?.inFront) continue;
		const dx = projectedB.x - projectedA.x; const dy = projectedB.y - projectedA.y;
		const lengthSq = dx * dx + dy * dy;
		if (!Number.isFinite(lengthSq) || lengthSq < 1e-12) continue;
		const rawT = ((options.clientX - projectedA.x) * dx + (options.clientY - projectedA.y) * dy) / lengthSq;
		const t = Math.max(0, Math.min(1, rawT));
		if (t <= 1e-9 || t >= 1 - 1e-9) continue;
		const point: AuthoringPoint = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
		if (!pointAllowed(point, options.restrictToPlane)) continue;
		const distance = screenDistance(options.viewport, point, options.clientX, options.clientY);
		if (distance === null || distance > AUTHORING_SNAP_RADIUS_CSS_PX) continue;
		const faceId = preferredFaceId && edge.faceIds.includes(preferredFaceId) ? preferredFaceId : edge.faceIds[0];
		const face = faceId ? topology.faceById.get(faceId) : undefined;
		const plane = face ? planeForFace(mesh, face) : options.activePlane ?? { origin: point, normal: [0, 1, 0] };
		if (!best || distance < best.screenDistancePx - 1e-9
			|| Math.abs(distance - best.screenDistancePx) <= 1e-9 && `${edge.a}:${edge.b}` < `${best.edge?.[0]}:${best.edge?.[1]}`) {
			best = Object.freeze({ point, kind: 'edge', edge: [edge.a, edge.b] as const, faceId, plane, screenDistancePx: distance });
		}
	}
	return best;
}

function closureCandidate(options: ResolveInferenceOptions): AuthoringInference | null {
	const point = options.closurePoint;
	if (!point || !pointAllowed(point, options.restrictToPlane)) return null;
	const distance = screenDistance(options.viewport, point, options.clientX, options.clientY);
	if (distance === null || distance > AUTHORING_SNAP_RADIUS_CSS_PX) return null;
	const plane = options.activePlane ?? { origin: point, normal: [0, 1, 0] as AuthoringPoint };
	return Object.freeze({ point, kind: 'closure', plane, screenDistancePx: distance });
}

function faceCandidate(options: ResolveInferenceOptions, mesh: Mesh, hit: FaceRayHit | null): AuthoringInference | null {
	if (!hit || !pointAllowed(hit.point, options.restrictToPlane)) return null;
	return Object.freeze({ point: hit.point, kind: 'face', faceId: hit.face.id, plane: planeForFace(mesh, hit.face), screenDistancePx: 0 });
}

function activePlaneCandidate(options: ResolveInferenceOptions, ray: Ray): AuthoringInference | null {
	if (!options.activePlane) return null;
	const point = intersectPlane(ray, options.activePlane);
	return point ? Object.freeze({ point, kind: 'plane' as const, plane: options.activePlane, screenDistancePx: 0 }) : null;
}

function axisCandidate(options: ResolveInferenceOptions, ray: Ray): AuthoringInference | null {
	const anchor = options.anchor;
	if (!anchor) return null;
	const projectedAnchor = options.viewport.projectWorldToScreen(anchor);
	if (!projectedAnchor?.inFront) return null;
	const pointerDx = options.clientX - projectedAnchor.x;
	const pointerDy = options.clientY - projectedAnchor.y;
	const pointerLength = Math.hypot(pointerDx, pointerDy);
	if (pointerLength < 1e-6) return null;
	let best: AuthoringInference | null = null;
	const angleLimit = AUTHORING_AXIS_ANGLE_DEGREES * Math.PI / 180;
	for (const candidate of AXES) {
		const projectedUnit = options.viewport.projectWorldToScreen([
			anchor[0] + candidate.vector[0], anchor[1] + candidate.vector[1], anchor[2] + candidate.vector[2]
		]);
		if (!projectedUnit?.inFront) continue;
		const dx = projectedUnit.x - projectedAnchor.x; const dy = projectedUnit.y - projectedAnchor.y;
		const projectedLength = Math.hypot(dx, dy);
		if (!Number.isFinite(projectedLength) || projectedLength < 1e-6) continue;
		const ux = dx / projectedLength; const uy = dy / projectedLength;
		const cosine = Math.min(1, Math.max(-1, Math.abs((pointerDx * ux + pointerDy * uy) / pointerLength)));
		const angle = Math.acos(cosine);
		const lineDistance = Math.abs(pointerDx * uy - pointerDy * ux);
		if (angle > angleLimit && lineDistance > AUTHORING_SNAP_RADIUS_CSS_PX) continue;
		const parameter = closestAxisParameterToRay(ray, anchor, candidate.vector);
		if (parameter === null) continue;
		const point: AuthoringPoint = [
			anchor[0] + candidate.vector[0] * parameter,
			anchor[1] + candidate.vector[1] * parameter,
			anchor[2] + candidate.vector[2] * parameter
		];
		if (!pointAllowed(point, options.restrictToPlane)) continue;
		const score = Math.min(lineDistance, angle / angleLimit * AUTHORING_SNAP_RADIUS_CSS_PX);
		if (!best || score < best.screenDistancePx - 1e-9
			|| Math.abs(score - best.screenDistancePx) <= 1e-9 && candidate.name < (best.axis ?? 'z')) {
			best = Object.freeze({
				point,
				kind: 'axis',
				axis: candidate.name,
				plane: { origin: anchor, normal: candidate.vector },
				screenDistancePx: score
			});
		}
	}
	return best;
}

export function resolveAuthoringInference(options: ResolveInferenceOptions): AuthoringInference | null {
	if (!Number.isFinite(options.clientX) || !Number.isFinite(options.clientY)) return null;
	const ray = options.viewport.rayFromScreen(options.clientX, options.clientY);
	if (!ray) return null;
	const mesh = options.graph.meshes[0];
	const faceHit = mesh ? nearestAuthoringFaceHit(options.graph, ray) : null;
	if (mesh) {
		const endpoint = endpointCandidate(options, mesh, faceHit?.face.id ?? null); if (endpoint) return endpoint;
		const edge = edgeCandidate(options, mesh, faceHit?.face.id ?? null); if (edge) return edge;
	}
	const closure = closureCandidate(options); if (closure) return closure;
	let guideCandidate:AuthoringInference|null=null;
	for(const guide of constructionGuides.get(options.graph)??[]){
		const direction=new Vector3(...guide.end).sub(new Vector3(...guide.start));
		let amount=guide.kind!=='point'?closestAxisParameterToRay(ray,guide.start,[direction.x,direction.y,direction.z]):0;
		if(amount===null)continue;
		if(guide.kind==='edge')amount=Math.max(0,Math.min(direction.length(),amount));
		const vector=new Vector3(...guide.start).addScaledVector(direction.normalize(),amount),point:AuthoringPoint=[vector.x,vector.y,vector.z];
		if(!pointAllowed(point,options.restrictToPlane))continue;
		const distance=screenDistance(options.viewport,point,options.clientX,options.clientY);
		if(distance===null||distance>AUTHORING_SNAP_RADIUS_CSS_PX||guideCandidate&&distance>=guideCandidate.screenDistancePx)continue;
		guideCandidate={point,kind:'guide',plane:options.activePlane??{origin:point,normal:[0,1,0]},screenDistancePx:distance};
	}
	if(guideCandidate)return guideCandidate;
	if (mesh) {
		const face = faceCandidate(options, mesh, faceHit); if (face) return face;
	}
	const plane = activePlaneCandidate(options, ray); if (plane) return plane;
	return axisCandidate(options, ray);
}

export function inferenceLabel(inference: AuthoringInference | null): string {
	if (!inference) return '';
	if (inference.kind === 'endpoint') return 'Endpoint';
	if (inference.kind === 'edge') return 'On Edge';
	if (inference.kind === 'closure') return 'Close Loop';
	if (inference.kind === 'face') return 'On Face';
	if (inference.kind === 'axis') return `${inference.axis?.toUpperCase() ?? ''} Axis`.trim();
	if (inference.kind === 'guide') return 'On Guide';
	return Math.abs(inference.plane.normal[1]) > 0.999999 ? 'Ground' : 'On Plane';
}

export function constructionBasis(
	normalTuple: AuthoringPoint,
	anchor: AuthoringPoint,
	viewport: InferenceViewport
): readonly [AuthoringPoint, AuthoringPoint] {
	const normal = new Vector3(...normalTuple).normalize();
	const projectedAnchor = viewport.projectWorldToScreen(anchor);
	const candidates = AXES.map((axis, order) => {
		const world = new Vector3(...axis.vector);
		const tangent = world.clone().addScaledVector(normal, -world.dot(normal));
		const tangentLength = tangent.length();
		if (tangentLength < 1e-9) return null;
		tangent.multiplyScalar(1 / tangentLength);
		const projected = viewport.projectWorldToScreen([anchor[0] + tangent.x, anchor[1] + tangent.y, anchor[2] + tangent.z]);
		const screenLength = projectedAnchor?.inFront && projected?.inFront ? Math.hypot(projected.x - projectedAnchor.x, projected.y - projectedAnchor.y) : 0;
		return { tangent, parallelScore: Math.abs(world.dot(normal)), screenLength, order };
	}).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
		.sort((left, right) => left.parallelScore - right.parallelScore || right.screenLength - left.screenLength || left.order - right.order);
	const first = candidates[0]?.tangent ?? new Vector3(1, 0, 0);
	const second = new Vector3().crossVectors(normal, first).normalize();
	return Object.freeze([
		Object.freeze(first.toArray() as AuthoringPoint),
		Object.freeze(second.toArray() as AuthoringPoint)
	]);
}

export function rectangleCorners(
	first: AuthoringPoint,
	opposite: AuthoringPoint,
	basis: readonly [AuthoringPoint, AuthoringPoint]
): readonly AuthoringPoint[] {
	const delta = subtract(opposite, first);
	const u = dot(delta, basis[0]); const v = dot(delta, basis[1]);
	return Object.freeze([
		first,
		[first[0] + basis[0][0] * u, first[1] + basis[0][1] * u, first[2] + basis[0][2] * u],
		[first[0] + basis[0][0] * u + basis[1][0] * v, first[1] + basis[0][1] * u + basis[1][1] * v, first[2] + basis[0][2] * u + basis[1][2] * v],
		[first[0] + basis[1][0] * v, first[1] + basis[1][1] * v, first[2] + basis[1][2] * v]
	] as AuthoringPoint[]);
}
