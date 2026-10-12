import { ShapeUtils, Vector2 } from 'three';
import type { BomcGraph, DocumentEdit, Face, Mesh, SolidMaterial } from '@sibambo/bomc-document';
import type { AuthoringPoint, AuthoringJournalEntry } from './protocol.js';
import { AuthoringPolygonError, MIN_AUTHORING_EDGE_METRES, preparePolygon, type Point3 } from './polygon.js';
import { AuthoringTopologyError, buildAuthoringTopology } from './topology.js';

const SHAPE_SCHEMA = 'sibambo-editor-shape-v1';
const SHAPE_SCHEMA_V2 = 'sibambo-editor-shape-v2';
const ROOT_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
const DEFAULT_RGBA = [155, 28, 49, 255] as const;
const NEUTRAL_RGBA = [226, 226, 226, 255] as const;
const MIN_EDGE_METRES = 1e-6;
const NORMAL_TOLERANCE = 1e-12;

export const DEFAULT_AUTHORING_MATERIAL_NAME = 'Default';
export const NEUTRAL_AUTHORING_RGBA = NEUTRAL_RGBA;
export const AUTHORING_SHAPE_SCHEMA_V2 = SHAPE_SCHEMA_V2;

export class AuthoringGeometryError extends Error {
	readonly code = 'INVALID_COMMAND' as const;
	constructor(message: string) { super(message); this.name = 'AuthoringGeometryError'; }
}

export type AuthoringEntity = {
	entityId: string;
	sequence: number;
	kind: 'rectangle' | 'extrusion' | 'face';
	faces: readonly Face[];
	baseFace: Face;
	outer: readonly number[];
	distance: number | null;
};

export type EditableSubsetResult =
	| { editable: true; entities: readonly AuthoringEntity[] }
	| { editable: false; reason: string };

export type GeometryEdit = { forward: DocumentEdit[]; inverse: DocumentEdit[] };

function codeUnitCompare(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }
function invalid(message: string): never { throw new AuthoringGeometryError(message); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function sameTuple(left: readonly number[], right: readonly number[]) {
	return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}
function jsonLabel(values: readonly unknown[]) { return JSON.stringify(values); }
function tupleLabel(face: Face): unknown[] | null {
	if (face.label === null) return null;
	try {
		const parsed: unknown = JSON.parse(face.label);
		return Array.isArray(parsed) && JSON.stringify(parsed) === face.label ? parsed : null;
	} catch { return null; }
}
function sequenceForEntity(documentId: string, entityId: string): number | null {
	const prefix = `${documentId}:rectangle:`;
	if (!entityId.startsWith(prefix)) return null;
	const suffix = entityId.slice(prefix.length);
	if (!/^[1-9]\d*$/.test(suffix)) return null;
	const sequence = Number(suffix);
	return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}
function sequenceForApplicationId(documentId: string, value: string): number | null {
	for (const kind of ['rectangle', 'face', 'op'] as const) {
		const prefix = `${documentId}:${kind}:`;
		if (!value.startsWith(prefix)) continue;
		const suffix = value.slice(prefix.length).split(':', 1)[0]!;
		if (!/^[1-9]\d*$/.test(suffix)) return null;
		const sequence = Number(suffix);
		return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
	}
	return null;
}
function defaultMaterialId(graph: BomcGraph) { return `${graph.documentId}:material:default`; }
function neutralMaterialId(graph: BomcGraph) { return `${graph.documentId}:material:authoring-neutral`; }
function rootMeshId(graph: BomcGraph) { return `${graph.documentId}:mesh:root`; }

function validateRectanglePoints(first: AuthoringPoint, opposite: AuthoringPoint) {
	for (const [label, point] of [['first', first], ['opposite', opposite]] as const) {
		if (!Array.isArray(point) || point.length !== 3 || !Object.is(point[1], 0) || point.some((coordinate) => !finite(coordinate))) {
			invalid(`${label} must contain finite [x,0,z] metre coordinates.`);
		}
	}
	const width = Math.abs(opposite[0] - first[0]);
	const depth = Math.abs(opposite[2] - first[2]);
	if (!Number.isFinite(width) || !Number.isFinite(depth) || width < MIN_EDGE_METRES || depth < MIN_EDGE_METRES) {
		invalid('Rectangle side lengths must each be at least 1e-6 metres.');
	}
}

export function validateRectangleInput(first: AuthoringPoint, opposite: AuthoringPoint): void {
	validateRectanglePoints(first, opposite);
}

function defaultMaterial(graph: BomcGraph): SolidMaterial {
	return {
		id: defaultMaterialId(graph),
		name: DEFAULT_AUTHORING_MATERIAL_NAME,
		displayName: null,
		rgba: [DEFAULT_RGBA[0], DEFAULT_RGBA[1], DEFAULT_RGBA[2], DEFAULT_RGBA[3]],
		opacityU16: 65535
	};
}

function neutralMaterial(graph: BomcGraph, useDefaultId = graph.materials.length === 0): SolidMaterial {
	return {
		id: useDefaultId ? defaultMaterialId(graph) : neutralMaterialId(graph),
		name: DEFAULT_AUTHORING_MATERIAL_NAME,
		displayName: null,
		rgba: [NEUTRAL_RGBA[0], NEUTRAL_RGBA[1], NEUTRAL_RGBA[2], NEUTRAL_RGBA[3]],
		opacityU16: 65535
	};
}

export function isNeutralMaterial(graph: BomcGraph, material: SolidMaterial): boolean {
	return (material.id === defaultMaterialId(graph) || material.id === neutralMaterialId(graph))
		&& material.name === DEFAULT_AUTHORING_MATERIAL_NAME && material.displayName === null
		&& sameTuple(material.rgba, NEUTRAL_RGBA) && material.opacityU16 === 65535;
}

export function isLegacyMaterial(graph: BomcGraph, material: SolidMaterial): boolean {
	return material.id === defaultMaterialId(graph) && sameMaterial(material, defaultMaterial(graph));
}

function currentNeutralMaterial(graph: BomcGraph): SolidMaterial | null {
	return graph.materials.find((material) => isNeutralMaterial(graph, material)) ?? null;
}

function materialForNewGeometry(graph: BomcGraph): { material: SolidMaterial; add: boolean } {
	const existing = currentNeutralMaterial(graph);
	if (existing) return { material: existing, add: false };
	const material = neutralMaterial(graph, graph.materials.length === 0);
	return { material, add: true };
}

function validateFlatRootIdentity(graph: BomcGraph): { definitionIndex: number; mesh: Mesh | null } {
	const definitionId = `${graph.documentId}:definition:root`;
	const instanceId = `${graph.documentId}:instance:root`;
	if (graph.rootDefinitionId !== definitionId || graph.rootInstanceId !== instanceId
		|| graph.definitions.length !== 1 || graph.instances.length !== 1) {
		invalid('Only the flat BOMC root definition and root instance can be edited.');
	}
	const definitionIndex = graph.definitions.findIndex((definition) => definition.id === definitionId);
	const definition = graph.definitions[definitionIndex];
	const root = graph.instances[0];
	if (!definition || definition.name !== 'Document Root' || definition.kind !== 'model'
		|| !root || root.id !== instanceId || root.name !== 'Root' || root.kind !== 'root'
		|| root.ownerDefinitionId !== null || root.definitionId !== definitionId
		|| !sameTuple(root.matrix, ROOT_MATRIX) || root.materialId !== null || root.visible !== true
		|| root.roleCode !== 0 || root.label !== null) {
		invalid('The canonical flat root identity is unsupported.');
	}
	if (graph.meshes.length === 0) {
		if (definition.meshId !== null || graph.materials.length !== 0) invalid('An empty authoring graph must have no mesh or material.');
		return { definitionIndex, mesh: null };
	}
	if (graph.meshes.length !== 1) invalid('Authoring supports exactly one root mesh.');
	const mesh = graph.meshes[0];
	if (!mesh || mesh.id !== rootMeshId(graph) || mesh.definitionId !== definitionId || definition.meshId !== mesh.id) {
		invalid('The root mesh identity is unsupported.');
	}
	return { definitionIndex, mesh };
}

function validateRootForTopologyEditing(graph: BomcGraph): { definitionIndex: number; mesh: Mesh | null } {
	const root = validateFlatRootIdentity(graph);
	if (!root.mesh) return root;
	if (graph.materials.length < 1 || graph.materials.length > 2
		|| graph.materials.some((material) => !isLegacyMaterial(graph, material) && !isNeutralMaterial(graph, material))) {
		invalid('Authoring topology supports only the legacy and neutral application materials.');
	}
	if (new Set(graph.materials.map((material) => material.id)).size !== graph.materials.length) invalid('Authoring material IDs must be unique.');
	return root;
}

function validateRootForEditing(graph: BomcGraph): { definitionIndex: number; mesh: Mesh | null } {
	const definitionId = `${graph.documentId}:definition:root`;
	const instanceId = `${graph.documentId}:instance:root`;
	if (graph.rootDefinitionId !== definitionId || graph.rootInstanceId !== instanceId
		|| graph.definitions.length !== 1 || graph.instances.length !== 1) {
		invalid('Only the flat BOMC root definition and root instance can be edited.');
	}
	const definitionIndex = graph.definitions.findIndex((definition) => definition.id === definitionId);
	const definition = graph.definitions[definitionIndex];
	const root = graph.instances[0];
	if (!definition || definition.name !== 'Document Root' || definition.kind !== 'model'
		|| !root || root.id !== instanceId || root.name !== 'Root' || root.kind !== 'root'
		|| root.ownerDefinitionId !== null || root.definitionId !== definitionId
		|| !sameTuple(root.matrix, ROOT_MATRIX) || root.materialId !== null || root.visible !== true
		|| root.roleCode !== 0 || root.label !== null) {
		invalid('The canonical flat root identity is unsupported.');
	}
	if (graph.meshes.length === 0) {
		if (definition.meshId !== null || graph.materials.length !== 0) invalid('An empty authoring graph must have no mesh or material.');
		return { definitionIndex, mesh: null };
	}
	if (graph.meshes.length !== 1) invalid('Authoring supports exactly one root mesh.');
	const mesh = graph.meshes[0];
	if (!mesh || mesh.id !== rootMeshId(graph) || mesh.definitionId !== definitionId || definition.meshId !== mesh.id) {
		invalid('The root mesh identity is unsupported.');
	}
	if (graph.materials.length !== 1 || !sameMaterial(graph.materials[0]!, defaultMaterial(graph))) {
		invalid('Authoring supports only the exact default solid material.');
	}
	return { definitionIndex, mesh };
}

function sameMaterial(left: SolidMaterial, right: SolidMaterial) {
	return left.id === right.id && left.name === right.name && left.displayName === right.displayName
		&& sameTuple(left.rgba, right.rgba) && Object.is(left.opacityU16, right.opacityU16);
}

function assertUniqueEntityId(graph: BomcGraph, entityId: string) {
	if (sequenceForEntity(graph.documentId, entityId) === null) invalid('Entity ID must use a positive decimal rectangle sequence for this document.');
	if (graph.meshes.some((mesh) => mesh.faces.some((face) => face.id === entityId || tupleLabel(face)?.[2] === entityId))) {
		invalid(`Entity ${entityId} already exists.`);
	}
}

function rectangleFace(entityId: string, meshStart: number, graph: BomcGraph): Face {
	const corners = [meshStart, meshStart + 1, meshStart + 2, meshStart + 3];
	return {
		id: entityId,
		outer: corners,
		holes: [],
		triangles: [corners[0]!, corners[1]!, corners[2]!, corners[0]!, corners[2]!, corners[3]!],
		normal: [0, 1, 0],
		frontMaterialId: defaultMaterialId(graph),
		backMaterialId: defaultMaterialId(graph),
		hidden: false,
		surfaceCode: 0,
		roleCode: 0,
		label: jsonLabel([SHAPE_SCHEMA, 'rectangle', entityId])
	};
}

function withSortedFaces(mesh: Mesh, faces: readonly Face[]): Mesh {
	return { ...mesh, faces: [...faces].sort((left, right) => codeUnitCompare(left.id, right.id)) };
}

/** Build one immutable flat rectangle edit without mutating the supplied graph. */
export function buildRectangleEdit(graph: BomcGraph, entityId: string, first: AuthoringPoint, opposite: AuthoringPoint): GeometryEdit {
	validateRectanglePoints(first, opposite);
	assertUniqueEntityId(graph, entityId);
	const { definitionIndex, mesh: previousMesh } = validateRootForEditing(graph);
	const meshId = rootMeshId(graph);
	const definition = graph.definitions[definitionIndex]!;
	const bounds = {
		xmin: Math.min(first[0], opposite[0]),
		xmax: Math.max(first[0], opposite[0]),
		zmin: Math.min(first[2], opposite[2]),
		zmax: Math.max(first[2], opposite[2])
	};
	const positionStart = previousMesh ? previousMesh.positions.length / 3 : 0;
	const newPositions = [
		bounds.xmin, 0, bounds.zmin,
		bounds.xmin, 0, bounds.zmax,
		bounds.xmax, 0, bounds.zmax,
		bounds.xmax, 0, bounds.zmin
	];
	const base: Mesh = previousMesh
		? { ...previousMesh, positions: [...previousMesh.positions, ...newPositions] }
		: { id: meshId, definitionId: graph.rootDefinitionId, positions: newPositions, faces: [] };
	const nextMesh = withSortedFaces(base, [...base.faces, rectangleFace(entityId, positionStart, graph)]);
	if (previousMesh) {
		return { forward: [{ type: 'put-mesh', value: nextMesh }], inverse: [{ type: 'put-mesh', value: previousMesh }] };
	}
	const nextDefinition = { ...definition, meshId };
	return {
		forward: [
			{ type: 'put-material', value: defaultMaterial(graph) },
			{ type: 'put-definition', value: nextDefinition },
			{ type: 'put-mesh', value: nextMesh }
		],
		inverse: [
			{ type: 'delete-mesh', id: meshId },
			{ type: 'put-definition', value: definition },
			{ type: 'delete-material', id: defaultMaterialId(graph) }
		]
	};
}

function vectorAt(positions: readonly number[], vertex: number): [number, number, number] {
	return [positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!];
}

function normalizedCross(a: readonly number[], b: readonly number[], c: readonly number[]): [number, number, number] {
	const ux = b[0]! - a[0]!; const uy = b[1]! - a[1]!; const uz = b[2]! - a[2]!;
	const vx = c[0]! - a[0]!; const vy = c[1]! - a[1]!; const vz = c[2]! - a[2]!;
	const nx = uy * vz - uz * vy;
	const ny = uz * vx - ux * vz;
	const nz = ux * vy - uy * vx;
	const length = Math.hypot(nx, ny, nz);
	if (!Number.isFinite(length) || length === 0) invalid('Extrusion side produced a degenerate face.');
	return [nx / length, ny / length, nz / length];
}

function pointEqual(left: readonly number[], right: readonly number[]): boolean {
	return left.length === 3 && right.length === 3 && left.every((value, index) => Object.is(value, right[index]));
}

function rawRingNormal(mesh: Mesh, ring: readonly number[]): [number, number, number] {
	// Sum the signed area of the complete ring. A first fan triangle can be
	// almost collinear after an edge split, amplifying construction roundoff.
	const origin = vectorAt(mesh.positions, ring[0]!);
	const normal = [0, 0, 0];
	for (let index = 1; index + 1 < ring.length; index += 1) {
		const a = subtract3(vectorAt(mesh.positions, ring[index]!), origin);
		const b = subtract3(vectorAt(mesh.positions, ring[index + 1]!), origin);
		normal[0]! += a[1] * b[2] - a[2] * b[1];
		normal[1]! += a[2] * b[0] - a[0] * b[2];
		normal[2]! += a[0] * b[1] - a[1] * b[0];
	}
	const magnitude = Math.hypot(...normal);
	if (magnitude >= 1e-15 && Number.isFinite(magnitude)) return normal.map(value => value / magnitude) as [number, number, number];
	invalid('Face ring is degenerate.');
}

function dot3(left: readonly number[], right: readonly number[]) {
	return left[0]! * right[0]! + left[1]! * right[1]! + left[2]! * right[2]!;
}

function subtract3(left: readonly number[], right: readonly number[]): Point3 {
	return [left[0]! - right[0]!, left[1]! - right[1]!, left[2]! - right[2]!];
}

function pointOnSegmentInterior3(point: Point3, start: Point3, end: Point3): boolean {
	const edge = subtract3(end, start);
	const relative = subtract3(point, start);
	const lengthSquared = dot3(edge, edge);
	if (!Number.isFinite(lengthSquared) || lengthSquared < MIN_AUTHORING_EDGE_METRES * MIN_AUTHORING_EDGE_METRES) return false;
	const parameter = dot3(relative, edge) / lengthSquared;
	if (parameter <= 1e-9 || parameter >= 1 - 1e-9) return false;
	const closest: Point3 = [
		start[0] + edge[0] * parameter,
		start[1] + edge[1] * parameter,
		start[2] + edge[2] * parameter
	];
	const tolerance = 1e-9 * Math.max(1, Math.sqrt(lengthSquared));
	return Math.hypot(point[0] - closest[0], point[1] - closest[1], point[2] - closest[2]) <= tolerance;
}

type Point2 = readonly [number, number];

function projectionAxis(normal: Point3): 0 | 1 | 2 {
	const absolute = normal.map(Math.abs);
	return absolute[0]! >= absolute[1]! && absolute[0]! >= absolute[2]! ? 0 : absolute[1]! >= absolute[2]! ? 1 : 2;
}

function projectPoint2(point: Point3, drop: 0 | 1 | 2): Point2 {
	return drop === 0 ? [point[1], point[2]] : drop === 1 ? [point[0], point[2]] : [point[0], point[1]];
}

function orientedTriangle(
	mesh: Mesh,
	triangle: readonly [number, number, number],
	normal: Point3
): [number, number, number] {
	const a = vectorAt(mesh.positions, triangle[0]);
	const b = vectorAt(mesh.positions, triangle[1]);
	const c = vectorAt(mesh.positions, triangle[2]);
	const ab = subtract3(b, a); const ac = subtract3(c, a);
	const cross: Point3 = [
		ab[1] * ac[2] - ab[2] * ac[1],
		ab[2] * ac[0] - ab[0] * ac[2],
		ab[0] * ac[1] - ab[1] * ac[0]
	];
	const alignment = dot3(cross, normal);
	if (!Number.isFinite(alignment) || Math.abs(alignment) < 1e-18) invalid('Face triangulation produced a degenerate triangle.');
	return alignment > 0 ? [...triangle] : [triangle[0], triangle[2], triangle[1]];
}

function triangulateFaceRings(
	mesh: Mesh,
	outer: readonly number[],
	holes: readonly (readonly number[])[],
	normal: Point3
): number[] {
	const drop = projectionAxis(normal);
	const rings = [outer, ...holes];
	const projected = rings.map((ring) => ring.map((vertex) => {
		const point = projectPoint2(vectorAt(mesh.positions, vertex), drop);
		return new Vector2(point[0], point[1]);
	}));
	const source = rings.flatMap((ring) => [...ring]);
	const triangles = ShapeUtils.triangulateShape(projected[0] ?? [], projected.slice(1));
	if (triangles.length === 0) invalid('Face rings could not be triangulated.');
	return triangles.flatMap((local) => {
		const triangle = [source[local[0]!]!, source[local[1]!]!, source[local[2]!]!] as const;
		return orientedTriangle(mesh, triangle, normal);
	});
}

function orient2(left: Point2, middle: Point2, right: Point2): number {
	return (middle[0] - left[0]) * (right[1] - left[1]) - (middle[1] - left[1]) * (right[0] - left[0]);
}

function samePoint2(left: Point2, right: Point2, tolerance: number): boolean {
	return Math.hypot(left[0] - right[0], left[1] - right[1]) <= tolerance;
}

function pointOnSegment2(point: Point2, start: Point2, end: Point2, tolerance: number): boolean {
	return Math.abs(orient2(start, end, point)) <= tolerance
		&& point[0] >= Math.min(start[0], end[0]) - tolerance && point[0] <= Math.max(start[0], end[0]) + tolerance
		&& point[1] >= Math.min(start[1], end[1]) - tolerance && point[1] <= Math.max(start[1], end[1]) + tolerance;
}

function properSegmentsCross(a: Point2, b: Point2, c: Point2, d: Point2, tolerance: number): boolean {
	const abC = orient2(a, b, c); const abD = orient2(a, b, d);
	const cdA = orient2(c, d, a); const cdB = orient2(c, d, b);
	return ((abC > tolerance && abD < -tolerance) || (abC < -tolerance && abD > tolerance))
		&& ((cdA > tolerance && cdB < -tolerance) || (cdA < -tolerance && cdB > tolerance));
}

function collinearOverlapNeedsSplit(a: Point2, b: Point2, c: Point2, d: Point2, tolerance: number): boolean {
	if (Math.abs(orient2(a, b, c)) > tolerance || Math.abs(orient2(a, b, d)) > tolerance) return false;
	const exactShared = (samePoint2(a, c, tolerance) && samePoint2(b, d, tolerance))
		|| (samePoint2(a, d, tolerance) && samePoint2(b, c, tolerance));
	if (exactShared) return false;
	const axis = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 0 : 1;
	const [a0, a1] = [Math.min(a[axis], b[axis]), Math.max(a[axis], b[axis])];
	const [c0, c1] = [Math.min(c[axis], d[axis]), Math.max(c[axis], d[axis])];
	return Math.min(a1, c1) - Math.max(a0, c0) > tolerance;
}

function pointInPolygonStrict(point: Point2, polygon: readonly Point2[], tolerance: number): boolean {
	for (let index = 0; index < polygon.length; index += 1) {
		if (pointOnSegment2(point, polygon[index]!, polygon[(index + 1) % polygon.length]!, tolerance)) return false;
	}
	let inside = false;
	for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
		const a = polygon[index]!; const b = polygon[previous]!;
		const crosses = (a[1] > point[1]) !== (b[1] > point[1]);
		if (crosses && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
	}
	return inside;
}

function ringsCrossOrOverlap(first: readonly Point2[], second: readonly Point2[], tolerance: number): boolean {
	for (let aIndex = 0; aIndex < first.length; aIndex += 1) {
		const a = first[aIndex]!; const b = first[(aIndex + 1) % first.length]!;
		for (let cIndex = 0; cIndex < second.length; cIndex += 1) {
			const c = second[cIndex]!; const d = second[(cIndex + 1) % second.length]!;
			if (properSegmentsCross(a, b, c, d, tolerance) || collinearOverlapNeedsSplit(a, b, c, d, tolerance)) return true;
		}
	}
	return false;
}

function pointInsideFaceRegion(point: Point2, outer: readonly Point2[], holes: readonly (readonly Point2[])[], tolerance: number): boolean {
	if (!pointInPolygonStrict(point, outer, tolerance)) return false;
	return holes.every((hole) => !pointInPolygonStrict(point, hole, tolerance)
		&& !hole.some((start, index) => pointOnSegment2(point, start, hole[(index + 1) % hole.length]!, tolerance)));
}

function projectedFaceRegionsOverlap(mesh: Mesh, first: Face, second: Face, normal: Point3): boolean {
	const drop = projectionAxis(normal);
	const projectRing = (ring: readonly number[]) => ring.map((vertex) => projectPoint2(vectorAt(mesh.positions, vertex), drop));
	const firstOuter = projectRing(first.outer);
	const firstHoles = first.holes.map(projectRing);
	const secondOuter = projectRing(second.outer);
	const secondHoles = second.holes.map(projectRing);
	const allPoints = [...firstOuter, ...firstHoles.flat(), ...secondOuter, ...secondHoles.flat()];
	const scale = Math.max(1, ...allPoints.flatMap((point) => point.map(Math.abs)));
	const tolerance = 1e-9 * scale;
	const ringsProperlyIntersect = (left: readonly Point2[], right: readonly Point2[]) => {
		for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
			const a = left[leftIndex]!; const b = left[(leftIndex + 1) % left.length]!;
			for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
				const c = right[rightIndex]!; const d = right[(rightIndex + 1) % right.length]!;
				if (properSegmentsCross(a, b, c, d, tolerance)) return true;
			}
		}
		return false;
	};
	const triangleCentroids = (face: Face) => {
		const centroids: Point2[] = [];
		for (let index = 0; index + 2 < face.triangles.length; index += 3) {
			const a = projectPoint2(vectorAt(mesh.positions, face.triangles[index]!), drop);
			const b = projectPoint2(vectorAt(mesh.positions, face.triangles[index + 1]!), drop);
			const c = projectPoint2(vectorAt(mesh.positions, face.triangles[index + 2]!), drop);
			centroids.push([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3]);
		}
		return centroids;
	};
	const firstRings = [firstOuter, ...firstHoles];
	const secondRings = [secondOuter, ...secondHoles];
	// Boundary-only contact is not an opposite-shell collision. This matters for
	// a raised child box whose side projects down to the top edge of the lower
	// slab wall: the two regions touch in projection but have zero shared area.
	if (firstRings.some((left) => secondRings.some((right) => ringsProperlyIntersect(left, right)))) return true;
	if (firstOuter.some((point) => pointInsideFaceRegion(point, secondOuter, secondHoles, tolerance))) return true;
	if (secondOuter.some((point) => pointInsideFaceRegion(point, firstOuter, firstHoles, tolerance))) return true;
	// Coincident/projectively identical opposite faces have no proper boundary
	// crossing and no strictly-inside boundary vertex, but their triangle
	// interiors overlap. Centroids distinguish that case from edge-only contact.
	if (triangleCentroids(first).some((point) => pointInsideFaceRegion(point, secondOuter, secondHoles, tolerance))) return true;
	return triangleCentroids(second).some((point) => pointInsideFaceRegion(point, firstOuter, firstHoles, tolerance));
}

function projectedOuterMatchesHole(mesh: Mesh, selected: Face, candidate: Face): boolean {
	if (selected.holes.length === 0 || candidate.outer.length < 3) return false;
	const drop = projectionAxis(selected.normal);
	const candidate2 = candidate.outer.map((vertex) => projectPoint2(vectorAt(mesh.positions, vertex), drop));
	const all = [...candidate2, ...selected.holes.flatMap((ring) => ring.map((vertex) => projectPoint2(vectorAt(mesh.positions, vertex), drop)))];
	const scale = Math.max(1, ...all.flatMap((point) => point.map(Math.abs)));
	const tolerance = 1e-9 * scale;
	const cycleMatches = (hole2: readonly Point2[]) => {
		if (hole2.length !== candidate2.length) return false;
		for (const source of [candidate2, [...candidate2].reverse()] as const) {
			for (let offset = 0; offset < source.length; offset += 1) {
				let matches = true;
				for (let index = 0; index < hole2.length; index += 1) {
					if (!samePoint2(hole2[index]!, source[(index + offset) % source.length]!, tolerance)) { matches = false; break; }
				}
				if (matches) return true;
			}
		}
		return false;
	};
	return selected.holes.some((ring) => cycleMatches(ring.map((vertex) => projectPoint2(vectorAt(mesh.positions, vertex), drop))));
}

function candidateStrictlyInsideFace(
	mesh: Mesh,
	face: Face,
	candidatePoints: readonly Point3[],
	candidateNormal: Point3
): boolean {
	if (Math.abs(Math.abs(dot3(face.normal, candidateNormal)) - 1) > 1e-9) return false;
	const anchor = candidatePoints[0]!;
	const scale = Math.max(1, ...candidatePoints.flatMap((point) => point.map(Math.abs)));
	const tolerance = 1e-9 * scale;
	const facePoints = face.outer.map((vertex) => vectorAt(mesh.positions, vertex) as Point3);
	if (facePoints.some((point) => Math.abs(dot3(subtract3(point, anchor), candidateNormal)) > tolerance)) return false;
	const drop = projectionAxis(candidateNormal);
	const candidate2 = candidatePoints.map((point) => projectPoint2(point, drop));
	const outer2 = facePoints.map((point) => projectPoint2(point, drop));
	const holes2 = face.holes.map((ring) => ring.map((vertex) => projectPoint2(vectorAt(mesh.positions, vertex), drop)));
	if (!candidate2.every((point) => pointInsideFaceRegion(point, outer2, holes2, tolerance))) return false;
	if (ringsCrossOrOverlap(candidate2, outer2, tolerance) || holes2.some((hole) => ringsCrossOrOverlap(candidate2, hole, tolerance))) return false;
	if (holes2.some((hole) => hole.some((point) => pointInPolygonStrict(point, candidate2, tolerance)))) return false;
	return true;
}

function candidateOverlapsFaceRegion(
	mesh: Mesh,
	face: Face,
	candidatePoints: readonly Point3[],
	candidateNormal: Point3
): boolean {
	if (Math.abs(Math.abs(dot3(face.normal, candidateNormal)) - 1) > 1e-9) return false;
	const anchor = candidatePoints[0]!;
	const facePoints = face.outer.map((vertex) => vectorAt(mesh.positions, vertex) as Point3);
	const scale = Math.max(1, ...candidatePoints.flatMap((point) => point.map(Math.abs)), ...facePoints.flatMap((point) => point.map(Math.abs)));
	const tolerance = 1e-9 * scale;
	if (facePoints.some((point) => Math.abs(dot3(subtract3(point, anchor), candidateNormal)) > tolerance)) return false;
	const drop = projectionAxis(candidateNormal);
	const candidate2 = candidatePoints.map((point) => projectPoint2(point, drop));
	const outer2 = facePoints.map((point) => projectPoint2(point, drop));
	const holes2 = face.holes.map((ring) => ring.map((vertex) => projectPoint2(vectorAt(mesh.positions, vertex), drop)));
	if (candidate2.some((point) => pointInsideFaceRegion(point, outer2, holes2, tolerance))) return true;
	if (outer2.some((point) => pointInPolygonStrict(point, candidate2, tolerance))) return true;
	if (ringsCrossOrOverlap(candidate2, outer2, tolerance)) return true;
	return holes2.some((hole) => ringsCrossOrOverlap(candidate2, hole, tolerance));
}

function insertionHostFace(previousMesh: Mesh, candidatePoints: readonly Point3[], candidateNormal: Point3): Face | null {
	const existingVertices = [...new Set(previousMesh.faces.flatMap((face) => [face.outer, ...face.holes].flatMap((ring) => [...ring])))];
	const existingEdges = new Map<string, readonly [number, number]>();
	for (const face of previousMesh.faces) for (const ring of [face.outer, ...face.holes]) for (let index = 0; index < ring.length; index += 1) {
		const first = ring[index]!; const second = ring[(index + 1) % ring.length]!;
		const key = first < second ? `${first}:${second}` : `${second}:${first}`;
		if (!existingEdges.has(key)) existingEdges.set(key, [first, second]);
	}

	for (const point of candidatePoints) {
		if (exactVertexIndex(previousMesh.positions, point) !== null) continue;
		for (const [first, second] of existingEdges.values()) {
			if (pointOnSegmentInterior3(point, vectorAt(previousMesh.positions, first), vectorAt(previousMesh.positions, second))) {
					invalid('New face endpoint lies inside an existing edge; edge splitting at a boundary snap is not supported yet.');
			}
		}
	}
	for (const vertex of existingVertices) {
		const point = vectorAt(previousMesh.positions, vertex) as Point3;
		if (candidatePoints.some((candidate) => pointEqual(candidate, point))) continue;
			for (let index = 0; index < candidatePoints.length; index += 1) {
				if (pointOnSegmentInterior3(point, candidatePoints[index]!, candidatePoints[(index + 1) % candidatePoints.length]!)) {
						invalid('New face edge passes through an existing vertex; boundary splitting is not supported yet.');
				}
			}
		}

	const hosts = previousMesh.faces.filter((face) => candidateStrictlyInsideFace(previousMesh, face, candidatePoints, candidateNormal));
	if (hosts.length > 1) invalid('New face is contained by more than one authored surface region.');
	const host = hosts[0] ?? null;
	for (const face of previousMesh.faces) {
		if (face.id === host?.id) continue;
		if (candidateOverlapsFaceRegion(previousMesh, face, candidatePoints, candidateNormal)) {
			invalid('New coplanar face overlaps existing topology outside one containing face and requires unsupported boundary splitting.');
		}
	}
	return host;
}

function v2FaceLabel(faceId: string, operation: 'rectangle' | 'line' | 'push-pull' | 'split', operationId?: string): string {
	return jsonLabel(operationId === undefined
		? [SHAPE_SCHEMA_V2, operation, faceId]
		: [SHAPE_SCHEMA_V2, operation, faceId, operationId]);
}

function isV2Face(face: Face): boolean {
	const label = tupleLabel(face);
	return !!label && label[0] === SHAPE_SCHEMA_V2 && typeof label[2] === 'string';
}

function faceFromRing(
	mesh: Mesh,
	id: string,
	ringInput: readonly number[],
	frontMaterialId: string,
	backMaterialId: string | null,
	label: string,
	preferredNormal?: readonly [number, number, number],
	holesInput: readonly (readonly number[])[] = []
): Face {
	let ring = [...ringInput];
	const inputPoints = ring.map((index) => vectorAt(mesh.positions, index) as Point3);
	let prepared;
	try { prepared = preparePolygon(inputPoints, preferredNormal as Point3 | undefined, { canonicalizeStart: false }); }
	catch (error) {
		if (error instanceof AuthoringPolygonError) invalid(error.message);
		throw error;
	}
	if (!pointEqual(prepared.points[0]!, inputPoints[0]!)) ring = [...ring].reverse();
	const holes = holesInput.map((hole) => [...hole]);
	const triangles = holes.length > 0
		? triangulateFaceRings({ ...mesh, faces: mesh.faces }, ring, holes, prepared.normal)
		: prepared.triangles.map((local) => ring[local]!);
	return {
		id,
		outer: ring,
		holes,
		triangles,
		normal: [prepared.normal[0], prepared.normal[1], prepared.normal[2]],
		frontMaterialId,
		backMaterialId,
		hidden: false,
		surfaceCode: 0,
		roleCode: 0,
		label
	};
}

function exactVertexIndex(positions: readonly number[], point: Point3): number | null {
	for (let index = 0; index < positions.length; index += 3) {
		if (Object.is(positions[index], point[0]) && Object.is(positions[index + 1], point[1]) && Object.is(positions[index + 2], point[2])) return index / 3;
	}
	return null;
}

function assertNewOwnedFaceId(graph: BomcGraph, faceId: string) {
	if (sequenceForApplicationId(graph.documentId, faceId) === null) invalid('Face ID must use a positive document-local rectangle/face sequence.');
	if (graph.meshes.some((mesh) => mesh.faces.some((face) => face.id === faceId))) invalid(`Face ${faceId} already exists.`);
}

function editsForFaceAppend(
	graph: BomcGraph,
	definitionIndex: number,
	previousMesh: Mesh | null,
	nextMesh: Mesh,
	material: SolidMaterial,
	addMaterial: boolean
): GeometryEdit {
	if (previousMesh) {
		const forward: DocumentEdit[] = [];
		if (addMaterial) forward.push({ type: 'put-material', value: material });
		forward.push({ type: 'put-mesh', value: nextMesh });
		const inverse: DocumentEdit[] = [{ type: 'put-mesh', value: previousMesh }];
		if (addMaterial) inverse.push({ type: 'delete-material', id: material.id });
		return { forward, inverse };
	}
	const definition = graph.definitions[definitionIndex]!;
	const nextDefinition = { ...definition, meshId: nextMesh.id };
	return {
		forward: [
			{ type: 'put-material', value: material },
			{ type: 'put-definition', value: nextDefinition },
			{ type: 'put-mesh', value: nextMesh }
		],
		inverse: [
			{ type: 'delete-mesh', id: nextMesh.id },
			{ type: 'put-definition', value: definition },
			{ type: 'delete-material', id: material.id }
		]
	};
}

function graphAfterEdits(graph: BomcGraph, edits: readonly DocumentEdit[]): BomcGraph {
	let materials = [...graph.materials];
	let definitions = [...graph.definitions];
	let meshes = [...graph.meshes];
	for (const edit of edits) {
		if (edit.type === 'put-material') materials = [...materials.filter((item) => item.id !== edit.value.id), edit.value].sort((a, b) => codeUnitCompare(a.id, b.id));
		else if (edit.type === 'delete-material') materials = materials.filter((item) => item.id !== edit.id);
		else if (edit.type === 'put-definition') definitions = [...definitions.filter((item) => item.id !== edit.value.id), edit.value].sort((a, b) => codeUnitCompare(a.id, b.id));
		else if (edit.type === 'put-mesh') meshes = [...meshes.filter((item) => item.id !== edit.value.id), edit.value].sort((a, b) => codeUnitCompare(a.id, b.id));
		else if (edit.type === 'delete-mesh') meshes = meshes.filter((item) => item.id !== edit.id);
	}
	return { ...graph, materials, definitions, meshes };
}

/** Commit a new application-owned planar face while reusing exact canonical endpoint vertices. */
export function buildFaceLoopEdit(
	graph: BomcGraph,
	faceId: string,
	points: readonly AuthoringPoint[],
	constructionNormal: AuthoringPoint,
	kind: 'rectangle' | 'line' = 'line'
): GeometryEdit {
	assertNewOwnedFaceId(graph, faceId);
	const { definitionIndex, mesh: previousMesh } = validateRootForTopologyEditing(graph);
	let prepared;
	try { prepared = preparePolygon(points as readonly Point3[], constructionNormal as Point3); }
	catch (error) {
		if (error instanceof AuthoringPolygonError) invalid(error.message);
		throw error;
	}
	const hostFace = previousMesh ? insertionHostFace(previousMesh, prepared.points, prepared.normal) : null;
	const materialPolicy = materialForNewGeometry(graph);
	const positions = previousMesh ? [...previousMesh.positions] : [];
	const ring: number[] = [];
	for (const point of prepared.points) {
		let vertex = exactVertexIndex(positions, point);
		if (vertex === null) {
			vertex = positions.length / 3;
			positions.push(point[0], point[1], point[2]);
		}
		ring.push(vertex);
	}
	const base: Mesh = previousMesh
		? { ...previousMesh, positions }
		: { id: rootMeshId(graph), definitionId: graph.rootDefinitionId, positions, faces: [] };
	const face: Face = {
		id: faceId,
		outer: ring,
		holes: [],
		triangles: prepared.triangles.map((local) => ring[local]!),
		normal: [prepared.normal[0], prepared.normal[1], prepared.normal[2]],
		frontMaterialId: materialPolicy.material.id,
		backMaterialId: materialPolicy.material.id,
		hidden: false,
		surfaceCode: 0,
		roleCode: 0,
		label: v2FaceLabel(faceId, kind)
	};
	let nextFaces = [...base.faces, face];
	if (hostFace) {
		const splitHost = faceFromRing(
			base,
			hostFace.id,
			hostFace.outer,
			hostFace.frontMaterialId!,
			hostFace.backMaterialId,
			v2FaceLabel(hostFace.id, 'split', faceId),
			hostFace.normal,
			[...hostFace.holes, ring]
		);
		nextFaces = [...base.faces.filter((existing) => existing.id !== hostFace.id), splitHost, face];
	}
	const nextMesh = withSortedFaces(base, nextFaces);
	const edit = editsForFaceAppend(graph, definitionIndex, previousMesh, nextMesh, materialPolicy.material, materialPolicy.add);
	const validation = validateEditableSubset(graphAfterEdits(graph, edit.forward));
	if (!validation.editable) invalid(`Face loop is outside the supported authoring topology: ${validation.reason}`);
	return edit;
}

/** Commit one exact four-corner orthogonal planar rectangle. */
export function buildPlanarRectangleEdit(
	graph: BomcGraph,
	faceId: string,
	points: readonly AuthoringPoint[],
	constructionNormal: AuthoringPoint
): GeometryEdit {
	if (points.length !== 4) invalid('Rectangle must contain exactly four corners.');
	const prepared = preparePolygon(points as readonly Point3[], constructionNormal as Point3);
	const edge = (start: number, end: number) => [
		prepared.points[end]![0] - prepared.points[start]![0],
		prepared.points[end]![1] - prepared.points[start]![1],
		prepared.points[end]![2] - prepared.points[start]![2]
	] as const;
	const e0 = edge(0, 1); const e1 = edge(1, 2); const e2 = edge(2, 3); const e3 = edge(3, 0);
	const scale = Math.max(1, ...[e0, e1, e2, e3].map((value) => Math.hypot(...value)));
	const tolerance = 1e-9 * scale * scale;
	if (Math.abs(dot3(e0, e1)) > tolerance || Math.abs(dot3(e1, e2)) > tolerance
		|| Math.abs(e0[0] + e2[0]) > 1e-9 * scale || Math.abs(e0[1] + e2[1]) > 1e-9 * scale || Math.abs(e0[2] + e2[2]) > 1e-9 * scale
		|| Math.abs(e1[0] + e3[0]) > 1e-9 * scale || Math.abs(e1[1] + e3[1]) > 1e-9 * scale || Math.abs(e1[2] + e3[2]) > 1e-9 * scale) {
		invalid('Rectangle corners must form one orthogonal planar rectangle.');
	}
	return buildFaceLoopEdit(graph, faceId, prepared.points as readonly AuthoringPoint[], constructionNormal, 'rectangle');
}

function upgradedFace(mesh: Mesh, face: Face, operationId: string): Face {
	const currentNormal = rawRingNormal(mesh, face.outer);
	if (dot3(currentNormal, face.normal) <= 1e-9) invalid(`Push/Pull would invert face ${face.id}.`);
	return faceFromRing(
		mesh,
		face.id,
		face.outer,
		face.frontMaterialId!,
		face.backMaterialId,
		v2FaceLabel(face.id, 'push-pull', operationId),
		face.normal,
		face.holes
	);
}

function upgradedFaceAllowOrientationFlip(mesh: Mesh, face: Face, operationId: string): Face {
	return faceFromRing(
		mesh,
		face.id,
		face.outer,
		face.frontMaterialId!,
		face.backMaterialId,
		v2FaceLabel(face.id, 'push-pull', operationId),
		undefined,
		face.holes
	);
}

function rejectOppositeBoundaryCrossing(mesh: Mesh, selected: Face, distance: number): void {
	const anchor = vectorAt(mesh.positions, selected.outer[0]!);
	const selectedVertices = new Set(selected.outer);
	for (const face of mesh.faces) {
		if (face.id === selected.id || face.outer.some((vertex) => selectedVertices.has(vertex))) continue;
		if (Math.abs(Math.abs(dot3(face.normal, selected.normal)) - 1) > 1e-9) continue;
		// A protruded/recessed child cap projects exactly into one of the selected
		// surrounding face's holes. Crossing that cap is a nested Push/Pull edit
		// (protrusion ↔ recess), not an unrelated opposite-shell collision.
		if (projectedOuterMatchesHole(mesh, selected, face)) continue;
		if (!projectedFaceRegionsOverlap(mesh, selected, face, selected.normal)) continue;
		const offsets = face.outer.map((vertex) => {
			const point = vectorAt(mesh.positions, vertex);
			return (point[0] - anchor[0]) * selected.normal[0] + (point[1] - anchor[1]) * selected.normal[1] + (point[2] - anchor[2]) * selected.normal[2];
		});
		const min = Math.min(...offsets); const max = Math.max(...offsets);
		if (max - min > 1e-9 * Math.max(1, Math.abs(min), Math.abs(max))) continue;
		const boundary = (min + max) / 2;
		if (Math.abs(boundary) <= MIN_EDGE_METRES) continue;
		if (boundary * distance > 0 && Math.abs(distance) + MIN_EDGE_METRES >= Math.abs(boundary)) {
			invalid('Push/Pull would cross or collapse an opposite boundary and requires unsupported topology deletion.');
		}
	}
}

function canonicalRingCycle(ring: readonly number[]): string {
	const candidates: string[] = [];
	for (const source of [ring, [...ring].reverse()] as const) for (let offset = 0; offset < source.length; offset += 1) {
		candidates.push([...source.slice(offset), ...source.slice(0, offset)].join(','));
	}
	return candidates.sort(codeUnitCompare)[0] ?? '';
}

function insetHostForFace(mesh: Mesh, target: Face): Face | null {
	const cycle = canonicalRingCycle(target.outer);
	const hosts = mesh.faces.filter((face) => face.id !== target.id && face.holes.some((hole) => canonicalRingCycle(hole) === cycle));
	if (hosts.length > 1) invalid(`Face ${target.id} is referenced by more than one containing surface region.`);
	return hosts[0] ?? null;
}

function holeBoundaryHostForFace(mesh: Mesh, target: Face): Face | null {
	const targetEdges = new Set<string>();
	for (let index = 0; index < target.outer.length; index += 1) {
		const a = target.outer[index]!; const b = target.outer[(index + 1) % target.outer.length]!;
		targetEdges.add(a < b ? `${a}:${b}` : `${b}:${a}`);
	}
	const hosts = mesh.faces.filter((face) => face.id !== target.id && face.holes.some((hole) => hole.some((a, index) => {
		const b = hole[(index + 1) % hole.length]!;
		return targetEdges.has(a < b ? `${a}:${b}` : `${b}:${a}`);
	})));
	if (hosts.length > 1) invalid(`Face ${target.id} touches hole boundaries on more than one containing surface region.`);
	return hosts[0] ?? null;
}

type ParallelHoleBridge = Readonly<{
	host: Face;
	holeIndex: number;
	hostRing: readonly number[];
	offset: number;
	bridgeFaceIds: readonly string[];
}>;

function parallelHoleBridgeForFace(mesh: Mesh, target: Face): ParallelHoleBridge | null {
	if (target.holes.length > 0 || target.outer.length < 3) return null;
	const topology = buildAuthoringTopology(mesh);
	const targetPoints = target.outer.map((vertex) => vectorAt(mesh.positions, vertex) as Point3);
	const scale = Math.max(1, ...targetPoints.flatMap((point) => point.map(Math.abs)));
	const tolerance = 1e-9 * scale;
	const candidates: ParallelHoleBridge[] = [];
	for (const host of mesh.faces) {
		if (host.id === target.id || Math.abs(Math.abs(dot3(host.normal, target.normal)) - 1) > 1e-9) continue;
		for (const [holeIndex, hole] of host.holes.entries()) {
			if (hole.length !== target.outer.length) continue;
			for (const source of [hole, [...hole].reverse()] as const) for (let offsetIndex = 0; offsetIndex < source.length; offsetIndex += 1) {
				const mapped = target.outer.map((_vertex, index) => source[(index + offsetIndex) % source.length]!);
				const offsets = mapped.map((vertex, index) => {
					const delta = subtract3(vectorAt(mesh.positions, vertex), targetPoints[index]!);
					const signed = dot3(delta, target.normal);
					const perpendicular: Point3 = [
						delta[0] - target.normal[0] * signed,
						delta[1] - target.normal[1] * signed,
						delta[2] - target.normal[2] * signed
					];
					return Math.hypot(...perpendicular) <= tolerance ? signed : Number.NaN;
				});
				if (offsets.some((value) => !Number.isFinite(value))) continue;
				const signedOffset = offsets.reduce((sum, value) => sum + value, 0) / offsets.length;
				if (Math.abs(signedOffset) <= MIN_AUTHORING_EDGE_METRES
					|| offsets.some((value) => Math.abs(value - signedOffset) > tolerance)) continue;

				const bridgeFaceIds = new Set<string>();
				let bridged = true;
				for (let index = 0; index < target.outer.length; index += 1) {
					const next = (index + 1) % target.outer.length;
					const targetEdge = topology.edges.get(target.outer[index]! < target.outer[next]!
						? `${target.outer[index]!}:${target.outer[next]!}` : `${target.outer[next]!}:${target.outer[index]!}`);
					const expected = new Set([target.outer[index]!, target.outer[next]!, mapped[index]!, mapped[next]!]);
					const bridge = (targetEdge?.faceIds ?? [])
						.filter((faceId) => faceId !== target.id)
						.map((faceId) => topology.faceById.get(faceId))
						.find((face): face is Face => !!face && face.outer.length === 4 && expected.size === 4
							&& face.outer.every((vertex) => expected.has(vertex)));
					if (!bridge) { bridged = false; break; }
					bridgeFaceIds.add(bridge.id);
				}
				if (!bridged || bridgeFaceIds.size !== target.outer.length) continue;
				candidates.push(Object.freeze({
					host,
					holeIndex,
					hostRing: Object.freeze(mapped),
					offset: signedOffset,
					bridgeFaceIds: Object.freeze([...bridgeFaceIds].sort(codeUnitCompare))
				}));
			}
		}
	}
	if (candidates.length > 1) invalid(`Face ${target.id} is bridged to more than one parallel containing surface.`);
	return candidates[0] ?? null;
}

function compactReferencedVertices(mesh: Mesh): Mesh {
	const used = [...new Set(mesh.faces.flatMap((face) => [face.outer, ...face.holes].flatMap((ring) => [...ring])))]
		.sort((left, right) => left - right);
	if (used.length === mesh.positions.length / 3 && used.every((vertex, index) => vertex === index)) return mesh;
	const remap = new Map(used.map((vertex, index) => [vertex, index]));
	const positions = used.flatMap((vertex) => vectorAt(mesh.positions, vertex));
	const remapRing = (ring: readonly number[]) => ring.map((vertex) => {
		const mapped = remap.get(vertex);
		if (mapped === undefined) invalid('Vertex compaction encountered an unreferenced face vertex.');
		return mapped;
	});
	const faces = mesh.faces.map((face) => ({
		...face,
		outer: remapRing(face.outer),
		holes: face.holes.map(remapRing),
		triangles: face.triangles.map((vertex) => {
			const mapped = remap.get(vertex);
			if (mapped === undefined) invalid('Vertex compaction encountered an unreferenced triangle vertex.');
			return mapped;
		})
	}));
	return { ...mesh, positions, faces };
}

function insertVerticesOnRing(mesh: Mesh, ring: readonly number[], insertions: readonly number[]): number[] {
	const result: number[] = [];
	for (let index = 0; index < ring.length; index += 1) {
		const startVertex = ring[index]!;
		const endVertex = ring[(index + 1) % ring.length]!;
		const start = vectorAt(mesh.positions, startVertex) as Point3;
		const end = vectorAt(mesh.positions, endVertex) as Point3;
		result.push(startVertex);
		const edge = subtract3(end, start);
		const lengthSquared = dot3(edge, edge);
		const inside = insertions.filter((vertex) => vertex !== startVertex && vertex !== endVertex)
			.map((vertex) => {
				const point = vectorAt(mesh.positions, vertex) as Point3;
				if (!pointOnSegmentInterior3(point, start, end)) return null;
				const parameter = dot3(subtract3(point, start), edge) / lengthSquared;
				return { vertex, parameter };
			})
			.filter((entry): entry is { vertex: number; parameter: number } => entry !== null)
			.sort((left, right) => left.parameter - right.parameter || left.vertex - right.vertex);
		for (const entry of inside) if (!result.includes(entry.vertex)) result.push(entry.vertex);
	}
	return result;
}

function cross2(a: Point2, b: Point2): number { return a[0] * b[1] - a[1] * b[0]; }

function raySegmentIntersection2(origin: Point2, direction: Point2, start: Point2, end: Point2): { distance: number; edgeParameter: number } | null {
	const edge: Point2 = [end[0] - start[0], end[1] - start[1]];
	const denominator = cross2(direction, edge);
	if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) return null;
	const delta: Point2 = [start[0] - origin[0], start[1] - origin[1]];
	const distance = cross2(delta, edge) / denominator;
	const edgeParameter = cross2(delta, direction) / denominator;
	if (!Number.isFinite(distance) || !Number.isFinite(edgeParameter) || distance <= MIN_AUTHORING_EDGE_METRES
		|| edgeParameter < -1e-9 || edgeParameter > 1 + 1e-9) return null;
	return { distance, edgeParameter };
}

type HoleBoundaryExit = Readonly<{
	holeIndex: number;
	holeEdgeIndex: number;
	outerEdgeIndex: number;
	distance: number;
	holeStart: number;
	holeEnd: number;
	outerStart: number;
	outerEnd: number;
	startParameter: number;
	endParameter: number;
}>;

function holeBoundaryExitForFace(mesh: Mesh, target: Face, host: Face): HoleBoundaryExit | null {
	if (Math.abs(dot3(target.normal, host.normal)) > 1e-9) return null;
	const drop = projectionAxis(host.normal as Point3);
	const direction3 = target.normal as Point3;
	const directionProjectedPoint = projectPoint2(direction3, drop);
	const direction: Point2 = [directionProjectedPoint[0], directionProjectedPoint[1]];
	if (Math.hypot(direction[0], direction[1]) < 1e-12) return null;
	const exits: HoleBoundaryExit[] = [];
	for (const [holeIndex, hole] of host.holes.entries()) for (let holeEdgeIndex = 0; holeEdgeIndex < hole.length; holeEdgeIndex += 1) {
		const holeStart = hole[holeEdgeIndex]!;
		const holeEnd = hole[(holeEdgeIndex + 1) % hole.length]!;
		const targetEdges = new Set<string>();
		for (let index = 0; index < target.outer.length; index += 1) {
			const a = target.outer[index]!; const b = target.outer[(index + 1) % target.outer.length]!;
			targetEdges.add(a < b ? `${a}:${b}` : `${b}:${a}`);
		}
		const holeKey = holeStart < holeEnd ? `${holeStart}:${holeEnd}` : `${holeEnd}:${holeStart}`;
		if (!targetEdges.has(holeKey)) continue;
		const startPoint = projectPoint2(vectorAt(mesh.positions, holeStart) as Point3, drop);
		const endPoint = projectPoint2(vectorAt(mesh.positions, holeEnd) as Point3, drop);
		for (let outerEdgeIndex = 0; outerEdgeIndex < host.outer.length; outerEdgeIndex += 1) {
			const outerStart = host.outer[outerEdgeIndex]!;
			const outerEnd = host.outer[(outerEdgeIndex + 1) % host.outer.length]!;
			const outerStartPoint = projectPoint2(vectorAt(mesh.positions, outerStart) as Point3, drop);
			const outerEndPoint = projectPoint2(vectorAt(mesh.positions, outerEnd) as Point3, drop);
			const first = raySegmentIntersection2(startPoint, direction, outerStartPoint, outerEndPoint);
			const second = raySegmentIntersection2(endPoint, direction, outerStartPoint, outerEndPoint);
			if (!first || !second) continue;
			const scale = Math.max(1, Math.abs(first.distance), Math.abs(second.distance));
			if (Math.abs(first.distance - second.distance) > 1e-9 * scale) continue;
			exits.push(Object.freeze({
				holeIndex, holeEdgeIndex, outerEdgeIndex,
				distance: (first.distance + second.distance) / 2,
				holeStart, holeEnd, outerStart, outerEnd,
				startParameter: first.edgeParameter, endParameter: second.edgeParameter
			}));
		}
	}
	if (exits.length === 0) return null;
	exits.sort((left, right) => left.distance - right.distance || left.holeIndex - right.holeIndex || left.holeEdgeIndex - right.holeEdgeIndex);
	if (exits.length > 1 && Math.abs(exits[0]!.distance - exits[1]!.distance) <= 1e-9 * Math.max(1, exits[0]!.distance)) {
		invalid(`Face ${target.id} reaches more than one host boundary at the same Push/Pull distance.`);
	}
	return exits[0]!;
}

/** Heal a step back into its coplanar host using canonical boundary cycles. */
function mergeStepIntoHost(mesh: Mesh, host: Face, step: Face, operationId: string): Face {
	const directed = new Map<string, readonly [number, number]>();
	for (const face of [host, step]) for (const [ringIndex, source] of [face.outer, ...face.holes].entries()) {
		let ring = [...source];
		if ((dot3(rawRingNormal(mesh, ring), host.normal) > 0) !== (ringIndex === 0)) ring.reverse();
		for (let index = 0; index < ring.length; index += 1) {
			const a = ring[index]!, b = ring[(index + 1) % ring.length]!;
			const key = a < b ? `${a}:${b}` : `${b}:${a}`;
			const previous = directed.get(key);
			if (previous) {
				if (previous[0] !== b || previous[1] !== a) invalid('Nested side step overlaps its containing face.');
				directed.delete(key);
			} else directed.set(key, [a, b]);
		}
	}
	const loops: number[][] = [];
	while (directed.size) {
		const start = directed.values().next().value![0], ring = [start];
		let current = start;
		do {
			const next = [...directed.entries()].filter(([, edge]) => edge[0] === current);
			if (next.length !== 1) invalid('Nested side step would create a branching boundary.');
			const [key, edge] = next[0]!;
			directed.delete(key); current = edge[1];
			if (current !== start) ring.push(current);
		} while (current !== start);
		loops.push(ring);
	}
	const area = (ring: readonly number[]) => {
		let sum: Point3 = [0, 0, 0];
		for (let index = 0; index < ring.length; index += 1) {
			const a = vectorAt(mesh.positions, ring[index]!), b = vectorAt(mesh.positions, ring[(index + 1) % ring.length]!);
			sum = [sum[0] + a[1] * b[2] - a[2] * b[1], sum[1] + a[2] * b[0] - a[0] * b[2], sum[2] + a[0] * b[1] - a[1] * b[0]];
		}
		return Math.abs(dot3(sum, host.normal));
	};
	loops.sort((a, b) => area(b) - area(a));
	return faceFromRing(mesh, host.id, loops[0]!, host.frontMaterialId!, host.backMaterialId,
		v2FaceLabel(host.id, 'push-pull', operationId), host.normal, loops.slice(1));
}

function openStepHost(mesh: Mesh, host: Face, exit: HoleBoundaryExit, boundaryStart: number, boundaryEnd: number, operationId: string): Face {
	const hole = host.holes[exit.holeIndex]!;
	const alternative: number[] = [];
	let cursor = (exit.holeEdgeIndex - 1 + hole.length) % hole.length;
	while (hole[cursor] !== exit.holeEnd) {
		alternative.push(hole[cursor]!);
		cursor = (cursor - 1 + hole.length) % hole.length;
		if (alternative.length > hole.length) invalid('Unable to open the nested step host boundary.');
	}
	const notch = exit.startParameter <= exit.endParameter
		? [boundaryStart, ...alternative, boundaryEnd] : [boundaryEnd, ...alternative.reverse(), boundaryStart];
	return faceFromRing(mesh, host.id,
		[...host.outer.slice(0, exit.outerEdgeIndex + 1), ...notch, ...host.outer.slice(exit.outerEdgeIndex + 1)],
		host.frontMaterialId!, host.backMaterialId, v2FaceLabel(host.id, 'push-pull', operationId), host.normal,
		host.holes.filter((_ring, index) => index !== exit.holeIndex));
}

/** Push/Pull one canonical face. Open standalone faces become prisms; manifold faces move their shared boundary. */
export function buildPushPullFaceEdit(graph: BomcGraph, faceId: string, distance: number, operationSequence: number): GeometryEdit {
	if (!finite(distance) || Math.abs(distance) < MIN_AUTHORING_EDGE_METRES) invalid('Push/Pull distance must be finite and at least 1e-6 metres from zero.');
	if (!Number.isSafeInteger(operationSequence) || operationSequence < 1 || operationSequence >= Number.MAX_SAFE_INTEGER) invalid('Push/Pull operation sequence is exhausted.');
	const { mesh } = validateRootForTopologyEditing(graph);
	if (!mesh) invalid('Push/Pull requires an authored face.');
	const subset = validateEditableSubset(graph);
	if (!subset.editable) invalid(`Document is outside the editable topology: ${subset.reason}`);
	const target = mesh.faces.find((face) => face.id === faceId);
	if (!target) invalid(`Face ${faceId} no longer exists.`);
	const topology = buildAuthoringTopology(mesh);
	const boundaryRings = [target.outer, ...target.holes];
	const ringIncidentCounts = boundaryRings.map((ring) => ring.map((vertex, index) => topology.edges.get(vertex < ring[(index + 1) % ring.length]!
		? `${vertex}:${ring[(index + 1) % ring.length]!}`
		: `${ring[(index + 1) % ring.length]!}:${vertex}`)?.faceIds.length ?? 0));
	const incidentCounts = ringIncidentCounts.flat();
	const holeAdjacentFaceIds = new Set<string>();
	for (const hole of target.holes) for (let index = 0; index < hole.length; index += 1) {
		const a = hole[index]!; const b = hole[(index + 1) % hole.length]!;
		const edge = topology.edges.get(a < b ? `${a}:${b}` : `${b}:${a}`);
		for (const adjacentFaceId of edge?.faceIds ?? []) if (adjacentFaceId !== target.id) holeAdjacentFaceIds.add(adjacentFaceId);
	}
	const operationId = `${graph.documentId}:op:${operationSequence}`;
	const oldMesh = mesh;
	const insetHost = insetHostForFace(mesh, target);
	const holeBoundaryHost = holeBoundaryHostForFace(mesh, target);
	const parallelBridge = parallelHoleBridgeForFace(mesh, target);

	// Rebase an existing step before another edit of the same side, including
	// crossing back over the original seam. This avoids collapsed/overlapping
	// ledges and makes a reverse edit equivalent to one net displacement.
	const ledges = (topology.adjacentFaceIds.get(target.id) ?? []).map(id => topology.faceById.get(id)!)
		.filter(face => face.id.endsWith(':ledge') && face.outer.length === 4 && face.holes.length === 0
			&& Math.abs(dot3(face.normal, target.normal)) <= 1e-9);
	if (ledges.length === 1 && target.holes.length === 0 && target.outer.length === 4) {
		const ledge = ledges[0]!;
		const stepPrefix = ledge.id.slice(0, ledge.id.lastIndexOf(':ledge'));
		const steps = mesh.faces.filter(face => face.id === `${stepPrefix}:ledge` || face.id === `${stepPrefix}:ledge:inner`);
		const shared = ledge.outer.filter(vertex => target.outer.includes(vertex));
		const fixed = [...new Set(steps.flatMap(face => face.outer))].filter(vertex => !shared.includes(vertex));
		if (shared.length === 2) {
			const restore = new Map<number, number>();
			const offsets: number[] = [];
			for (const vertex of shared) {
				const point = vectorAt(mesh.positions, vertex);
				const candidates = fixed.map(original => {
					const delta = subtract3(point, vectorAt(mesh.positions, original));
					const offset = dot3(delta, target.normal);
					return { original, offset, aligned: Math.hypot(...delta.map((value, axis) => value - offset * target.normal[axis]!)) <= 1e-9 };
				}).filter(candidate => candidate.aligned).sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset));
				if (candidates[0]) { restore.set(vertex, candidates[0].original); offsets.push(candidates[0].offset); }
			}
			if (restore.size === 2 && Math.abs(offsets[0]! - offsets[1]!) <= 1e-9) {
				const offset = offsets[0]!;
				const innerStep = steps.find(face => face.id.endsWith(':inner')) ?? ledge;
				const edgeKeys = (face: Face) => new Set([face.outer, ...face.holes].flatMap(ring => ring.map((a, index) => {
					const b = ring[(index + 1) % ring.length]!; return a < b ? `${a}:${b}` : `${b}:${a}`;
				})));
				const stepEdges = edgeKeys(innerStep);
				const hosts = mesh.faces.filter(face => !steps.includes(face) && Math.abs(Math.abs(dot3(face.normal, ledge.normal)) - 1) <= 1e-9
					&& [...edgeKeys(face)].filter(key => stepEdges.has(key)).length >= 2);
				if (hosts.length !== 1) invalid('Nested side step requires one coplanar containing face.');
				const host = mergeStepIntoHost(mesh, hosts[0]!, innerStep, operationId);
				const positions = [...mesh.positions];
				for (const vertex of target.outer.filter(vertex => !restore.has(vertex))) for (let axis = 0; axis < 3; axis += 1) {
					positions[vertex * 3 + axis] = positions[vertex * 3 + axis]! - target.normal[axis]! * offset;
				}
				const restoredMesh: Mesh = { ...mesh, positions };
				const seamPoints = new Set(steps.flatMap(face => face.outer));
				const simplify = (source: readonly number[], moving: boolean): number[] => {
					const restoringSeam = moving && source.some(vertex => restore.has(vertex));
					const ring = source.filter(vertex => !restoringSeam || !seamPoints.has(vertex) || restore.has(vertex))
						.map(vertex => moving ? restore.get(vertex) ?? vertex : vertex).filter((vertex, index, values) => vertex !== values[(index + 1) % values.length]);
					let changed = true;
					while (changed && ring.length > 3) {
						changed = false;
						for (let index = 0; index < ring.length; index += 1) if (seamPoints.has(ring[index]!) && pointOnSegmentInterior3(
							vectorAt(positions, ring[index]!) as Point3,
							vectorAt(positions, ring[(index - 1 + ring.length) % ring.length]!) as Point3,
							vectorAt(positions, ring[(index + 1) % ring.length]!) as Point3)) {
							ring.splice(index, 1); changed = true; break;
						}
					}
					return ring;
				};
				const freeVertices = target.outer.filter(vertex => !restore.has(vertex));
				const faces = mesh.faces.filter(face => !steps.includes(face)).map(original => {
					const face = original.id === host.id ? host : original;
					const moving = face.id === target.id || face.outer.some(vertex => freeVertices.includes(vertex));
					const outer = simplify(face.outer, moving), holes = face.holes.map(ring => simplify(ring, moving || face.id === host.id));
					if (sameTuple(outer, face.outer) && holes.every((ring, index) => sameTuple(ring, face.holes[index]!))
						&& [outer, ...holes].flat().every(vertex => sameTuple(vectorAt(positions, vertex), vectorAt(mesh.positions, vertex)))) return face;
					return faceFromRing(restoredMesh, face.id, outer, face.frontMaterialId!, face.backMaterialId,
						v2FaceLabel(face.id, 'push-pull', operationId), face.normal, holes);
				});
				const restored = compactReferencedVertices(withSortedFaces(restoredMesh, faces));
				const restoredGraph = { ...graph, meshes: [restored] };
				const validation = validateEditableSubset(restoredGraph);
				if (!validation.editable) invalid(`Nested side seam cannot be restored safely: ${validation.reason}`);
				const netDistance = offset + distance;
				const forward = Math.abs(netDistance) < MIN_AUTHORING_EDGE_METRES
					? [{ type: 'put-mesh' as const, value: restored }]
					: buildPushPullFaceEdit(restoredGraph, faceId, netDistance, operationSequence).forward;
				return { forward, inverse: [{ type: 'put-mesh', value: oldMesh }] };
			}
		}
	}

	// A lower reveal meets the stationary upper reveal and the perforated base
	// at one three-face edge. Detach only this side of the seam: translating the
	// shared vertices would tilt the upper cavity wall. A planar ledge joins the
	// old and new seams, and the base hole grows only when the child grows.
	const junctionEdges = target.outer.map((a, index) => {
		const b = target.outer[(index + 1) % target.outer.length]!;
		return topology.edges.get(a < b ? `${a}:${b}` : `${b}:${a}`)!;
	}).filter(edge => edge.faceIds.length === 3);
	if (holeBoundaryHost && target.holes.length === 0 && target.outer.length === 4 && junctionEdges.length === 1) {
		const seam = junctionEdges[0]!;
		const upper = seam.faceIds.map(id => topology.faceById.get(id)!)
			.find(face => face.id !== target.id && face.id !== holeBoundaryHost.id
				&& Math.abs(Math.abs(dot3(face.normal, target.normal)) - 1) <= 1e-9);
		if (upper) {
			rejectOppositeBoundaryCrossing(mesh, target, distance);
			const seamVertices = new Set([seam.a, seam.b]);
			const freeVertices = new Set(target.outer.filter(vertex => !seamVertices.has(vertex)));
			const positions = [...mesh.positions];
			const detached = new Map<number, number>();
			for (const vertex of target.outer) {
				const point = vectorAt(mesh.positions, vertex);
				const moved = point.map((value, axis) => value + target.normal[axis]! * distance);
				if (seamVertices.has(vertex)) {
					detached.set(vertex, positions.length / 3);
					positions.push(...moved);
				} else positions.splice(vertex * 3, 3, ...moved);
			}
			const expanded: Mesh = { ...mesh, positions };
			const drop = projectionAxis(holeBoundaryHost.normal as Point3);
			const hole = holeBoundaryHost.holes.find(ring => ring.includes(seam.a) && ring.includes(seam.b))!;
			const midpoint = [0, 1, 2].map(axis => (positions[detached.get(seam.a)! * 3 + axis]! + positions[detached.get(seam.b)! * 3 + axis]!) / 2) as [number, number, number];
			const growsHole = !pointInPolygonStrict(projectPoint2(midpoint, drop), hole.map(vertex => projectPoint2(vectorAt(mesh.positions, vertex) as Point3, drop)), 1e-9);
			const motionNormal = target.normal.map(value => value * Math.sign(distance)) as [number, number, number];
			const exit = growsHole ? holeBoundaryExitForFace(mesh, { ...target, normal: motionNormal }, holeBoundaryHost) : null;
			const tolerance = 1e-9 * Math.max(1, Math.abs(distance));
			const reachesBoundary = !!exit && Math.abs(distance) + tolerance >= exit.distance;
			const boundary = new Map<number, number>();
			if (exit && reachesBoundary) for (const vertex of seamVertices) {
				if (Math.abs(Math.abs(distance) - exit.distance) <= tolerance) boundary.set(vertex, detached.get(vertex)!);
				else {
					const point = vectorAt(mesh.positions, vertex).map((value, axis) => value + motionNormal[axis]! * exit.distance) as [number, number, number];
					const index = exactVertexIndex(positions, point) ?? positions.length / 3;
					if (index === positions.length / 3) positions.push(...point);
					boundary.set(vertex, index);
				}
			}
			const openedHost = exit && reachesBoundary ? openStepHost(expanded, holeBoundaryHost, exit,
				boundary.get(exit.holeStart)!, boundary.get(exit.holeEnd)!, operationId) : null;
			const insertions = [...seamVertices, ...detached.values(), ...boundary.values()];
			const faces = mesh.faces.map(face => {
				if (openedHost && face.id === openedHost.id) return faceFromRing(expanded, face.id,
					insertVerticesOnRing(expanded, openedHost.outer, insertions), face.frontMaterialId!, face.backMaterialId,
					v2FaceLabel(face.id, 'push-pull', operationId), face.normal, openedHost.holes);
				const moving = face.id === target.id || face.outer.some(vertex => freeVertices.has(vertex)) || (growsHole && !openedHost && face.id === holeBoundaryHost.id);
				const remap = (ring: readonly number[]) => insertVerticesOnRing(expanded, moving ? ring.map(vertex => detached.get(vertex) ?? vertex) : ring, insertions);
				const outer = remap(face.outer), holes = face.holes.map(remap);
				if (!moving && canonicalRingCycle(outer) === canonicalRingCycle(face.outer)
					&& holes.every((ring, index) => canonicalRingCycle(ring) === canonicalRingCycle(face.holes[index]!))) return face;
				return faceFromRing(expanded, face.id, outer, face.frontMaterialId!, face.backMaterialId,
					v2FaceLabel(face.id, 'push-pull', operationId), face.normal, holes);
			});
			const ledgeId = `${operationId}:ledge`;
			const overhang = reachesBoundary && exit && Math.abs(distance) - exit.distance > tolerance;
			const innerId = overhang ? `${ledgeId}:inner` : ledgeId;
			faces.push(faceFromRing(expanded, innerId,
				[seam.a, seam.b, boundary.get(seam.b) ?? detached.get(seam.b)!, boundary.get(seam.a) ?? detached.get(seam.a)!], target.frontMaterialId!, null,
				v2FaceLabel(innerId, 'push-pull', operationId), holeBoundaryHost.normal));
			if (overhang) faces.push(faceFromRing(expanded, ledgeId,
				[boundary.get(seam.a)!, boundary.get(seam.b)!, detached.get(seam.b)!, detached.get(seam.a)!], target.frontMaterialId!, null,
				v2FaceLabel(ledgeId, 'push-pull', operationId), holeBoundaryHost.normal));
			const nextMesh = withSortedFaces(expanded, faces);
			const validation = validateEditableSubset({ ...graph, meshes: [nextMesh] });
			if (!validation.editable) invalid(`Nested side Push/Pull result is outside the supported topology: ${validation.reason}`);
			return { forward: [{ type: 'put-mesh', value: nextMesh }], inverse: [{ type: 'put-mesh', value: oldMesh }] };
		}
	}

	if (insetHost && !(parallelBridge && parallelBridge.offset * distance > 0)) {
		rejectOppositeBoundaryCrossing(mesh, target, distance);
		const movingStart = mesh.positions.length / 3;
		const positions = [...mesh.positions];
		for (const vertex of target.outer) {
			const point = vectorAt(mesh.positions, vertex);
			positions.push(
				point[0] + target.normal[0] * distance,
				point[1] + target.normal[1] * distance,
				point[2] + target.normal[2] * distance
			);
		}
		const moving = target.outer.map((_vertex, index) => movingStart + index);
		const expanded: Mesh = { ...mesh, positions };
		const materialId = target.frontMaterialId;
		if (!materialId) invalid('Push/Pull target has no supported front material.');
		const replacements: Face[] = [
			faceFromRing(expanded, target.id, moving, materialId, target.backMaterialId, v2FaceLabel(target.id, 'push-pull', operationId), target.normal)
		];
		for (let index = 0; index < target.outer.length; index += 1) {
			const next = (index + 1) % target.outer.length;
			const start = vectorAt(mesh.positions, target.outer[index]!);
			const end = vectorAt(mesh.positions, target.outer[next]!);
			const edge: Point3 = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
			const outward: Point3 = [
				edge[1] * target.normal[2] - edge[2] * target.normal[1],
				edge[2] * target.normal[0] - edge[0] * target.normal[2],
				edge[0] * target.normal[1] - edge[1] * target.normal[0]
			];
			const preferred: Point3 = distance > 0 ? outward : [-outward[0], -outward[1], -outward[2]];
			const sideId = `${operationId}:side:${index}`;
			replacements.push(faceFromRing(
				expanded,
				sideId,
				[target.outer[index]!, target.outer[next]!, moving[next]!, moving[index]!],
				materialId,
				null,
				v2FaceLabel(sideId, 'push-pull', operationId),
				preferred
			));
		}
		const nextMesh = withSortedFaces(expanded, [...mesh.faces.filter((face) => face.id !== target.id), ...replacements]);
		const validation = validateEditableSubset({ ...graph, meshes: [nextMesh] });
		if (!validation.editable) invalid(`Inset Push/Pull result is outside the supported topology: ${validation.reason}`);
		return { forward: [{ type: 'put-mesh', value: nextMesh }], inverse: [{ type: 'put-mesh', value: oldMesh }] };
	}

	if (parallelBridge && parallelBridge.offset * distance > 0) {
		const transitionTolerance = 1e-9 * Math.max(1, Math.abs(parallelBridge.offset), Math.abs(distance));
		const materialId = target.frontMaterialId;
		if (!materialId) invalid('Push/Pull target has no supported front material.');
		const reachesHost = Math.abs(distance) + transitionTolerance >= Math.abs(parallelBridge.offset);
		const excess = distance - parallelBridge.offset;
		const positions = [...mesh.positions];
		let expanded: Mesh = mesh;
		const replacements: Face[] = [];
		const bridgeFaceForEdge = (index: number): Face => {
			const next = (index + 1) % target.outer.length;
			const expected = new Set([
				target.outer[index]!, target.outer[next]!,
				parallelBridge.hostRing[index]!, parallelBridge.hostRing[next]!
			]);
			const bridge = parallelBridge.bridgeFaceIds
				.map((faceId) => mesh.faces.find((face) => face.id === faceId))
				.find((face): face is Face => !!face && face.outer.length === 4 && face.outer.every((vertex) => expected.has(vertex)));
			if (!bridge) invalid(`Nested Push/Pull bridge for face ${target.id} is incomplete.`);
			return bridge;
		};

		if (!reachesHost) {
			const movingStart = positions.length / 3;
			for (const vertex of target.outer) {
				const point = vectorAt(mesh.positions, vertex);
				positions.push(
					point[0] + target.normal[0] * distance,
					point[1] + target.normal[1] * distance,
					point[2] + target.normal[2] * distance
				);
			}
			const moving = target.outer.map((_vertex, index) => movingStart + index);
			expanded = { ...mesh, positions };
			replacements.push(faceFromRing(
				expanded,
				target.id,
				moving,
				materialId,
				target.backMaterialId,
				v2FaceLabel(target.id, 'push-pull', operationId),
				target.normal
			));
			for (let index = 0; index < target.outer.length; index += 1) {
				const next = (index + 1) % target.outer.length;
				const sideId = `${operationId}:side:${index}`;
				replacements.push(faceFromRing(
					expanded,
					sideId,
					[moving[index]!, moving[next]!, parallelBridge.hostRing[next]!, parallelBridge.hostRing[index]!],
					materialId,
					null,
					v2FaceLabel(sideId, 'push-pull', operationId),
					bridgeFaceForEdge(index).normal
				));
			}
		} else if (Math.abs(excess) <= transitionTolerance) {
			replacements.push(faceFromRing(
				expanded,
				target.id,
				parallelBridge.hostRing,
				materialId,
				target.backMaterialId,
				v2FaceLabel(target.id, 'push-pull', operationId),
				target.normal
			));
		} else {
			const movingStart = positions.length / 3;
			for (const vertex of parallelBridge.hostRing) {
				const point = vectorAt(mesh.positions, vertex);
				positions.push(
					point[0] + target.normal[0] * excess,
					point[1] + target.normal[1] * excess,
					point[2] + target.normal[2] * excess
				);
			}
			const moving = parallelBridge.hostRing.map((_vertex, index) => movingStart + index);
			expanded = { ...mesh, positions };
			replacements.push(faceFromRing(
				expanded,
				target.id,
				moving,
				materialId,
				target.backMaterialId,
				v2FaceLabel(target.id, 'push-pull', operationId),
				target.normal
			));
			for (let index = 0; index < parallelBridge.hostRing.length; index += 1) {
				const next = (index + 1) % parallelBridge.hostRing.length;
				const sideId = `${operationId}:side:${index}`;
				replacements.push(faceFromRing(
					expanded,
					sideId,
					[parallelBridge.hostRing[index]!, parallelBridge.hostRing[next]!, moving[next]!, moving[index]!],
					materialId,
					null,
					v2FaceLabel(sideId, 'push-pull', operationId),
					bridgeFaceForEdge(index).normal
				));
			}
		}

		if (insetHost) {
			const baseId = `${operationId}:base`;
			replacements.push(faceFromRing(
				expanded,
				baseId,
				target.outer,
				materialId,
				target.backMaterialId,
				v2FaceLabel(baseId, 'push-pull', operationId),
				target.normal
			));
		}

		const removed = new Set([target.id, ...parallelBridge.bridgeFaceIds]);
		const transitioned = withSortedFaces(expanded, [...mesh.faces.filter((face) => !removed.has(face.id)), ...replacements]);
		const nextMesh = compactReferencedVertices(transitioned);
		const validation = validateEditableSubset({ ...graph, meshes: [nextMesh] });
		if (!validation.editable) invalid(`Nested face level transition is outside the supported topology: ${validation.reason}`);
		return { forward: [{ type: 'put-mesh', value: nextMesh }], inverse: [{ type: 'put-mesh', value: oldMesh }] };
	}

	const holeBoundaryExit = !insetHost && holeBoundaryHost && target.holes.length === 0 && distance > 0
		&& incidentCounts.every((count) => count === 2)
		? holeBoundaryExitForFace(mesh, target, holeBoundaryHost)
		: null;
	if (holeBoundaryHost && holeBoundaryExit) {
		const boundaryTolerance = 1e-9 * Math.max(1, Math.abs(holeBoundaryExit.distance), Math.abs(distance));
		if (distance + boundaryTolerance >= holeBoundaryExit.distance) {
			rejectOppositeBoundaryCrossing(mesh, target, distance);
			const materialId = target.frontMaterialId;
			if (!materialId) invalid('Push/Pull target has no supported front material.');
			const positions = [...mesh.positions];
			for (const vertex of target.outer) {
				const offset = vertex * 3;
				positions[offset] = positions[offset]! + target.normal[0] * distance;
				positions[offset + 1] = positions[offset + 1]! + target.normal[1] * distance;
				positions[offset + 2] = positions[offset + 2]! + target.normal[2] * distance;
			}
			const residual = distance - holeBoundaryExit.distance;
			const boundaryPoint = (vertex: number): Point3 => {
				const original = vectorAt(mesh.positions, vertex);
				return [
					original[0] + target.normal[0] * holeBoundaryExit.distance,
					original[1] + target.normal[1] * holeBoundaryExit.distance,
					original[2] + target.normal[2] * holeBoundaryExit.distance
				];
			};
			const ensureBoundaryVertex = (point: Point3): number => {
				const existing = exactVertexIndex(positions, point);
				if (existing !== null) return existing;
				const vertex = positions.length / 3;
				positions.push(point[0], point[1], point[2]);
				return vertex;
			};
			const boundaryStart = Math.abs(residual) <= boundaryTolerance
				? holeBoundaryExit.holeStart : ensureBoundaryVertex(boundaryPoint(holeBoundaryExit.holeStart));
			const boundaryEnd = Math.abs(residual) <= boundaryTolerance
				? holeBoundaryExit.holeEnd : ensureBoundaryVertex(boundaryPoint(holeBoundaryExit.holeEnd));
			const expanded: Mesh = { ...mesh, positions };

			const hole = holeBoundaryHost.holes[holeBoundaryExit.holeIndex]!;
			const alternative: number[] = [];
			let cursor = (holeBoundaryExit.holeEdgeIndex - 1 + hole.length) % hole.length;
			let guard = 0;
			while (hole[cursor] !== holeBoundaryExit.holeEnd) {
				alternative.push(hole[cursor]!);
				cursor = (cursor - 1 + hole.length) % hole.length;
				guard += 1;
				if (guard > hole.length) invalid('Unable to open the nested host hole at its crossed boundary.');
			}
			const notchPath = holeBoundaryExit.startParameter <= holeBoundaryExit.endParameter
				? [boundaryStart, ...alternative, boundaryEnd]
				: [boundaryEnd, ...[...alternative].reverse(), boundaryStart];
			const notchOuter = [
				...holeBoundaryHost.outer.slice(0, holeBoundaryExit.outerEdgeIndex + 1),
				...notchPath,
				...holeBoundaryHost.outer.slice(holeBoundaryExit.outerEdgeIndex + 1)
			];
			const remainingHoles = holeBoundaryHost.holes.filter((_ring, index) => index !== holeBoundaryExit.holeIndex);
			const rebuiltHost = faceFromRing(
				expanded,
				holeBoundaryHost.id,
				notchOuter,
				holeBoundaryHost.frontMaterialId!,
				holeBoundaryHost.backMaterialId,
				v2FaceLabel(holeBoundaryHost.id, 'push-pull', operationId),
				holeBoundaryHost.normal,
				remainingHoles
			);

			const insertionVertices = [boundaryStart, boundaryEnd];
			const affected = new Set([target.id, ...(topology.adjacentFaceIds.get(target.id) ?? [])]);
			const retained = mesh.faces
				.filter((face) => face.id !== holeBoundaryHost.id)
				.map((face) => {
					const outer = insertVerticesOnRing(expanded, face.outer, insertionVertices);
					const holes = face.holes.map((ring) => insertVerticesOnRing(expanded, ring, insertionVertices));
					const split = outer.length !== face.outer.length || holes.some((ring, index) => ring.length !== face.holes[index]!.length);
					if (!affected.has(face.id) && !split) return face;
					if (!face.frontMaterialId) invalid(`Push/Pull affected face ${face.id} has no supported front material.`);
					return faceFromRing(
						expanded,
						face.id,
						outer,
						face.frontMaterialId,
						face.backMaterialId,
						v2FaceLabel(face.id, 'push-pull', operationId),
						face.normal,
						holes
					);
				});

			const additions: Face[] = [rebuiltHost];
			if (residual > boundaryTolerance) {
				if (residual < MIN_AUTHORING_EDGE_METRES) invalid('Push/Pull overhang beyond the host boundary is too small to form a stable underside.');
				const undersideId = `${operationId}:underside`;
				additions.push(faceFromRing(
					expanded,
					undersideId,
					[boundaryStart, boundaryEnd, holeBoundaryExit.holeEnd, holeBoundaryExit.holeStart],
					materialId,
					null,
					v2FaceLabel(undersideId, 'push-pull', operationId),
					[-holeBoundaryHost.normal[0], -holeBoundaryHost.normal[1], -holeBoundaryHost.normal[2]]
				));
			}
			const nextMesh = withSortedFaces(expanded, [...retained, ...additions]);
			const validation = validateEditableSubset({ ...graph, meshes: [nextMesh] });
			if (!validation.editable) invalid(`Connected overhang Push/Pull result is outside the supported topology: ${validation.reason}`);
			return { forward: [{ type: 'put-mesh', value: nextMesh }], inverse: [{ type: 'put-mesh', value: oldMesh }] };
		}
	}

	const surroundingOpenParent = target.holes.length > 0
		&& ringIncidentCounts[0]?.every((count) => count === 1)
		&& ringIncidentCounts.slice(1).every((counts) => counts.every((count) => count === 2));
	if (surroundingOpenParent) {
		rejectOppositeBoundaryCrossing(mesh, target, distance);
		const materialId = target.frontMaterialId;
		if (!materialId) invalid('Push/Pull target has no supported front material.');
		const positions = [...mesh.positions];
		const movingOuterStart = positions.length / 3;
		for (const vertex of target.outer) {
			const point = vectorAt(mesh.positions, vertex);
			positions.push(
				point[0] + target.normal[0] * distance,
				point[1] + target.normal[1] * distance,
				point[2] + target.normal[2] * distance
			);
			}
			const movingOuter = target.outer.map((_vertex, index) => movingOuterStart + index);
			const movingHoles: number[][] = [];
			const decoupledHoles: Array<{ holeIndex: number; source: readonly number[]; moving: readonly number[] }> = [];
			const mutatedHoleAdjacentFaceIds = new Set<string>();
			for (const [holeIndex, hole] of target.holes.entries()) {
				const adjacentIds = new Set<string>();
				for (let index = 0; index < hole.length; index += 1) {
					const a = hole[index]!; const b = hole[(index + 1) % hole.length]!;
					const edge = topology.edges.get(a < b ? `${a}:${b}` : `${b}:${a}`);
					for (const adjacentFaceId of edge?.faceIds ?? []) if (adjacentFaceId !== target.id) adjacentIds.add(adjacentFaceId);
				}
				const hasCoplanarNestedFace = [...adjacentIds].some((faceId) => {
					const adjacentFace = topology.faceById.get(faceId);
					return !!adjacentFace && Math.abs(Math.abs(dot3(adjacentFace.normal, target.normal)) - 1) <= 1e-9;
				});
				if (hasCoplanarNestedFace) {
					const movingStart = positions.length / 3;
					for (const vertex of hole) {
						const point = vectorAt(mesh.positions, vertex);
						positions.push(
							point[0] + target.normal[0] * distance,
							point[1] + target.normal[1] * distance,
							point[2] + target.normal[2] * distance
						);
					}
					const moving = hole.map((_vertex, index) => movingStart + index);
					movingHoles.push(moving);
					decoupledHoles.push({ holeIndex, source: hole, moving });
				} else {
					for (const adjacentFaceId of adjacentIds) mutatedHoleAdjacentFaceIds.add(adjacentFaceId);
					for (const vertex of hole) {
						const offset = vertex * 3;
						positions[offset] = positions[offset]! + target.normal[0] * distance;
						positions[offset + 1] = positions[offset + 1]! + target.normal[1] * distance;
						positions[offset + 2] = positions[offset + 2]! + target.normal[2] * distance;
					}
					movingHoles.push([...hole]);
				}
			}
			const expanded: Mesh = { ...mesh, positions };
			const movedParent = faceFromRing(
			expanded,
			target.id,
			movingOuter,
			materialId,
			target.backMaterialId,
				v2FaceLabel(target.id, 'push-pull', operationId),
				target.normal,
				movingHoles
			);
			const retained = mesh.faces
				.filter((face) => face.id !== target.id)
				.map((face) => mutatedHoleAdjacentFaceIds.has(face.id)
					? upgradedFaceAllowOrientationFlip(expanded, face, operationId)
					: face);
			const sides: Face[] = [];
			const baseFaces: Face[] = [];
			if (decoupledHoles.length > 0 && decoupledHoles.length === target.holes.length) {
				const baseId = `${operationId}:base`;
				baseFaces.push(faceFromRing(
					expanded,
					baseId,
					target.outer,
					materialId,
					target.backMaterialId,
					v2FaceLabel(baseId, 'push-pull', operationId),
					target.normal,
					target.holes
				));
			}
			for (let index = 0; index < target.outer.length; index += 1) {
			const next = (index + 1) % target.outer.length;
			const start = vectorAt(mesh.positions, target.outer[index]!);
			const end = vectorAt(mesh.positions, target.outer[next]!);
			const edge: Point3 = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
			const outward: Point3 = [
				edge[1] * target.normal[2] - edge[2] * target.normal[1],
				edge[2] * target.normal[0] - edge[0] * target.normal[2],
				edge[0] * target.normal[1] - edge[1] * target.normal[0]
			];
			const sideId = `${operationId}:side:${index}`;
			sides.push(faceFromRing(
				expanded,
				sideId,
				[target.outer[index]!, target.outer[next]!, movingOuter[next]!, movingOuter[index]!],
				materialId,
				null,
				v2FaceLabel(sideId, 'push-pull', operationId),
					outward
				));
			}
			for (const decoupled of decoupledHoles) for (let index = 0; index < decoupled.source.length; index += 1) {
				const next = (index + 1) % decoupled.source.length;
				const start = vectorAt(mesh.positions, decoupled.source[index]!);
				const end = vectorAt(mesh.positions, decoupled.source[next]!);
				const edge: Point3 = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
				const inward: Point3 = [
					edge[1] * target.normal[2] - edge[2] * target.normal[1],
					edge[2] * target.normal[0] - edge[0] * target.normal[2],
					edge[0] * target.normal[1] - edge[1] * target.normal[0]
				];
				const sideId = `${operationId}:hole:${decoupled.holeIndex}:side:${index}`;
				sides.push(faceFromRing(
					expanded,
					sideId,
					[decoupled.source[index]!, decoupled.source[next]!, decoupled.moving[next]!, decoupled.moving[index]!],
					materialId,
					null,
					v2FaceLabel(sideId, 'push-pull', operationId),
					inward
				));
			}
			const nextMesh = withSortedFaces(expanded, [...retained, ...baseFaces, movedParent, ...sides]);
		const validation = validateEditableSubset({ ...graph, meshes: [nextMesh] });
		if (!validation.editable) invalid(`Surrounding face Push/Pull result is outside the supported topology: ${validation.reason}`);
		return { forward: [{ type: 'put-mesh', value: nextMesh }], inverse: [{ type: 'put-mesh', value: oldMesh }] };
	}

	// buildAuthoringTopology has already validated each three-face junction.
	// A base ring can meet both upper and lower reveals. Moving that ring must
	// move its hole vertices too, stretching both reveals while keeping caps fixed.
	const supportedRevealRing = target.holes.length > 0
		&& ringIncidentCounts[0]!.every((count) => count === 2)
		&& ringIncidentCounts.slice(1).every((counts) => counts.every((count) => count === 2 || count === 3));
	if (target.holes.length > 0 && !incidentCounts.every((count) => count === 2) && !supportedRevealRing) {
		invalid('Push/Pull of a surrounding face requires either a closed manifold boundary or an open outer ring with manifold inset boundaries.');
	}

	if (incidentCounts.every((count) => count === 1)) {
		const capStart = mesh.positions.length / 3;
		const positions = [...mesh.positions];
		for (const vertex of target.outer) {
			const point = vectorAt(mesh.positions, vertex);
			positions.push(
				point[0] + target.normal[0] * distance,
				point[1] + target.normal[1] * distance,
				point[2] + target.normal[2] * distance
			);
		}
		const moving = target.outer.map((_vertex, index) => capStart + index);
		const expanded: Mesh = { ...mesh, positions };
		const positive = distance > 0;
		const baseRing = positive ? [...target.outer].reverse() : [...target.outer];
		const capRing = positive ? [...moving] : [...moving].reverse();
		const materialId = target.frontMaterialId;
		if (!materialId) invalid('Push/Pull target has no supported front material.');
		const replacements: Face[] = [
			faceFromRing(expanded, target.id, baseRing, materialId, null, v2FaceLabel(target.id, 'push-pull', operationId), positive
				? [-target.normal[0], -target.normal[1], -target.normal[2]] : target.normal),
			faceFromRing(expanded, `${operationId}:cap`, capRing, materialId, null, v2FaceLabel(`${operationId}:cap`, 'push-pull', operationId), positive
				? target.normal : [-target.normal[0], -target.normal[1], -target.normal[2]])
		];
		for (let index = 0; index < target.outer.length; index += 1) {
			const next = (index + 1) % target.outer.length;
			const sideRing = [target.outer[index]!, target.outer[next]!, moving[next]!, moving[index]!];
			const sideId = `${operationId}:side:${index}`;
			const start = vectorAt(mesh.positions, target.outer[index]!);
			const end = vectorAt(mesh.positions, target.outer[next]!);
			const edge: Point3 = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
			const outward: Point3 = [
				edge[1] * target.normal[2] - edge[2] * target.normal[1],
				edge[2] * target.normal[0] - edge[0] * target.normal[2],
				edge[0] * target.normal[1] - edge[1] * target.normal[0]
			];
			replacements.push(faceFromRing(expanded, sideId, sideRing, materialId, null, v2FaceLabel(sideId, 'push-pull', operationId), outward));
		}
		const nextMesh = withSortedFaces(expanded, [...mesh.faces.filter((face) => face.id !== target.id), ...replacements]);
		const nextGraph = { ...graph, meshes: [nextMesh] };
		const validation = validateEditableSubset(nextGraph);
		if (!validation.editable) invalid(`Push/Pull result is outside the supported topology: ${validation.reason}`);
		return { forward: [{ type: 'put-mesh', value: nextMesh }], inverse: [{ type: 'put-mesh', value: oldMesh }] };
	}

	if (!incidentCounts.every((count) => count === 2) && !supportedRevealRing) invalid('Push/Pull supports standalone faces or faces on a closed manifold component.');
	rejectOppositeBoundaryCrossing(mesh, target, distance);
	const moved = new Set(boundaryRings.flatMap((ring) => [...ring]));
	const positions = [...mesh.positions];
	for (const vertex of moved) {
		const offset = vertex * 3;
		positions[offset] = positions[offset]! + target.normal[0] * distance;
		positions[offset + 1] = positions[offset + 1]! + target.normal[1] * distance;
		positions[offset + 2] = positions[offset + 2]! + target.normal[2] * distance;
	}
	const movedMesh: Mesh = { ...mesh, positions };
	const affected = new Set([target.id, ...(topology.adjacentFaceIds.get(target.id) ?? [])]);
	const faces = mesh.faces.map((face) => affected.has(face.id)
		? face.id !== target.id && holeAdjacentFaceIds.has(face.id)
			? upgradedFaceAllowOrientationFlip(movedMesh, face, operationId)
			: upgradedFace(movedMesh, face, operationId)
		: face);
	const nextMesh = withSortedFaces(movedMesh, faces);
	const validation = validateEditableSubset({ ...graph, meshes: [nextMesh] });
	if (!validation.editable) invalid(`Push/Pull result is outside the supported topology: ${validation.reason}`);
	return { forward: [{ type: 'put-mesh', value: nextMesh }], inverse: [{ type: 'put-mesh', value: oldMesh }] };
}

function makeFace(
	entityId: string,
	part: string,
	distance: number,
	ring: readonly number[],
	mesh: Mesh,
	graph: BomcGraph,
	normal?: readonly [number, number, number]
): Face {
	const vertices = ring.map((index) => vectorAt(mesh.positions, index));
	const faceNormal = normal ?? normalizedCross(vertices[0]!, vertices[1]!, vertices[2]!);
	return {
		id: part === 'base' ? entityId : part === 'cap' ? `${entityId}:cap` : `${entityId}:${part}`,
		outer: [...ring],
		holes: [],
		triangles: [ring[0]!, ring[1]!, ring[2]!, ring[0]!, ring[2]!, ring[3]!],
		normal: [...faceNormal],
		frontMaterialId: defaultMaterialId(graph),
		backMaterialId: null,
		hidden: false,
		surfaceCode: 0,
		roleCode: 0,
		label: jsonLabel([SHAPE_SCHEMA, 'extrusion', entityId, part, distance])
	};
}

function canonicalRectangleCorners(mesh: Mesh, ring: readonly number[]): boolean {
	if (ring.length !== 4 || new Set(ring).size !== 4) return false;
	if (ring.some((index) => !Number.isSafeInteger(index) || index < 0 || index * 3 + 2 >= mesh.positions.length)) return false;
	const points = ring.map((index) => vectorAt(mesh.positions, index));
	if (points.some((point) => !Object.is(point[1], 0))) return false;
	const xmin = Math.min(...points.map((point) => point[0]));
	const xmax = Math.max(...points.map((point) => point[0]));
	const zmin = Math.min(...points.map((point) => point[2]));
	const zmax = Math.max(...points.map((point) => point[2]));
	if (xmax - xmin < MIN_EDGE_METRES || zmax - zmin < MIN_EDGE_METRES) return false;
	const expected: readonly (readonly number[])[] = [
		[xmin, 0, zmin], [xmin, 0, zmax], [xmax, 0, zmax], [xmax, 0, zmin]
	];
	return points.every((point, index) => sameTuple(point, expected[index]!));
}

/** Replace one supported flat rectangle with a closed signed prism. */
export function buildExtrusionEdit(graph: BomcGraph, entityId: string, distance: number): GeometryEdit {
	if (!finite(distance) || Math.abs(distance) < MIN_EDGE_METRES) invalid('Extrusion distance must be finite and at least 1e-6 metres from zero.');
	const { mesh } = validateRootForEditing(graph);
	if (!mesh) invalid('Select an existing rectangle before extruding.');
	const target = mesh.faces.find((face) => face.id === entityId);
	if (!target || target.label === null) invalid('Selected entity does not exist.');
	const label = tupleLabel(target);
	if (!label || label.length !== 3 || label[0] !== SHAPE_SCHEMA || label[1] !== 'rectangle' || label[2] !== entityId
		|| !canonicalRectangleCorners(mesh, target.outer) || target.holes.length !== 0) {
		invalid('Only an unextruded authored rectangle can be extruded.');
	}
	if (!sameTuple(target.triangles, [target.outer[0]!, target.outer[1]!, target.outer[2]!, target.outer[0]!, target.outer[2]!, target.outer[3]!])
		|| !sameTuple(target.normal, [0, 1, 0]) || target.frontMaterialId !== defaultMaterialId(graph)
		|| target.backMaterialId !== defaultMaterialId(graph)) {
		invalid('Selected rectangle does not match the canonical authoring topology.');
	}
	const oldMesh = mesh;
	const capStart = oldMesh.positions.length / 3;
	const capPositions: number[] = [];
	for (const index of target.outer) {
		const point = vectorAt(oldMesh.positions, index);
		capPositions.push(point[0], point[1] + distance, point[2]);
	}
	const nextMesh: Mesh = { ...oldMesh, positions: [...oldMesh.positions, ...capPositions] };
	const original = [...target.outer];
	const cap = [capStart, capStart + 1, capStart + 2, capStart + 3];
	const positive = distance > 0;
	const baseRing = positive ? [original[0]!, original[3]!, original[2]!, original[1]!] : original;
	const capRing = positive ? cap : [cap[0]!, cap[3]!, cap[2]!, cap[1]!];
	const replacements: Face[] = [
		makeFace(entityId, 'base', distance, baseRing, nextMesh, graph, positive ? [0, -1, 0] : [0, 1, 0]),
		makeFace(entityId, 'cap', distance, capRing, nextMesh, graph, positive ? [0, 1, 0] : [0, -1, 0])
	];
	for (let side = 0; side < 4; side += 1) {
		const next = (side + 1) % 4;
		const sideRing = positive
			? [original[side]!, original[next]!, cap[next]!, cap[side]!]
			: [original[side]!, cap[side]!, cap[next]!, original[next]!];
		replacements.push(makeFace(entityId, `side:${side}`, distance, sideRing, nextMesh, graph));
	}
	const nextFaces = [...oldMesh.faces.filter((face) => face.id !== entityId), ...replacements];
	const updated = withSortedFaces(nextMesh, nextFaces);
	return { forward: [{ type: 'put-mesh', value: updated }], inverse: [{ type: 'put-mesh', value: oldMesh }] };
}

function faceCommon(face: Face, expectedFront: string, expectedBack: string | null) {
	return face.hidden === false && face.surfaceCode === 0 && face.roleCode === 0
		&& face.frontMaterialId === expectedFront && face.backMaterialId === expectedBack
		&& face.holes.length === 0 && face.outer.length === 4 && new Set(face.outer).size === 4
		&& sameTuple(face.triangles, [face.outer[0]!, face.outer[1]!, face.outer[2]!, face.outer[0]!, face.outer[2]!, face.outer[3]!]);
}

function ringReverseWinding(ring: readonly number[]) {
	return [ring[0]!, ring[3]!, ring[2]!, ring[1]!];
}

function closeNormal(actual: readonly number[], expected: readonly number[]) {
	return actual.length === 3 && expected.length === 3
		&& actual.every((value, index) => finite(value) && Math.abs(value - expected[index]!) <= NORMAL_TOLERANCE);
}

function verifyRectangleEntity(entityId: string, faces: readonly Face[], mesh: Mesh, materialId: string): boolean {
	if (faces.length !== 1) return false;
	const face = faces[0]!;
	return face.id === entityId && faceCommon(face, materialId, materialId)
		&& sameTuple(face.normal, [0, 1, 0]) && canonicalRectangleCorners(mesh, face.outer);
}

function verifyExtrusionEntity(
	entityId: string,
	faces: readonly Face[],
	mesh: Mesh,
	materialId: string,
	distance: number
): { ok: boolean; usedVertices: number[]; baseFace: Face | null; outer: number[] } {
	if (faces.length !== 6 || !finite(distance) || Math.abs(distance) < MIN_EDGE_METRES) return { ok: false, usedVertices: [], baseFace: null, outer: [] };
	const byPart = new Map<string, Face>();
	for (const face of faces) {
		const parts = tupleLabel(face);
		if (!parts || parts.length !== 5 || parts[0] !== SHAPE_SCHEMA || parts[1] !== 'extrusion' || parts[2] !== entityId
			|| !Object.is(parts[4], distance) || typeof parts[3] !== 'string' || byPart.has(parts[3])) {
			return { ok: false, usedVertices: [], baseFace: null, outer: [] };
		}
		byPart.set(parts[3], face);
	}
	const base = byPart.get('base');
	const cap = byPart.get('cap');
	if (!base || !cap || base.id !== entityId || cap.id !== `${entityId}:cap`) return { ok: false, usedVertices: [], baseFace: null, outer: [] };
	const sides: Face[] = [];
	for (let side = 0; side < 4; side += 1) {
		const face = byPart.get(`side:${side}`);
		if (!face || face.id !== `${entityId}:side:${side}`) return { ok: false, usedVertices: [], baseFace: null, outer: [] };
		sides.push(face);
	}
	if (byPart.size !== 6 || !faceCommon(base, materialId, null) || !faceCommon(cap, materialId, null)
		|| sides.some((face) => !faceCommon(face, materialId, null))) return { ok: false, usedVertices: [], baseFace: null, outer: [] };
	const positive = distance > 0;
	const original = positive ? ringReverseWinding(base.outer) : [...base.outer];
	const capOriginal = positive ? [...cap.outer] : ringReverseWinding(cap.outer);
	if (!canonicalRectangleCorners(mesh, original) || capOriginal.length !== 4
		|| new Set(capOriginal).size !== 4 || original.some((index) => capOriginal.includes(index))) {
		return { ok: false, usedVertices: [], baseFace: null, outer: [] };
	}
	const expectedBase = positive ? ringReverseWinding(original) : original;
	const expectedCap = positive ? capOriginal : ringReverseWinding(capOriginal);
	if (!sameTuple(base.outer, expectedBase) || !sameTuple(cap.outer, expectedCap)) return { ok: false, usedVertices: [], baseFace: null, outer: [] };
	for (let index = 0; index < 4; index += 1) {
		const basePoint = vectorAt(mesh.positions, original[index]!);
		const capPoint = vectorAt(mesh.positions, capOriginal[index]!);
		if (!Object.is(capPoint[0], basePoint[0]) || !Object.is(capPoint[1], basePoint[1] + distance)
			|| !Object.is(capPoint[2], basePoint[2])) return { ok: false, usedVertices: [], baseFace: null, outer: [] };
	}
	if (!sameTuple(base.normal, positive ? [0, -1, 0] : [0, 1, 0])
		|| !sameTuple(cap.normal, positive ? [0, 1, 0] : [0, -1, 0])) {
		return { ok: false, usedVertices: [], baseFace: null, outer: [] };
	}
	for (let side = 0; side < 4; side += 1) {
		const next = (side + 1) % 4;
		const expectedRing = positive
			? [original[side]!, original[next]!, capOriginal[next]!, capOriginal[side]!]
			: [original[side]!, capOriginal[side]!, capOriginal[next]!, original[next]!];
		const face = sides[side]!;
		const expectedNormal = normalizedCross(
			vectorAt(mesh.positions, expectedRing[0]!),
			vectorAt(mesh.positions, expectedRing[1]!),
			vectorAt(mesh.positions, expectedRing[2]!)
		);
		if (!sameTuple(face.outer, expectedRing) || !closeNormal(face.normal, expectedNormal)) {
			return { ok: false, usedVertices: [], baseFace: null, outer: [] };
		}
	}
	return {
		ok: true,
		usedVertices: [...new Set([...original, ...capOriginal])],
		baseFace: base,
		outer: original
	};
}

function v2SequenceForFace(graph: BomcGraph, face: Face): number | null {
	const direct = sequenceForApplicationId(graph.documentId, face.id);
	if (direct !== null) return direct;
	const label = tupleLabel(face);
	if (!label) return null;
	for (const value of label) if (typeof value === 'string') {
		const sequence = sequenceForApplicationId(graph.documentId, value);
		if (sequence !== null) return sequence;
	}
	return null;
}

function validateTopologyEditableSubset(graph: BomcGraph): EditableSubsetResult {
	try {
		const { mesh } = validateRootForTopologyEditing(graph);
		if (!mesh) return { editable: true, entities: [] };
		if (mesh.positions.length === 0 || mesh.positions.length % 3 !== 0 || mesh.positions.some((value) => !finite(value))) {
			return { editable: false, reason: 'Mesh positions are malformed for authoring.' };
		}
		for (let index = 1; index < mesh.faces.length; index += 1) {
			if (codeUnitCompare(mesh.faces[index - 1]!.id, mesh.faces[index]!.id) >= 0) {
				return { editable: false, reason: 'Mesh faces are not in canonical code-unit ID order.' };
			}
		}
			const supportedMaterialIds = new Set(graph.materials.map((material) => material.id));
			const usedVertices = new Set<number>();
			for (const face of mesh.faces) {
				if (face.hidden || face.surfaceCode !== 0 || face.roleCode !== 0) {
					return { editable: false, reason: `Face ${face.id} uses unsupported authoring face attributes.` };
				}
			if (!face.frontMaterialId || !supportedMaterialIds.has(face.frontMaterialId)
				|| (face.backMaterialId !== null && !supportedMaterialIds.has(face.backMaterialId))) {
				return { editable: false, reason: `Face ${face.id} references an unsupported authoring material.` };
				}
				const label = tupleLabel(face);
				const v2 = label?.[0] === SHAPE_SCHEMA_V2 && (label.length === 3 || label.length === 4)
					&& ['rectangle', 'line', 'push-pull', 'split'].includes(String(label[1])) && label[2] === face.id
					&& (label.length === 3 || (typeof label[3] === 'string' && sequenceForApplicationId(graph.documentId, label[3]) !== null));
				const legacy = label?.[0] === SHAPE_SCHEMA && (label?.[1] === 'rectangle' || label?.[1] === 'extrusion')
					&& typeof label?.[2] === 'string' && sequenceForEntity(graph.documentId, label[2]) !== null;
				if (!v2 && !legacy) return { editable: false, reason: `Face ${face.id} has an unsupported authoring label.` };
				const rings = [face.outer, ...face.holes];
				const ringVertices = rings.flatMap((ring) => [...ring]);
				const expectedTriangleCount = ringVertices.length + 2 * face.holes.length - 2;
				if (rings.some((ring) => ring.length < 3 || ring.length > 256 || new Set(ring).size !== ring.length)
					|| new Set(ringVertices).size !== ringVertices.length
					|| face.triangles.length !== expectedTriangleCount * 3
					|| face.triangles.some((vertex) => !ringVertices.includes(vertex))) {
					return { editable: false, reason: `Face ${face.id} has malformed ring or triangle topology.` };
				}
				for (const vertex of ringVertices) usedVertices.add(vertex);
				let prepared;
				try { prepared = preparePolygon(face.outer.map((vertex) => vectorAt(mesh.positions, vertex)) as Point3[], face.normal as Point3, { canonicalizeStart: false }); }
				catch (error) { return { editable: false, reason: `Face ${face.id} is not a supported simple planar polygon: ${error instanceof Error ? error.message : 'polygon validation failed'}` }; }
				if (dot3(rawRingNormal(mesh, face.outer), face.normal) < 1 - 1e-9 || dot3(prepared.normal, face.normal) < 1 - 1e-9) {
					return { editable: false, reason: `Face ${face.id} normal is inconsistent with its ring.` };
				}
				for (const hole of face.holes) {
					try { preparePolygon(hole.map((vertex) => vectorAt(mesh.positions, vertex)) as Point3[], face.normal as Point3, { canonicalizeStart: false }); }
					catch (error) { return { editable: false, reason: `Face ${face.id} has an invalid hole ring: ${error instanceof Error ? error.message : 'polygon validation failed'}` }; }
				}
				if (face.holes.length > 0) {
					let expected: number[];
					try { expected = triangulateFaceRings(mesh, face.outer, face.holes, face.normal as Point3); }
					catch (error) { return { editable: false, reason: `Face ${face.id} holes could not be triangulated: ${error instanceof Error ? error.message : 'triangulation failed'}` }; }
					if (!sameTuple(face.triangles, expected)) return { editable: false, reason: `Face ${face.id} hole triangulation is not canonical.` };
				}
			}
		if (usedVertices.size !== mesh.positions.length / 3) return { editable: false, reason: 'Mesh contains orphan vertex positions.' };
		try { buildAuthoringTopology(mesh); }
		catch (error) {
			const message = error instanceof AuthoringTopologyError ? error.message : 'Topology validation failed.';
			return { editable: false, reason: message };
		}
		const entities: AuthoringEntity[] = mesh.faces.map((face) => ({
			entityId: face.id,
			sequence: v2SequenceForFace(graph, face) ?? 1,
			kind: 'face' as const,
			faces: [face],
			baseFace: face,
			outer: face.outer,
			distance: null
		})).sort((left, right) => left.sequence - right.sequence || codeUnitCompare(left.entityId, right.entityId));
		return { editable: true, entities };
	} catch (error) {
		return { editable: false, reason: error instanceof Error ? error.message : 'Application authoring topology validation failed.' };
	}
}

/**
 * Inspect a kernel-valid BOMC graph without repairing it. Callers must run the
 * canonical BOMC reader/document validator first; unsupported application
 * structures are returned as viewer-only reasons.
 */
export function validateEditableSubset(graph: BomcGraph): EditableSubsetResult {
	try {
		if (graph.meshes.some((mesh) => mesh.faces.some(isV2Face))) return validateTopologyEditableSubset(graph);
		const docId = graph.documentId;
		if (typeof docId !== 'string' || !docId) return { editable: false, reason: 'Document identity is missing.' };
		const rootDefinitionId = `${docId}:definition:root`;
		const rootInstanceId = `${docId}:instance:root`;
		if (graph.rootDefinitionId !== rootDefinitionId || graph.rootInstanceId !== rootInstanceId
			|| graph.definitions.length !== 1 || graph.instances.length !== 1) {
			return { editable: false, reason: 'The document is outside the flat root-only authoring subset.' };
		}
		const definition = graph.definitions[0]!;
		const root = graph.instances[0]!;
		if (definition.id !== rootDefinitionId || definition.name !== 'Document Root' || definition.kind !== 'model'
			|| root.id !== rootInstanceId || root.name !== 'Root' || root.kind !== 'root'
			|| root.ownerDefinitionId !== null || root.definitionId !== rootDefinitionId
			|| !sameTuple(root.matrix, ROOT_MATRIX) || root.materialId !== null || root.visible !== true
			|| root.roleCode !== 0 || root.label !== null) {
			return { editable: false, reason: 'The document root differs from the exact New document root.' };
		}
		if (graph.meshes.length === 0) {
			if (definition.meshId !== null || graph.materials.length !== 0) return { editable: false, reason: 'An empty document contains unrelated mesh or material data.' };
			return { editable: true, entities: [] };
		}
		if (graph.meshes.length !== 1) return { editable: false, reason: 'Authoring supports exactly one root mesh.' };
		const mesh = graph.meshes[0]!;
		const materialId = defaultMaterialId(graph);
		if (mesh.id !== rootMeshId(graph) || mesh.definitionId !== rootDefinitionId || definition.meshId !== mesh.id) {
			return { editable: false, reason: 'The root mesh identity differs from the exact authoring mesh.' };
		}
		if (graph.materials.length !== 1 || !sameMaterial(graph.materials[0]!, defaultMaterial(graph))) {
			return { editable: false, reason: 'Authoring supports only the exact default solid material.' };
		}
		if (mesh.positions.length === 0 || mesh.positions.length % 3 !== 0
			|| mesh.positions.some((value) => !finite(value))) return { editable: false, reason: 'Mesh positions are malformed for authoring.' };
		for (let index = 1; index < mesh.faces.length; index += 1) {
			if (codeUnitCompare(mesh.faces[index - 1]!.id, mesh.faces[index]!.id) >= 0) {
				return { editable: false, reason: 'Mesh faces are not in canonical code-unit ID order.' };
			}
		}
		const grouped = new Map<string, { sequence: number; labels: unknown[][]; faces: Face[] }>();
		for (const face of mesh.faces) {
			const label = tupleLabel(face);
			if (!label || label[0] !== SHAPE_SCHEMA || (label[1] !== 'rectangle' && label[1] !== 'extrusion')
				|| typeof label[2] !== 'string') return { editable: false, reason: `Face ${face.id} has an unsupported authoring label.` };
			const entityId = label[2];
			const sequence = sequenceForEntity(docId, entityId);
			if (sequence === null) return { editable: false, reason: `Entity ${entityId} does not use a positive document-local sequence.` };
			const group = grouped.get(entityId) ?? { sequence, labels: [], faces: [] };
			if (group.sequence !== sequence) return { editable: false, reason: `Entity ${entityId} has an inconsistent sequence.` };
			group.labels.push(label);
			group.faces.push(face);
			grouped.set(entityId, group);
		}
		const used = new Set<number>();
		const entities: AuthoringEntity[] = [];
		for (const [entityId, group] of grouped) {
			const labels = group.labels;
			if (labels.length === 1 && labels[0]!.length === 3 && labels[0]![1] === 'rectangle'
				&& labels[0]![2] === entityId && verifyRectangleEntity(entityId, group.faces, mesh, materialId)) {
				const face = group.faces[0]!;
				for (const index of face.outer) {
					if (used.has(index)) return { editable: false, reason: 'Authoring entities cannot share vertex positions.' };
					used.add(index);
				}
				entities.push({ entityId, sequence: group.sequence, kind: 'rectangle', faces: group.faces, baseFace: face, outer: face.outer, distance: null });
				continue;
			}
			if (labels.every((label) => label.length === 5 && label[1] === 'extrusion' && label[2] === entityId)
				&& typeof labels[0]![4] === 'number' && labels.every((label) => Object.is(label[4], labels[0]![4]))) {
				const distance = labels[0]![4] as number;
				const result = verifyExtrusionEntity(entityId, group.faces, mesh, materialId, distance);
				if (!result.ok || !result.baseFace) return { editable: false, reason: `Extrusion ${entityId} differs from the canonical six-face prism.` };
				for (const index of result.usedVertices) {
					if (used.has(index)) return { editable: false, reason: 'Authoring entities cannot share vertex positions.' };
					used.add(index);
				}
				entities.push({ entityId, sequence: group.sequence, kind: 'extrusion', faces: group.faces, baseFace: result.baseFace, outer: result.outer, distance });
				continue;
			}
			return { editable: false, reason: `Entity ${entityId} has malformed or mixed rectangle/prism faces.` };
		}
		if (used.size !== mesh.positions.length / 3) return { editable: false, reason: 'Mesh contains orphan vertex positions.' };
		entities.sort((left, right) => left.sequence - right.sequence);
		return { editable: true, entities };
	} catch (error) {
		return { editable: false, reason: error instanceof Error ? error.message : 'Application authoring validation failed.' };
	}
}

/** The next new entity ID after reopening an already validated graph. */
export function nextRectangleSequence(graph: BomcGraph): number {
	const subset = validateEditableSubset(graph);
	if (!subset.editable) invalid(`Cannot allocate an ID for a viewer-only document: ${subset.reason}`);
	let max = subset.entities.reduce((value, entity) => Math.max(value, entity.sequence), 0);
	for (const mesh of graph.meshes) for (const face of mesh.faces) {
		for (const value of [face.id, ...(tupleLabel(face) ?? [])]) if (typeof value === 'string') {
			const sequence = sequenceForApplicationId(graph.documentId, value);
			if (sequence !== null) max = Math.max(max, sequence);
		}
	}
	if (max >= Number.MAX_SAFE_INTEGER) invalid('Rectangle ID sequence is exhausted.');
	return max + 1;
}

export const nextAuthoringSequence = nextRectangleSequence;

export function hasEntityId(graph: BomcGraph, entityId: string): boolean {
	return graph.meshes.some((mesh) => mesh.faces.some((face) => face.id === entityId || tupleLabel(face)?.[2] === entityId));
}

export function hasFaceId(graph: BomcGraph, faceId: string): boolean {
	return graph.meshes.some((mesh) => mesh.faces.some((face) => face.id === faceId));
}

export { faceFromRing, compactReferencedVertices };

export function journalEntry(edit: GeometryEdit): AuthoringJournalEntry {
	return { forward: edit.forward, inverse: edit.inverse };
}
