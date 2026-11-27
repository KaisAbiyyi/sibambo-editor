/**
 * The C7.4–5 deviation, proven rather than asserted.
 *
 * `construction:'plan-literal'` builds the solid exactly as C7.4–5 are written (corner quads + node fan). The default
 * `'hardened'` construction also unions each segment's butt-ended body and a bridge strip per straight continuation.
 * These tests show (1) the plan-literal solid loses wall material at acute/mixed-thickness junctions, (2) the hardened
 * solid equals it everywhere the plan is sound (every golden, every orthogonal junction), (3) everything it adds lies
 * inside the authored bodies and it never removes plan material, (4) the zero-volume-shell cleanup is necessary, and
 * (5) the structural PRECONDITIONS of the later topology/bake stage hold. (5) is a probe, NOT a CP5 result.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { evaluateModule } from '../../src/lib/arch/evaluate';
import { createKernel, Kernel, signedArea, type Ring } from '../../src/lib/arch/kernel';
import { buildWallNetwork, type WallElement } from '../../src/lib/arch/walls';
import { topologyProbe } from './fixtures/topology-probe';
import { g1, g2, g3, g4, g5, g6, g7, g8, g9 } from './fixtures/modules';

let kernel: Kernel;
beforeAll(async () => {
	kernel = createKernel();
	await kernel.init();
});

type Wall = WallElement;
const wallsOf = (m: { elements: any[] }) => m.elements.filter((e) => e.kind === 'wall') as Wall[];
const star = (spec: [number, string, number, number][]): Wall[] =>
	spec.map(([t, side, deg, len], i) => ({
		elementId: `w${i}`, thickness: t, side: side as any, height: 2.7, baseElevation: 0,
		path: [[0, 0], [len * Math.cos((deg * Math.PI) / 180), len * Math.sin((deg * Math.PI) / 180)]]
	}));
const butt = (w: Wall): Ring => {
	const a = w.path[0]!, b = w.path[1]!;
	const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
	const d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], n = [-d[1], d[0]];
	const [yL, yR] = w.side === 'left' ? [w.thickness, 0] : w.side === 'right' ? [0, -w.thickness] : [w.thickness / 2, -w.thickness / 2];
	const at = (x: number, y: number): [number, number] => [a[0] + d[0] * x + n[0] * y, a[1] + d[1] * x + n[1] * y];
	return [at(0, yR), at(len, yR), at(len, yL), at(0, yL)];
};
function both(walls: Wall[]) {
	const plan = buildWallNetwork(kernel, walls, { construction: 'plan-literal' });
	const hard = buildWallNetwork(kernel, walls);
	const out = {
		plan: plan.footprintRings, hard: hard.footprintRings,
		planVolume: kernel.stats(plan.solid).volume, hardVolume: kernel.stats(hard.solid).volume,
		bodies: walls.map(butt)
	};
	kernel.release(plan.solid, hard.solid);
	kernel.resetTags();
	return out;
}
const area = (r: readonly Ring[]) => r.reduce((s, x) => s + signedArea(x), 0);
const TOL = 5e-5; // footprint rings are rounded to 1e-6 m: allow perimeter × 0.5e-6

describe('1 · the hardened solid equals the plan wherever the plan is sound', () => {
	for (const [name, make] of [['G1', g1], ['G2', g2], ['G3', g3], ['G4', g4], ['G5', g5], ['G6', g6], ['G7 30°', () => g7(30)], ['G7 14°', () => g7(14)], ['G8', g8], ['G9', g9]] as const)
		test(`${name}: identical footprint and volume`, () => {
			const r = both(wallsOf(make()));
			expect(kernel.differenceArea2d(r.hard, r.plan)).toBeLessThan(1e-6);
			expect(kernel.differenceArea2d(r.plan, r.hard)).toBeLessThan(1e-6);
			expect(Math.abs(r.hardVolume - r.planVolume)).toBeLessThan(1e-6);
		});
	test('orthogonal junctions of any thickness mix, and equal-thickness centre junctions of any angle, are unchanged', () => {
		for (const [ta, tb] of [[0.1, 0.4], [0.4, 0.1], [0.25, 0.25]] as const)
			for (const sa of ['center', 'left', 'right'])
				for (const sb of ['center', 'left', 'right']) {
					const r = both(star([[ta, sa, 0, 3], [tb, sb, 90, 3]]));
					expect({ ta, tb, sa, sb, added: kernel.differenceArea2d(r.hard, r.plan) < 1e-6 }).toEqual({ ta, tb, sa, sb, added: true });
				}
		for (const deg of [5, 15, 30, 60, 120, 150, 175]) {
			const r = both(star([[0.15, 'center', 0, 3], [0.15, 'center', deg, 3]]));
			expect({ deg, added: kernel.differenceArea2d(r.hard, r.plan) < 1e-6 }).toEqual({ deg, added: true });
		}
	});
});

describe('2 · NEGATIVE: the plan-literal solid loses wall material at acute / mixed-thickness junctions', () => {
	const cases: [number, number, number, number][] = [[0.25, 0.1, 12, 0.012], [0.25, 0.1, 30, 0.0039], [0.4, 0.1, 12, 0.052], [0.4, 0.1, 20, 0.029], [0.4, 0.15, 12, 0.035], [0.2, 0.1, 12, 0.0056]];
	for (const [ta, tb, deg, expected] of cases)
		test(`two centre walls, t ${ta}/${tb}, ${deg}°: plan-literal misses ≈${expected} m² of the authored bodies; hardened misses none`, () => {
			const r = both(star([[ta, 'center', 0, 3], [tb, 'center', deg, 3]]));
			const missingPlan = kernel.differenceArea2d(r.bodies, r.plan);
			const missingHard = kernel.differenceArea2d(r.bodies, r.hard);
			expect(missingPlan).toBeGreaterThan(expected * 0.9);
			expect(missingPlan).toBeLessThan(expected * 1.1);
			expect(missingHard).toBeLessThan(TOL);
			expect(r.hardVolume - r.planVolume).toBeCloseTo(missingPlan * 2.7, 4); // the whole difference is that material
		});
	test('the three-wall junction found by the fuzz (12° between a 0.25 m and a 0.10 m wall) has a ≈0.3 m long hole in the plan-literal solid', () => {
		const walls: Wall[] = [
			{ elementId: 'a', path: [[0, 0], [1.815, 2.685]], thickness: 0.25, height: 2.7, baseElevation: 0, side: 'center' },
			{ elementId: 'b', path: [[0, 0], [-1.189, -1.759]], thickness: 0.15, height: 2.7, baseElevation: 0, side: 'center' },
			{ elementId: 'c', path: [[0, 0], [1.44, 3.553]], thickness: 0.1, height: 2.7, baseElevation: 0, side: 'center' }
		];
		const r = both(walls);
		expect(kernel.differenceArea2d(r.bodies, r.plan)).toBeGreaterThan(5e-3);
		expect(kernel.differenceArea2d(r.bodies, r.hard)).toBeLessThan(TOL);
	});
});

describe('3 · everything the hardened solid adds lies inside the authored bodies and nothing of the plan is removed', () => {
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
	for (const [mode, seed] of [['any side', 20261115], ['centre only', 20261116]] as const)
		test(`300 seeded stars (${mode})`, () => {
			const random = rng(seed);
			let withHolesInPlan = 0, withAdded = 0, cases = 0;
			for (let c = 0; c < 300; c++) {
				const count = 2 + Math.floor(random() * 4);
				const base = random() * 2 * Math.PI;
				const slots = Array.from({ length: 30 }, (_, i) => base + (i * 2 * Math.PI) / 30);
				const chosen: number[] = [];
				while (chosen.length < count) {
					const idx = Math.floor(random() * slots.length);
					if (chosen.some((s) => Math.abs(s - slots[idx]!) < 1e-9 || Math.abs(Math.abs(s - slots[idx]!) - Math.PI) < 1e-9)) continue;
					chosen.push(slots[idx]!);
				}
				const sides = mode === 'centre only' ? ['center'] : ['center', 'left', 'right'];
				const walls: Wall[] = chosen.map((a, i) => ({
					elementId: `w${i}`, path: [[0, 0], [(2 + random() * 2) * Math.cos(a), (2 + random() * 2) * Math.sin(a)]],
					thickness: [0.1, 0.15, 0.2, 0.25, 0.4][Math.floor(random() * 5)]!, height: 2.7, baseElevation: 0,
					side: sides[Math.floor(random() * sides.length)] as any
				}));
				let r;
				try {
					r = both(walls);
				} catch {
					continue; // WALL_SEGMENT_TOO_SHORT is a legitimate rejection of both constructions
				}
				cases++;
				const added = kernel.differenceRings2d(r.hard, r.plan);
				const label = JSON.stringify({ c, mode });
				expect({ label, addedOutsideBodies: kernel.differenceArea2d(added, r.bodies) < TOL }).toEqual({ label, addedOutsideBodies: true });
				expect({ label, planRemoved: kernel.differenceArea2d(r.plan, r.hard) < TOL }).toEqual({ label, planRemoved: true });
				expect({ label, hardenedHole: kernel.differenceArea2d(r.bodies, r.hard) < TOL }).toEqual({ label, hardenedHole: true });
				if (area(added) > 1e-6) withAdded++;
				if (kernel.differenceArea2d(r.bodies, r.plan) > 1e-4) withHolesInPlan++;
			}
			// the test must not be vacuous: the plan-literal solid really is deficient in a large share of the random stars
			expect(cases).toBeGreaterThan(250);
			expect(withHolesInPlan).toBeGreaterThan(100);
			expect(withAdded).toBeGreaterThan(100);
		});
	test('side-offset walls meeting obliquely: the added corner is part of the authored body (it can poke past the neighbour face by its own butt corner only)', () => {
		const walls: Wall[] = [
			{ elementId: 'a', path: [[0, 0], [3.263, 0.208]], thickness: 0.2, height: 2.7, baseElevation: 0, side: 'right' },
			{ elementId: 'b', path: [[0, 0], [-0.761, 1.919]], thickness: 0.1, height: 2.7, baseElevation: 0, side: 'right' }
		];
		const r = both(walls);
		const added = kernel.differenceRings2d(r.hard, r.plan);
		expect(area(added)).toBeGreaterThan(1e-5); // a protrusion exists…
		expect(kernel.differenceArea2d(added, r.bodies)).toBeLessThan(TOL); // …and it is authored material
		expect(kernel.differenceArea2d(r.plan, r.hard)).toBeLessThan(TOL);
	});
});

describe('4 · NEGATIVE: without the zero-volume-shell cleanup, ordinary junctions report phantom components', () => {
	function stars() {
		let s = 20261116 >>> 0;
		const random = () => {
			s = (s + 0x6d2b79f5) >>> 0;
			let t = s;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const out: Wall[][] = [];
		for (let c = 0; c < 300; c++) {
			const count = 2 + Math.floor(random() * 4);
			const base = random() * 2 * Math.PI;
			const slots = Array.from({ length: 30 }, (_, i) => base + (i * 2 * Math.PI) / 30);
			const chosen: number[] = [];
			while (chosen.length < count) {
				const idx = Math.floor(random() * slots.length);
				if (chosen.some((v) => Math.abs(v - slots[idx]!) < 1e-9 || Math.abs(Math.abs(v - slots[idx]!) - Math.PI) < 1e-9)) continue;
				chosen.push(slots[idx]!);
			}
			out.push(chosen.map((a, i) => ({
				elementId: `w${i}`, path: [[0, 0], [(2 + random() * 2) * Math.cos(a), (2 + random() * 2) * Math.sin(a)]] as [number, number][],
				thickness: [0.1, 0.15, 0.2, 0.25, 0.4][Math.floor(random() * 5)]!, height: 2.7, baseElevation: 0, side: 'center' as const
			})));
		}
		return out;
	}
	test('centre-wall stars are ONE solid; with the cleanup disabled some report extra components of volume < 1e-9 m³', async () => {
		const raw = new Kernel({ sliverVolume: 0 });
		await raw.init();
		let phantom = 0, phantomVolume = 0, cleanedWithPhantom = 0;
		for (const walls of stars()) {
			let a, b;
			try {
				a = buildWallNetwork(raw, walls);
				b = buildWallNetwork(kernel, walls);
			} catch {
				continue;
			}
			const components: any[] = a.solid.decompose();
			const volumes = components.map((c) => Math.abs(c.volume()));
			components.forEach((c) => c.delete());
			if (components.length > 1) {
				phantom++;
				phantomVolume = Math.max(phantomVolume, ...volumes.filter((v) => v < 0.5));
			}
			if (kernel.stats(b.solid).components !== 1) cleanedWithPhantom++;
			raw.release(a.solid);
			kernel.release(b.solid);
			raw.resetTags();
			kernel.resetTags();
		}
		expect(phantom).toBeGreaterThan(0); // the cleanup is needed: if this ever fails, re-evaluate it rather than delete the test
		expect(phantomVolume).toBeLessThan(1e-9); // and what it removes is never real geometry
		expect(cleanedWithPhantom).toBe(0);
	});
});

describe('5 · PROBE: structural preconditions of the later topology/bake stage (NOT CP5 results)', () => {
	const materialOf = (tags: { materialId: string }[]) => (t: number) => tags[t]?.materialId ?? '?';
	for (const [name, make] of [['G1', g1], ['G2', g2], ['G3', g3], ['G4', g4], ['G5', g5], ['G6', g6], ['G7 30°', () => g7(30)], ['G8', g8], ['G9', g9]] as const)
		test(`${name}: every part is a closed, oriented, fully attributed solid with no internal duplicate faces`, () => {
			const e = evaluateModule(make(), kernel, { cache: false });
			for (const part of e.parts) {
				const r = topologyProbe(part.mesh, materialOf(e.tags));
				expect({ part: part.partId, watertight: r.watertight, duplicates: r.duplicateFaces, collapsed: r.collapsed, untagged: r.untagged }).toEqual({
					part: part.partId, watertight: true, duplicates: 0, collapsed: 0, untagged: 0
				});
				expect(r.volume).toBeCloseTo(part.stats.volume, 9);
				expect(r.volume).toBeGreaterThan(0);
			}
		});
	test('literal C9 steps 1–2 on the raw wall meshes: coplanar groups line up with the plan (G1 10, G4 14), no fragment groups on the clean goldens', () => {
		const groups = (make: typeof g1) => {
			const e = evaluateModule(make(), kernel, { cache: false });
			return topologyProbe(e.parts.find((p) => p.partId === 'walls')!.mesh, materialOf(e.tags));
		};
		expect(groups(g1).groups).toBe(10); // equal to the face counts of G1/G4 in the plan's CP5 list — a compatibility signal only
		expect(groups(g4).groups).toBe(14);
		for (const make of [g1, g2, g3, g4, g5, g6, g8, g9]) expect(groups(make).tinyGroups).toBe(0);
		// KNOWN COST of the deviation, recorded not hidden: on the 30° acute corner the unions leave 6 degenerate triangles
		// and one group below 1e-6 m². C9 step 1 drops the degenerates; the fragment needs a decision in WP5.
		const acute = groups(() => g7(30));
		expect(acute.degenerate).toBeLessThanOrEqual(6);
		expect(acute.tinyGroups).toBeLessThanOrEqual(1);
	});
	test('raw size stays inside the A18 bake budgets for a 10×10 crossing grid, at about 3.4× the plan-literal vertex count', () => {
		const walls: Wall[] = [];
		for (let i = 0; i < 10; i++) {
			walls.push({ elementId: `h${i}`, path: [[0, i * 3], [27, i * 3]], thickness: 0.15, height: 2.7, baseElevation: 0 });
			walls.push({ elementId: `v${i}`, path: [[i * 3, 0], [i * 3, 27]], thickness: 0.15, height: 2.7, baseElevation: 0 });
		}
		const size = (construction: 'hardened' | 'plan-literal') => {
			const n = buildWallNetwork(kernel, walls, { construction });
			const mesh = kernel.exportMesh(n.solid);
			kernel.release(n.solid);
			kernel.resetTags();
			return { vertices: mesh.positions.length / 3, triangles: mesh.triangles.length / 3 };
		};
		const hard = size('hardened'), plan = size('plan-literal');
		expect(hard.vertices).toBeLessThanOrEqual(8192); // baked positions ≤ 8192 (A18); baking re-triangulates from loops, so this is a ceiling
		expect(hard.triangles).toBeLessThanOrEqual(20000);
		expect(hard.vertices / plan.vertices).toBeLessThan(4);
	});
});
