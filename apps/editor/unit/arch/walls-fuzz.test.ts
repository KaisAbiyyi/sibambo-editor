/**
 * Seeded property tests for the wall solver: random junction stars (mixed thickness, sides, angles) must always yield
 * a manifold solid without zero-volume shells. When every body contains the node (all centre walls) it is ONE
 * component; with side left/right the bodies can legitimately meet only at the node (two components touching along
 * an edge line). Independent lower bounds on the footprint:
 *  - every body, cut off at the miter limit radius, is fully inside the footprint (any side);
 *  - for centre walls the complete butt-ended bodies are inside (a miter only adds the outer notch). This does NOT
 *    hold for side left/right: C7.3 ends a wall on the neighbour's body line, which may trim its butt corner.
 * The PRNG is fixed, so a failure names a reproducible case.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createKernel, type Kernel, type Vec2 } from '../../src/lib/arch/kernel';
import { buildWallNetwork, type WallElement } from '../../src/lib/arch/walls';

let kernel: Kernel;
beforeAll(async () => {
	kernel = createKernel();
	await kernel.init();
});

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const buttRectangle = (a: Vec2, b: Vec2, t: number, side: string, from = 0): Vec2[] => {
	const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
	const d: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], n: Vec2 = [-d[1], d[0]];
	const [yL, yR] = side === 'left' ? [t, 0] : side === 'right' ? [0, -t] : [t / 2, -t / 2];
	const at = (x: number, y: number): Vec2 => [a[0] + d[0] * x + n[0] * y, a[1] + d[1] * x + n[1] * y];
	return [at(from, yR), at(len, yR), at(len, yL), at(from, yL)];
};

describe('random junction stars', () => {
	for (const mode of ['any side', 'centre only'] as const)
	test(`300 stars of 2–5 walls (${mode}): manifold, no slivers, footprint ⊇ independent bound`, () => {
		const random = rng(mode === 'any side' ? 20261115 : 20261116);
		for (let c = 0; c < 300; c++) {
			const count = 2 + Math.floor(random() * 4);
			const sides = mode === 'centre only' ? ['center', 'center', 'center'] : ['center', 'left', 'right'];
			// angles at least 12° apart, random start
			const base = random() * 2 * Math.PI;
			const slots = Array.from({ length: 30 }, (_, i) => base + (i * 2 * Math.PI) / 30);
			const chosen: number[] = [];
			while (chosen.length < count) {
				const index = Math.floor(random() * slots.length);
				// no exactly opposite pair here: walls on opposite sides of a straight continuation touch only along an
				// edge line (two components by design); those are covered by the dedicated continuation test below
				if (chosen.some((_, k) => Math.abs(k - index) === 0) || chosen.some((slot) => Math.abs(slot - slots[index]!) < 1e-9)) continue;
				if (chosen.some((slot) => Math.abs(Math.abs(slot - slots[index]!) - Math.PI) < 1e-9)) continue;
				chosen.push(slots[index]!);
			}
			const walls: WallElement[] = chosen.map((angle, i) => {
				const length = 2 + random() * 2;
				const thickness = [0.1, 0.15, 0.2, 0.25, 0.4][Math.floor(random() * 5)]!;
				return {
					elementId: `w${i}`, path: [[0, 0], [length * Math.cos(angle), length * Math.sin(angle)]], thickness, height: 2.7,
					baseElevation: 0, side: sides[Math.floor(random() * 3)] as any
				};
			});
			const label = JSON.stringify(walls.map((w) => [w.thickness, w.side, w.path[1]!.map((v) => +v.toFixed(3))]));
			let network;
			try {
				network = buildWallNetwork(kernel, walls);
			} catch (error) {
				// a miter on a very short thick segment may legitimately collapse; nothing else may throw
				expect({ case: c, label, reason: (error as any).detail?.reason }).toEqual({ case: c, label, reason: 'WALL_SEGMENT_TOO_SHORT' });
				continue;
			}
			const stats = kernel.stats(network.solid);
			expect({ case: c, label, status: stats.status, positive: stats.components >= 1 }).toEqual({ case: c, label, status: 'NoError', positive: true });
			// every body contains the node only for centre walls ⇒ then the star is one connected solid
			if (mode === 'centre only') expect({ case: c, label, components: stats.components }).toEqual({ case: c, label, components: 1 });
			// independent lower bound (the miter limit radius is 4·max thickness around the node)
			const reach = mode === 'centre only' ? 0 : 4 * Math.max(...walls.map((w) => w.thickness)) + 0.5;
			const bound = kernel.unionArea2d(walls.map((w) => buttRectangle(w.path[0] as Vec2, w.path[1] as Vec2, w.thickness, w.side ?? 'center', reach)));
			// mesh vertices are rounded to 1e-6 m: allow perimeter·0.5e-6·height of rounding on the volume
			expect({ case: c, label, ok: stats.volume + 2e-4 >= bound * 2.7 }).toEqual({ case: c, label, ok: true });
			kernel.release(network.solid);
			kernel.resetTags();
		}
		expect(kernel.liveCount()).toBe(0);
	});
});

describe('performance and scale', () => {
	test('10×10 crossing grid (100 X nodes, 200 segments) solves well under the 120 s write budget', () => {
		const walls: WallElement[] = [];
		for (let i = 0; i < 10; i++) {
			walls.push({ elementId: `h${i}`, path: [[0, i * 3], [27, i * 3]], thickness: 0.15, height: 2.7, baseElevation: 0 });
			walls.push({ elementId: `v${i}`, path: [[i * 3, 0], [i * 3, 27]], thickness: 0.15, height: 2.7, baseElevation: 0 });
		}
		const t0 = performance.now();
		const network = buildWallNetwork(kernel, walls);
		const elapsed = performance.now() - t0;
		expect(network.segments).toHaveLength(180); // 20 walls, each cut at its 9 interior crossings
		const stats = kernel.stats(network.solid);
		expect(stats).toMatchObject({ status: 'NoError', components: 1 });
		expect(network.nodes.filter((n) => n.degree === 4)).toHaveLength(64); // 8×8 interior crossings; the 36 border nodes are L/T/free
		kernel.release(network.solid);
		kernel.resetTags();
		expect(elapsed).toBeLessThan(10_000);
		console.log(`[wall grid] 20 walls → ${network.segments.length} segments, ${network.nodes.length} nodes in ${elapsed.toFixed(0)} ms`);
	});
});

describe('straight continuation of two walls (antiparallel, same node)', () => {
	const sides = ['center', 'left', 'right'] as const;
	const lateralRange = (side: string, t: number): [number, number] => (side === 'left' ? [0, t] : side === 'right' ? [-t, 0] : [-t / 2, t / 2]);
	for (const sa of sides)
		for (const sb of sides)
			for (const [ta, tb] of [[0.15, 0.15], [0.15, 0.25], [0.4, 0.1]] as const)
				test(`A ${sa} t${ta} + B ${sb} t${tb}: lateral overlap ⇒ one bonded component, none ⇒ two (edge contact only)`, () => {
					for (const tilt of [0, 0.3, 1.1, 2.9]) {
						const c = Math.cos(tilt), s = Math.sin(tilt);
						const walls: WallElement[] = [
							{ elementId: 'a', path: [[0, 0], [3 * c, 3 * s]], thickness: ta, height: 2.7, baseElevation: 0, side: sa },
							{ elementId: 'b', path: [[0, 0], [-2 * c, -2 * s]], thickness: tb, height: 2.7, baseElevation: 0, side: sb }
						];
						const network = buildWallNetwork(kernel, walls);
						const stats = kernel.stats(network.solid);
						// B's lateral range in A's frame is mirrored
						const [a0, a1] = lateralRange(sa, ta), [b0, b1] = lateralRange(sb, tb);
						const overlap = Math.min(a1, -b0) - Math.max(a0, -b1);
						expect({ tilt, status: stats.status, components: stats.components }).toEqual({ tilt, status: 'NoError', components: overlap > 1e-9 ? 1 : 2 });
						expect(stats.volume).toBeCloseTo((3 * ta + 2 * tb) * 2.7, 3);
						kernel.release(network.solid);
						kernel.resetTags();
					}
				});
});
