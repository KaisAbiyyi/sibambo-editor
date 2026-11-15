/**
 * Authored (centreline) enclosure vs solid enclosure — the G9 disposition evidence. `centerlineEnclosure` is pure and not
 * wired into `evaluateModule`; these tests show it can report G9 as open WITHOUT touching the 3D mesh.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { centerlineEnclosure } from '../../src/lib/arch/connectivity';
import { evaluateModule } from '../../src/lib/arch/evaluate';
import { createKernel, type Kernel } from '../../src/lib/arch/kernel';
import { buildWallNetwork, type WallElement } from '../../src/lib/arch/walls';
import type { ArchModule } from '../../src/lib/arch/schema';
import type { SpaceElement } from '../../src/lib/arch/elements';
import { exportDigest } from './fixtures/digest';
import { g1, g3, g4, g5, g8, g9, moduleOf, space, wall } from './fixtures/modules';

let kernel: Kernel;
beforeAll(async () => {
	kernel = createKernel();
	await kernel.init();
});

const authored = (m: ArchModule) => {
	const walls = m.elements.filter((e) => e.kind === 'wall') as unknown as WallElement[];
	const spaces = m.elements.filter((e) => e.kind === 'space') as unknown as SpaceElement[];
	const network = buildWallNetwork(kernel, walls);
	const result = centerlineEnclosure(kernel, network.segments, spaces);
	kernel.release(network.solid);
	kernel.resetTags();
	return Object.fromEntries(result.map((r) => [r.elementId, r.centerlineEnclosed]));
};
const solid = (m: ArchModule) => Object.fromEntries(evaluateModule(m, kernel, { cache: false }).spaces.map((s) => [s.elementId, s.enclosed]));

describe('G9: authored enclosure is open, solid enclosure is closed, and the mesh is untouched', () => {
	test('the fixture is exactly the plan fixture (north wall shortened by 0.02 at its east end)', () => {
		const north = g9().elements.find((e) => e.elementId === 'w3') as any;
		expect(north.path).toEqual([[3.98, 3], [0, 3]]);
		expect(g9().elements.find((e) => e.elementId === 'w2')).toMatchObject({ path: [[4, 0], [4, 3]], thickness: 0.15 });
	});
	test('centreline: enclosed:false (the 0.02 m gap exceeds JOIN_TOL); solid: enclosed:true (bodies overlap)', () => {
		expect(authored(g9())).toEqual({ sp: false });
		expect(solid(g9())).toEqual({ sp: true });
	});
	test('computing the authored answer never changes the evaluated mesh (digest equal before and after, across two kernels)', async () => {
		const before = exportDigest(evaluateModule(g9(), kernel, { cache: false }));
		authored(g9());
		authored(g9());
		const after = exportDigest(evaluateModule(g9(), kernel, { cache: false }));
		const other = createKernel();
		await other.init();
		expect(after).toBe(before);
		expect(exportDigest(evaluateModule(g9(), other, { cache: false }))).toBe(before);
		expect(kernel.liveCount()).toBe(0);
	});
});

describe('the two predicates agree wherever the plan has no complaint', () => {
	test('G3, G4, G5, G8 and the closed G1 room: both closed for every seed', () => {
		for (const make of [g3, g4, g5, g8, () => moduleOf([...g1().elements, space('sp', 'Room', [2, 1.5])])]) {
			const m = make();
			const a = authored(m), s = solid(m);
			expect(Object.keys(a).length).toBeGreaterThan(0);
			expect(Object.values(a).every((v) => v === true)).toBe(true);
			expect(a).toEqual(s);
		}
	});
	test('a gap wider than half the thickness opens both; a gap of 0.9 mm is a join (clustered) and closes the centreline', () => {
		const withGap = (gap: number) =>
			moduleOf([wall('w1', [[0, 0], [4, 0]]), wall('w2', [[4, 0], [4, 3]]), wall('w3', [[4 - gap, 3], [0, 3]]), wall('w4', [[0, 3], [0, 0]]), space('sp', 'R', [2, 1.5])]);
		expect([authored(withGap(0.1)), solid(withGap(0.1))]).toEqual([{ sp: false }, { sp: false }]);
		expect([authored(withGap(0.0009)), solid(withGap(0.0009))]).toEqual([{ sp: true }, { sp: true }]);
		expect(authored(withGap(0.0012))).toEqual({ sp: false }); // beyond JOIN_TOL: no node, so open on the centreline…
		expect(solid(withGap(0.0012))).toEqual({ sp: true }); // …while the 0.15 m bodies still overlap
	});
	test('a seed on a centreline has no authored answer; a seed outside everything is open', () => {
		expect(authored(moduleOf([...g1().elements, space('on', 'On', [4, 1.5])]))).toEqual({ on: null });
		expect(authored(moduleOf([...g1().elements, space('out', 'Out', [10, 10])]))).toEqual({ out: false });
		expect(authored(moduleOf([...g1().elements]))).toEqual({});
	});
	test('an island wall inside a room does not open it; two rooms are answered independently', () => {
		const m = moduleOf([...g4().elements.filter((e) => e.kind === 'wall'), wall('col', [[0.5, 0.5], [1, 0.5], [1, 1], [0.5, 1]], { closed: true }), space('sa', 'A', [1.5, 2]), space('sb', 'B', [3, 1.5])]);
		expect(authored(m)).toEqual({ sa: true, sb: true });
	});
});
