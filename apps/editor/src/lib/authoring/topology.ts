import type { Face, Mesh } from '@sibambo/bomc-document';

export type MeshEdge = Readonly<{
	key: string;
	a: number;
	b: number;
	faceIds: readonly string[];
}>;

export type AuthoringTopology = Readonly<{
	edges: ReadonlyMap<string, MeshEdge>;
	faceById: ReadonlyMap<string, Face>;
	adjacentFaceIds: ReadonlyMap<string, readonly string[]>;
}>;

export class AuthoringTopologyError extends Error {
	constructor(message: string) { super(message); this.name = 'AuthoringTopologyError'; }
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
	const edgeFaces = new Map<string, { a: number; b: number; faceIds: string[] }>();
	const cycles = new Map<string, string>();
	for (const face of mesh.faces) {
		if (!face.id || faceById.has(face.id)) throw new AuthoringTopologyError(`Face identity ${face.id || '<empty>'} is duplicated.`);
		if (face.outer.length < 3 || new Set(face.outer).size !== face.outer.length) throw new AuthoringTopologyError(`Face ${face.id} has an invalid outer ring.`);
		if (face.outer.some((vertex) => !Number.isSafeInteger(vertex) || vertex < 0 || vertex >= vertexCount)) throw new AuthoringTopologyError(`Face ${face.id} references an invalid vertex.`);
		const cycle = canonicalCycle(face.outer);
		const duplicate = cycles.get(cycle);
		if (duplicate) throw new AuthoringTopologyError(`Faces ${duplicate} and ${face.id} duplicate the same vertex cycle.`);
		cycles.set(cycle, face.id);
		faceById.set(face.id, face);
		for (let index = 0; index < face.outer.length; index += 1) {
			const a = face.outer[index]!; const b = face.outer[(index + 1) % face.outer.length]!;
			const key = edgeKey(a, b);
			const entry = edgeFaces.get(key) ?? { a: Math.min(a, b), b: Math.max(a, b), faceIds: [] };
			entry.faceIds.push(face.id);
			if (entry.faceIds.length > 2) throw new AuthoringTopologyError(`Edge ${key} is non-manifold with more than two incident faces.`);
			edgeFaces.set(key, entry);
		}
	}
	const edges = new Map<string, MeshEdge>();
	const adjacency = new Map<string, Set<string>>([...faceById.keys()].map((faceId) => [faceId, new Set()]));
	for (const [key, entry] of edgeFaces) {
		const faceIds = [...entry.faceIds].sort(codeUnitCompare);
		edges.set(key, Object.freeze({ key, a: entry.a, b: entry.b, faceIds: Object.freeze(faceIds) }));
		if (faceIds.length === 2) {
			adjacency.get(faceIds[0]!)!.add(faceIds[1]!);
			adjacency.get(faceIds[1]!)!.add(faceIds[0]!);
		}
	}
	const adjacentFaceIds = new Map<string, readonly string[]>();
	for (const [faceId, values] of adjacency) adjacentFaceIds.set(faceId, Object.freeze([...values].sort(codeUnitCompare)));
	return Object.freeze({ edges, faceById, adjacentFaceIds });
}

export function faceBoundaryEdges(face: Face): readonly (readonly [number, number])[] {
	return Object.freeze(face.outer.map((vertex, index) => Object.freeze([vertex, face.outer[(index + 1) % face.outer.length]!] as [number, number])));
}

export function uniqueBoundaryVertices(face: Face): readonly number[] {
	return Object.freeze([...new Set(face.outer)]);
}
