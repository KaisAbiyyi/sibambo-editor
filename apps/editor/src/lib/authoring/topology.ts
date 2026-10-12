import type { Face, Mesh } from '@sibambo/bomc-document';

export type MeshEdge = Readonly<{
	key: string;
	a: number;
	b: number;
	faceIds: readonly string[];
}>;

type EdgeFaceRef = Readonly<{
	faceId: string;
	ringIndex: number;
}>;

export type AuthoringTopology = Readonly<{
	edges: ReadonlyMap<string, MeshEdge>;
	faceById: ReadonlyMap<string, Face>;
	adjacentFaceIds: ReadonlyMap<string, readonly string[]>;
}>;

export class AuthoringTopologyError extends Error {
	constructor(message: string) { super(message); this.name = 'AuthoringTopologyError'; }
}

function dot(left: readonly number[], right: readonly number[]): number {
	return left[0]! * right[0]! + left[1]! * right[1]! + left[2]! * right[2]!;
}

function isSubdividedQuad(face: Face, mesh: Mesh): boolean {
	if (face.holes.length > 0 || face.outer.length < 4) return false;
	let corners = 0;
	for (let index = 0; index < face.outer.length; index += 1) {
		const point = (offset: number) => mesh.positions.slice(face.outer[(index + offset + face.outer.length) % face.outer.length]! * 3, face.outer[(index + offset + face.outer.length) % face.outer.length]! * 3 + 3);
		const a = point(-1), b = point(0), c = point(1);
		const incoming = b.map((value, axis) => value - a[axis]!);
		const outgoing = c.map((value, axis) => value - b[axis]!);
		const cross = [incoming[1]! * outgoing[2]! - incoming[2]! * outgoing[1]!, incoming[2]! * outgoing[0]! - incoming[0]! * outgoing[2]!, incoming[0]! * outgoing[1]! - incoming[1]! * outgoing[0]!];
		if (Math.hypot(...cross) > 1e-9 * Math.hypot(...incoming) * Math.hypot(...outgoing)) corners += 1;
		else if (dot(incoming, outgoing) <= 0) return false;
	}
	return corners === 4;
}

function supportedNestedThreeFaceJunction(entry: readonly EdgeFaceRef[], faceById: ReadonlyMap<string, Face>, mesh: Mesh, a: number, b: number): boolean {
	if (entry.length !== 3) return false;
	const holeRefs = entry.filter((ref) => ref.ringIndex > 0);
	const outerRefs = entry.filter((ref) => ref.ringIndex === 0);
	if (holeRefs.length !== 1 || outerRefs.length !== 2) return false;
	const holeFace = faceById.get(holeRefs[0]!.faceId);
	const outerFaces = outerRefs.map((ref) => faceById.get(ref.faceId));
	if (!holeFace || outerFaces.some((face) => !face)) return false;
	const [first, second] = outerFaces as [Face, Face];
	const firstParallel = Math.abs(Math.abs(dot(holeFace.normal, first.normal)) - 1) <= 1e-9;
	const secondParallel = Math.abs(Math.abs(dot(holeFace.normal, second.normal)) - 1) <= 1e-9;
	if (firstParallel !== secondParallel) {
		const reveal = firstParallel ? second : first;
		return Math.abs(dot(holeFace.normal, reveal.normal)) <= 1e-9;
	}
	// Pulling the nested child away from the raised ring leaves the base ring
	// between two coplanar reveal segments. They must extend to opposite sides
	// of that base plane, never overlap or admit an arbitrary three-face edge.
	if (firstParallel || Math.abs(dot(holeFace.normal, first.normal)) > 1e-9
		|| Math.abs(dot(holeFace.normal, second.normal)) > 1e-9
		|| Math.abs(Math.abs(dot(first.normal, second.normal)) - 1) > 1e-9
		|| [first, second].some((face) => !isSubdividedQuad(face, mesh))) return false;
	const anchor = mesh.positions.slice(a * 3, a * 3 + 3);
	const deltas = [first, second].map((face) => face.outer.filter((vertex) => vertex !== a && vertex !== b)
		.map((vertex) => [0, 1, 2].map((axis) => mesh.positions[vertex * 3 + axis]! - anchor[axis]!)));
	const tolerance = 1e-9 * Math.max(1, ...deltas.flat().map((delta) => Math.hypot(...delta)));
	if (deltas.flat().some((delta) => Math.abs(dot(first.normal, delta)) > tolerance)) return false;
	const side = (points: readonly number[][]) => points.every((point) => dot(holeFace.normal, point) >= -tolerance) && points.some((point) => dot(holeFace.normal, point) > tolerance) ? 1
		: points.every((point) => dot(holeFace.normal, point) <= tolerance) && points.some((point) => dot(holeFace.normal, point) < -tolerance) ? -1 : 0;
	return side(deltas[0]!) * side(deltas[1]!) === -1;
}

export function edgeKey(a: number, b: number): string {
	return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function codeUnitCompare(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }

function canonicalCycle(ring: readonly number[]): string {
	const candidates: string[] = [];
	for (const source of [ring, [...ring].reverse()] as const) for (let offset = 0; offset < source.length; offset += 1) {
		const rotated = [...source.slice(offset), ...source.slice(0, offset)];
		candidates.push(rotated.join(','));
	}
	return candidates.sort(codeUnitCompare)[0] ?? '';
}

export function buildAuthoringTopology(mesh: Mesh): AuthoringTopology {
	const vertexCount = mesh.positions.length / 3;
	if (!Number.isInteger(vertexCount)) throw new AuthoringTopologyError('Mesh positions are not XYZ triples.');
	const faceById = new Map<string, Face>();
	const edgeFaces = new Map<string, { a: number; b: number; refs: EdgeFaceRef[] }>();
	const cycles = new Map<string, string>();
	for (const face of mesh.faces) {
		if (!face.id || faceById.has(face.id)) throw new AuthoringTopologyError(`Face identity ${face.id || '<empty>'} is duplicated.`);
		const rings = [face.outer, ...face.holes];
		for (const [ringIndex, ring] of rings.entries()) {
			if (ring.length < 3 || new Set(ring).size !== ring.length) throw new AuthoringTopologyError(`Face ${face.id} has an invalid ${ringIndex === 0 ? 'outer' : 'hole'} ring.`);
			if (ring.some((vertex) => !Number.isSafeInteger(vertex) || vertex < 0 || vertex >= vertexCount)) throw new AuthoringTopologyError(`Face ${face.id} references an invalid vertex.`);
		}
		const cycle = canonicalCycle(face.outer);
		const duplicate = cycles.get(cycle);
		if (duplicate) throw new AuthoringTopologyError(`Faces ${duplicate} and ${face.id} duplicate the same vertex cycle.`);
		cycles.set(cycle, face.id);
		faceById.set(face.id, face);
		for (const [ringIndex, ring] of rings.entries()) for (let index = 0; index < ring.length; index += 1) {
			const a = ring[index]!; const b = ring[(index + 1) % ring.length]!;
			const key = edgeKey(a, b);
			const entry = edgeFaces.get(key) ?? { a: Math.min(a, b), b: Math.max(a, b), refs: [] };
			if (entry.refs.some((ref) => ref.faceId === face.id)) throw new AuthoringTopologyError(`Face ${face.id} reuses edge ${key} across its rings.`);
			entry.refs.push(Object.freeze({ faceId: face.id, ringIndex }));
			if (entry.refs.length > 3) throw new AuthoringTopologyError(`Edge ${key} is non-manifold with more than three incident faces.`);
			edgeFaces.set(key, entry);
		}
	}
	const edges = new Map<string, MeshEdge>();
	const adjacency = new Map<string, Set<string>>([...faceById.keys()].map((faceId) => [faceId, new Set()]));
	for (const [key, entry] of edgeFaces) {
		if (entry.refs.length === 3 && !supportedNestedThreeFaceJunction(entry.refs, faceById, mesh, entry.a, entry.b)) {
			throw new AuthoringTopologyError(`Edge ${key} is non-manifold with an unsupported three-face junction.`);
		}
		const faceIds = entry.refs.map((ref) => ref.faceId).sort(codeUnitCompare);
		edges.set(key, Object.freeze({ key, a: entry.a, b: entry.b, faceIds: Object.freeze(faceIds) }));
		if (faceIds.length >= 2) {
			for (let first = 0; first < faceIds.length; first += 1) for (let second = first + 1; second < faceIds.length; second += 1) {
				adjacency.get(faceIds[first]!)!.add(faceIds[second]!);
				adjacency.get(faceIds[second]!)!.add(faceIds[first]!);
			}
		}
	}
	const adjacentFaceIds = new Map<string, readonly string[]>();
	for (const [faceId, values] of adjacency) adjacentFaceIds.set(faceId, Object.freeze([...values].sort(codeUnitCompare)));
	return Object.freeze({ edges, faceById, adjacentFaceIds });
}

export function faceBoundaryEdges(face: Face): readonly (readonly [number, number])[] {
	return Object.freeze([face.outer, ...face.holes].flatMap((ring) => ring.map((vertex, index) => Object.freeze([vertex, ring[(index + 1) % ring.length]!] as [number, number]))));
}

export function uniqueBoundaryVertices(face: Face): readonly number[] {
	return Object.freeze([...new Set([face.outer, ...face.holes].flatMap((ring) => [...ring]))]);
}
