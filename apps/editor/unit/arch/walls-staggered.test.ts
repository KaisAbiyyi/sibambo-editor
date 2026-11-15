/**
 * Straight continuation of walls on OPPOSITE sides of the path (side left/right mixes): deterministic classification,
 * explicit report, opt-in rejection. The default keeps the WP4 geometry; nothing is joined or dropped silently.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { ArchError } from '../../src/lib/arch/errors';
import { evaluateModule } from '../../src/lib/arch/evaluate';
import { createKernel, type Kernel } from '../../src/lib/arch/kernel';
import { buildWallNetwork, type WallElement } from '../../src/lib/arch/walls';
import { g1, g3, g4, g5, g6, g7, g8, moduleOf, wall } from './fixtures/modules';

let kernel: Kernel;
beforeAll(async () => {
	kernel = createKernel();
	await kernel.init();
});

const sides = ['center', 'left', 'right'] as const;
// lateral range of a body in its own path frame
const range = (side: string, t: number): [number, number] => (side === 'left' ? [0, t] : side === 'right' ? [-t, 0] : [-t / 2, t / 2]);
const pair = (sa: string, sb: string, ta: number, tb: number, tilt = 0, order: 'ab' | 'ba' = 'ab'): WallElement[] => {
	const c = Math.cos(tilt), s = Math.sin(tilt);
	const a: WallElement = { elementId: 'a', path: [[0, 0], [3 * c, 3 * s]], thickness: ta, height: 2.7, baseElevation: 0, side: sa as any };
	const b: WallElement = { elementId: 'b', path: [[0, 0], [-2 * c, -2 * s]], thickness: tb, height: 2.7, baseElevation: 0, side: sb as any };
	return order === 'ab' ? [a, b] : [b, a];
};
const run = (walls: WallElement[], options = {}) => {
	const network = buildWallNetwork(kernel, walls, options);
	const stats = network.solid ? kernel.stats(network.solid) : null;
	kernel.release(network.solid);
	kernel.resetTags();
	return { network, stats };
};
// B runs the opposite way, so its lateral range is mirrored in A's frame
const sharedWidth = (sa: string, sb: string, ta: number, tb: number) => {
	const [a0, a1] = range(sa, ta), [b0, b1] = range(sb, tb);
	return Math.min(a1, -b0) - Math.max(a0, -b1);
};

describe('classification is deterministic and exact', () => {
	for (const sa of sides)
		for (const sb of sides)
			for (const [ta, tb] of [[0.15, 0.15], [0.15, 0.25], [0.4, 0.01], [2, 0.01]] as const)
				test(`A ${sa} t${ta} + B ${sb} t${tb}`, () => {
					const width = sharedWidth(sa, sb, ta, tb);
					for (const tilt of [0, 0.7, 2.1]) {
						const { network, stats } = run(pair(sa, sb, ta, tb, tilt));
						if (width > 1e-9) {
							expect({ tilt, staggered: network.staggered.length, components: stats!.components }).toEqual({ tilt, staggered: 0, components: 1 });
							expect(network.nodes.find((n) => n.degree === 2)!.bridges).toHaveLength(1);
						} else {
							expect(network.staggered).toHaveLength(1);
							expect(network.staggered[0]).toMatchObject({ elements: ['a', 'b'], tags: [0, 1], overlap: 0 });
							expect(network.staggered[0]!.at).toEqual([0, 0]);
							expect(stats!.components).toBe(2); // the geometry is exactly what was authored: two solids touching on an edge
						}
					}
				});
	test('the shared width of schema-valid walls is never in the ambiguous band (0 or ≥ 0.005)', () => {
		const seen = new Set<number>();
		for (const sa of sides)
			for (const sb of sides)
				for (const ta of [0.01, 0.05, 0.15, 1, 2])
					for (const tb of [0.01, 0.05, 0.15, 1, 2]) {
						const w = sharedWidth(sa, sb, ta, tb);
						seen.add(w <= 1e-12 ? 0 : w);
						expect(w <= 1e-12 || w >= 0.005 - 1e-12).toBe(true);
					}
		expect(seen.has(0)).toBe(true);
	});
});

describe('report policy (default) vs reject policy', () => {
	const staggeredWalls = () => pair('right', 'right', 0.15, 0.15, 0.4); // bodies on opposite sides of the shared line
	test('default is "report": identical geometry to an explicit report, the pair is listed', () => {
		const implicit = run(staggeredWalls()), explicit = run(staggeredWalls(), { staggered: 'report' });
		expect(implicit.network.staggered).toEqual(explicit.network.staggered);
		expect(implicit.stats).toEqual(explicit.stats);
		expect(implicit.network.staggered).toHaveLength(1);
	});
	test('reject: INVALID_GEOMETRY WALL_STAGGERED_CONTINUATION with the node, the first element and a next action; nothing is allocated', () => {
		try {
			run(staggeredWalls(), { staggered: 'reject' });
			throw new Error('expected failure');
		} catch (error) {
			expect(error).toBeInstanceOf(ArchError);
			const e = error as ArchError;
			expect(e.code).toBe('INVALID_GEOMETRY');
			expect(e.detail).toMatchObject({ reason: 'WALL_STAGGERED_CONTINUATION', elementId: 'a', at: [0, 0] });
			expect(e.message).toContain("'a' and 'b'");
			expect(e.message).toMatch(/same side|connecting wall/);
		}
		expect(kernel.liveCount()).toBe(0);
	});
	test('reject never fires on bonded continuations or on the goldens', () => {
		expect(() => run(pair('left', 'right', 0.15, 0.25, 0.3), { staggered: 'reject' })).not.toThrow();
		for (const make of [g1, g3, g4, g5, g6, g7, g8]) {
			const walls = make().elements.filter((e) => e.kind === 'wall') as unknown as WallElement[];
			expect(run(walls, { staggered: 'reject' }).network.staggered).toEqual([]);
		}
	});
	test('the report does not depend on input order or on which wall is listed first', () => {
		const forward = run(pair('right', 'right', 0.15, 0.25, 1.1, 'ab')).network.staggered;
		const backward = run(pair('right', 'right', 0.15, 0.25, 1.1, 'ba')).network.staggered;
		expect(backward).toEqual(forward);
	});
	test('several staggered nodes are listed in node order; a bonded neighbour is not listed', () => {
		const chain: WallElement[] = [
			{ elementId: 'a', path: [[0, 0], [2, 0]], thickness: 0.15, height: 2.7, baseElevation: 0, side: 'left' },
			{ elementId: 'b', path: [[4, 0], [2, 0]], thickness: 0.15, height: 2.7, baseElevation: 0, side: 'left' }, // runs west: its left is south
			{ elementId: 'c', path: [[4, 0], [6, 0]], thickness: 0.15, height: 2.7, baseElevation: 0, side: 'left' } // runs east: its left is north
		];
		const { network } = run(chain);
		expect(network.staggered.map((s) => [s.at, s.elements])).toEqual([
			[[2, 0], ['a', 'b']],
			[[4, 0], ['b', 'c']]
		]);
		// flip c to the south: now b and c share their lateral range, so (4,0) is bonded and only (2,0) remains
		const bonded = run(chain.map((w) => (w.elementId === 'c' ? { ...w, side: 'right' as const } : w))).network;
		expect(bonded.staggered.map((s) => s.at)).toEqual([[2, 0]]);
	});
	test('walls at different heights that never share height are neither bonded nor reported', () => {
		const stacked: WallElement[] = [
			{ elementId: 'a', path: [[0, 0], [3, 0]], thickness: 0.15, height: 2.7, baseElevation: 0, side: 'left' },
			{ elementId: 'b', path: [[0, 0], [-2, 0]], thickness: 0.15, height: 2.7, baseElevation: 3, side: 'left' }
		];
		expect(run(stacked).network.staggered).toEqual([]);
	});
});

describe('evaluateModule surfaces the diagnostic and honours the policy', () => {
	const module = () => moduleOf([wall('a', [[0, 0], [3, 0]], { side: 'right' }), wall('b', [[0, 0], [-2, 0]], { side: 'right' })]);
	test('report: write allowed, diagnostic listed; goldens have none', () => {
		const e = evaluateModule(module(), kernel, { cache: false });
		expect(e.diagnostics).toEqual([{ code: 'WALL_STAGGERED_CONTINUATION', at: [0, 0], elements: ['a', 'b'], overlap: 0 }]);
		for (const make of [g1, g3, g4, g5, g8]) expect(evaluateModule(make(), kernel, { cache: false }).diagnostics).toEqual([]);
	});
	test('reject: error carries the module id; the policy is part of the cache key', () => {
		const first = evaluateModule(module(), kernel); // cached under "report"
		expect(first.diagnostics).toHaveLength(1);
		try {
			evaluateModule(module(), kernel, { staggered: 'reject' });
			throw new Error('expected failure');
		} catch (error) {
			expect((error as ArchError).detail).toMatchObject({ moduleId: 'test/ground', reason: 'WALL_STAGGERED_CONTINUATION' });
		}
		expect(evaluateModule(module(), kernel)).toBe(first);
		expect(kernel.liveCount()).toBe(0);
	});
});
