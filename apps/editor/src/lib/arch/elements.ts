/**
 * SIB-MCP-MODELING-001 v2.3 C8 — `arch/elements.ts`: slabs, openings (cutters + inserts) and spaces.
 *
 * Everything here works on the output of the wall solver (`WallNetwork`) and the kernel; nothing here writes
 * the document. Validation failures are `ArchError` (`INVALID_GEOMETRY` + reason) and block the write.
 */
import { invalidGeometry } from './errors.js';
import { canonicalRing, signedArea, type Kernel, type Solid, type Vec2 } from './kernel.js';
import { JOIN_TOL, type WallElement, type WallNetwork, type WallSegment } from './walls.js';

const EPS = 1e-9;
/**
 * Slab area validity (amendment A22 to C8). The kernel quantises input by up to ≈ 3.5e-9 m, so `section.area()` differs
 * from the shoelace area of the same ring by ≈ that times the ring perimeter: the tolerance is `base + perMetre × perimeter`.
 */
const AREA_TOL_BASE = 1e-9;
const AREA_TOL_PER_METRE = 2e-8;
const END_CLEARANCE = 0.05;
const HEAD_CLEARANCE = 0.05;
const CUTTER_OVERSHOOT = 0.01;

export type SlabElement = {
	elementId: string;
	outline: readonly (readonly [number, number])[];
	holes?: readonly (readonly (readonly [number, number])[])[];
	thickness: number;
	topElevation: number;
	role?: 'floor' | 'ceiling' | 'roof-flat';
	materialId?: string;
};

export type OpeningType = 'door' | 'window' | 'void';
export type OpeningElement = {
	elementId: string;
	hostElementId: string;
	along: number;
	width: number;
	height: number;
	sillHeight: number;
	openingType: OpeningType;
	swing?: { hinge: 'start' | 'end'; side: 'left' | 'right' };
	materialId?: string;
};

export type SpaceElement = { elementId: string; name: string; seedPoint: readonly [number, number] };

// ── slabs ─────────────────────────────────────────────────────────────────────────────────────────

/** True when no two non-adjacent edges of the closed ring touch, cross or overlap. */
export function isSimpleRing(ring: readonly (readonly [number, number])[]): boolean {
	const n = ring.length;
	const orient = (a: readonly number[], b: readonly number[], c: readonly number[]) => (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);
	const onSegment = (a: readonly number[], b: readonly number[], p: readonly number[]) =>
		Math.min(a[0]!, b[0]!) - EPS <= p[0]! && p[0]! <= Math.max(a[0]!, b[0]!) + EPS && Math.min(a[1]!, b[1]!) - EPS <= p[1]! && p[1]! <= Math.max(a[1]!, b[1]!) + EPS;
	const touches = (a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]) => {
		const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
		if (o1 * o2 < 0 && o3 * o4 < 0) return true;
		return (Math.abs(o1) <= EPS && onSegment(a, b, c)) || (Math.abs(o2) <= EPS && onSegment(a, b, d)) ||
			(Math.abs(o3) <= EPS && onSegment(c, d, a)) || (Math.abs(o4) <= EPS && onSegment(c, d, b));
	};
	for (let i = 0; i < n; i++)
		for (let j = i + 1; j < n; j++) {
			if (j === i + 1 || (i === 0 && j === n - 1)) continue;
			if (touches(ring[i]!, ring[(i + 1) % n]!, ring[j]!, ring[(j + 1) % n]!)) return false;
		}
	return true;
}

/** `AREA_TOL_BASE + AREA_TOL_PER_METRE × Σ perimeter` of canonical rings. `Math.sqrt`, not `Math.hypot`: engine-independent. */
function areaTolerance(rings: readonly (readonly Vec2[])[]): number {
	let perimeter = 0;
	for (const ring of rings)
		for (let i = 0; i < ring.length; i++) {
			const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
			const dx = b[0] - a[0], dy = b[1] - a[1];
			perimeter += Math.sqrt(dx * dx + dy * dy);
		}
	return AREA_TOL_BASE + AREA_TOL_PER_METRE * perimeter;
}

/** Normalises orientation, rejects self-intersection and builds the slab prism `[top − thickness, top]`. */
export function buildSlab(kernel: Kernel, slab: SlabElement, tag: number): Solid {
	for (const ring of [slab.outline, ...(slab.holes ?? [])]) if (!isSimpleRing(ring)) throw invalidGeometry('SLAB_SELF_INTERSECTS', slab.elementId);
	const outline = canonicalRing(slab.outline, true);
	const holes = (slab.holes ?? []).map((h) => canonicalRing(h, false));
	const areaOf = (ring: readonly Vec2[]) => Math.abs(signedArea(ring));
	if (Math.abs(kernel.unionArea2d([outline]) - areaOf(outline)) > areaTolerance([outline])) throw invalidGeometry('SLAB_SELF_INTERSECTS', slab.elementId);
	holes.forEach((hole) => {
		if (Math.abs(kernel.unionArea2d([hole]) - areaOf(hole)) > areaTolerance([hole])) throw invalidGeometry('SLAB_SELF_INTERSECTS', slab.elementId);
	});
	// Holes must lie inside the outline and be disjoint, which is exactly "area with holes = outline − Σ holes".
	const expected = areaOf(outline) - holes.reduce((sum, h) => sum + areaOf(h), 0);
	if (Math.abs(kernel.areaWithHoles2d(outline, holes) - expected) > areaTolerance([outline, ...holes])) throw invalidGeometry('SLAB_SELF_INTERSECTS', slab.elementId);
	return kernel.prismWithHoles(outline, holes, slab.topElevation - slab.thickness, slab.topElevation, tag);
}

// ── openings ──────────────────────────────────────────────────────────────────────────────────────

export type OpeningPlacement = {
	opening: OpeningElement;
	segment: WallSegment;
	/** Span along the host sub-segment axis from its `a`. */
	x0: number;
	x1: number;
	/** Absolute z of the opening bottom/top. */
	zBottom: number;
	zTop: number;
	/** Span along the authored host path (from its start). */
	authoredStart: number;
	authoredEnd: number;
	/** Distance limits the span had to respect on the sub-segment axis. */
	startLimit: number;
	endLimit: number;
};

/** Authored path of a wall as `[a, b]` pairs including the closing segment, with cumulative start lengths. */
function authoredPath(host: WallElement): { a: Vec2; b: Vec2; start: number; length: number; d: Vec2 }[] {
	const pts = host.path.map((p) => [Math.round(p[0] * 1e9) / 1e9 + 0, Math.round(p[1] * 1e9) / 1e9 + 0] as Vec2);
	const pairs: [Vec2, Vec2][] = [];
	for (let i = 0; i + 1 < pts.length; i++) pairs.push([pts[i]!, pts[i + 1]!]);
	if (host.closed) pairs.push([pts[pts.length - 1]!, pts[0]!]);
	let start = 0;
	return pairs.map(([a, b]) => {
		const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
		const item = { a, b, start, length, d: [(b[0] - a[0]) / length, (b[1] - a[1]) / length] as Vec2 };
		start += length;
		return item;
	});
}

/**
 * Places every opening on its host and validates it. `openings` are processed in elementId order; the first
 * violation throws.
 */
export function placeOpenings(
	network: WallNetwork,
	walls: ReadonlyMap<string, WallElement>,
	openings: readonly OpeningElement[]
): OpeningPlacement[] {
	const placements: OpeningPlacement[] = [];
	const sorted = [...openings].sort((p, q) => (p.elementId < q.elementId ? -1 : p.elementId > q.elementId ? 1 : 0));
	for (const opening of sorted) {
		const host = walls.get(opening.hostElementId);
		if (!host) throw invalidGeometry('OPENING_OUTSIDE_HOST', opening.elementId);
		const path = authoredPath(host);
		const total = path.reduce((sum, s) => sum + s.length, 0);
		const along = opening.along, end = opening.along + opening.width;
		if (end > total + EPS) throw invalidGeometry('OPENING_OUTSIDE_HOST', opening.elementId);
		const authored = path.find((s) => along >= s.start - EPS && end <= s.start + s.length + EPS);
		if (!authored) throw invalidGeometry('OPENING_ACROSS_VERTEX', opening.elementId);
		const p0: Vec2 = [authored.a[0] + authored.d[0] * (along - authored.start), authored.a[1] + authored.d[1] * (along - authored.start)];
		const p1: Vec2 = [p0[0] + authored.d[0] * opening.width, p0[1] + authored.d[1] * opening.width];
		const segment = network.segments.find((s) => {
			if (s.elementId !== host.elementId) return false;
			const rel0: Vec2 = [p0[0] - s.a[0], p0[1] - s.a[1]];
			const x0 = rel0[0] * s.d[0] + rel0[1] * s.d[1];
			const x1 = x0 + opening.width;
			const off = Math.abs(rel0[0] * s.d[1] - rel0[1] * s.d[0]);
			const dir = s.d[0] * authored.d[0] + s.d[1] * authored.d[1];
			return off <= JOIN_TOL && dir > 0.999999 && x0 >= -EPS && x1 <= s.length + EPS;
		});
		if (!segment) throw invalidGeometry('OPENING_ACROSS_VERTEX', opening.elementId, p0);
		const x0 = (p0[0] - segment.a[0]) * segment.d[0] + (p0[1] - segment.a[1]) * segment.d[1];
		const x1 = x0 + opening.width;
		const proj = (q: Vec2) => (q[0] - segment.a[0]) * segment.d[0] + (q[1] - segment.a[1]) * segment.d[1];
		const startLimit = Math.max(proj(segment.La), proj(segment.Ra));
		const endLimit = Math.min(proj(segment.Lb), proj(segment.Rb));
		if (x0 < startLimit + END_CLEARANCE - EPS || x1 > endLimit - END_CLEARANCE + EPS) throw invalidGeometry('OPENING_TOO_CLOSE_TO_JUNCTION', opening.elementId, p0);
		if ((opening.openingType === 'door' && opening.sillHeight !== 0) || (opening.openingType === 'window' && !(opening.sillHeight > 0)))
			throw invalidGeometry('OPENING_SILL_RULE', opening.elementId, p0);
		if (opening.sillHeight + opening.height > host.height - HEAD_CLEARANCE + EPS) throw invalidGeometry('OPENING_NO_HEAD', opening.elementId, p0);
		const zBase = host.baseElevation ?? 0;
		placements.push({
			opening, segment, x0, x1, zBottom: zBase + opening.sillHeight, zTop: zBase + opening.sillHeight + opening.height,
			authoredStart: along, authoredEnd: end, startLimit, endLimit
		});
	}
	const byHost = new Map<string, OpeningPlacement[]>();
	for (const p of placements) byHost.set(p.opening.hostElementId, [...(byHost.get(p.opening.hostElementId) ?? []), p]);
	for (const list of byHost.values()) {
		list.sort((p, q) => p.authoredStart - q.authoredStart);
		for (let i = 1; i < list.length; i++)
			if (list[i]!.authoredStart <= list[i - 1]!.authoredEnd + EPS) throw invalidGeometry('OPENING_OVERLAP', list[i]!.opening.elementId);
	}
	return placements;
}

/** Cutter prism of one placement: the full wall body depth plus 1 cm either side. */
export function openingCutter(kernel: Kernel, placement: OpeningPlacement, tag: number): Solid {
	const s = placement.segment;
	return kernel.boxLocal(s.a, s.d, s.n, placement.x0, placement.x1, s.yR - CUTTER_OVERSHOOT, s.yL + CUTTER_OVERSHOOT, placement.zBottom, placement.zTop, tag);
}

export type InsertKind = 'frame' | 'glazing' | 'leaf';
export type InsertPart = { kind: InsertKind; solid: Solid; materialId: string };

/** Frame width `fw` of an opening in a wall of thickness `t` (contract C8). */
export const frameWidth = (width: number, height: number, t: number) => Math.min(0.045, width / 12, height / 12, t / 4);

/**
 * Insert parts of one opening (door: frame + leaf, window: frame + glazing, void: none). Frame boxes are
 * unioned into one part; every part is tagged through `tagFor(kind)`. Returned solids are owned by the caller.
 */
export function openingInserts(kernel: Kernel, placement: OpeningPlacement, tagFor: (kind: InsertKind) => number): InsertPart[] {
	const { opening, segment: s, x0, x1, zBottom, zTop } = placement;
	if (opening.openingType === 'void') return [];
	const fw = frameWidth(opening.width, opening.height, s.t);
	const box = (a0: number, a1: number, y0: number, y1: number, z0: number, z1: number, kind: InsertKind) =>
		kernel.boxLocal(s.a, s.d, s.n, a0, a1, y0, y1, z0, z1, tagFor(kind));
	const parts: InsertPart[] = [];
	const frameBoxes: Solid[] = [];
	try {
		frameBoxes.push(box(x0, x0 + fw, s.yR, s.yL, zBottom, zTop, 'frame')); // left jamb
		frameBoxes.push(box(x1 - fw, x1, s.yR, s.yL, zBottom, zTop, 'frame')); // right jamb
		frameBoxes.push(box(x0, x1, s.yR, s.yL, zTop - fw, zTop, 'frame')); // head
		if (opening.openingType === 'window') frameBoxes.push(box(x0, x1, s.yR, s.yL, zBottom, zBottom + fw, 'frame')); // sill
		parts.push({ kind: 'frame', solid: kernel.union(frameBoxes), materialId: opening.materialId ?? 'sib-frame' });
		if (opening.openingType === 'window') {
			const centre = (s.yL + s.yR) / 2;
			const depth = Math.min(0.008, s.t / 3);
			parts.push({ kind: 'glazing', solid: box(x0 + fw, x1 - fw, centre - depth / 2, centre + depth / 2, zBottom + fw, zTop - fw, 'glazing'), materialId: 'sib-glass' });
		} else {
			const swing = opening.swing ?? { hinge: 'start', side: 'left' };
			const thickness = Math.min(0.035, 0.75 * fw);
			const length = opening.width - 2 * fw;
			const hingeX = swing.hinge === 'start' ? x0 + fw : x1 - fw;
			const [lx0, lx1] = swing.hinge === 'start' ? [hingeX, hingeX + thickness] : [hingeX - thickness, hingeX];
			const [ly0, ly1] = swing.side === 'left' ? [s.yL, s.yL + length] : [s.yR - length, s.yR];
			parts.push({ kind: 'leaf', solid: box(lx0, lx1, ly0, ly1, zBottom, zTop - fw, 'leaf'), materialId: 'sib-door' });
		}
		return parts;
	} catch (error) {
		kernel.release(...parts.map((part) => part.solid)); // nothing is returned on failure, so nothing may stay alive
		throw error;
	} finally {
		kernel.release(...frameBoxes);
	}
}

// ── spaces ────────────────────────────────────────────────────────────────────────────────────────

/**
 * A room. `enclosed:false` (seed outside every closed region, i.e. the walls leave a gap) is a RESULT, not a
 * rejection: per G9 the write commits and perception (WP8) reports `WALL_GAP`. Only a seed inside a wall body is
 * invalid geometry (`SPACE_SEED_IN_WALL`).
 */
export type SpaceResult = {
	elementId: string;
	name: string;
	seed: Vec2;
	enclosed: boolean;
	ring: Vec2[];
	holes: Vec2[][];
	area: number;
	bbox: { minX: number; minY: number; maxX: number; maxY: number } | null;
};

export function windingNumber(p: Vec2, ring: readonly Vec2[]): number {
	let wn = 0;
	for (let i = 0; i < ring.length; i++) {
		const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
		const side = (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]);
		if (a[1] <= p[1]) {
			if (b[1] > p[1] && side > 0) wn++;
		} else if (b[1] <= p[1] && side < 0) wn--;
	}
	return wn;
}

export function distanceToRings(p: Vec2, rings: readonly (readonly Vec2[])[]): number {
	let best = Infinity;
	for (const ring of rings)
		for (let i = 0; i < ring.length; i++) {
			const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
			const dx = b[0] - a[0], dy = b[1] - a[1];
			const len2 = dx * dx + dy * dy;
			const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
			best = Math.min(best, Math.hypot(p[0] - (a[0] + u * dx), p[1] - (a[1] + u * dy)));
		}
	return best;
}

/**
 * Rooms: connected regions of `bounds+1 m ∖ footprint`. A region touching the clipping box is the outside
 * (the room is then `enclosed:false`).
 * Openings and heights are ignored (a door does not connect rooms here).
 */
export function buildSpaces(kernel: Kernel, footprintRings: readonly (readonly Vec2[])[], spaces: readonly SpaceElement[]): SpaceResult[] {
	if (spaces.length === 0) return [];
	const xs = footprintRings.flatMap((r) => r.map((p) => p[0])), ys = footprintRings.flatMap((r) => r.map((p) => p[1]));
	const bounds = xs.length
		? { minX: Math.min(...xs) - 1, minY: Math.min(...ys) - 1, maxX: Math.max(...xs) + 1, maxY: Math.max(...ys) + 1 }
		: { minX: -1, minY: -1, maxX: 1, maxY: 1 };
	const regions = kernel.regionsOutside(footprintRings, bounds);
	const results: SpaceResult[] = [];
	for (const space of [...spaces].sort((p, q) => (p.elementId < q.elementId ? -1 : p.elementId > q.elementId ? 1 : 0))) {
		const seed: Vec2 = [space.seedPoint[0], space.seedPoint[1]];
		const inWall = footprintRings.reduce((sum, ring) => sum + windingNumber(seed, ring), 0) > 0;
		if (inWall || distanceToRings(seed, footprintRings) <= 1e-6) throw invalidGeometry('SPACE_SEED_IN_WALL', space.elementId, seed);
		const region = regions.find((r) => windingNumber(seed, r.ring) > 0 && r.holes.every((h) => windingNumber(seed, h) === 0));
		if (!region || region.touchesBounds) {
			results.push({ elementId: space.elementId, name: space.name, seed, enclosed: false, ring: [], holes: [], area: 0, bbox: null });
			continue;
		}
		results.push({ elementId: space.elementId, name: space.name, seed, enclosed: true, ring: region.ring, holes: region.holes, area: region.area, bbox: region.bbox });
	}
	return results;
}
