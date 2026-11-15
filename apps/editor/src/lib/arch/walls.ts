/**
 * SIB-MCP-MODELING-001 v2.3 C7 — `arch/walls.ts`: the wall network solver.
 * NOT SAFE FOR LOWER-CAPABILITY DELEGATION: orientation, tolerance, miter and mixed-thickness traps.
 *
 * Input: the wall elements of ONE module (module-local, +Z up, metres). Output: one manifold solid for
 * the whole network plus the segments, nodes, footprint rings and junction report that openings
 * (C8), topology (C9), perception (C12) and the plan (C14) consume.
 *
 * Pipeline (contract numbers refer to C7):
 *  1. authored segments, duplicate / reversal checks, merge of same-direction collinear runs;
 *  2. node clustering (JOIN_TOL), splitting at T/X, rejection of collinear overlap;
 *  3. per-node corner solving in outward-angle order, miter limit → bevel;
 *  4. plan-rule quads `[Ra, Rb, Lb, La]` per segment (opening limits, WALL_SEGMENT_TOO_SHORT);
 *  5. solid = ONE union of the quads, the node fan pieces, the butt-ended full bodies and the bridge strips of
 *     straight continuations (parts sorted by canonical geometry so equal networks give equal meshes);
 *  6. footprint rings; 7. junction report.
 *
 * DEVIATION from C7.4–5 as written (recorded in the WP4 evidence): the plan extrudes only the corner quads and node
 * polygon. For acute junctions with mixed thickness that trims a wide wall's own body along a far seam and leaves a
 * hole (found by the seeded fuzz in unit/arch/walls-fuzz.test.ts). The solid therefore also includes each segment's
 * butt-ended full body and, for straight continuations, an overlap bridge. Quads keep the connectivity (they share
 * exact corner vertices); bodies and bridges attach by volume overlap, never by near-coincident faces. Every plan
 * golden is reproduced exactly; a body can protrude past a neighbour's face by at most its own butt corner.
 *
 * Conventions: a segment runs a→b with unit direction `d` and left normal `n = (−d.y, d.x)`. `yL ≥ 0 ≥ yR` are
 * the lateral offsets of the left/right body lines (side=center: ±t/2, left: t/0, right: 0/−t).
 */
import { budgetExceeded, invalidGeometry } from './errors.js';
import { canonicalRing, signedArea, type Kernel, type Ring, type Solid, type Vec2 } from './kernel.js';

export const JOIN_TOL = 0.001;
export const MAX_WALL_SEGMENTS = 256;
const MITER_FACTOR = 4;
const ANGLE_EPS = 1e-9;
const MIN_AREA = 1e-9;
/**
 * Two directions count as a straight continuation in the junction REPORT when sin(angle) is below this (≈0.057°).
 * Splitting at a point up to JOIN_TOL off a wall bends the two halves by ~JOIN_TOL/length, which must still read as T/X.
 * Geometry is unaffected: near-parallel corners fall beyond the miter limit and become butt feet.
 */
const COLLINEAR_SIN = 1e-3;
/** Straight continuations within this sine are bonded with an overlap strip (below). */
const BRIDGE_SIN = 1e-4;
/** Axial half-depth of the bridge strip (m); it lies inside both bodies, so it adds no material. */
const BRIDGE_DEPTH = 1e-4;
/** Lateral inset of the bridge strip from the shared lateral range (m): no coincident faces with the bodies. */
const BRIDGE_INSET = 1e-5;
const COORD = 1e9;
const snap = (v: number) => Math.round(v * COORD) / COORD + 0;
const snapPoint = (p: Vec2): Vec2 => [snap(p[0]), snap(p[1])];
const keyOf = (p: Vec2) => `${p[0]}|${p[1]}`;
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const scale = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const norm = (a: Vec2) => Math.hypot(a[0], a[1]);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export type WallSide = 'center' | 'left' | 'right';
export type WallElement = {
	elementId: string;
	path: readonly (readonly [number, number])[];
	closed?: boolean;
	thickness: number;
	height: number;
	baseElevation?: number;
	side?: WallSide;
	materialId?: string;
};

export type WallSegment = {
	/** Index into the sorted segment list; also the part tag of this segment's triangles. */
	tag: number;
	elementId: string;
	/** Index of the (merged) authored segment of the element. */
	index: number;
	/** Sub-segment number after splitting at T/X nodes (0 when unsplit). */
	sub: number;
	a: Vec2;
	b: Vec2;
	length: number;
	d: Vec2;
	n: Vec2;
	t: number;
	h: number;
	z0: number;
	side: WallSide;
	yL: number;
	yR: number;
	/** End corners: at a (left/right) and at b (own-left `Lb` / own-right `Rb`). */
	La: Vec2;
	Ra: Vec2;
	Lb: Vec2;
	Rb: Vec2;
	/** Plan-rule end quad `[Ra, Rb, Lb, La]` (C7.4): corners are body-line intersections with the neighbours. */
	quad: Vec2[];
	/**
	 * Full body `[Ra, Rb, Lb, La]` with butt ends exactly at the nodes. Extruded in ADDITION to the quad so that no
	 * body material near a node is lost (see the deviation note in the header).
	 */
	body: Vec2[];
	/** Distance from the start of the authored segment to `a`. */
	offset: number;
};

export type WallNode = {
	id: string;
	point: Vec2;
	degree: number;
	/** Incident segment tags with the end that touches the node. */
	incident: { tag: number; end: 'a' | 'b' }[];
	/**
	 * Fan triangles `(node, a, b)` around the node bounded by the quad end edges and the bevel chords. Empty where
	 * neighbouring ends meet in a shared miter corner (L) or are straight continuations.
	 */
	pieces: Vec2[][];
	/** Overlap strips that bond a straight continuation robustly (lie entirely inside the two bodies). */
	bridges: Vec2[][];
};

export type JunctionType = 'free-end' | 'L' | 'T' | 'X' | 'Y' | 'multi';
export type Junction = { at: Vec2; type: JunctionType; with: string[] };

export type WallNetwork = {
	/** Union of all quads and node pieces; `null` when there are no walls. The caller releases it. */
	solid: Solid | null;
	segments: WallSegment[];
	nodes: WallNode[];
	footprintRings: Vec2[][];
	junctions: Map<string, Junction[]>;
};

type Raw = { elementId: string; index: number; a: Vec2; b: Vec2; offset: number; el: WallElement };

function lateral(side: WallSide, t: number): { yL: number; yR: number } {
	if (side === 'left') return { yL: t, yR: 0 };
	if (side === 'right') return { yL: 0, yR: -t };
	return { yL: t / 2, yR: -t / 2 };
}

/** Step 1: authored → merged segments of one element. */
function authoredSegments(el: WallElement): Raw[] {
	const pts = el.path.map((p) => snapPoint(p as Vec2));
	const count = pts.length;
	const pairs: [Vec2, Vec2][] = [];
	for (let i = 0; i + 1 < count; i++) pairs.push([pts[i]!, pts[i + 1]!]);
	if (el.closed) pairs.push([pts[count - 1]!, pts[0]!]);
	for (const [a, b] of pairs) if (norm(sub(b, a)) <= JOIN_TOL) throw invalidGeometry('WALL_DUPLICATE_POINT', el.elementId, a);

	const unit = (s: [Vec2, Vec2]) => scale(sub(s[1], s[0]), 1 / norm(sub(s[1], s[0])));
	const merged: [Vec2, Vec2][] = [];
	const consider = (prev: [Vec2, Vec2], cur: [Vec2, Vec2]): 'merge' | 'keep' => {
		const dp = unit(prev), dc = unit(cur);
		if (Math.abs(cross(dp, dc)) > ANGLE_EPS) return 'keep';
		if (dot(dp, dc) < 0) throw invalidGeometry('WALL_PATH_REVERSES', el.elementId, prev[1]);
		return 'merge';
	};
	for (const pair of pairs) {
		const prev = merged[merged.length - 1];
		if (prev && consider(prev, pair) === 'merge') prev[1] = pair[1];
		else merged.push([pair[0], pair[1]]);
	}
	if (el.closed && merged.length > 1) {
		const first = merged[0]!, last = merged[merged.length - 1]!;
		if (consider(last, first) === 'merge') {
			first[0] = last[0];
			merged.pop();
		}
	}
	return merged.map(([a, b], index) => ({ elementId: el.elementId, index, a, b, offset: 0, el }));
}

/** Step 2: cluster endpoints (sorted order, representative = lexicographically smallest) and snap. */
function clusterEndpoints(raws: Raw[]): void {
	const unique = new Map<string, Vec2>();
	for (const r of raws) for (const p of [r.a, r.b]) unique.set(keyOf(p), p);
	const sorted = [...unique.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
	const reps: Vec2[] = [];
	const mapTo = new Map<string, Vec2>();
	for (const p of sorted) {
		const rep = reps.find((r) => norm(sub(p, r)) <= JOIN_TOL);
		if (rep) mapTo.set(keyOf(p), rep);
		else {
			reps.push(p);
			mapTo.set(keyOf(p), p);
		}
	}
	for (const r of raws) {
		r.a = mapTo.get(keyOf(r.a))!;
		r.b = mapTo.get(keyOf(r.b))!;
		if (keyOf(r.a) === keyOf(r.b)) throw invalidGeometry('WALL_DUPLICATE_POINT', r.elementId, r.a);
	}
}

/**
 * Two segments overlap collinearly when both ends of one lie within JOIN_TOL of the other's line (tested in both
 * directions, so a short wall along a long one is caught) and they share more than JOIN_TOL of length. A strict
 * parallelism test would let a wall skewed by less than the tolerance slip through and be split into duplicates.
 */
function checkCollinearOverlap(raws: Raw[]): void {
	const within = (base: Raw, other: Raw) => {
		const d = scale(sub(base.b, base.a), 1 / norm(sub(base.b, base.a)));
		return Math.abs(cross(d, sub(other.a, base.a))) <= JOIN_TOL && Math.abs(cross(d, sub(other.b, base.a))) <= JOIN_TOL;
	};
	for (let i = 0; i < raws.length; i++)
		for (let j = i + 1; j < raws.length; j++) {
			let base = raws[i]!, other = raws[j]!;
			if (!within(base, other)) {
				[base, other] = [other, base];
				if (!within(base, other)) continue;
			}
			const len = norm(sub(base.b, base.a));
			const d = scale(sub(base.b, base.a), 1 / len);
			const s0 = dot(sub(other.a, base.a), d), s1 = dot(sub(other.b, base.a), d);
			const lo = Math.max(0, Math.min(s0, s1)), hi = Math.min(len, Math.max(s0, s1));
			if (hi - lo > JOIN_TOL) throw invalidGeometry('WALL_COLLINEAR_OVERLAP', base.elementId, snapPoint(add(base.a, scale(d, (lo + hi) / 2))));
		}
}

function splitAt(raws: Raw[], index: number, p: Vec2): void {
	const r = raws[index]!;
	const first: Raw = { ...r, b: p };
	const second: Raw = { ...r, a: p, offset: r.offset + norm(sub(p, r.a)) };
	raws.splice(index, 1, first, second);
}

function splitToFixpoint(raws: Raw[]): void {
	for (;;) {
		if (raws.length > MAX_WALL_SEGMENTS) throw budgetExceeded('WALL_SEGMENTS');
		let changed = false;
		// Endpoint of one segment strictly inside another → split the other at that endpoint.
		search: for (let i = 0; i < raws.length; i++) {
			const si = raws[i]!;
			const len = norm(sub(si.b, si.a));
			const d = scale(sub(si.b, si.a), 1 / len);
			for (let j = 0; j < raws.length; j++) {
				if (j === i) continue;
				for (const p of [raws[j]!.a, raws[j]!.b]) {
					const along = dot(sub(p, si.a), d);
					if (along > JOIN_TOL && along < len - JOIN_TOL && Math.abs(cross(d, sub(p, si.a))) <= JOIN_TOL) {
						splitAt(raws, i, p);
						changed = true;
						break search;
					}
				}
			}
		}
		if (changed) continue;
		// Proper interior crossing → split both at the intersection.
		cross: for (let i = 0; i < raws.length; i++)
			for (let j = i + 1; j < raws.length; j++) {
				const si = raws[i]!, sj = raws[j]!;
				const li = norm(sub(si.b, si.a)), lj = norm(sub(sj.b, sj.a));
				const di = scale(sub(si.b, si.a), 1 / li), dj = scale(sub(sj.b, sj.a), 1 / lj);
				const denom = cross(di, dj);
				if (Math.abs(denom) <= ANGLE_EPS) continue;
				const w = sub(sj.a, si.a);
				const s = cross(w, dj) / denom;
				const u = cross(w, di) / denom;
				if (s > JOIN_TOL && s < li - JOIN_TOL && u > JOIN_TOL && u < lj - JOIN_TOL) {
					const p = snapPoint(add(si.a, scale(di, s)));
					splitAt(raws, j, p); // j > i, so index i is unaffected
					splitAt(raws, i, p);
					changed = true;
					break cross;
				}
			}
		if (!changed) return;
	}
}

type Incident = {
	/** Butt corners of this segment at the node, snapped to the 1e-9 lattice (outward-left / outward-right). */
	footL: Vec2;
	footR: Vec2;
	seg: WallSegment;
	end: 'a' | 'b';
	u: Vec2; // outward direction
	nl: Vec2; // outward-left normal
	lo: number; // outward-left lateral offset (≥ 0 side)
	ro: number; // outward-right lateral offset
	angle: number;
	left: Vec2; // solved outward-left end point
	right: Vec2; // solved outward-right end point
};

function bodyArea(ring: readonly Vec2[]): number {
	return signedArea(ring);
}

function segmentsProperlyIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
	const d1 = cross(sub(p2, p1), sub(p3, p1)), d2 = cross(sub(p2, p1), sub(p4, p1));
	const d3 = cross(sub(p4, p3), sub(p1, p3)), d4 = cross(sub(p4, p3), sub(p2, p3));
	return d1 * d2 < 0 && d3 * d4 < 0;
}

function isSimpleQuad(q: readonly Vec2[]): boolean {
	return !segmentsProperlyIntersect(q[0]!, q[1]!, q[2]!, q[3]!) && !segmentsProperlyIntersect(q[1]!, q[2]!, q[3]!, q[0]!);
}

export function buildWallNetwork(kernel: Kernel, walls: readonly WallElement[]): WallNetwork {
	// ── 1–2 ─────────────────────────────────────────────────────────────────────────────────────
	const raws: Raw[] = [];
	for (const el of [...walls].sort((p, q) => cmp(p.elementId, q.elementId))) raws.push(...authoredSegments(el));
	if (raws.length > MAX_WALL_SEGMENTS) throw budgetExceeded('WALL_SEGMENTS');
	if (raws.length === 0) return { solid: null, segments: [], nodes: [], footprintRings: [], junctions: new Map() };
	clusterEndpoints(raws);
	checkCollinearOverlap(raws);
	splitToFixpoint(raws);

	raws.sort((p, q) => cmp(p.elementId, q.elementId) || p.index - q.index || p.offset - q.offset);
	const subCounter = new Map<string, number>();
	const segments: WallSegment[] = raws.map((r, tag) => {
		const subKey = `${r.elementId}#${r.index}`;
		const sub_ = subCounter.get(subKey) ?? 0;
		subCounter.set(subKey, sub_ + 1);
		const delta = sub(r.b, r.a);
		const length = norm(delta);
		const d: Vec2 = scale(delta, 1 / length);
		const side = r.el.side ?? 'center';
		const { yL, yR } = lateral(side, r.el.thickness);
		const zero: Vec2 = [0, 0];
		return {
			tag, elementId: r.elementId, index: r.index, sub: sub_, a: r.a, b: r.b, length, d, n: [-d[1], d[0]], t: r.el.thickness,
			h: r.el.height, z0: r.el.baseElevation ?? 0, side, yL, yR, La: zero, Ra: zero, Lb: zero, Rb: zero, quad: [], body: [], offset: r.offset
		};
	});

	// ── 3 ───────────────────────────────────────────────────────────────────────────────────────
	const byNode = new Map<string, { point: Vec2; items: Incident[] }>();
	const touch = (seg: WallSegment, end: 'a' | 'b') => {
		const point = end === 'a' ? seg.a : seg.b;
		const u: Vec2 = end === 'a' ? seg.d : [-seg.d[0], -seg.d[1]];
		const lo = end === 'a' ? seg.yL : -seg.yR;
		const ro = end === 'a' ? seg.yR : -seg.yL;
		let angle = Math.atan2(u[1], u[0]);
		if (angle < 0) angle += 2 * Math.PI;
		const entry = byNode.get(keyOf(point)) ?? { point, items: [] };
		entry.items.push({ seg, end, u, nl: [-u[1], u[0]], lo, ro, angle, left: point, right: point, footL: point, footR: point });
		byNode.set(keyOf(point), entry);
	};
	for (const seg of segments) {
		touch(seg, 'a');
		touch(seg, 'b');
	}

	const nodes: WallNode[] = [];
	type Extra = { ring: Vec2[]; tag: number; z0: number; z1: number };
	const extras: Extra[] = [];
	const orderedNodes = [...byNode.values()].sort((p, q) => p.point[0] - q.point[0] || p.point[1] - q.point[1]);
	for (const node of orderedNodes) {
		const items = node.items.sort((p, q) => (Math.abs(p.angle - q.angle) > 1e-12 ? p.angle - q.angle : p.seg.tag - q.seg.tag));
		const degree = items.length;
		for (const it of items) {
			it.footL = snapPoint(add(node.point, scale(it.nl, it.lo)));
			it.footR = snapPoint(add(node.point, scale(it.nl, it.ro)));
		}
		const pieces: Vec2[][] = [];
		const bridges: Vec2[][] = [];
		const smallestTag = items.reduce((m, it) => (it.seg.tag < m.seg.tag ? it : m), items[0]!).seg.tag;
		const zLow = Math.min(...items.map((it) => it.seg.z0)), zHigh = Math.max(...items.map((it) => it.seg.z0 + it.seg.h));
		const fan = (p: Vec2, q: Vec2) => {
			if (cross(sub(p, node.point), sub(q, node.point)) / 2 >= MIN_AREA) {
				pieces.push([node.point, p, q]);
				extras.push({ ring: [node.point, p, q], tag: smallestTag, z0: zLow, z1: zHigh });
			}
		};
		if (degree === 1) {
			const it = items[0]!;
			it.left = it.footL;
			it.right = it.footR;
		} else {
			for (let i = 0; i < degree; i++) {
				const ei = items[i]!, ej = items[(i + 1) % degree]!;
				const denom = cross(ei.u, ej.u);
				let corner: Vec2 | null = null;
				if (Math.abs(denom) > ANGLE_EPS) {
					const footLeft = add(node.point, scale(ei.nl, ei.lo)), footRight = add(node.point, scale(ej.nl, ej.ro));
					const s = cross(sub(footRight, footLeft), ej.u) / denom;
					const c = add(footLeft, scale(ei.u, s));
					if (norm(sub(c, node.point)) <= MITER_FACTOR * Math.max(ei.seg.t, ej.seg.t)) corner = snapPoint(c);
				}
				if (corner) {
					ei.left = corner;
					ej.right = corner;
				} else {
					// Parallel (straight continuation) or beyond the miter limit: butt feet (bevel chord below).
					ei.left = ei.footL;
					ej.right = ej.footR;
				}
			}
			// Node region = fan around the node bounded by the quad end edges (right→left of each incident segment) and the
			// chords between neighbouring ends. A triangle is kept only when counter-clockwise: where neighbouring ends meet
			// in a shared corner, or the bodies overlap (acute wedge), it is degenerate or clockwise and nothing needs filling.
			for (let i = 0; i < degree; i++) {
				fan(items[i]!.right, items[i]!.left);
				fan(items[i]!.left, items[(i + 1) % degree]!.right);
			}
			// Straight continuations: bond the two end faces with a strip inside both bodies.
			for (let i = 0; i < degree; i++)
				for (let j = i + 1; j < degree; j++) {
					const A = items[i]!, B = items[j]!;
					if (!(Math.abs(cross(A.u, B.u)) <= BRIDGE_SIN && dot(A.u, B.u) < 0)) continue;
					const y0 = Math.max(A.ro, -B.lo) + BRIDGE_INSET, y1 = Math.min(A.lo, -B.ro) - BRIDGE_INSET;
					const z0 = Math.max(A.seg.z0, B.seg.z0), z1 = Math.min(A.seg.z0 + A.seg.h, B.seg.z0 + B.seg.h);
					if (!(y1 - y0 > 1e-6) || !(z1 - z0 > 1e-6)) continue;
					const at = (y: number, depth: number): Vec2 => snapPoint(add(add(node.point, scale(A.nl, y)), scale(A.u, depth)));
					const ring = [at(y0, -BRIDGE_DEPTH), at(y1, -BRIDGE_DEPTH), at(y1, BRIDGE_DEPTH), at(y0, BRIDGE_DEPTH)];
					bridges.push(ring);
					extras.push({ ring, tag: Math.min(A.seg.tag, B.seg.tag), z0, z1 });
				}
		}
		for (const it of items) {
			if (it.end === 'a') {
				it.seg.La = it.left;
				it.seg.Ra = it.right;
			} else {
				// Outward frame at b is reversed: outward-left is the segment's own right side.
				it.seg.Rb = it.left;
				it.seg.Lb = it.right;
			}
		}
		nodes.push({
			id: `n${nodes.length}`,
			point: node.point,
			degree,
			incident: items.map((it) => ({ tag: it.seg.tag, end: it.end })),
			pieces,
			bridges
		});
	}
	// Butt-ended bodies: the same snapped feet as the quad ends where those are butt, so no near-coincident faces.
	const feet = new Map<string, Incident>();
	for (const node of orderedNodes) for (const it of node.items) feet.set(`${it.seg.tag}${it.end}`, it);
	for (const seg of segments) {
		const fa = feet.get(`${seg.tag}a`)!, fb = feet.get(`${seg.tag}b`)!;
		seg.body = [fa.footR, fb.footL, fb.footR, fa.footL];
	}

	// ── 4 ───────────────────────────────────────────────────────────────────────────────────────
	// A corner pair whose end quad folds over itself means the segment is too short for its neighbours' miters.
	for (const seg of segments) {
		const quad: Vec2[] = [seg.Ra, seg.Rb, seg.Lb, seg.La];
		if (!isSimpleQuad(quad) || bodyArea(quad) <= MIN_AREA)
			throw invalidGeometry('WALL_SEGMENT_TOO_SHORT', seg.elementId, snapPoint(scale(add(seg.a, seg.b), 0.5)));
		seg.quad = quad;
	}

	// ── 5 ───────────────────────────────────────────────────────────────────────────────────────
	type Part = { ring: Ring; z0: number; z1: number; tag: number; key: string };
	const parts: Part[] = [];
	const keyFor = (ring: Ring, z0: number, z1: number) => `${canonicalRing(ring, true).map((p) => `${p[0]},${p[1]}`).join(';')}@${z0},${z1}`;
	for (const seg of segments) {
		parts.push({ ring: seg.quad, z0: seg.z0, z1: seg.z0 + seg.h, tag: seg.tag, key: keyFor(seg.quad, seg.z0, seg.z0 + seg.h) });
		parts.push({ ring: seg.body, z0: seg.z0, z1: seg.z0 + seg.h, tag: seg.tag, key: keyFor(seg.body, seg.z0, seg.z0 + seg.h) });
	}
	for (const e of extras) parts.push({ ring: e.ring, z0: e.z0, z1: e.z1, tag: e.tag, key: keyFor(e.ring, e.z0, e.z1) });
	parts.sort((p, q) => cmp(p.key, q.key));
	const prisms = parts.map((part) => kernel.prism(part.ring, part.z0, part.z1, part.tag));
	let solid: Solid;
	try {
		solid = kernel.union(prisms);
	} finally {
		kernel.release(...prisms);
	}

	// ── 6 ───────────────────────────────────────────────────────────────────────────────────────
	let footprintRings: Vec2[][];
	try {
		footprintRings = kernel.union2d([...segments.flatMap((s) => [s.quad, s.body]), ...extras.map((e) => e.ring)]);
	} catch (error) {
		kernel.release(solid);
		throw error;
	}

	// ── 7 ───────────────────────────────────────────────────────────────────────────────────────
	const junctions = new Map<string, Junction[]>();
	for (const node of orderedNodes) {
		const items = node.items;
		const degree = items.length;
		const antiparallel = (p: Incident, q: Incident) => Math.abs(cross(p.u, q.u)) <= COLLINEAR_SIN && dot(p.u, q.u) < 0;
		let pairs = 0;
		const used = new Set<Incident>();
		for (let i = 0; i < degree; i++)
			for (let j = i + 1; j < degree; j++)
				if (antiparallel(items[i]!, items[j]!) && !used.has(items[i]!) && !used.has(items[j]!)) {
					pairs++;
					used.add(items[i]!);
					used.add(items[j]!);
				}
		let type: JunctionType | null;
		if (degree === 1) type = 'free-end';
		else if (degree === 2) type = pairs === 1 ? null : 'L';
		else if (degree === 3) type = pairs >= 1 ? 'T' : 'Y';
		else if (degree === 4) type = pairs === 2 ? 'X' : 'multi';
		else type = 'multi';
		if (type === null) continue;
		const elements = [...new Set(items.map((it) => it.seg.elementId))].sort(cmp);
		for (const elementId of elements) {
			const others = [...new Set(items.filter((it) => it.seg.elementId !== elementId).map((it) => it.seg.elementId))].sort(cmp);
			const list = junctions.get(elementId) ?? [];
			list.push({ at: node.point, type, with: others });
			junctions.set(elementId, list);
		}
	}
	return { solid, segments, nodes, footprintRings, junctions };
}
