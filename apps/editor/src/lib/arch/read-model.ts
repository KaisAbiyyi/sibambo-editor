/**
 * SIB-MCP-MODELING-001 v2.3 C12/C13 — `arch/read-model.ts`: the read-only scene index shared by perception and checks.
 *
 * - Works on the frozen document snapshot only; nothing here returns or stages an edit (invariant 9).
 * - Managed modules are evaluated with `purpose:'read'` (v2.4 A4/A7): existing geometry is described, never rejected.
 * - Coordinates: module-local +Z-up for architecture; world +Z-up (`CONVENTION⁻¹` of the runtime frame) for freeform
 *   geometry (A10/A17). Both use the same matrix: world-Z-up ← definition-local = CONVENTION⁻¹ · occurrence matrix,
 *   because a managed container's matrix already contains CONVENTION · T.
 * - Element/role attribution of a baked face is recomputed by face index (A21) and only for modules in state `ok`.
 */
import { Matrix4, Vector3 } from 'three';
import type { BomcGraph, Definition, Face, Instance, Mesh } from '@sibambo/bomc-document';
import { instanceVisible, organization, type ModelOrganization } from '../authoring/organization.js';
import { meshEdges, modelOccurrences } from '../authoring/model.js';
import { CONVENTION_INVERSE_ROW_MAJOR, CONVENTION_ROW_MAJOR, transpose } from './convention.js';
import { frameWidth, type OpeningElement, type SlabElement } from './elements.js';
import { ArchError } from './errors.js';
import { evaluateModule, type EvaluatedModule, type EvaluatedPart } from './evaluate.js';
import type { Kernel } from './kernel.js';
import { readManaged, type ManagedModuleRecord, type ManagedState } from './managed.js';
import type { ArchElement, ArchModule } from './schema.js';
import type { TopologyEdge, TopologyFace } from './topology.js';
import type { Bounds3, P3 } from './textfmt.js';

export const TO_Z_UP = new Matrix4().fromArray(transpose(CONVENTION_INVERSE_ROW_MAJOR));
const FROM_Z_UP = new Matrix4().fromArray(transpose(CONVENTION_ROW_MAJOR));

export const apply = (m: Matrix4, p: readonly number[]): P3 => {
	const v = new Vector3(p[0], p[1], p[2]).applyMatrix4(m);
	return [v.x, v.y, v.z];
};
/** Runtime (Y-up) point → world Z-up. */
export const worldZUp = (p: readonly number[]): P3 => apply(TO_Z_UP, p);

export function boundsOf(points: Iterable<readonly number[]>): Bounds3 | null {
	let bounds: Bounds3 | null = null;
	for (const p of points) {
		bounds ??= { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
		for (let k = 0; k < 3; k++) {
			bounds.min[k] = Math.min(bounds.min[k]!, p[k]!);
			bounds.max[k] = Math.max(bounds.max[k]!, p[k]!);
		}
	}
	return bounds;
}

export type ArchFaceRef = { id: string; graphFaceId: string | null; moduleId: string; part: EvaluatedPart; face: TopologyFace };
export type ArchEdgeRef = { id: string; moduleId: string; part: EvaluatedPart; edge: TopologyEdge };

/**
 * Topology numbers faces per part, so the frame, glazing and leaf of one opening each have an `<opening>:f0`. Insert faces are
 * therefore addressed by part (`moduleId:door/frame:f0`); wall and slab faces keep `moduleId:elementId:f<k>`.
 */
export function archFaceId(moduleId: string, part: EvaluatedPart, faceId: string): string {
	const insert = part.kind === 'frame' || part.kind === 'glazing' || part.kind === 'leaf';
	return `${moduleId}:${insert ? part.partId + faceId.slice(faceId.lastIndexOf(':')) : faceId}`;
}

export type Occurrence = { definitionId: string; path: string[]; matrix: Matrix4 };

export type ReadModule = {
	moduleId: string;
	record: ManagedModuleRecord;
	state: ManagedState;
	module: ArchModule;
	/** `null` for detached/orphaned modules and for modules whose stored parameters cannot be evaluated. */
	evaluated: EvaluatedModule | null;
	/** Spaces whose seed lies inside a wall body; the rest of the module is still evaluated without them. */
	seedsInWall: { elementId: string; at: readonly [number, number] }[];
	/** Evaluation failure of stored parameters (only possible for a document not written by `edit_model`). */
	failure: { reason: string; elementId: string | null; message: string } | null;
	/** World Z-up ← module-local, one per visible-or-hidden occurrence of the container (empty when orphaned). */
	placements: Matrix4[];
	path: string[];
	faces: ArchFaceRef[];
	edges: ArchEdgeRef[];
};

export type ReadScene = {
	graph: BomcGraph;
	org: ModelOrganization;
	modules: Map<string, ReadModule>;
	occurrences: Occurrence[];
	instanceById: Map<string, Instance>;
	definitionById: Map<string, Definition>;
	meshByDefinition: Map<string, Mesh>;
	/** Container instance id → module id, for containers that are present. */
	managedByInstance: Map<string, string>;
	tagOf: (instanceId: string) => string | null;
	visible: (instanceId: string) => boolean;
	materialName: (materialId: string | null) => string | null;
};

/** Evaluates a stored module for reading; a space seed inside a wall is reported instead of hiding the whole module. */
export function evaluateForRead(module: ArchModule, kernel: Kernel): Pick<ReadModule, 'evaluated' | 'seedsInWall' | 'failure'> {
	const seedsInWall: ReadModule['seedsInWall'] = [];
	let current = module;
	for (;;) {
		try {
			return { evaluated: evaluateModule(current, kernel, { purpose: 'read' }), seedsInWall, failure: null };
		} catch (error) {
			if (!(error instanceof ArchError)) throw error;
			const { reason, elementId, at } = error.detail;
			if (reason === 'SPACE_SEED_IN_WALL' && elementId && current.elements.some((e) => e.elementId === elementId && e.kind === 'space')) {
				seedsInWall.push({ elementId, at: at ?? (current.elements.find((e) => e.elementId === elementId)!.seedPoint as [number, number]) });
				current = { ...current, elements: current.elements.filter((e) => e.elementId !== elementId) };
				continue;
			}
			return { evaluated: null, seedsInWall, failure: { reason, elementId: elementId ?? null, message: error.message } };
		}
	}
}

/** True when the document has at least one module that must be evaluated (so the caller needs an initialised kernel). */
export function needsKernel(graph: BomcGraph): boolean {
	for (const record of readManaged(graph).values()) if (record.state === 'ok') return true;
	return false;
}

export function readScene(graph: BomcGraph, kernel: Kernel): ReadScene {
	const org = organization(graph);
	const instanceById = new Map(graph.instances.map((i) => [i.id, i]));
	const definitionById = new Map(graph.definitions.map((d) => [d.id, d]));
	const meshByDefinition = new Map(graph.meshes.map((m) => [m.definitionId, m]));
	const materialById = new Map(graph.materials.map((m) => [m.id, m]));
	const tagById = new Map(org.tags.map((t) => [t.id, t.name]));
	const tagByInstance = new Map(org.assignments.map((a) => [a.instanceId, a.tagId]));
	const occurrences: Occurrence[] = modelOccurrences(graph, true);
	const managedByInstance = new Map<string, string>();
	const modules = new Map<string, ReadModule>();
	const records = readManaged(graph);
	for (const moduleId of [...records.keys()].sort()) {
		const record = records.get(moduleId)!;
		if (record.instance) managedByInstance.set(record.instance.id, moduleId);
		const own = occurrences.filter((o) => o.path.at(-1) === record.entry.instanceId);
		const read: Pick<ReadModule, 'evaluated' | 'seedsInWall' | 'failure'> =
			record.state === 'ok' ? evaluateForRead(record.entry.module, kernel) : { evaluated: null, seedsInWall: [], failure: null };
		const faces: ArchFaceRef[] = [];
		const edges: ArchEdgeRef[] = [];
		if (read.evaluated) {
			const mesh = meshByDefinition.get(record.instance!.definitionId) ?? null;
			for (const part of read.evaluated.parts) {
				for (const face of part.topology.faces) faces.push({ id: archFaceId(moduleId, part, face.id), graphFaceId: null, moduleId, part, face });
				part.topology.edges.forEach((edge, k) => edges.push({ id: `${moduleId}:${part.partId}:e${k}`, moduleId, part, edge }));
			}
			// A21: baked face k is topology face k; only while the stored parameters are exactly what was baked.
			if (read.seedsInWall.length === 0 && mesh && mesh.faces.length === faces.length) mesh.faces.forEach((face, k) => (faces[k]!.graphFaceId = face.id));
		}
		modules.set(moduleId, {
			moduleId, record, state: record.state, module: record.entry.module, ...read,
			placements: own.map((o) => TO_Z_UP.clone().multiply(o.matrix)),
			path: own[0]?.path ?? [],
			faces, edges
		});
	}
	return {
		graph, org, modules, occurrences, instanceById, definitionById, meshByDefinition, managedByInstance,
		tagOf: (id) => tagById.get(tagByInstance.get(id) ?? '') ?? null,
		visible: (id) => instanceVisible(graph, id, org),
		materialName: (id) => (id === null ? null : (materialById.get(id)?.name ?? null))
	};
}

// ─── architectural elements ──────────────────────────────────────────────────────────────────────────────────────

/** Module-local points whose AABB is the element's body bounds; `null` without evaluated geometry. Spaces are 2D (z = 0). */
export function elementPoints(read: ReadModule, element: ArchElement): P3[] | null {
	const evaluated = read.evaluated;
	if (!evaluated) return null;
	if (element.kind === 'wall') {
		return evaluated.segments
			.filter((s) => s.elementId === element.elementId)
			.flatMap((s) => [...s.quad, ...s.body].flatMap(([x, y]): P3[] => [[x, y, s.z0], [x, y, s.z0 + s.h]]));
	}
	if (element.kind === 'slab') {
		const slab = element as unknown as SlabElement;
		return slab.outline.flatMap(([x, y]): P3[] => [[x, y, slab.topElevation - slab.thickness], [x, y, slab.topElevation]]);
	}
	if (element.kind === 'opening') {
		const placed = openingGeometry(read, element);
		return placed ? placed.corners : null;
	}
	const space = evaluated.spaces.find((s) => s.elementId === element.elementId);
	return space && space.ring.length ? space.ring.map(([x, y]): P3 => [x, y, 0]) : null;
}

export function openingGeometry(read: ReadModule, element: ArchElement) {
	const placed = read.evaluated?.openings.find((o) => o.elementId === element.elementId);
	const segment = placed && read.evaluated!.segments.find((s) => s.tag === placed.segmentTag);
	if (!placed || !segment) return null;
	const at = (x: number, y: number, z: number): P3 => [segment.a[0] + segment.d[0] * x + segment.n[0] * y, segment.a[1] + segment.d[1] * x + segment.n[1] * y, z];
	const opening = element as unknown as OpeningElement;
	const fw = opening.openingType === 'void' ? 0 : frameWidth(opening.width, opening.height, segment.t);
	const corners = [placed.x0, placed.x1].flatMap((x) => [segment.yR, segment.yL].flatMap((y) => [placed.zBottom, placed.zTop].map((z) => at(x, y, z))));
	return {
		placed, segment, corners,
		start: at(placed.x0, 0, placed.zBottom),
		end: at(placed.x1, 0, placed.zBottom),
		clearWidth: opening.width - 2 * fw,
		clearHeight: opening.height - (opening.openingType === 'window' ? 2 * fw : fw)
	};
}

// ─── faces and edges in a chosen frame ───────────────────────────────────────────────────────────────────────────

export type FaceGeometry = {
	id: string;
	/** `moduleId:elementId` for attributed architectural faces. */
	element: string | null;
	role: string | null;
	material: string | null;
	outer: P3[];
	holes: P3[][];
	normal: P3;
	area: number;
	centroid: P3;
};

/** Newell vector of a loop: direction = normal, length = 2·area. */
function newell(loop: readonly P3[]): P3 {
	const n: P3 = [0, 0, 0];
	const o = loop[0]!;
	for (let i = 0; i < loop.length; i++) {
		const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
		const u = [a[0] - o[0], a[1] - o[1], a[2] - o[2]], v = [b[0] - o[0], b[1] - o[1], b[2] - o[2]];
		n[0] += u[1]! * v[2]! - u[2]! * v[1]!;
		n[1] += u[2]! * v[0]! - u[0]! * v[2]!;
		n[2] += u[0]! * v[1]! - u[1]! * v[0]!;
	}
	return n;
}

/** Normal and net area of a planar face from its loops; `hint` selects the side (loop winding is not trusted for it). */
function planar(outer: readonly P3[], holes: readonly (readonly P3[])[], hint: readonly number[]): { normal: P3; area: number } {
	const n = newell(outer);
	const length = Math.hypot(...n);
	if (length === 0) return { normal: [0, 0, 0], area: 0 };
	const sign = n[0] * hint[0]! + n[1] * hint[1]! + n[2] * hint[2]! < 0 ? -1 : 1;
	const holesArea = holes.reduce((sum, hole) => sum + Math.hypot(...newell(hole)) / 2, 0);
	return { normal: [(sign * n[0]) / length, (sign * n[1]) / length, (sign * n[2]) / length], area: length / 2 - holesArea };
}

/** Outward hint of a mapped plane: image of the old normal under the inverse transpose. */
const mappedNormal = (m: Matrix4, n: readonly number[]): P3 => {
	const inverse = m.clone().invert().transpose();
	const v = new Vector3(n[0], n[1], n[2]).transformDirection(inverse);
	return [v.x, v.y, v.z];
};

/** `toFrame` = null keeps module-local coordinates (and the evaluator's own normal/area/centroid). */
export function archFaceGeometry(ref: ArchFaceRef, toFrame: Matrix4 | null): FaceGeometry {
	const pos = ref.part.topology.positions;
	const at = (i: number): P3 => {
		const p: P3 = [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!];
		return toFrame ? apply(toFrame, p) : p;
	};
	const outer = ref.face.outer.map(at), holes = ref.face.holes.map((h) => h.map(at));
	const base = { id: ref.id, element: `${ref.moduleId}:${ref.face.elementId}`, role: ref.face.role, material: ref.face.materialId, outer, holes };
	if (!toFrame) return { ...base, normal: ref.face.normal, area: ref.face.area, centroid: ref.face.centroid };
	return { ...base, ...planar(outer, holes, mappedNormal(toFrame, ref.face.normal)), centroid: apply(toFrame, ref.face.centroid) };
}

export function graphFaceGeometry(scene: ReadScene, mesh: Mesh, face: Face, toFrame: Matrix4): FaceGeometry {
	const at = (i: number): P3 => apply(toFrame, [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!]);
	const outer = face.outer.map(at), holes = face.holes.map((h) => h.map(at));
	let weight = 0;
	const centroid: P3 = [0, 0, 0];
	for (let t = 0; t < face.triangles.length; t += 3) {
		const tri = [at(face.triangles[t]!), at(face.triangles[t + 1]!), at(face.triangles[t + 2]!)];
		const area = Math.hypot(...newell(tri));
		weight += area;
		for (let k = 0; k < 3; k++) centroid[k] += ((tri[0]![k]! + tri[1]![k]! + tri[2]![k]!) / 3) * area;
	}
	if (weight > 0) for (let k = 0; k < 3; k++) centroid[k] /= weight;
	return { id: face.id, element: null, role: null, material: scene.materialName(face.frontMaterialId), outer, holes, ...planar(outer, holes, mappedNormal(toFrame, face.normal)), centroid };
}

export type EdgeGeometry = { id: string; a: P3; b: P3; length: number; flag: 'hard' | 'soft'; faces: string[]; angle: number | null };

export function archEdgeGeometry(ref: ArchEdgeRef, toFrame: Matrix4 | null): EdgeGeometry {
	const pos = ref.part.topology.positions;
	const at = (i: number): P3 => {
		const p: P3 = [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!];
		return toFrame ? apply(toFrame, p) : p;
	};
	const a = at(ref.edge.a), b = at(ref.edge.b);
	return {
		id: ref.id, a, b, length: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), flag: ref.edge.flag,
		faces: ref.edge.faces.map((f) => archFaceId(ref.moduleId, ref.part, f)), angle: ref.edge.faces.length === 2 ? ref.edge.dihedral : null
	};
}

/** Every freeform edge is drawn by the authoring renderer, so all of them are `hard`. `angle` needs exactly two faces. */
export function graphEdgeGeometries(mesh: Mesh, owner: string, toFrame: Matrix4): EdgeGeometry[] {
	const normals = new Map(mesh.faces.map((f) => [f.id, mappedNormal(toFrame, f.normal)]));
	return meshEdges(mesh).map((edge, k) => {
		const a = apply(toFrame, edge.start), b = apply(toFrame, edge.end);
		const faces = [...new Set(edge.faceIds)].sort();
		let angle: number | null = null;
		if (faces.length === 2) {
			const [m, n] = [normals.get(faces[0]!)!, normals.get(faces[1]!)!];
			angle = (Math.acos(Math.max(-1, Math.min(1, m[0] * n[0] + m[1] * n[1] + m[2] * n[2]))) * 180) / Math.PI;
		}
		return { id: `${owner}:e${k}`, a, b, length: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), flag: 'hard' as const, faces, angle };
	});
}

// ─── freeform ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Module owning an occurrence path (the first managed container on it), if any. */
export function managedModuleOfPath(scene: ReadScene, path: readonly string[]): string | null {
	for (const id of path) {
		const moduleId = scene.managedByInstance.get(id);
		if (moduleId !== undefined) return moduleId;
	}
	return null;
}

/** Occurrences with a mesh that carry freeform geometry: everything except containers whose architecture is intact (`ok`). */
export function freeformOccurrences(scene: ReadScene): (Occurrence & { mesh: Mesh; toWorld: Matrix4; owner: string })[] {
	return scene.occurrences.flatMap((o) => {
		const moduleId = managedModuleOfPath(scene, o.path);
		const mesh = scene.meshByDefinition.get(o.definitionId);
		if (!mesh || (moduleId !== null && scene.modules.get(moduleId)!.state === 'ok')) return [];
		return [{ ...o, mesh, toWorld: TO_Z_UP.clone().multiply(o.matrix), owner: o.path.at(-1) ?? scene.graph.rootInstanceId }];
	});
}

export const pathKey = (path: readonly string[]): string => path.join('\u0000');

export type Aggregate = { bounds: Bounds3 | null; faces: number };

/** World Z-up bounds and face count of every occurrence subtree, keyed by `pathKey` ('' = the whole model). */
export function aggregates(scene: ReadScene): Map<string, Aggregate> {
	const out = new Map<string, Aggregate>();
	for (const o of scene.occurrences) {
		const mesh = scene.meshByDefinition.get(o.definitionId);
		const own = mesh ? boundsOf(meshPoints(mesh, TO_Z_UP.clone().multiply(o.matrix))) : null;
		for (let depth = 0; depth <= o.path.length; depth++) {
			const key = pathKey(o.path.slice(0, depth));
			const entry = out.get(key) ?? { bounds: null, faces: 0 };
			entry.faces += mesh?.faces.length ?? 0;
			if (own) entry.bounds = boundsOf(entry.bounds ? [entry.bounds.min, entry.bounds.max, own.min, own.max] : [own.min, own.max]);
			out.set(key, entry);
		}
	}
	return out;
}

export function* meshPoints(mesh: Mesh, toFrame: Matrix4): Generator<P3> {
	for (let i = 0; i < mesh.positions.length; i += 3) yield apply(toFrame, [mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!]);
}

export type Placement = { translation: P3; rotation: P3; scale: P3 };

const DEG = 180 / Math.PI;

/** Translation, XYZ rotation (degrees) and scale of a world-Z-up matrix. */
export function decompose(m: Matrix4): Placement {
	const e = m.elements;
	const x = new Vector3(e[0], e[1], e[2]), y = new Vector3(e[4], e[5], e[6]), z = new Vector3(e[8], e[9], e[10]);
	let sx = x.length();
	if (m.determinant() < 0) sx = -sx;
	const sy = y.length(), sz = z.length();
	const r11 = x.x / sx, r12 = y.x / sy, r13 = z.x / sz, r22 = y.y / sy, r23 = z.y / sz, r32 = y.z / sy, r33 = z.z / sz;
	// three.js Euler 'XYZ' from a rotation matrix.
	const ry = Math.asin(Math.max(-1, Math.min(1, r13)));
	const [rx, rz] = Math.abs(r13) < 0.9999999 ? [Math.atan2(-r23, r33), Math.atan2(-r12, r11)] : [Math.atan2(r32, r22), 0];
	return { translation: [e[12]!, e[13]!, e[14]!], rotation: [rx * DEG, ry * DEG, rz * DEG], scale: [sx, sy, sz] };
}

/** Freeform placement in world Z-up axes: CONVENTION⁻¹ · M · CONVENTION. */
export const freeformPlacement = (matrix: Matrix4): Placement => decompose(TO_Z_UP.clone().multiply(matrix).multiply(FROM_Z_UP));
