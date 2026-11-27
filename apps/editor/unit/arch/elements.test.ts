/** C8 elements: slabs, openings (placement rules, cutters, inserts) and spaces. */
import { beforeAll, describe, expect, test } from 'bun:test';
import { ArchError } from '../../src/lib/arch/errors';
import { evaluateModule } from '../../src/lib/arch/evaluate';
import { createKernel, type Kernel } from '../../src/lib/arch/kernel';
import type { ArchModule } from '../../src/lib/arch/schema';
import { frameWidth } from '../../src/lib/arch/elements';
import { g1, g3, g4, g8, g9, moduleOf, opening, space, wall } from './fixtures/modules';

let kernel: Kernel;
beforeAll(async () => {
	kernel = createKernel();
	await kernel.init();
});
const evaluate = (m: ArchModule) => evaluateModule(m, kernel, { cache: false });
const reasonOf = (m: ArchModule) => {
	try {
		evaluate(m);
	} catch (error) {
		expect(error).toBeInstanceOf(ArchError);
		return (error as ArchError).detail;
	}
	throw new Error('expected ArchError');
};
const withOpening = (base: ArchModule, ...extra: ArchModule['elements']) => moduleOf([...base.elements, ...extra]);
const part = (e: ReturnType<typeof evaluate>, id: string) => e.parts.find((p) => p.partId === id)!;
const bbox = (p: { mesh: { positions: Float64Array } }) => {
	const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < p.mesh.positions.length; i += 3)
		for (let k = 0; k < 3; k++) {
			min[k] = Math.min(min[k]!, p.mesh.positions[i + k]!);
			max[k] = Math.max(max[k]!, p.mesh.positions[i + k]!);
		}
	return { min, max };
};

describe('openings: G8 volumes, inserts and reveals', () => {
	test('each opening removes exactly w·h·t from the wall; inserts are separate manifold parts', () => {
		const e = evaluate(g8());
		const plain = evaluate(g3());
		expect(part(plain, 'walls').stats.volume - part(e, 'walls').stats.volume).toBeCloseTo(0.9 * 2.1 * 0.15 + 1.0 * 1.2 * 0.15, 6);
		expect(part(e, 'walls').stats).toMatchObject({ status: 'NoError', components: 1 });
		expect(e.parts.map((p) => p.partId)).toEqual(['door/frame', 'door/leaf', 'walls', 'win/frame', 'win/glazing']);
		for (const p of e.parts) expect(p.stats).toMatchObject({ status: 'NoError', components: 1 });
		expect(e.openings.map((o) => [o.elementId, o.x0, o.x1, o.zBottom, o.zTop])).toEqual([
			['door', 1, 1.9, 0, 2.1], ['win', 2.5, 3.5, 0.9, 2.1]
		]);
	});
	test('cutter-tagged triangles belong to the host as reveal:<openingId>; inserts carry their own roles and materials', () => {
		const e = evaluate(g8());
		const walls = part(e, 'walls');
		const roles = new Set(Array.from(new Set(walls.mesh.triTag)).map((t) => e.tags[t]?.role));
		expect(roles).toEqual(new Set(['wall', 'reveal:door', 'reveal:win']));
		for (const t of new Set(walls.mesh.triTag)) expect(e.tags[t]!.elementId).toBe('shell');
		expect(Array.from(new Set(part(e, 'win/glazing').mesh.triTag)).map((t) => e.tags[t])).toEqual([{ elementId: 'win', role: 'glazing', materialId: 'sib-glass' }]);
		expect(Array.from(new Set(part(e, 'door/leaf').mesh.triTag)).map((t) => e.tags[t]!.materialId)).toEqual(['sib-door']);
		expect(Array.from(new Set(part(e, 'door/frame').mesh.triTag)).map((t) => e.tags[t]!.materialId)).toEqual(['sib-frame']);
	});
	test('frame dimension rule fw = min(0.045, w/12, h/12, t/4); door leaf stands perpendicular at the hinge jamb on the swing side', () => {
		expect(frameWidth(0.9, 2.1, 0.15)).toBeCloseTo(0.0375, 12);
		expect(frameWidth(3, 3, 0.4)).toBe(0.045);
		const e = evaluate(g8());
		const fw = 0.0375, lt = Math.min(0.035, 0.75 * fw);
		const leaf = bbox(part(e, 'door/leaf'));
		// south wall: d=+x, n=+y, side right ⇒ yL=0; swing side "left" is +y (into the room)
		expect(leaf.min[0]).toBeCloseTo(1.0 + fw, 6);
		expect(leaf.max[0]).toBeCloseTo(1.0 + fw + lt, 6);
		expect(leaf.min[1]).toBeCloseTo(0, 6);
		expect(leaf.max[1]).toBeCloseTo(0.9 - 2 * fw, 6);
		expect(leaf.max[2]).toBeCloseTo(2.1 - fw, 6);
		const glass = bbox(part(e, 'win/glazing'));
		expect(glass.max[1] - glass.min[1]).toBeCloseTo(Math.min(0.008, 0.05), 6);
		expect((glass.max[1] + glass.min[1]) / 2).toBeCloseTo(-0.075, 6); // centred on the body (−0.15…0)
		const doorRight = evaluate(withOpening(g3(), { ...opening('d2', 'shell', 2.0, 0.9, 2.1, 0, 'door', { swing: { hinge: 'end', side: 'right' } }) }));
		const leaf2 = bbox(part(doorRight, 'd2/leaf'));
		expect(leaf2.max[0]).toBeCloseTo(2.9 - fw, 6);
		expect(leaf2.max[1]).toBeCloseTo(-0.15, 6);
		expect(leaf2.min[1]).toBeCloseTo(-0.15 - (0.9 - 2 * fw), 6);
	});
	test('a void opening cuts without inserts', () => {
		const e = evaluate(withOpening(g3(), opening('hole', 'shell', 1, 1, 2, 0, 'void')));
		expect(e.parts.map((p) => p.partId)).toEqual(['walls']);
		expect(part(evaluate(g3()), 'walls').stats.volume - part(e, 'walls').stats.volume).toBeCloseTo(1 * 2 * 0.15, 6);
	});
	test('an opening on a side-left/right/centre wall cuts the full body depth (no skin left behind)', () => {
		for (const side of ['left', 'center', 'right'] as const) {
			const e = evaluate(moduleOf([wall('w', [[0, 0], [4, 0]], { side }), opening('d', 'w', 1, 1, 2, 0, 'door')]));
			expect(part(e, 'walls').stats.volume).toBeCloseTo(4 * 0.15 * 2.7 - 1 * 2 * 0.15, 6); // door 1 × 2, full depth 0.15
		}
	});
});

describe('opening placement rules (each reason once, plus the boundary that passes)', () => {
	const door = (along: number, width = 0.9, extra = {}) => withOpening(g3(), opening('o', 'shell', along, width, 2.1, 0, 'door', extra));
	test('outside host / across a vertex', () => {
		expect(reasonOf(door(13.9, 0.5)).reason).toBe('OPENING_OUTSIDE_HOST');
		expect(reasonOf(door(3.8, 0.5)).reason).toBe('OPENING_ACROSS_VERTEX');
		expect(reasonOf(door(3.8, 0.5)).elementId).toBe('o');
		expect(reasonOf(door(3.8, 0.5)).moduleId).toBe('test/ground');
	});
	test('too close to a junction: boundary 0.05 m from the corner limit', () => {
		expect(reasonOf(door(0.04)).reason).toBe('OPENING_TOO_CLOSE_TO_JUNCTION');
		expect(() => evaluate(door(0.05))).not.toThrow();
		expect(reasonOf(door(3.06)).reason).toBe('OPENING_TOO_CLOSE_TO_JUNCTION'); // ends at 3.96 > 3.95
		expect(() => evaluate(door(3.05))).not.toThrow(); // ends at exactly 3.95
	});
	test('T junction splits the host: an opening may not cross the node and keeps 0.05 m beyond the stem corner', () => {
		const t = (along: number, width: number) => withOpening(g4(), opening('o', 'w1', along, width, 2.1, 0, 'door'));
		expect(reasonOf(t(1.8, 0.4)).reason).toBe('OPENING_ACROSS_VERTEX');
		expect(reasonOf(t(2.12, 0.5)).reason).toBe('OPENING_TOO_CLOSE_TO_JUNCTION'); // stem corner at 2.075 + 0.05 = 2.125
		expect(() => evaluate(t(2.13, 0.5))).not.toThrow();
		expect(() => evaluate(t(1.0, 0.8))).not.toThrow(); // 1.8 ≤ 1.925 − 0.05
		expect(reasonOf(t(1.1, 0.8)).reason).toBe('OPENING_TOO_CLOSE_TO_JUNCTION'); // 1.9 > 1.875
	});
	test('sill rule: door sill 0, window sill > 0', () => {
		expect(reasonOf(withOpening(g3(), opening('o', 'shell', 1, 0.9, 2.0, 0.1, 'door'))).reason).toBe('OPENING_SILL_RULE');
		expect(reasonOf(withOpening(g3(), opening('o', 'shell', 1, 1, 1, 0, 'window'))).reason).toBe('OPENING_SILL_RULE');
	});
	test('head clearance 0.05 m below the wall top: 2.65 passes, 2.66 fails', () => {
		expect(() => evaluate(withOpening(g3(), opening('o', 'shell', 1, 0.9, 2.65, 0, 'door')))).not.toThrow();
		expect(reasonOf(withOpening(g3(), opening('o', 'shell', 1, 0.9, 2.66, 0, 'door'))).reason).toBe('OPENING_NO_HEAD');
		expect(reasonOf(withOpening(g3(), opening('o', 'shell', 1, 1, 1.0, 1.66, 'window'))).reason).toBe('OPENING_NO_HEAD');
	});
	test('same-host openings must not overlap or touch', () => {
		const two = (a: number, aw: number, b: number) => withOpening(g3(), opening('a', 'shell', a, aw, 2.1, 0, 'door'), opening('b', 'shell', b, 0.5, 2.1, 0, 'door'));
		expect(reasonOf(two(1, 0.9, 1.5)).reason).toBe('OPENING_OVERLAP');
		expect(reasonOf(two(1, 0.9, 1.9)).reason).toBe('OPENING_OVERLAP'); // touching
		expect(() => evaluate(two(1, 0.9, 1.95))).not.toThrow();
	});
	test('openings on different walls and on a path with a collinear middle vertex', () => {
		const m = moduleOf([wall('w', [[0, 0], [2, 0], [4, 0]]), opening('d', 'w', 0.5, 0.9, 2.1, 0, 'door'), opening('e', 'w', 2.5, 0.9, 2.1, 0, 'door')]);
		const e = evaluate(m);
		expect(e.stats.segments).toBe(1);
		expect(e.openings.map((o) => [o.x0, o.x1])).toEqual([[0.5, 1.4], [2.5, 3.4]]);
		// the authored middle vertex still counts as a vertex for the "across vertex" rule
		expect(reasonOf(moduleOf([wall('w', [[0, 0], [2, 0], [4, 0]]), opening('d', 'w', 1.8, 0.4, 2.1, 0, 'door')])).reason).toBe('OPENING_ACROSS_VERTEX');
	});
});

describe('slabs', () => {
	const slab = (outline: [number, number][], holes: [number, number][][] = []) => moduleOf([{ elementId: 's', kind: 'slab', outline, holes, thickness: 0.2, topElevation: 0 } as any]);
	const rect: [number, number][] = [[0, 0], [4, 0], [4, 3], [0, 3]];
	test('volume, orientation normalisation, holes', () => {
		expect(evaluate(slab(rect)).parts[0]!.stats.volume).toBeCloseTo(2.4, 9);
		expect(evaluate(slab([...rect].reverse())).parts[0]!.stats.volume).toBeCloseTo(2.4, 9);
		const holed = evaluate(slab(rect, [[[1, 1], [2, 1], [2, 2], [1, 2]]]));
		expect(holed.parts[0]!.stats).toMatchObject({ genus: 1, status: 'NoError' });
		expect(holed.parts[0]!.stats.volume).toBeCloseTo(11 * 0.2, 9);
		const b = bbox(holed.parts[0]!);
		expect([b.min[2], b.max[2]]).toEqual([-0.2, 0]);
		expect(evaluate(slab(rect, [[[1, 1], [1, 2], [2, 2], [2, 1]]])).parts[0]!.stats.volume).toBeCloseTo(11 * 0.2, 9); // clockwise hole
	});
	test('self-intersecting outline, hole outside, overlapping holes → SLAB_SELF_INTERSECTS', () => {
		expect(reasonOf(slab([[0, 0], [4, 3], [4, 0], [0, 3]])).reason).toBe('SLAB_SELF_INTERSECTS');
		expect(reasonOf(slab(rect, [[[5, 5], [6, 5], [6, 6], [5, 6]]])).reason).toBe('SLAB_SELF_INTERSECTS');
		expect(reasonOf(slab(rect, [[[1, 1], [2.5, 1], [2.5, 2], [1, 2]], [[2, 1], [3, 1], [3, 2], [2, 2]]])).reason).toBe('SLAB_SELF_INTERSECTS');
		expect(reasonOf(slab([[0, 0], [4, 3], [4, 0], [0, 3]])).elementId).toBe('s');
		expect(reasonOf(slab([[0, 0], [4, 0], [4, 3], [2, 0], [0, 3]])).reason).toBe('SLAB_SELF_INTERSECTS'); // touching vertex
	});
	test('walls and slab together: separate parts in partId order, slab sits on top of nothing it was not told to', () => {
		const e = evaluate(moduleOf([...g1().elements, { elementId: 'floor', kind: 'slab', outline: rect, thickness: 0.2, topElevation: 0 } as any]));
		expect(e.parts.map((p) => p.partId)).toEqual(['floor', 'walls']);
	});
});

describe('spaces', () => {
	test('G3/G4: enclosed rooms with exact interior dimensions', () => {
		const a = evaluate(g3()).spaces[0]!;
		expect(a).toMatchObject({ enclosed: true, area: 12 });
		expect(a.bbox).toEqual({ minX: 0, minY: 0, maxX: 4, maxY: 3 });
		const rooms = evaluate(g4()).spaces;
		for (const r of rooms) {
			expect(r.area).toBeCloseTo(1.85 * 2.85, 6);
			expect(r.bbox!.maxX - r.bbox!.minX).toBeCloseTo(1.85, 6);
			expect(r.bbox!.maxY - r.bbox!.minY).toBeCloseTo(2.85, 6);
		}
		expect(rooms.map((r) => r.area.toFixed(2))).toEqual(['5.27', '5.27']);
	});
	test('an island (column) inside a room becomes a hole of the room, not a second room', () => {
		const m = moduleOf([...g1().elements, wall('col', [[1, 1], [1.5, 1], [1.5, 1.5], [1, 1.5]], { closed: true }), space('sp', 'Hall', [3, 2])]);
		const r = evaluate(m).spaces[0]!;
		expect(r.enclosed).toBe(true);
		expect(r.holes).toHaveLength(1);
		expect(r.area).toBeCloseTo(3.85 * 2.85 - 0.65 * 0.65, 6);
	});
	test('seed inside a wall body is INVALID_GEOMETRY; a seed outside the walls is enclosed:false (a result, not an error)', () => {
		expect(reasonOf(moduleOf([...g3().elements.slice(0, 1), space('sp', 'X', [2, -0.05])])).reason).toBe('SPACE_SEED_IN_WALL');
		expect(reasonOf(moduleOf([...g1().elements, space('sp', 'X', [4, 1.5])])).reason).toBe('SPACE_SEED_IN_WALL'); // on the centre line of the east wall
		const outside = evaluate(moduleOf([...g1().elements, space('sp', 'Out', [10, 10])])).spaces[0]!;
		expect(outside).toMatchObject({ enclosed: false, area: 0, bbox: null });
	});
	test('openings and heights are ignored: a door does not open the room', () => {
		expect(evaluate(g8()).spaces[0]).toMatchObject({ enclosed: true, area: 12 });
	});
	test('G9 as written commits; its 0.02 m shortening leaves overlapping bodies, so the C8 footprint stays closed', () => {
		const e = evaluate(g9());
		expect(part(e, 'walls').stats).toMatchObject({ status: 'NoError', components: 1 });
		expect(e.spaces[0]!.enclosed).toBe(true); // plan G9 says false: DISCREPANCY recorded in the WP4 evidence
		const free = Object.values(e.junctions).flat().filter((j) => j.type === 'free-end').map((j) => j.at.join(','));
		expect(free.sort()).toEqual(['3.98,3', '4,3']); // the two ends stay unjoined: the 0.02 m near miss is never auto-snapped
	});
	test('a gap wider than half the thickness really leaks: enclosed:false', () => {
		const m = moduleOf([wall('w1', [[0, 0], [4, 0]]), wall('w2', [[4, 0], [4, 3]]), wall('w3', [[3.9, 3], [0, 3]]), wall('w4', [[0, 3], [0, 0]]), space('sp', 'Leaky', [2, 1.5])]);
		expect(evaluate(m).spaces[0]).toMatchObject({ enclosed: false, area: 0 });
	});
});
