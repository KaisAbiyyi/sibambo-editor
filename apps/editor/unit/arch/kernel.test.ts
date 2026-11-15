/** C6 kernel behaviour + T-K1 (.delete() balance). */
import { beforeAll, describe, expect, test } from 'bun:test';
import { KernelError, createKernel, meshVolume, canonicalRing, type Kernel } from '../../src/lib/arch/kernel';
import { evaluateModule } from '../../src/lib/arch/evaluate';
import { g1, g8 } from './fixtures/modules';

let kernel: Kernel;
beforeAll(async () => {
	kernel = createKernel();
	await kernel.init();
});

const sq = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

describe('kernel', () => {
	test('init is idempotent and using an uninitialised kernel fails with KernelError', async () => {
		await kernel.init();
		expect(() => createKernel().prism(sq(0, 0, 1, 1), 0, 1, 0)).toThrow(KernelError);
	});

	test('prism is canonical: ring orientation and start vertex do not change the mesh', () => {
		const a = kernel.prism(sq(0, 0, 2, 1), 0, 3, 1);
		const b = kernel.prism([[2, 1], [2, 0], [0, 0], [0, 1]], 0, 3, 1); // clockwise, different start
		const ma = kernel.exportMesh(a), mb = kernel.exportMesh(b);
		expect(same(ma.positions, mb.positions)).toBe(true);
		expect(same(ma.triangles, mb.triangles)).toBe(true);
		expect(meshVolume(ma)).toBe(6);
		kernel.release(a, b);
		expect(kernel.liveCount()).toBe(0);
	});

	test('union attributes triangles to part tags; exported positions are 1e-6 multiples', () => {
		const a = kernel.prism(sq(0, 0, 1, 1), 0, 1, 7);
		const b = kernel.boxLocal([0.5, 0], [1, 0], [0, 1], 0, 1, 0, 1, 0, 1, 9);
		const u = kernel.union([a, b]);
		const mesh = kernel.exportMesh(u);
		expect(new Set(mesh.triTag)).toEqual(new Set([7, 9]));
		expect(Array.from(mesh.positions).every((v) => Math.abs(v * 1e6 - Math.round(v * 1e6)) < 1e-6)).toBe(true);
		expect(kernel.stats(u)).toMatchObject({ components: 1, genus: 0, status: 'NoError', volume: 1.5 });
		kernel.release(a, b, u);
		kernel.resetTags();
		expect(kernel.liveCount()).toBe(0);
	});

	test('difference keeps cutter tags on the reveal triangles', () => {
		const wall = kernel.prism(sq(0, 0, 4, 1), 0, 2, 1);
		const cutter = kernel.boxLocal([0, 0], [1, 0], [0, 1], 1, 2, -0.1, 1.1, 0, 1, 5);
		const cut = kernel.difference(wall, [cutter]);
		const mesh = kernel.exportMesh(cut);
		expect(new Set(mesh.triTag)).toEqual(new Set([1, 5]));
		expect(meshVolume(mesh)).toBe(8 - 1);
		kernel.release(wall, cutter, cut);
		kernel.resetTags();
	});

	test('prismWithHoles subtracts hole volume; invalid rings are KernelError reasons', () => {
		const slab = kernel.prismWithHoles(sq(0, 0, 4, 3), [sq(1, 1, 2, 2)], 0, 0.2, 1);
		expect(meshVolume(kernel.exportMesh(slab))).toBeCloseTo((12 - 1) * 0.2, 9);
		expect(kernel.stats(slab).genus).toBe(1);
		kernel.release(slab);
		expect(() => canonicalRing([[0, 0], [1, 1], [2, 2]])).toThrow(/zero area/);
		expect(() => canonicalRing([[0, 0], [1, 0]])).toThrow(KernelError);
		expect(() => kernel.prism(sq(0, 0, 1, 1), 1, 1, 0)).toThrow(/z1 > z0/);
		kernel.resetTags();
	});

	test('2D helpers: sliceAt, union2d and regionsOutside', () => {
		const ring = kernel.prismWithHoles(sq(0, 0, 4, 3), [sq(1, 1, 3, 2)], 0, 2, 1);
		const slice = kernel.sliceAt(ring, 1);
		expect(slice).toHaveLength(2);
		const overlap = kernel.union2d([sq(0, 0, 2, 1), sq(1, 0, 3, 1)]);
		expect(overlap).toHaveLength(1); // Clipper keeps collinear vertices; topology (WP5) removes them
		expect(kernel.unionArea2d([sq(0, 0, 2, 1), sq(1, 0, 3, 1)])).toBe(3);
		const box = { minX: -1, minY: -1, maxX: 5, maxY: 4 };
		const solidRoom = kernel.regionsOutside([sq(0, 0, 4, 3)], box);
		expect(solidRoom).toHaveLength(1);
		expect(solidRoom[0]!.touchesBounds).toBe(true);
		// A closed frame (outer CCW + hole CW, as union2d returns it) encloses its hole.
		const frame = kernel.union2d([sq(0, 0, 4, 0.2), sq(3.8, 0, 4, 3), sq(0, 2.8, 4, 3), sq(0, 0, 0.2, 3)]);
		expect(frame).toHaveLength(2);
		const regions = kernel.regionsOutside(frame, box);
		expect(regions.map((r) => [r.touchesBounds, r.area]).sort()).toEqual([[false, 9.36], [true, 6 * 5 - 12]].sort());
		kernel.release(ring);
		kernel.resetTags();
		expect(kernel.liveCount()).toBe(0);
	});
});

describe('T-K1 .delete() balance', () => {
	test('100 evaluations of a house leave no live kernel objects', () => {
		const k = createKernel();
		return k.init().then(() => {
			for (let i = 0; i < 100; i++) {
				evaluateModule(i % 2 ? g1() : g8(), k, { cache: false });
				expect(k.liveCount()).toBe(0);
			}
		});
	});

	test('a failing evaluation releases everything (no leak on error paths)', async () => {
		const k = createKernel();
		await k.init();
		const bad = g8();
		(bad.elements.find((e) => e.elementId === 'win') as any).along = 3.95; // runs past the wall end
		for (let i = 0; i < 20; i++) expect(() => evaluateModule(bad, k, { cache: false })).toThrow();
		expect(k.liveCount()).toBe(0);
	});
});
