import type { BomcGraph, DocumentEdit, Face, Mesh, SolidMaterial } from '@sibambo/bomc-document';
import type { AuthoringPoint, AuthoringJournalEntry } from './protocol.js';

const SHAPE_SCHEMA = 'sibambo-editor-shape-v1';
const ROOT_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
const DEFAULT_RGBA = [155, 28, 49, 255] as const;
const MIN_EDGE_METRES = 1e-6;
const NORMAL_TOLERANCE = 1e-12;

export const DEFAULT_AUTHORING_MATERIAL_NAME = 'Default';

export class AuthoringGeometryError extends Error {
	readonly code = 'INVALID_COMMAND' as const;
	constructor(message: string) { super(message); this.name = 'AuthoringGeometryError'; }
}

export type AuthoringEntity = {
	entityId: string;
	sequence: number;
	kind: 'rectangle' | 'extrusion';
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
function defaultMaterialId(graph: BomcGraph) { return `${graph.documentId}:material:default`; }
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

/**
 * Inspect a kernel-valid BOMC graph without repairing it. Callers must run the
 * canonical BOMC reader/document validator first; unsupported application
 * structures are returned as viewer-only reasons.
 */
export function validateEditableSubset(graph: BomcGraph): EditableSubsetResult {
	try {
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
	const max = subset.entities.reduce((value, entity) => Math.max(value, entity.sequence), 0);
	if (max >= Number.MAX_SAFE_INTEGER) invalid('Rectangle ID sequence is exhausted.');
	return max + 1;
}

export function hasEntityId(graph: BomcGraph, entityId: string): boolean {
	return graph.meshes.some((mesh) => mesh.faces.some((face) => face.id === entityId || tupleLabel(face)?.[2] === entityId));
}

export function journalEntry(edit: GeometryEdit): AuthoringJournalEntry {
	return { forward: edit.forward, inverse: edit.inverse };
}
