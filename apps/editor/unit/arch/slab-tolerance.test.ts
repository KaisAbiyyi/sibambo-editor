/**
 * SIB-MCP-MODELING-001 v2.6 WP8A / amendment A22 — slab area tolerance (F-WP8-1).
 *
 * `buildSlab` compares kernel areas with the shoelace area of the same ring. The kernel quantises input by ≈ 3.5e-9 m,
 * so the two differ by ≈ that times the perimeter; the tolerance is therefore `1e-9 + 2e-8 × perimeter`, not a constant.
 * Valid decimal slabs must be admitted; genuine defects must still be rejected with the same payload.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { ArchError } from '../../src/lib/arch/errors';
import { buildSlab, type SlabElement } from '../../src/lib/arch/elements';
import { createKernel, type Kernel } from '../../src/lib/arch/kernel';
import { newDocument } from './fixtures/agent-harness';
import { moduleOf } from './fixtures/modules';

type P = [number, number];

let kernel: Kernel;
beforeAll(async () => {
	kernel = createKernel();
	await kernel.init();
});

const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const slabOf = (outline: P[], holes: P[][] = []): SlabElement => ({ elementId: 's', outline, holes, thickness: 0.2, topElevation: 0 });
const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

/** The ArchError detail of a rejection, or `null` when the slab was admitted (its solid is released). */
function rejection(slab: SlabElement): { reason?: string; elementId?: string } | null {
	try {
		kernel.release(buildSlab(kernel, slab, 1));
		return null;
	} catch (error) {
		expect(error).toBeInstanceOf(ArchError);
		expect((error as ArchError).code).toBe('INVALID_GEOMETRY');
		return (error as ArchError).detail as { reason?: string; elementId?: string };
	}
}
const expectRejected = (slab: SlabElement) => {
	expect(rejection(slab)).toMatchObject({ reason: 'SLAB_SELF_INTERSECTS', elementId: 's' });
};

describe('WP8A / A22 — slab area tolerance', () => {
	test('T-S1: every rectangle on a 0.1 m grid is admitted', () => {
		const before = kernel.liveCount();
		let iterations = 0;
		const rejected: string[] = [];
		for (let ox = 0; ox < 5; ox++)
			for (let oy = 0; oy < 5; oy++)
				for (let w = 1; w <= 40; w++)
					for (let h = 1; h <= 40; h++) {
						iterations++;
						const x0 = ox / 10, y0 = oy / 10, x1 = (ox + w) / 10, y1 = (oy + h) / 10;
						if (rejection(slabOf(rect(x0, y0, x1, y1)))) rejected.push(`(${x0},${y0})-(${x1},${y1})`);
					}
		console.log(`T-S1: rejected ${rejected.length} of ${iterations}${rejected.length ? ` e.g. ${rejected.slice(0, 3).join(' ')}` : ''}`);
		expect(iterations).toBe(40000);
		expect(rejected.length).toBe(0);
		expect(kernel.liveCount()).toBe(before);
	}, 60000);

	test('T-S2: centimetre rectangles at offsets up to ±9,800 m are admitted', () => {
		const rnd = lcg(20261128);
		const offsets = [-9800, -1000, -100, -10, 0, 10, 100, 1000, 9800];
		let rejected = 0, extent = 0;
		for (let i = 0; i < 3000; i++) {
			const ox = offsets[Math.floor(rnd() * 9)]!, oy = offsets[Math.floor(rnd() * 9)]!;
			const x0 = ox + Math.round(rnd() * 5000) / 100, y0 = oy + Math.round(rnd() * 5000) / 100;
			const w = Math.round(rnd() * 6000) / 100 + 0.01, h = Math.round(rnd() * 6000) / 100 + 0.01;
			const outline = rect(x0, y0, x0 + w, y0 + h);
			for (const [x, y] of outline) extent = Math.max(extent, Math.abs(x), Math.abs(y));
			if (rejection(slabOf(outline))) rejected++;
		}
		expect(extent).toBeLessThanOrEqual(10000); // the fixture never leaves the supported range
		expect(rejected).toBe(0);
	}, 60000);

	test('T-S3: decimal outlines with decimal holes are admitted and the holes are real', () => {
		const rnd = lcg(7);
		for (let i = 0; i < 2000; i++) {
			const w = 4 + Math.round(rnd() * 400) / 10, h = 4 + Math.round(rnd() * 300) / 10;
			const hx = 1 + Math.round(rnd() * 10) / 10, hy = 1 + Math.round(rnd() * 10) / 10;
			const hw = 0.3 + Math.round(rnd() * 10) / 10, hh = 0.3 + Math.round(rnd() * 10) / 10;
			const slab = slabOf(rect(0.1, 0.1, 0.1 + w, 0.1 + h), [rect(hx, hy, hx + hw, hy + hh)]);
			let solid: ReturnType<typeof buildSlab> | undefined;
			try {
				solid = buildSlab(kernel, slab, 1);
			} catch (error) {
				throw new Error(`case ${i} rejected: outline ${w}x${h}, hole (${hx},${hy}) ${hw}x${hh}: ${error instanceof ArchError ? JSON.stringify(error.detail) : String(error)}`);
			}
			try {
				const stats = kernel.stats(solid);
				expect(stats.status).toBe('NoError');
				expect(stats.genus).toBe(1);
				expect(Math.abs(stats.volume - (w * h - hw * hh) * 0.2)).toBeLessThanOrEqual(1e-6);
			} finally {
				kernel.release(solid);
			}
		}
	}, 60000);

	test('T-S4: genuine defects at decimal scale are still rejected', () => {
		const outline = rect(0, 0, 4, 3);
		for (const e of [1e-3, 1e-4, 1e-5, 1e-6]) expectRejected(slabOf(outline, [[[3.5, 1], [4 + e, 1], [4 + e, 2], [3.5, 2]]])); // hole protrudes
		for (const e of [1e-3, 1e-5]) expectRejected(slabOf(outline, [rect(1, 1, 2, 2), rect(2 - e, 1, 3, 2)])); // holes overlap
		expectRejected(slabOf(rect(0.3, 0.3, 4.2, 3.3), [[[3.7, 1], [4.2 + 1e-4, 1], [4.2 + 1e-4, 2], [3.7, 2]]])); // decimal outline
	});

	test('T-S5: the tolerance scales with the ring but does not blanket-open a large one', () => {
		expectRejected(slabOf(rect(0, 0, 100, 100), [[[90, 40], [100.0001, 40], [100.0001, 41], [90, 41]]]));
	});

	test('T-S6: simple-ring and containment rejections are unchanged at decimal coordinates', () => {
		expectRejected(slabOf([[0.3, 0.3], [4.2, 3.3], [4.2, 0.3], [0.3, 3.3]])); // bow-tie
		expectRejected(slabOf(rect(0.3, 0.3, 4.2, 3.3), [rect(5.1, 5.1, 6.2, 6.2)])); // hole outside
		expectRejected(slabOf([[0.3, 0.3], [4.2, 0.3], [4.2, 3.3], [2.1, 0.3], [0.3, 3.3]])); // touching vertex
	});

	test('T-S7: a decimal slab with a hole goes through edit_model, describe_scene, check_model and undo', async () => {
		const harness = await newDocument();
		const before = harness.revision();
		await harness.addModule(
			moduleOf([{ elementId: 's', kind: 'slab', outline: rect(0, 1.1, 4, 3), holes: [[[1.2, 1.7], [1.2, 2.3], [1.9, 2.3], [1.9, 1.7]]], thickness: 0.2, topElevation: 0 } as any])
		);
		expect(harness.revision()).not.toBe(before);
		const scene = await harness.text('describe_scene');
		expect(scene).toContain('test/ground');
		expect(scene).toContain('slabs 1');
		const json = await harness.ok('check_model', { limit: 1000, format: 'json' });
		expect(json.findings.filter((f: any) => f.code === 'MODULE_NOT_EVALUABLE' || f.severity === 'ERROR')).toEqual([]);
		await harness.ok('undo', { steps: 1 });
		const after = await harness.text('describe_scene');
		expect(after).toContain('Arch modules 0:');
		expect(after).not.toContain('test/ground');
	}, 60000);
});
