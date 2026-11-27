/**
 * SIB-MCP-MODELING-001 v2.3 C13 & v2.4 A2 — `arch/findings.ts`: pure architectural model findings
 * and before/after receipt diffing (`edit_model` findings diff). Does not import the geometry kernel.
 */
import { distanceToRings, frameWidth, windingNumber } from './elements.js';
import type { EvaluatedModule } from './evaluate.js';
import type { Vec2 } from './kernel.js';
import type { ManagedModuleRecord } from './managed.js';
import { canonicalJson } from './schema.js';
import { JOIN_TOL, type WallSegment } from './walls.js';

export type FindingSeverity = 'ERROR' | 'WARNING' | 'INFO';

export type ArchFinding = {
	key: string;
	code: string;
	severity: FindingSeverity;
	scope: string;
	elementId: string | null;
	at?: readonly [number, number] | readonly [number, number, number];
	message: string;
	fix?: unknown;
};

export type FindingsDiff = {
	new: ArchFinding[];
	resolved: string[];
	totals: Record<FindingSeverity, number>;
};

export const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { ERROR: 0, WARNING: 1, INFO: 2 };
const MAX_DIFF_ITEMS = 10;
const WALL_GAP_MAX = 0.30;
const LEVEL_TOL = 0.001;
const COVER_TOL = 1e-6;
const SLAB_OVERLAP_MIN = 1e-6;
export const TINY_EDGE_MAX = 0.002;
export const SLIVER_FACE_MAX = 1e-4;
const DOOR_MIN_WIDTH = 0.70;
const DOOR_MIN_HEIGHT = 1.90;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const round3 = (v: number): number => {
	const r = Math.round(v * 1000) / 1000;
	return r === 0 ? 0 : r;
};
const fmt3 = (v: number): string => round3(v).toFixed(3);

function formatAt(at?: readonly number[]): string {
	if (!at || at.length === 0) return '';
	return at.map(fmt3).join(',');
}

export function findingKey(code: string, scope: string, elementId: string | null, at?: readonly number[]): string {
	return `${code}:${scope}:${elementId ?? ''}:${formatAt(at)}`;
}

export function makeFinding(
	code: string,
	severity: FindingSeverity,
	scope: string,
	elementId: string | null,
	message: string,
	at?: readonly [number, number] | readonly [number, number, number],
	fix?: unknown
): ArchFinding {
	const roundedAt = at
		? (at.length === 2
			? ([round3(at[0]), round3(at[1])] as const)
			: ([round3(at[0]), round3(at[1]), round3(at[2]!)] as const))
		: undefined;
	const finding: ArchFinding = {
		key: findingKey(code, scope, elementId, roundedAt),
		code,
		severity,
		scope,
		elementId,
		message
	};
	if (roundedAt) finding.at = roundedAt;
	if (fix !== undefined) finding.fix = fix;
	return finding;
}

function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; dist: number } {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const lenSq = dx * dx + dy * dy;
	if (lenSq <= 1e-18) return { point: a, dist: Math.hypot(p[0] - a[0], p[1] - a[1]) };
	const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
	const q: Vec2 = [a[0] + t * dx, a[1] + t * dy];
	return { point: q, dist: Math.hypot(p[0] - q[0], p[1] - q[1]) };
}

function incidentSegmentsAt(point: Vec2, segments: readonly WallSegment[]): WallSegment[] {
	return segments.filter(
		(s) => Math.hypot(s.a[0] - point[0], s.a[1] - point[1]) <= JOIN_TOL || Math.hypot(s.b[0] - point[0], s.b[1] - point[1]) <= JOIN_TOL
	);
}

function canonicalLoopKey(ring: readonly Vec2[]): string | null {
	const pts: Vec2[] = [];
	for (const p of ring) {
		const q: Vec2 = [Math.round(p[0] * 1e9) / 1e9 + 0, Math.round(p[1] * 1e9) / 1e9 + 0];
		const last = pts[pts.length - 1];
		if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
	}
	while (pts.length > 1 && pts[0]![0] === pts[pts.length - 1]![0] && pts[0]![1] === pts[pts.length - 1]![1]) pts.pop();
	if (pts.length < 3) return null;
	let area = 0;
	for (let i = 0; i < pts.length; i++) {
		const [x0, y0] = pts[i]!;
		const [x1, y1] = pts[(i + 1) % pts.length]!;
		area += x0 * y1 - x1 * y0;
	}
	if (area === 0) return null;
	if (area < 0) pts.reverse();
	let start = 0;
	for (let i = 1; i < pts.length; i++) {
		const p = pts[i]!, s = pts[start]!;
		if (p[0] < s[0] || (p[0] === s[0] && p[1] < s[1])) start = i;
	}
	return canonicalJson([...pts.slice(start), ...pts.slice(0, start)]);
}

type SlabLike = { elementId: string; outline: Vec2[]; holes: Vec2[][]; top: number; bottom: number; role: string };

/** Inside the slab outline and outside its holes; the boundary itself (within 1e-6 m) counts as covered. */
function slabCovers(slab: SlabLike, p: Vec2): boolean {
	if (distanceToRings(p, [slab.outline, ...slab.holes]) <= COVER_TOL) return true;
	return windingNumber(p, slab.outline) !== 0 && slab.holes.every((h) => windingNumber(p, h) === 0);
}

/**
 * Area shared by two polygons with holes (even-odd), stopping as soon as it exceeds `limit`. Between two consecutive
 * y values of vertices and edge crossings no boundary starts, ends or crosses, so the shared width is linear in y and
 * its value at the middle times the height is exact.
 */
export function overlapArea(a: readonly (readonly Vec2[])[], b: readonly (readonly Vec2[])[], limit = Infinity): number {
	type Edge = readonly [Vec2, Vec2];
	const edgesOf = (rings: readonly (readonly Vec2[])[]): Edge[] => rings.flatMap((r) => r.map((p, i): Edge => [p, r[(i + 1) % r.length]!]));
	const ea = edgesOf(a), eb = edgesOf(b);
	const ys = [...ea, ...eb].map((e) => e[0][1]);
	for (const [p, q] of ea)
		for (const [r, s] of eb) {
			if (Math.max(p[1], q[1]) < Math.min(r[1], s[1]) || Math.max(r[1], s[1]) < Math.min(p[1], q[1])) continue;
			const dx = q[0] - p[0], dy = q[1] - p[1], ex = s[0] - r[0], ey = s[1] - r[1];
			const det = dx * ey - dy * ex;
			if (det === 0) continue;
			const u = ((r[0] - p[0]) * ey - (r[1] - p[1]) * ex) / det;
			if (u > 0 && u < 1) ys.push(p[1] + u * dy);
		}
	const levels = [...new Set(ys)].sort((m, n) => m - n);
	const crossings = (edges: readonly Edge[], y: number): number[] =>
		edges
			.filter(([p, q]) => p[1] <= y !== q[1] <= y)
			.map(([p, q]) => p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]))
			.sort((m, n) => m - n);
	let total = 0;
	for (let i = 0; i + 1 < levels.length && total <= limit; i++) {
		const y = (levels[i]! + levels[i + 1]!) / 2, height = levels[i + 1]! - levels[i]!;
		if (height <= 1e-12) continue;
		const xa = crossings(ea, y), xb = crossings(eb, y);
		for (let m = 0; m + 1 < xa.length; m += 2)
			for (let n = 0; n + 1 < xb.length; n += 2) total += Math.max(0, Math.min(xa[m + 1]!, xb[n + 1]!) - Math.max(xa[m]!, xb[n]!)) * height;
	}
	return total;
}

/** Collect deterministic architectural findings across managed modules. */
export function collectManagedFindings(
	records: ReadonlyMap<string, ManagedModuleRecord>,
	evaluatedByModuleId: ReadonlyMap<string, EvaluatedModule>
): ArchFinding[] {
	const findings = new Map<string, ArchFinding>();
	const add = (f: ArchFinding) => {
		if (!findings.has(f.key)) findings.set(f.key, f);
	};

	const moduleIds = [...records.keys()].sort(cmp);
	for (const moduleId of moduleIds) {
		const record = records.get(moduleId)!;
		if (record.state === 'detached') {
			add(makeFinding('MODULE_DETACHED', 'WARNING', moduleId, null, `Managed module ${moduleId} was edited inside its container group and is detached.`));
			continue;
		}
		if (record.state === 'orphaned') {
			add(makeFinding('MODULE_ORPHANED', 'INFO', moduleId, null, `Managed module ${moduleId} container instance is missing (orphaned).`));
			continue;
		}
		const evaluated = evaluatedByModuleId.get(moduleId);
		if (!evaluated) continue;
		const mod = record.entry.module;

		// 1. Wall free ends: a near miss (A8) is a WALL_GAP, any other free end a WALL_FREE_END.
		const wallById = new Map(mod.elements.filter((e) => e.kind === 'wall').map((e) => [e.elementId, e]));
		const gaps: { point: Vec2; fix: Vec2; reach: number }[] = [];
		for (const node of evaluated.nodes) {
			const incident = incidentSegmentsAt(node.point, evaluated.segments);
			if (node.degree !== 1 || incident.length === 0) continue;
			const seg = incident[0]!;
			let best: { dist: number; point: Vec2; target: WallSegment } | null = null;
			for (const other of evaluated.segments) {
				if (Math.hypot(other.a[0] - node.point[0], other.a[1] - node.point[1]) <= JOIN_TOL) continue;
				if (Math.hypot(other.b[0] - node.point[0], other.b[1] - node.point[1]) <= JOIN_TOL) continue;
				const proj = closestPointOnSegment(node.point, other.a, other.b);
				if (proj.dist > JOIN_TOL && proj.dist <= WALL_GAP_MAX && (!best || proj.dist < best.dist)) {
					best = { dist: proj.dist, point: proj.point, target: other };
				}
			}
			if (!best) {
				add(makeFinding('WALL_FREE_END', 'INFO', moduleId, seg.elementId, `Wall ${seg.elementId} has a free end at (${fmt3(node.point[0])}, ${fmt3(node.point[1])}).`, node.point));
				continue;
			}
			gaps.push({ point: node.point, fix: best.point, reach: Math.max(seg.t, best.target.t) + JOIN_TOL });
			const fix: [number, number] = [round3(best.point[0]), round3(best.point[1])];
			add(
				makeFinding(
					'WALL_GAP',
					'WARNING',
					moduleId,
					seg.elementId,
					`Wall ${seg.elementId} ends ${fmt3(best.dist)} m from ${best.target.elementId}; extend endpoint to (${fmt3(fix[0])}, ${fmt3(fix[1])}).`,
					node.point,
					fix
				)
			);
		}

		// 1b. Wall bases against the slabs under their segment midpoints.
		const slabs: SlabLike[] = mod.elements
			.filter((e) => e.kind === 'slab')
			.map((e) => ({
				elementId: e.elementId,
				outline: e.outline as Vec2[],
				holes: (e.holes as Vec2[][] | undefined) ?? [],
				top: e.topElevation as number,
				bottom: (e.topElevation as number) - (e.thickness as number),
				role: (e.role as string | undefined) ?? 'floor'
			}))
			.sort((p, q) => cmp(p.elementId, q.elementId));
		for (const seg of evaluated.segments) {
			const mid: Vec2 = [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2];
			const covering = slabs.filter((slab) => slabCovers(slab, mid));
			if (covering.length === 0) {
				if (seg.z0 > LEVEL_TOL) {
					add(makeFinding('ELEMENT_FLOATING', 'WARNING', moduleId, seg.elementId, `Wall ${seg.elementId} starts ${fmt3(seg.z0)} m above the module ground with no slab at (${fmt3(mid[0])}, ${fmt3(mid[1])}).`, mid));
				}
				continue;
			}
			// A ceiling, or a slab lying on top of the wall, is not something the wall can stand on.
			const bases = covering.filter((slab) => slab.role !== 'ceiling' && slab.bottom < seg.z0 + seg.h - LEVEL_TOL);
			if (bases.length === 0 || bases.some((slab) => Math.abs(slab.top - seg.z0) <= LEVEL_TOL + 1e-9)) continue;
			const nearest = bases.reduce((p, q) => (Math.abs(q.top - seg.z0) < Math.abs(p.top - seg.z0) ? q : p));
			add(makeFinding('WALL_BASE_MISMATCH', 'WARNING', moduleId, seg.elementId, `Wall ${seg.elementId} base ${fmt3(seg.z0)} differs from the top ${fmt3(nearest.top)} of slab ${nearest.elementId}; set baseElevation to ${fmt3(nearest.top)}.`, mid, { baseElevation: round3(nearest.top) }));
		}

		// 2. Spaces: unenclosed, solid leak (v2.4 A2), centreline gap (v2.4 A2), and duplicates.
		const seenRings = new Set<string>();
		for (const space of evaluated.spaces) {
			if (!space.enclosed) {
				add(makeFinding('SPACE_NOT_ENCLOSED', 'ERROR', moduleId, space.elementId, `Space "${space.name}" (${space.elementId}) is not enclosed by walls.`, space.seed));
				if (space.authoredEnclosed === true) {
					add(makeFinding('ROOM_SOLID_LEAK', 'ERROR', moduleId, space.elementId, `Space "${space.name}" (${space.elementId}) centrelines close but wall solids leak.`, space.seed));
				}
			} else {
				// v2.4 A2: enclosed and not authoredEnclosed is a WALL_GAP. A near-miss finding on this room's own boundary
				// already names the gap and its fix (G9); a near miss elsewhere never hides this room's gap.
				const named = gaps.some((g) => [g.point, g.fix].some((p) => distanceToRings(p, [space.ring, ...space.holes]) <= g.reach));
				if (space.authoredEnclosed === false && !named) {
					add(makeFinding('WALL_GAP', 'WARNING', moduleId, space.elementId, `Space "${space.name}" (${space.elementId}) is enclosed by wall thickness overlap, but wall centrelines have a gap.`, space.seed));
				}
				if (space.ring.length >= 3) {
					const ringKey = canonicalLoopKey(space.ring);
					if (ringKey) {
						if (seenRings.has(ringKey)) {
							add(makeFinding('SPACE_DUPLICATE', 'WARNING', moduleId, space.elementId, `Space "${space.name}" (${space.elementId}) duplicates an already-defined enclosed room.`, space.seed));
						} else {
							seenRings.add(ringKey);
						}
					}
				}
			}
		}

		// 3. Door clearance (clear opening between the jambs and under the frame head) and slab overlap (true 2D area).
		for (const el of mod.elements) {
			if (el.kind === 'opening' && el.openingType === 'door') {
				const thickness = wallById.get(el.hostElementId as string)!.thickness as number;
				const fw = frameWidth(el.width as number, el.height as number, thickness);
				const width = (el.width as number) - 2 * fw;
				const height = (el.height as number) - fw;
				if (width < DOOR_MIN_WIDTH - 1e-9 || height < DOOR_MIN_HEIGHT - 1e-9) {
					add(makeFinding('DOOR_CLEARANCE', 'WARNING', moduleId, el.elementId, `Door ${el.elementId} clear opening ${fmt3(width)}×${fmt3(height)} m is smaller than 0.70×1.90 m.`));
				}
			}
		}

		for (let i = 0; i < slabs.length; i++) {
			for (let j = i + 1; j < slabs.length; j++) {
				const a = slabs[i]!, b = slabs[j]!;
				if (Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom) <= 1e-6) continue;
				if (overlapArea([a.outline, ...a.holes], [b.outline, ...b.holes], SLAB_OVERLAP_MIN) > SLAB_OVERLAP_MIN) {
					add(makeFinding('SLAB_OVERLAP', 'WARNING', moduleId, b.elementId, `Slab ${b.elementId} overlaps vertically and horizontally with ${a.elementId}.`));
				}
			}
		}

		// 4. Staggered continuation diagnostics (on pre-existing modules).
		for (const diag of evaluated.diagnostics) {
			add(makeFinding('WALL_STAGGERED_CONTINUATION', 'WARNING', moduleId, diag.elements[0], `Walls ${diag.elements[0]} and ${diag.elements[1]} form a staggered continuation at (${fmt3(diag.at[0])}, ${fmt3(diag.at[1])}).`, diag.at));
		}

		// 5. Topology geometry quality checks (tiny edge, sliver face).
		for (const part of evaluated.parts) {
			const pos = part.topology.positions;
			for (const edge of part.topology.edges) {
				if (edge.flag !== 'hard') continue;
				const a = edge.a * 3, b = edge.b * 3;
				const len = Math.hypot(pos[b]! - pos[a]!, pos[b + 1]! - pos[a + 1]!, pos[b + 2]! - pos[a + 2]!);
				if (len < TINY_EDGE_MAX) {
					const mid: [number, number, number] = [(pos[a]! + pos[b]!) / 2, (pos[a + 1]! + pos[b + 1]!) / 2, (pos[a + 2]! + pos[b + 2]!) / 2];
					add(makeFinding('TINY_EDGE', 'WARNING', moduleId, part.elementId, `Part ${part.partId} has an edge shorter than ${TINY_EDGE_MAX} m.`, mid));
				}
			}
			for (const face of part.topology.faces) {
				if (face.area < SLIVER_FACE_MAX) {
					add(makeFinding('SLIVER_FACE', 'WARNING', moduleId, face.elementId, `Face ${face.id} has sliver area ${face.area.toExponential(2)} m².`, face.centroid));
				}
			}
		}
	}

	return sortFindings([...findings.values()]);
}

/** ERROR, WARNING, INFO, then identity key (code-unit order). */
export function sortFindings(findings: readonly ArchFinding[]): ArchFinding[] {
	return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || cmp(a.key, b.key));
}

export function diffFindings(before: readonly ArchFinding[], after: readonly ArchFinding[]): FindingsDiff {
	const beforeKeys = new Set(before.map((f) => f.key));
	const afterKeys = new Set(after.map((f) => f.key));
	const added = after.filter((f) => !beforeKeys.has(f.key)).slice(0, MAX_DIFF_ITEMS);
	const resolved = [...beforeKeys].filter((k) => !afterKeys.has(k)).sort(cmp).slice(0, MAX_DIFF_ITEMS);
	const totals: Record<FindingSeverity, number> = { ERROR: 0, WARNING: 0, INFO: 0 };
	for (const f of after) totals[f.severity] += 1;
	return { new: added, resolved, totals };
}
