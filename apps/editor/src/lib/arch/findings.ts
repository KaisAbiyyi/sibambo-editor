/**
 * SIB-MCP-MODELING-001 v2.3 C13 & v2.4 A2 — `arch/findings.ts`: pure architectural model findings
 * and before/after receipt diffing (`edit_model` findings diff). Does not import the geometry kernel.
 */
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

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { ERROR: 0, WARNING: 1, INFO: 2 };
const MAX_DIFF_ITEMS = 10;
const WALL_GAP_MAX = 0.30;
const TINY_EDGE_MAX = 0.002;
const SLIVER_FACE_MAX = 1e-4;
const DOOR_MIN_WIDTH = 0.70;
const DOOR_MIN_HEIGHT = 1.90;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const round3 = (v: number): number => {
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

function makeFinding(
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

		// 1. Wall nodes: free ends, near-miss gaps, and base-elevation mismatches.
		let moduleHasGap = false;
		for (const node of evaluated.nodes) {
			const incident = incidentSegmentsAt(node.point, evaluated.segments);
			if (node.degree === 1 && incident.length > 0) {
				const seg = incident[0]!;
				add(makeFinding('WALL_FREE_END', 'INFO', moduleId, seg.elementId, `Wall ${seg.elementId} has a free end at (${fmt3(node.point[0])}, ${fmt3(node.point[1])}).`, node.point));

				let best: { dist: number; point: Vec2; targetId: string } | null = null;
				for (const other of evaluated.segments) {
					if (Math.hypot(other.a[0] - node.point[0], other.a[1] - node.point[1]) <= JOIN_TOL) continue;
					if (Math.hypot(other.b[0] - node.point[0], other.b[1] - node.point[1]) <= JOIN_TOL) continue;
					const proj = closestPointOnSegment(node.point, other.a, other.b);
					if (proj.dist > JOIN_TOL && proj.dist <= WALL_GAP_MAX && (!best || proj.dist < best.dist)) {
						best = { dist: proj.dist, point: proj.point, targetId: other.elementId };
					}
				}
				if (best) {
					moduleHasGap = true;
					const fix: [number, number] = [round3(best.point[0]), round3(best.point[1])];
					add(
						makeFinding(
							'WALL_GAP',
							'WARNING',
							moduleId,
							seg.elementId,
							`Wall ${seg.elementId} ends ${fmt3(best.dist)} m from ${best.targetId}; extend endpoint to (${fmt3(fix[0])}, ${fmt3(fix[1])}).`,
							node.point,
							fix
						)
					);
				}
			} else if (node.degree >= 2 && incident.length >= 2) {
				const zValues = incident.map((s) => s.z0);
				if (Math.max(...zValues) - Math.min(...zValues) > 1e-6) {
					add(makeFinding('WALL_BASE_MISMATCH', 'WARNING', moduleId, incident[0]!.elementId, `Walls meeting at (${fmt3(node.point[0])}, ${fmt3(node.point[1])}) have differing baseElevation values.`, node.point));
				}
			}
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
				if (space.authoredEnclosed === false && !moduleHasGap) {
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

		// 3. Door clearance & slab overlap.
		for (const el of mod.elements) {
			if (el.kind === 'opening' && el.openingType === 'door') {
				const width = el.width as number;
				const height = el.height as number;
				if (width < DOOR_MIN_WIDTH || height < DOOR_MIN_HEIGHT) {
					add(makeFinding('DOOR_CLEARANCE', 'WARNING', moduleId, el.elementId, `Door ${el.elementId} (${width.toFixed(2)}×${height.toFixed(2)} m) is smaller than 0.70×1.90 m.`));
				}
			}
		}

		const slabs = mod.elements.filter((e) => e.kind === 'slab');
		for (let i = 0; i < slabs.length; i++) {
			for (let j = i + 1; j < slabs.length; j++) {
				const a = slabs[i]!, b = slabs[j]!;
				const aTop = a.topElevation as number, aBot = aTop - (a.thickness as number);
				const bTop = b.topElevation as number, bBot = bTop - (b.thickness as number);
				if (Math.min(aTop, bTop) - Math.max(aBot, bBot) <= 1e-6) continue;
				const box = (pts: readonly (readonly [number, number])[]) => ({
					minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])),
					minY: Math.min(...pts.map((p) => p[1])), maxY: Math.max(...pts.map((p) => p[1]))
				});
				const ba = box(a.outline as readonly (readonly [number, number])[]);
				const bb = box(b.outline as readonly (readonly [number, number])[]);
				if (Math.min(ba.maxX, bb.maxX) - Math.max(ba.minX, bb.minX) > 1e-6 && Math.min(ba.maxY, bb.maxY) - Math.max(ba.minY, bb.minY) > 1e-6) {
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

	return [...findings.values()].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || cmp(a.key, b.key));
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
