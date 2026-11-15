/**
 * SIB-MCP-MODELING-001 — AUTHORED (centreline) enclosure, as a PURE, NOT-YET-WIRED function.
 *
 * Context (WP4 open item 1, G9). A room can be closed in two different senses:
 *  - SOLID enclosure: the wall BODIES leave no opening. This is what `buildSpaces` computes today (`SpaceResult.enclosed`)
 *    and it follows the 3D mesh exactly.
 *  - AUTHORED enclosure: the wall CENTRELINES, joined with the module's own JOIN_TOL, close a loop around the seed.
 *    G9 shortens the north wall by 0.02 m: its centreline stops 0.02 m short of the east wall's (> JOIN_TOL, so no node
 *    is made and `WALL_GAP` applies) although the 0.15 m thick bodies still overlap and the solid is closed.
 *
 * Reporting the authored answer never alters a mesh: this function only reads the segments the wall solver already
 * produced and builds 2D strokes of width JOIN_TOL with square caps of JOIN_TOL/2. Strokes of segments that share a node
 * (endpoints equal after clustering) overlap by their caps; a gap wider than JOIN_TOL stays open.
 *
 * Which of the two (or both) `enclosed` should mean is a PLAN decision that the owner has not taken; see
 * docs/implementation-plan/PLAN_DISPOSITION_2026-11-15_SIB-MCP-MODELING-001_WP4_G9-C7_v0.1.md. Nothing calls this yet.
 */
import { distanceToRings, windingNumber, type SpaceElement } from './elements.js';
import type { Kernel, Ring, Vec2 } from './kernel.js';
import { JOIN_TOL, type WallSegment } from './walls.js';

export type CenterlineEnclosure = {
	elementId: string;
	/**
	 * `true`: a loop of joined centrelines encloses the seed. `false`: the seed reaches the outside through a gap wider than
	 * JOIN_TOL. `null`: the seed lies on a centreline (no answer).
	 */
	centerlineEnclosed: boolean | null;
};

export function centerlineEnclosure(kernel: Kernel, segments: readonly Pick<WallSegment, 'a' | 'b' | 'd' | 'n' | 'length'>[], spaces: readonly SpaceElement[]): CenterlineEnclosure[] {
	if (spaces.length === 0) return [];
	const half = JOIN_TOL / 2;
	const strokes: Ring[] = segments.map((s) => {
		const at = (along: number, across: number): Vec2 => [s.a[0] + s.d[0] * along + s.n[0] * across, s.a[1] + s.d[1] * along + s.n[1] * across];
		return [at(-half, -half), at(s.length + half, -half), at(s.length + half, half), at(-half, half)];
	});
	const footprint = strokes.length ? kernel.union2d(strokes) : [];
	const xs = footprint.flatMap((r) => r.map((p) => p[0])), ys = footprint.flatMap((r) => r.map((p) => p[1]));
	const bounds = xs.length
		? { minX: Math.min(...xs) - 1, minY: Math.min(...ys) - 1, maxX: Math.max(...xs) + 1, maxY: Math.max(...ys) + 1 }
		: { minX: -1, minY: -1, maxX: 1, maxY: 1 };
	const regions = kernel.regionsOutside(footprint, bounds);
	return [...spaces]
		.sort((p, q) => (p.elementId < q.elementId ? -1 : p.elementId > q.elementId ? 1 : 0))
		.map((space) => {
			const seed: Vec2 = [space.seedPoint[0], space.seedPoint[1]];
			if (footprint.reduce((sum, ring) => sum + windingNumber(seed, ring), 0) > 0 || distanceToRings(seed, footprint) <= 1e-6)
				return { elementId: space.elementId, centerlineEnclosed: null };
			const region = regions.find((r) => windingNumber(seed, r.ring) > 0 && r.holes.every((h) => windingNumber(seed, h) === 0));
			return { elementId: space.elementId, centerlineEnclosed: !!region && !region.touchesBounds };
		});
}
