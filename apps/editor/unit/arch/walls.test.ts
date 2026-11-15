/** C7 wall network: golden G1/G2/G4/G5/G6/G7 plus the orientation/tolerance traps. */
import { beforeAll, describe, expect, test } from 'bun:test';
import { ArchError } from '../../src/lib/arch/errors';
import { createKernel, meshVolume, type Kernel, type MeshExport } from '../../src/lib/arch/kernel';
import { buildWallNetwork, JOIN_TOL, type WallElement } from '../../src/lib/arch/walls';
import { g1, g2, g2Clockwise, g2Rotated, g4, g5, g6, g7, wall } from './fixtures/modules';
import type { ArchModule } from '../../src/lib/arch/schema';

let kernel: Kernel;
beforeAll(async () => {
	kernel = createKernel();
	await kernel.init();
});

const wallsOf = (m: ArchModule) => m.elements.filter((e) => e.kind === 'wall') as unknown as WallElement[];
function run(m: ArchModule | WallElement[]) {
	const network = buildWallNetwork(kernel, Array.isArray(m) ? m : wallsOf(m));
	const mesh = network.solid ? kernel.exportMesh(network.solid) : null;
	const stats = network.solid ? kernel.stats(network.solid) : null;
	kernel.release(network.solid);
	kernel.resetTags();
	return { network, mesh: mesh as MeshExport, stats: stats! };
}
const hasVertex = (mesh: MeshExport, x: number, y: number, z: number, tol = 1e-6) => {
	for (let i = 0; i < mesh.positions.length; i += 3)
		if (Math.abs(mesh.positions[i]! - x) <= tol && Math.abs(mesh.positions[i + 1]! - y) <= tol && Math.abs(mesh.positions[i + 2]! - z) <= tol) return true;
	return false;
};
const types = (network: ReturnType<typeof run>['network']) => {
	const out: Record<string, number> = {};
	for (const node of network.nodes) {
		const seen = new Set<string>();
		for (const list of network.junctions.values())
			for (const j of list) if (j.at[0] === node.point[0] && j.at[1] === node.point[1]) seen.add(j.type);
		for (const t of seen) out[t] = (out[t] ?? 0) + 1;
	}
	return out;
};
const reason = (fn: () => unknown) => {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(ArchError);
		return (error as ArchError).detail.reason;
	}
	throw new Error('expected ArchError');
};

describe('G1 four centre walls', () => {
	let r!: ReturnType<typeof run>;
	beforeAll(() => {
		r = run(g1());
	});
	test('manifold, one component, volume 5.670000, no leaked objects', () => {
		expect(r.stats).toMatchObject({ status: 'NoError', components: 1, genus: 1 });
		expect(r.stats.volume).toBeCloseTo(5.67, 6);
		expect(kernel.liveCount()).toBe(0);
	});
	test('outer corner (−0.075,−0.075,0) is a vertex, there is no notch or doubled inner square', () => {
		expect(hasVertex(r.mesh, -0.075, -0.075, 0)).toBe(true);
		expect(hasVertex(r.mesh, 4.075, 3.075, 2.7)).toBe(true);
		expect(hasVertex(r.mesh, 0.075, 0.075, 0)).toBe(true); // inner corner
		// outer 4.15 × 3.15 minus inner 3.85 × 2.85, times 2.7
		expect(r.stats.volume).toBeCloseTo((4.15 * 3.15 - 3.85 * 2.85) * 2.7, 6);
	});
	test('four L junctions', () => {
		expect(types(r.network)).toEqual({ L: 4 });
		expect(r.network.nodes).toHaveLength(4);
		expect(r.network.segments.map((s) => s.tag)).toEqual([0, 1, 2, 3]);
	});
});

describe('G2 four walls ≡ one closed wall', () => {
	let base!: ReturnType<typeof run>;
	beforeAll(() => {
		base = run(g1());
	});
	for (const [name, mod] of [['closed CCW', g2()], ['closed CW', g2Clockwise()], ['closed, rotated start', g2Rotated()]] as const)
		test(`${name}: identical exported positions and triangles`, () => {
			const other = run(mod);
			expect(Array.from(other.mesh.positions)).toEqual(Array.from(base.mesh.positions));
			expect(Array.from(other.mesh.triangles)).toEqual(Array.from(base.mesh.triangles));
			expect(other.stats.volume).toBe(base.stats.volume);
		});
	test('identical across two independent kernels', async () => {
		const k2 = createKernel();
		await k2.init();
		const n = buildWallNetwork(k2, wallsOf(g2()));
		const m = k2.exportMesh(n.solid!);
		k2.release(n.solid);
		expect(Array.from(m.positions)).toEqual(Array.from(base.mesh.positions));
		expect(Array.from(m.triangles)).toEqual(Array.from(base.mesh.triangles));
	});
});

describe('T and X junctions (G4, G5)', () => {
	test('G4: two T, partition adds exactly its own volume, segments are split at the T nodes', () => {
		const r = run(g4());
		expect(types(r.network)).toEqual({ L: 4, T: 2 });
		expect(r.stats).toMatchObject({ status: 'NoError', components: 1, genus: 2 });
		expect(r.stats.volume).toBeCloseTo(5.67 + 0.15 * (3 - 0.15) * 2.7, 6);
		expect(r.network.segments).toHaveLength(7); // south and north split once each, plus the partition
		const t = r.network.junctions.get('part')!;
		expect(t.map((j) => [j.type, j.at[0], j.at[1], j.with])).toEqual([['T', 2, 0, ['w1']], ['T', 2, 3, ['w3']]]);
	});
	test('G5: one X and four T, four holes in the footprint', () => {
		const r = run(g5());
		expect(types(r.network)).toEqual({ L: 4, T: 4, X: 1 });
		expect(r.stats).toMatchObject({ status: 'NoError', components: 1, genus: 4 });
		const area = 4.15 * 3.15 - 4 * 1.85 * 1.35;
		expect(r.stats.volume).toBeCloseTo(area * 2.7, 6);
		const x = [...r.network.junctions.values()].flat().filter((j) => j.type === 'X');
		expect(x.every((j) => j.at[0] === 2 && j.at[1] === 1.5)).toBe(true);
	});
	test('a T whose stem meets the through wall exactly reproduces the analytic node triangle', () => {
		const r = run([wall('t1', [[-2, 0], [2, 0]]) as any, wall('t2', [[0, 0], [0, 3]]) as any]);
		const node = r.network.nodes.find((n) => n.point[0] === 0 && n.point[1] === 0)!;
		expect(node.degree).toBe(3);
		expect(node.pieces.length).toBeGreaterThan(0); // plan node triangle (c0, c1, foot), as fan pieces around the node
		// footprint = through wall + stem: 4·0.15 + (3 − 0.075)·0.15
		expect(r.stats.volume).toBeCloseTo((4 * 0.15 + (3 - 0.075) * 0.15) * 2.7, 6);
		expect(hasVertex(r.mesh, 0.075, 0.075, 0)).toBe(true);
		expect(hasVertex(r.mesh, -0.075, 0.075, 0)).toBe(true);
	});
});

describe('G6 mixed thickness L', () => {
	let r!: ReturnType<typeof run>;
	beforeAll(() => {
		r = run(g6());
	});
	test('outer and inner corners are the analytic body-line intersections', () => {
		expect(r.stats).toMatchObject({ status: 'NoError', components: 1, genus: 0 });
		expect(hasVertex(r.mesh, 4.125, -0.075, 0)).toBe(true); // a right line ∩ b right line
		expect(hasVertex(r.mesh, 3.875, 0.075, 0)).toBe(true); // a left line ∩ b left line
		expect(r.stats.volume).toBeCloseTo(((3.875 + 4.125) / 2 * 0.15 + (2.925 + 3.075) / 2 * 0.25) * 2.7, 6);
	});
	test('mixed thickness through a straight continuation leaves a clean step, no gap or overlap', () => {
		const s = run([wall('a', [[0, 0], [2, 0]]) as any, wall('b', [[2, 0], [4, 0]], { thickness: 0.25 }) as any]);
		expect(s.stats).toMatchObject({ status: 'NoError', components: 1, genus: 0 });
		expect(s.stats.volume).toBeCloseTo((2 * 0.15 + 2 * 0.25) * 2.7, 6);
		expect(s.network.junctions.size).toBe(2); // two free ends; the continuation itself is not a junction
		expect([...s.network.junctions.values()].flat().every((j) => j.type === 'free-end')).toBe(true);
	});
});

describe('G7 acute corner', () => {
	test('30°: miter — tip vertices at (t/2)/sin(θ/2) along the bisectors, volume = two mitred quads', () => {
		const r = run(g7(30));
		expect(r.stats).toMatchObject({ status: 'NoError', components: 1, genus: 0 });
		const d = 0.075 / Math.sin(Math.PI / 12);
		expect(hasVertex(r.mesh, d * Math.cos(Math.PI / 12), d * Math.sin(Math.PI / 12), 0)).toBe(true); // inner (acute) tip
		expect(hasVertex(r.mesh, -d * Math.cos(Math.PI / 12), -d * Math.sin(Math.PI / 12), 0)).toBe(true); // outer tip
		expect(r.stats.volume).toBeCloseTo(1.2 * 2.7, 4);
		expect(r.network.nodes.find((n) => n.degree === 2)!.pieces).toHaveLength(0);
	});
	test('10°: beyond the miter limit (4·t) → bevel: nothing spikes behind the node', () => {
		const r = run(g7(10));
		expect(r.stats).toMatchObject({ status: 'NoError', components: 1, genus: 0 });
		let minX = Infinity;
		for (let i = 0; i < r.mesh.positions.length; i += 3) minX = Math.min(minX, r.mesh.positions[i]!);
		expect(minX).toBeGreaterThanOrEqual(-0.08); // a miter would reach x = −0.8605·cos(5°)
		expect(r.network.nodes.find((n) => n.degree === 2)!.pieces.length).toBeGreaterThan(0);
		const d = 0.075 / Math.sin(Math.PI / 36);
		expect(d).toBeGreaterThan(4 * 0.15);
	});
	test('a very acute corner still produces a manifold single component for the whole 5°…175° sweep', () => {
		for (const deg of [5, 12, 14, 15, 20, 45, 60, 90, 120, 150, 170, 175]) {
			const r = run(g7(deg));
			expect({ deg, status: r.stats.status, components: r.stats.components }).toEqual({ deg, status: 'NoError', components: 1 });
		}
	});
});

describe('wall network validation', () => {
	test('same-direction collinear consecutive segments merge; no node appears at the middle point', () => {
		const r = run([wall('w', [[0, 0], [2, 0], [4, 0]]) as any]);
		expect(r.network.segments).toHaveLength(1);
		expect(r.network.nodes).toHaveLength(2);
		expect(r.stats.volume).toBeCloseTo(4 * 0.15 * 2.7, 6);
	});
	test('rejections carry the contract reasons and a location', () => {
		expect(reason(() => run([wall('w', [[0, 0], [0.0005, 0], [3, 0]]) as any]))).toBe('WALL_DUPLICATE_POINT');
		expect(reason(() => run([wall('w', [[0, 0], [3, 0], [1, 0]]) as any]))).toBe('WALL_PATH_REVERSES');
		expect(reason(() => run([wall('a', [[0, 0], [4, 0]]) as any, wall('b', [[1, 0], [2, 0]]) as any]))).toBe('WALL_COLLINEAR_OVERLAP');
		expect(reason(() => run([wall('a', [[0, 0], [4, 0]]) as any, wall('b', [[1, 0.0004], [3, 0.0004]]) as any]))).toBe('WALL_COLLINEAR_OVERLAP');
		expect(reason(() => run([wall('w', [[0, 0], [0.05, 0], [0.05, 3]]) as any]))).toBe('WALL_SEGMENT_TOO_SHORT');
		try {
			run([wall('a', [[0, 0], [4, 0]]) as any, wall('b', [[1, 0], [2, 0]]) as any]);
		} catch (error) {
			expect((error as ArchError).detail.at).toEqual([1.5, 0]);
			expect((error as ArchError).code).toBe('INVALID_GEOMETRY');
		}
		expect(kernel.liveCount()).toBe(0);
	});
	test('near-collinear overlap (skewed by less than JOIN_TOL over the overlap) is an overlap, from either wall', () => {
		const long = wall('a', [[0, 0], [40, 0]]) as any;
		// short wall skewed by 0.4 mm over its length: not exactly parallel, but both ends within JOIN_TOL of the line
		expect(reason(() => run([long, wall('b', [[10, 0], [12, 0.0004]]) as any]))).toBe('WALL_COLLINEAR_OVERLAP');
		expect(reason(() => run([wall('a', [[10, 0], [12, 0.0004]]) as any, wall('b', [[0, 0], [40, 0]]) as any]))).toBe('WALL_COLLINEAR_OVERLAP');
		// the same skew with 2 m separation along the line is not an overlap (touching ends only)
		expect(() => run([wall('a', [[0, 0], [10, 0]]) as any, wall('b', [[10, 0.0004], [12, 0.0008]]) as any])).not.toThrow();
	});
	test('collinear touching (end to end) is not an overlap', () => {
		expect(() => run([wall('a', [[0, 0], [2, 0]]) as any, wall('b', [[2, 0], [4, 0]]) as any])).not.toThrow();
	});
	test('JOIN_TOL: endpoints 0.5 mm apart join; an endpoint 0.5 mm from a wall interior splits it', () => {
		const joined = run([wall('a', [[0, 0], [4, 0]]) as any, wall('b', [[4.0005, 0], [4.0005, 3]]) as any]);
		expect(joined.network.nodes.filter((n) => n.degree === 2)).toHaveLength(1);
		expect(joined.stats.components).toBe(1);
		const tee = run([wall('a', [[0, 0], [4, 0]]) as any, wall('b', [[2, 0.0004], [2, 3]]) as any]);
		expect(types(tee.network)).toEqual({ T: 1, 'free-end': 3 });
		expect(JOIN_TOL).toBe(0.001);
	});
	test('crossing walls split both at the crossing (X); a third wall through the same point joins it', () => {
		const r = run([wall('a', [[-2, 0], [2, 0]]) as any, wall('b', [[0, -2], [0, 2]]) as any, wall('c', [[-2, -2], [2, 2]]) as any]);
		expect(r.stats).toMatchObject({ status: 'NoError', components: 1 });
		expect(r.network.nodes.find((n) => n.point[0] === 0 && n.point[1] === 0)!.degree).toBe(6);
		expect([...r.network.junctions.values()].flat().some((j) => j.type === 'multi')).toBe(true);
	});
	test('budget: more than 256 segments is BUDGET_EXCEEDED', () => {
		const many = Array.from({ length: 257 }, (_, i) => wall(`w${String(i).padStart(3, '0')}`, [[i * 3, 0], [i * 3 + 1, 0]]) as any);
		try {
			run(many);
			throw new Error('expected failure');
		} catch (error) {
			expect((error as ArchError).code).toBe('BUDGET_EXCEEDED');
		}
		expect(run(many.slice(0, 256)).network.segments).toHaveLength(256);
	});
	test('side left/right and base elevation: bodies lie on the stated side at the stated height', () => {
		const left = run([wall('a', [[0, 0], [4, 0]], { side: 'left', baseElevation: 1 }) as any]);
		const right = run([wall('a', [[0, 0], [4, 0]], { side: 'right' }) as any]);
		expect(hasVertex(left.mesh, 0, 0.15, 1)).toBe(true);
		expect(hasVertex(left.mesh, 4, 0, 3.7)).toBe(true);
		expect(hasVertex(right.mesh, 0, -0.15, 0)).toBe(true);
		expect(left.stats.volume).toBeCloseTo(4 * 0.15 * 2.7, 6);
	});
	test('empty wall list yields no solid', () => {
		expect(run([]).network.solid).toBeNull();
	});
	test('meshVolume of the exported mesh equals the kernel statistic', () => {
		const r = run(g4());
		expect(meshVolume(r.mesh)).toBe(r.stats.volume);
	});
});
