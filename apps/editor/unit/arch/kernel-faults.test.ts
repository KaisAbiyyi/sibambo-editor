/**
 * Kernel lifecycle under failure: concurrent init, failed init, and a fault injected at EVERY wrapped WASM call of each
 * kernel operation. After every failure no Manifold/CrossSection may stay alive (true count from the injector).
 */
import { describe, expect, test } from 'bun:test';
import { centerlineEnclosure } from '../../src/lib/arch/connectivity';
import { buildSlab, openingInserts, placeOpenings, type SlabElement, type SpaceElement } from '../../src/lib/arch/elements';
import { evaluateModule } from '../../src/lib/arch/evaluate';
import { Kernel, KernelError, type Ring } from '../../src/lib/arch/kernel';
import { buildWallNetwork, type WallElement } from '../../src/lib/arch/walls';
import { faultyLoader, InjectedFault, newFaultState, type FaultState } from './fixtures/fault';
import { g4, g8, g9, moduleOf, wall } from './fixtures/modules';

const sq = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

async function faulty(options: { sliverVolume?: number } = {}) {
	const state = newFaultState();
	const kernel = new Kernel({ load: faultyLoader(state), ...options });
	await kernel.init();
	return { state, kernel };
}

describe('Kernel.init', () => {
	test('concurrent callers share ONE load and one outcome', async () => {
		let loads = 0;
		const state = newFaultState();
		const inner = faultyLoader(state);
		const kernel = new Kernel({
			load: async () => {
				loads++;
				await new Promise((resolve) => setTimeout(resolve, 15)); // widen the race window
				return inner();
			}
		});
		const calls = Array.from({ length: 12 }, () => kernel.init());
		expect(new Set(calls).size).toBe(1); // literally the same promise
		await Promise.all(calls);
		await kernel.init();
		expect(loads).toBe(1);
		const solid = kernel.prism(sq(0, 0, 1, 1), 0, 1, 0);
		kernel.release(solid);
		expect(state.live.size).toBe(0);
	});

	test('a failing load rejects every concurrent caller, leaves the kernel unusable, and a later init retries', async () => {
		let attempts = 0;
		const state = newFaultState();
		const kernel = new Kernel({
			load: async () => {
				attempts++;
				if (attempts === 1) throw new Error('wasm fetch failed');
				return faultyLoader(state)();
			}
		});
		const results = await Promise.allSettled(Array.from({ length: 6 }, () => kernel.init()));
		expect(results.every((r) => r.status === 'rejected')).toBe(true);
		for (const r of results) {
			const error = (r as PromiseRejectedResult).reason;
			expect(error).toBeInstanceOf(KernelError);
			expect(error.detail.reason).toBe('KERNEL_INIT_FAILED');
			expect(error.message).toContain('wasm fetch failed');
		}
		expect(attempts).toBe(1); // six callers, one attempt
		expect(() => kernel.prism(sq(0, 0, 1, 1), 0, 1, 0)).toThrow(/not.*initialised|init\(\)/i);
		await kernel.init(); // retry
		expect(attempts).toBe(2);
		kernel.release(kernel.prism(sq(0, 0, 1, 1), 0, 1, 0));
		expect(state.live.size).toBe(0);
	});

	test('a failing setup() is not published as initialised, and the retry works', async () => {
		let failSetup = true;
		const state = newFaultState();
		const kernel = new Kernel({
			load: faultyLoader(state, {
				beforeSetup: () => {
					if (failSetup) throw new Error('setup exploded');
				}
			})
		});
		await expect(kernel.init()).rejects.toThrow(/setup exploded/);
		expect(() => kernel.prism(sq(0, 0, 1, 1), 0, 1, 0)).toThrow(KernelError);
		failSetup = false;
		await kernel.init();
		kernel.release(kernel.prism(sq(0, 0, 1, 1), 0, 1, 0));
		expect(state.live.size).toBe(0);
	});
});

/**
 * Runs `op` once with no fault (to count wrapped calls), then once per call index with a fault at exactly that call.
 * Every faulted run must throw, and no handle created by the failed run may still be alive. `release` frees the
 * result of a successful run. `prepare` builds inputs (without faults) that stay alive across the sweep.
 */
async function sweep<T>(kernel: Kernel, state: FaultState, op: () => T, release: (result: T) => void = () => {}): Promise<number> {
	const base = state.live.size;
	const kernelBase = kernel.liveCount();
	state.failAt = null;
	state.calls = 0;
	release(op());
	kernel.resetTags();
	expect(state.live.size).toBe(base);
	const total = state.calls;
	expect(total).toBeGreaterThan(0);
	for (let n = 1; n <= total; n++) {
		state.failAt = n;
		state.calls = 0;
		let error: unknown;
		try {
			release(op());
		} catch (caught) {
			error = caught;
		}
		state.failAt = null;
		kernel.resetTags();
		expect({ n, injected: error instanceof InjectedFault }).toEqual({ n, injected: true });
		expect({ n, leaked: state.live.size - base, kernelLive: kernel.liveCount() - kernelBase }).toEqual({ n, leaked: 0, kernelLive: 0 });
	}
	return total;
}

describe('fault injection: a failure at every wrapped call leaks nothing', () => {
	test('prism, prismWithHoles, boxLocal', async () => {
		const { kernel, state } = await faulty();
		await sweep(kernel, state, () => kernel.prism(sq(0, 0, 2, 1), 0, 1, 3), (s) => kernel.release(s));
		await sweep(kernel, state, () => kernel.prismWithHoles(sq(0, 0, 4, 3), [sq(1, 1, 2, 2)], 0, 1, 3), (s) => kernel.release(s));
		await sweep(kernel, state, () => kernel.boxLocal([0, 0], [1, 0], [0, 1], 0, 1, 0, 1, 0, 1, 3), (s) => kernel.release(s));
	});

	test('union, difference, and the sliver-cleanup (compose) path', async () => {
		const { kernel, state } = await faulty();
		const a = kernel.prism(sq(0, 0, 1, 1), 0, 1, 1);
		const b = kernel.prism(sq(0.5, 0, 2, 1), 0, 1, 2);
		const tiny = kernel.prism(sq(10, 10, 10.001, 10.001), 0, 1e-4, 3); // 1e-10 m³, disjoint ⇒ a sliver component
		const cutter = kernel.prism(sq(0.2, -1, 0.4, 2), -1, 2, 4);
		await sweep(kernel, state, () => kernel.union([a, b]), (s) => kernel.release(s));
		await sweep(kernel, state, () => kernel.difference(a, [cutter]), (s) => kernel.release(s));
		await sweep(kernel, state, () => kernel.difference(a, []), (s) => kernel.release(s));
		// the cleanup actually runs here: the 1e-10 m³ shell is dropped and a composed solid is returned
		const cleaned = kernel.union([a, tiny]);
		expect(kernel.stats(cleaned).components).toBe(1);
		expect(kernel.stats(cleaned).volume).toBeCloseTo(1, 9);
		kernel.release(cleaned);
		await sweep(kernel, state, () => kernel.union([a, tiny]), (s) => kernel.release(s));
		kernel.release(a, b, tiny, cutter);
		expect(state.live.size).toBe(0);
	});

	test('exportMesh, stats, sliceAt and the 2D helpers', async () => {
		const { kernel, state } = await faulty();
		const solid = kernel.prismWithHoles(sq(0, 0, 4, 3), [sq(1, 1, 2, 2)], 0, 2, 1);
		await sweep(kernel, state, () => kernel.exportMesh(solid));
		await sweep(kernel, state, () => kernel.stats(solid));
		await sweep(kernel, state, () => kernel.sliceAt(solid, 1));
		await sweep(kernel, state, () => kernel.union2d([sq(0, 0, 2, 1), sq(1, 0, 3, 1)]));
		await sweep(kernel, state, () => kernel.unionArea2d([sq(0, 0, 2, 1)]));
		await sweep(kernel, state, () => kernel.areaWithHoles2d(sq(0, 0, 4, 3), [sq(1, 1, 2, 2)]));
		const frame = kernel.union2d([sq(0, 0, 4, 0.2), sq(3.8, 0, 4, 3), sq(0, 2.8, 4, 3), sq(0, 0, 0.2, 3)]);
		await sweep(kernel, state, () => kernel.regionsOutside(frame, { minX: -1, minY: -1, maxX: 5, maxY: 4 }));
		kernel.release(solid);
		expect(state.live.size).toBe(0);
	});

	test('buildWallNetwork (T junction), buildSlab and openingInserts', async () => {
		const { kernel, state } = await faulty();
		const walls = g4().elements.filter((e) => e.kind === 'wall') as unknown as WallElement[];
		const total = await sweep(kernel, state, () => buildWallNetwork(kernel, walls), (network) => kernel.release(network.solid));
		expect(total).toBeGreaterThan(30);
		const slab = { elementId: 's', outline: sq(0, 0, 4, 3), holes: [sq(1, 1, 2, 2)], thickness: 0.2, topElevation: 0 } as SlabElement;
		await sweep(kernel, state, () => buildSlab(kernel, slab, 1), (s) => kernel.release(s));
		// openingInserts needs a placement: take it from a real network
		const module = g8();
		const wallsG8 = module.elements.filter((e) => e.kind === 'wall') as unknown as WallElement[];
		const network = buildWallNetwork(kernel, wallsG8);
		const placements = placeOpenings(network, new Map(wallsG8.map((w) => [w.elementId, w])), module.elements.filter((e) => e.kind === 'opening') as any);
		for (const placement of placements)
			await sweep(kernel, state, () => openingInserts(kernel, placement, (kind) => kind.length), (parts) => kernel.release(...parts.map((p) => p.solid)));
		kernel.release(network.solid);
		expect(state.live.size).toBe(0);
	});

	test('centerlineEnclosure and the oriented 2D difference helpers', async () => {
		const { kernel, state } = await faulty();
		const walls = g9().elements.filter((e) => e.kind === 'wall') as unknown as WallElement[];
		const spaces = g9().elements.filter((e) => e.kind === 'space') as unknown as SpaceElement[];
		const network = buildWallNetwork(kernel, walls);
		await sweep(kernel, state, () => centerlineEnclosure(kernel, network.segments, spaces));
		await sweep(kernel, state, () => kernel.differenceRings2d(network.footprintRings, [sq(0, 0, 1, 1)]));
		kernel.release(network.solid);
		expect(state.live.size).toBe(0);
	});

	test('evaluateModule of the door+window house: a fault at each of its wrapped calls leaves nothing alive', async () => {
		const { kernel, state } = await faulty();
		const total = await sweep(kernel, state, () => evaluateModule(g8(), kernel, { cache: false }));
		expect(total).toBeGreaterThan(100);
	});

	test('a failing evaluation is not cached and does not poison the next one', async () => {
		const { kernel, state } = await faulty();
		const module = g8();
		state.failAt = 20;
		state.calls = 0;
		expect(() => evaluateModule(module, kernel)).toThrow(InjectedFault);
		state.failAt = null;
		const good = evaluateModule(module, kernel);
		expect(good.parts.length).toBe(5);
		expect(evaluateModule(module, kernel)).toBe(good);
		expect(kernel.liveCount()).toBe(0);
		const plain = evaluateModule(moduleOf([wall('w', [[0, 0], [4, 0]])]), kernel, { cache: false });
		expect(plain.parts).toHaveLength(1);
	});
});
