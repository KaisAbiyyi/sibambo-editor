/**
 * SIB-MCP-MODELING-001 WP8 / CP8 — T-C*: one positive and one near-negative (or boundary) fixture per C13 rule, with the
 * v2.4 amendments (A2 WALL_GAP / ROOM_SOLID_LEAK, A4 staggered diagnostics). Everything runs through the real worker and the
 * real `check_model` tool; stored states that no agent write can produce are opened from an edited root metadata.
 */
import { describe, expect, test } from 'bun:test';
import { overlapArea } from '../../src/lib/arch/findings.js';
import type { ArchElement, ArchModule } from '../../src/lib/arch/schema.js';
import { expectUntouched } from './fixtures/agent-expect.js';
import { newDocument, openGraph, withStoredModule, type AgentHarness } from './fixtures/agent-harness.js';
import { g1, g3, g4, g9, moduleOf, opening, space, wall } from './fixtures/modules.js';

type P = [number, number];
type Row = { code: string; severity: string; scope: string; elementId: string | null; at: number[] | null; message: string; fix: any; hint: string | null; key: string };

const slab = (elementId: string, outline: P[], topElevation: number, thickness = 0.15, extra: Record<string, unknown> = {}): ArchElement => ({ elementId, kind: 'slab', outline, holes: [], thickness, topElevation, ...extra }) as ArchElement;
const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

async function check(harness: AgentHarness, args: Record<string, unknown> = {}): Promise<{ findings: Row[]; totals: Record<string, number>; spaces: any[]; diagnostics: any[]; modules: any[]; hidden: number }> {
	const before = harness.state();
	const json = await harness.ok('check_model', { limit: 1000, ...args, format: 'json' });
	expectUntouched(harness, before);
	return json;
}

async function written(...elements: ArchElement[]): Promise<AgentHarness> {
	const harness = await newDocument();
	await harness.addModule(moduleOf(elements));
	return harness;
}

/** A stored module whose geometry the write path would reject or never produce. */
async function stored(base: ArchModule, edit: (module: ArchModule) => void): Promise<AgentHarness> {
	const source = await newDocument();
	await source.addModule(base);
	return openGraph(withStoredModule(source.graph(), base.moduleId, edit));
}

const only = async (harness: AgentHarness, code: string): Promise<Row[]> => (await check(harness)).findings.filter((f) => f.code === code);
const codes = async (harness: AgentHarness): Promise<string[]> => [...new Set((await check(harness)).findings.map((f) => f.code))].sort();

describe('WALL_GAP — near-miss endpoint (A8) and G9 as amended by v2.4 A1', () => {
	test('G9: enclosed:true, authoredEnclosed:false, WALL_GAP with fix (4.000,3.000); no SPACE_NOT_ENCLOSED, no ROOM_SOLID_LEAK', async () => {
		const harness = await written(...g9().elements);
		const report = await check(harness);
		expect(report.spaces).toEqual([expect.objectContaining({ id: 'test/ground:sp', enclosed: true, authoredEnclosed: false, area: 10.97 })]);
		const gaps = report.findings.filter((f) => f.code === 'WALL_GAP');
		expect(gaps.find((f) => f.elementId === 'w3')).toMatchObject({ severity: 'WARNING', scope: 'test/ground', at: [3.98, 3], fix: [4, 3], key: 'WALL_GAP:test/ground:w3:3.980,3.000' });
		expect(gaps.every((f) => f.elementId !== 'sp')).toBe(true); // the near miss on the room's own boundary already names the gap
		expect(report.findings.map((f) => f.code)).not.toContain('SPACE_NOT_ENCLOSED');
		expect(report.findings.map((f) => f.code)).not.toContain('ROOM_SOLID_LEAK');
		expect(await harness.text('check_model')).toContain('WARNING WALL_GAP  test/ground:w3 at (3.980,3.000)');
		expect(await harness.text('check_model')).toContain('fix (4.000,3.000)');
		expect(await harness.text('check_model')).toContain('enclosed:true authoredEnclosed:false');
	});
	for (const [gap, expected] of [[0.0011, 'WALL_GAP'], [0.3, 'WALL_GAP'], [0.301, 'WALL_FREE_END'], [0.0009, null]] as const)
		test(`gap ${gap} m → ${expected ?? 'joined, nothing'}`, async () => {
			const harness = await written(wall('a', [[0, 0], [4, 0]]) as ArchElement, wall('b', [[0, 2], [0, gap]], { thickness: 0.05 }) as ArchElement);
			const at = (await check(harness)).findings.filter((f) => f.elementId === 'b' && f.at![1]! < 1);
			expect(at.map((f) => f.code)).toEqual(expected ? [expected] : []);
			if (expected === 'WALL_GAP') expect(at[0]!.fix).toEqual([0, 0]);
		});
	test('a near miss is never reported twice as WALL_FREE_END', async () => {
		const harness = await written(...g9().elements);
		expect(await only(harness, 'WALL_FREE_END')).toEqual([]);
	});
});

describe('WALL_GAP — enclosed ∧ ¬authoredEnclosed (v2.4 A2)', () => {
	// 0.8 m bodies close the solid although the centrelines end 0.35 m apart, which is beyond the 0.30 m near-miss rule.
	const thick = { thickness: 0.8 };
	const room = (end: number) => [
		wall('s', [[0, 0], [6, 0]], thick), wall('e', [[6, 0], [6, 5]], thick), wall('n', [[end, 5], [0, 5]], thick), wall('w', [[0, 5], [0, 0]], thick), space('sp', 'Tebal', [3, 2.5])
	] as ArchElement[];
	test('positive: no near miss, so the room itself carries the finding', async () => {
		const harness = await written(...room(5.65));
		const report = await check(harness);
		expect(report.spaces[0]).toMatchObject({ enclosed: true, authoredEnclosed: false });
		expect(report.findings.filter((f) => f.code === 'WALL_GAP')).toEqual([expect.objectContaining({ elementId: 'sp', severity: 'WARNING', at: [3, 2.5] })]);
	});
	test('an unrelated near miss elsewhere in the module does not hide it', async () => {
		const harness = await written(...room(5.65), wall('far-a', [[20, 0], [24, 0]]) as ArchElement, wall('far-b', [[22, 0.1], [22, 3]]) as ArchElement);
		const ids = (await only(harness, 'WALL_GAP')).map((f) => f.elementId);
		expect(ids).toContain('sp');
		expect(ids).toContain('far-b');
	});
	test('near-negative: joined centrelines', async () => {
		const harness = await written(...room(6));
		expect((await check(harness)).spaces[0]).toMatchObject({ enclosed: true, authoredEnclosed: true });
		expect(await only(harness, 'WALL_GAP')).toEqual([]);
	});
});

describe('ROOM_SOLID_LEAK (v2.4 A2) and WALL_STAGGERED_CONTINUATION (v2.4 A4/A7)', () => {
	const room = (second: 'left' | 'right'): ArchModule =>
		moduleOf([
			wall('s', [[0, 0], [4, 0]]), wall('e', [[4, 0], [4, 3]]), wall('n1', [[4, 3], [2, 3]], { side: 'left' }), wall('n2', [[2, 3], [0, 3]], { side: second }),
			wall('w', [[0, 3], [0, 0]]), space('sp', 'Bocor', [1, 1])
		] as ArchElement[]);
	const staggered = () => stored(room('left'), (m) => (m.elements.find((e) => e.elementId === 'n2')!.side = 'right'));
	test('positive: centrelines close, bodies touch only along an edge → both values and the diagnostic are reported, nothing is joined', async () => {
		const harness = await staggered();
		const report = await check(harness);
		expect(report.spaces[0]).toMatchObject({ enclosed: false, authoredEnclosed: true, area: null });
		expect(report.findings.filter((f) => f.code === 'ROOM_SOLID_LEAK')).toEqual([expect.objectContaining({ elementId: 'sp', severity: 'ERROR', at: [1, 1] })]);
		expect(report.diagnostics).toEqual([{ moduleId: 'test/ground', code: 'WALL_STAGGERED_CONTINUATION', at: [2, 3], elements: ['n1', 'n2'], overlap: 0 }]);
		expect(report.findings.filter((f) => f.code === 'WALL_STAGGERED_CONTINUATION')).toEqual([expect.objectContaining({ elementId: 'n1', severity: 'WARNING', at: [2, 3] })]);
		const scene = await harness.text('describe_scene');
		expect(scene).toContain('enclosed:false authoredEnclosed:true');
		expect(scene).toContain('test/ground  WALL_STAGGERED_CONTINUATION at (2.000,3.000) elements n1 | n2 overlap 0.000');
	});
	test('reads never use the write policy: the same stored module is rejected only when an agent writes it', async () => {
		const harness = await staggered();
		const before = harness.state();
		const error = await harness.fails('edit_model', { changes: [{ op: 'update', moduleId: 'test/ground', elementId: 'sp', set: { name: 'X' } }] });
		expect(error).toMatchObject({ code: 'INVALID_GEOMETRY', detail: { reason: 'WALL_STAGGERED_CONTINUATION' } });
		expectUntouched(harness, before);
	});
	test('near-negative: both halves on the same side', async () => {
		const harness = await written(...room('left').elements);
		const report = await check(harness);
		expect(report.spaces[0]).toMatchObject({ enclosed: true, authoredEnclosed: true });
		expect(report.diagnostics).toEqual([]);
		expect(await codes(harness)).toEqual([]);
	});
});

describe('spaces', () => {
	test('SPACE_NOT_ENCLOSED: ERROR with a wall missing; not with it', async () => {
		const [w1, w2, w3, w4] = g1().elements;
		const open = await written(w1!, w2!, w3!, space('sp', 'Terbuka', [2, 1.5]) as ArchElement);
		expect(await only(open, 'SPACE_NOT_ENCLOSED')).toEqual([expect.objectContaining({ severity: 'ERROR', elementId: 'sp', at: [2, 1.5] })]);
		expect(await only(open, 'ROOM_SOLID_LEAK')).toEqual([]);
		const closed = await written(w1!, w2!, w3!, w4!, space('sp', 'Tertutup', [2, 1.5]) as ArchElement);
		expect(await only(closed, 'SPACE_NOT_ENCLOSED')).toEqual([]);
	});
	test('SPACE_SEED_IN_WALL: ERROR, and the rest of the module is still described; not 0.01 m outside the body', async () => {
		const inside = await stored(g4(), (m) => (m.elements.find((e) => e.elementId === 'sa')!.seedPoint = [2.05, 1.5]));
		const report = await check(inside);
		expect(report.findings.filter((f) => f.code === 'SPACE_SEED_IN_WALL')).toEqual([expect.objectContaining({ severity: 'ERROR', elementId: 'sa', at: [2.05, 1.5] })]);
		expect(report.spaces.map((s) => [s.id, s.seedInWall, s.enclosed])).toEqual([['test/ground:sa', true, null], ['test/ground:sb', false, true]]);
		expect(await inside.text('describe_scene')).toContain('SEED IN WALL');
		const outside = await stored(g4(), (m) => (m.elements.find((e) => e.elementId === 'sb')!.seedPoint = [2.085, 1.5]));
		expect(await only(outside, 'SPACE_SEED_IN_WALL')).toEqual([]);
	});
	test('SPACE_DUPLICATE: two seeds in one region; not in two regions', async () => {
		const twice = await written(...g1().elements, space('a', 'A', [1, 1.5]) as ArchElement, space('b', 'B', [3, 1.5]) as ArchElement);
		expect(await only(twice, 'SPACE_DUPLICATE')).toEqual([expect.objectContaining({ severity: 'WARNING', elementId: 'b' })]);
		expect(await only(await written(...g4().elements), 'SPACE_DUPLICATE')).toEqual([]);
	});
});

describe('walls and slabs', () => {
	test('WALL_FREE_END: INFO for a stub with no wall within 0.30; not for a closed loop', async () => {
		const stub = await written(wall('a', [[0, 0], [4, 0]]) as ArchElement);
		expect((await only(stub, 'WALL_FREE_END')).map((f) => [f.severity, f.at])).toEqual([['INFO', [0, 0]], ['INFO', [4, 0]]]);
		expect(await only(await written(...g1().elements), 'WALL_FREE_END')).toEqual([]);
	});
	test('WALL_BASE_MISMATCH: base 0 under a slab top 0.1; not at the slab top, not within ±0.001, not for a ceiling above', async () => {
		const at = (base: number, ...slabs: ArchElement[]) => written(wall('a', [[1, 1], [3, 1]], { baseElevation: base }) as ArchElement, ...slabs);
		const floor = (top: number) => slab('floor', rect(0, 0, 4, 3), top);
		expect(await only(await at(0, floor(0.1)), 'WALL_BASE_MISMATCH')).toEqual([expect.objectContaining({ severity: 'WARNING', elementId: 'a', at: [2, 1], fix: { baseElevation: 0.1 } })]);
		expect(await only(await at(0, floor(0.0011)), 'WALL_BASE_MISMATCH')).toHaveLength(1);
		expect(await only(await at(0.1, floor(0.1)), 'WALL_BASE_MISMATCH')).toEqual([]);
		expect(await only(await at(0, floor(0.001)), 'WALL_BASE_MISMATCH')).toEqual([]);
		expect(await only(await at(0, floor(0), slab('ceiling', rect(0, 0, 4, 3), 2.6, 0.1, { role: 'ceiling' }), slab('roof', rect(0, 0, 4, 3), 2.85, 0.15, { role: 'roof-flat' })), 'WALL_BASE_MISMATCH')).toEqual([]);
		expect(await only(await at(0, slab('beside', rect(0, 1.125, 4, 3), 0.1)), 'WALL_BASE_MISMATCH')).toEqual([]); // does not cover the midpoint
		expect(await only(await at(0, { ...floor(0.1), holes: [rect(1.5, 0.5, 2.5, 1.5)] } as ArchElement), 'WALL_BASE_MISMATCH')).toEqual([]); // midpoint over a hole
	});
	test('ELEMENT_FLOATING: base 0.002 with no slab; not at 0.001, not on a slab', async () => {
		const at = (base: number, ...slabs: ArchElement[]) => written(wall('a', [[1, 1], [3, 1]], { baseElevation: base }) as ArchElement, ...slabs);
		expect(await only(await at(0.002), 'ELEMENT_FLOATING')).toEqual([expect.objectContaining({ severity: 'WARNING', elementId: 'a', at: [2, 1] })]);
		expect(await only(await at(0.001), 'ELEMENT_FLOATING')).toEqual([]);
		expect(await only(await at(0.5, slab('floor', rect(0, 0, 4, 3), 0.5)), 'ELEMENT_FLOATING')).toEqual([]);
	});
	for (const [label, width, height, flagged] of [
		['clear width 0.695', 0.77, 2.1, true], ['clear width exactly 0.700', 0.775, 2.1, false],
		['clear height 1.8925', 0.9, 1.93, true], ['clear height exactly 1.900', 0.9, 1.9375, false]
	] as const)
		test(`DOOR_CLEARANCE: ${label} → ${flagged ? 'WARNING' : 'nothing'}`, async () => {
			const harness = await written(...g3().elements, opening('d', 'shell', 1, width, height, 0, 'door') as ArchElement);
			expect((await only(harness, 'DOOR_CLEARANCE')).map((f) => [f.severity, f.elementId])).toEqual(flagged ? [['WARNING', 'd']] : []);
		});
	test('DOOR_CLEARANCE ignores windows and voids', async () => {
		const harness = await written(...g3().elements, opening('v', 'shell', 1, 0.5, 1.5, 0, 'void') as ArchElement, opening('w', 'shell', 2.5, 0.5, 0.5, 0.9, 'window') as ArchElement);
		expect(await only(harness, 'DOOR_CLEARANCE')).toEqual([]);
	});
	test('SLAB_OVERLAP: shared area and height; not for overlapping boxes without shared area, stacked slabs, or a slab filling a hole', async () => {
		const l = slab('l', [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]], 0);
		expect(await only(await written(l, slab('x', rect(0.5, 0.5, 3, 3), 0)), 'SLAB_OVERLAP')).toEqual([expect.objectContaining({ severity: 'WARNING', elementId: 'x' })]);
		expect(await only(await written(l, slab('notch', rect(1, 1, 4, 4), 0)), 'SLAB_OVERLAP')).toEqual([]); // bounding boxes overlap, areas only touch
		expect(await only(await written(slab('a', rect(0, 0, 2, 2), 0), slab('b', rect(0, 0, 2, 2), 0.15)), 'SLAB_OVERLAP')).toEqual([]); // touching in z
		expect(await only(await written({ ...slab('ring', rect(0, 0, 4, 4), 0), holes: [rect(1, 1, 3, 3)] } as ArchElement, slab('plug', rect(1, 1, 3, 3), 0)), 'SLAB_OVERLAP')).toEqual([]);
	});
	test('overlapArea is exact for crossing, contained, holed and disjoint polygons', () => {
		expect(overlapArea([rect(0, 0, 4, 4)], [rect(2, 2, 6, 6)])).toBeCloseTo(4, 12);
		expect(overlapArea([rect(0, 0, 4, 4)], [rect(1, 1, 2, 3)])).toBeCloseTo(2, 12);
		expect(overlapArea([rect(0, 0, 4, 4), rect(1, 1, 3, 3)], [rect(0, 0, 4, 4)])).toBeCloseTo(12, 12);
		expect(overlapArea([rect(0, 0, 1, 1)], [rect(1, 0, 2, 1)])).toBe(0);
		// Square with side 2 and the same square rotated by 45° about its centre: a regular octagon of area 8(√2 − 1).
		const r = Math.SQRT2;
		expect(overlapArea([rect(-1, -1, 1, 1)], [[[r, 0], [0, r], [-r, 0], [0, -r]]])).toBeCloseTo(8 * (Math.SQRT2 - 1), 12);
	});
});

describe('TINY_EDGE and SLIVER_FACE', () => {
	// Binary-exact steps (7/4096 m, 10/4096 m): the C8 slab check compares areas at 1e-9 and rejects most decimal outlines
	// (escalated as F-WP8-1; not a WP8 rule).
	const TINY = 7 / 4096, SMALL = 10 / 4096;
	const stepped = (step: number, thickness: number): ArchElement => slab('s', [[0, 0], [1, 0], [1, 1], [0.5, 1], [0.5, 1 - step], [0, 1 - step]], 0, thickness);
	test('TINY_EDGE (architecture): 0.0017 m step; not 0.0024 m', async () => {
		const tiny = await only(await written(stepped(TINY, 0.15)), 'TINY_EDGE');
		expect(tiny.map((f) => [f.severity, f.scope, f.elementId])).toEqual([['WARNING', 'test/ground', 's'], ['WARNING', 'test/ground', 's']]); // top and bottom
		expect(await only(await written(stepped(SMALL, 0.15)), 'TINY_EDGE')).toEqual([]);
	});
	test('SLIVER_FACE (architecture): 7.3e-5 m² without any tiny edge; not 1.22e-4 m²', async () => {
		const harness = await written(stepped(SMALL, 0.03));
		expect((await only(harness, 'SLIVER_FACE')).map((f) => [f.severity, f.elementId])).toEqual([['WARNING', 's']]);
		expect(await only(harness, 'TINY_EDGE')).toEqual([]);
		expect(await only(await written(stepped(SMALL, 0.05)), 'SLIVER_FACE')).toEqual([]);
	});
	const freeform = async (dx: number, dy: number) => {
		const harness = await newDocument();
		await harness.owner({ type: 'raw', command: { kind: 'CREATE_RECTANGLE', points: [[1, 0, 0], [1 + dx, 0, 0], [1 + dx, 0, -dy], [1, 0, -dy]], normal: [0, 1, 0] } });
		return harness;
	};
	test('TINY_EDGE (freeform): 0.0015 m, located in world Z-up; not 0.0025 m', async () => {
		const tiny = await only(await freeform(0.0015, 1), 'TINY_EDGE');
		expect(tiny.map((f) => [f.scope, f.at]).sort()).toEqual([['freeform', [1.001, 0, 0]], ['freeform', [1.001, 1, 0]]]);
		expect(await only(await freeform(0.0025, 1), 'TINY_EDGE')).toEqual([]);
	});
	test('SLIVER_FACE (freeform): 8.1e-5 m²; not 1.21e-4 m²', async () => {
		const harness = await freeform(0.009, 0.009);
		expect(await only(harness, 'SLIVER_FACE')).toEqual([expect.objectContaining({ scope: 'freeform', elementId: harness.meshOf(null).faces[0]!.id })]);
		expect(await only(await freeform(0.011, 0.011), 'SLIVER_FACE')).toEqual([]);
	});
	test('freeform rules measure the placed size: a 0.01 m edge scaled by 0.1 is tiny', async () => {
		const harness = await freeform(0.01, 1);
		await harness.owner({ type: 'group', selection: [{ type: 'face', id: harness.meshOf(null).faces[0]!.id }], containerKind: 'group', name: 'G' });
		expect(await only(harness, 'TINY_EDGE')).toEqual([]);
		const group = harness.graph().instances.find((i) => i.kind === 'group')!.id;
		await harness.owner({ type: 'scale', selection: [{ type: 'instance', id: group }], factors: [0.1, 1, 1], pivot: [0, 0, 0], copy: false });
		expect((await only(harness, 'TINY_EDGE')).every((f) => f.elementId === group)).toBe(true);
		expect(await only(harness, 'TINY_EDGE')).toHaveLength(2);
	});
});

describe('module state', () => {
	test('MODULE_DETACHED: after an owner push-pull inside the group; not after moving the group', async () => {
		const harness = await written(...g3().elements);
		const container = harness.containerOf('test/ground');
		await harness.owner({ type: 'transform', selection: [{ type: 'instance', id: container }], delta: [1, 0, 0], copy: false, count: 1, spacing: 'multiply', radial: null });
		expect(await only(harness, 'MODULE_DETACHED')).toEqual([]);
		const top = harness.meshOf(container).faces.find((f) => f.normal[2] > 0.99)!;
		await harness.owner({ type: 'raw', command: { kind: 'PUSH_PULL_FACE', faceId: top.id, distance: 0.1 } }, [container]);
		expect(await only(harness, 'MODULE_DETACHED')).toEqual([expect.objectContaining({ severity: 'WARNING', scope: 'test/ground', elementId: null })]);
		const scene = await harness.text('describe_scene');
		expect(scene).toContain('DETACHED');
		expect(scene).not.toContain('hard-edges'); // no evaluated numbers for geometry that is no longer the stored module
	});
	test('MODULE_ORPHANED: after the owner erases the group; gone again after the owner undoes it', async () => {
		const harness = await written(...g3().elements);
		const container = harness.containerOf('test/ground');
		await harness.owner({ type: 'erase', selection: [{ type: 'instance', id: container }] });
		expect(await only(harness, 'MODULE_ORPHANED')).toEqual([expect.objectContaining({ severity: 'INFO', scope: 'test/ground' })]);
		expect(await harness.text('describe_scene')).toContain('ORPHANED');
		await harness.send('UNDO', { expectedRevision: harness.revision() });
		expect(await only(harness, 'MODULE_ORPHANED')).toEqual([]);
	});
	test('MODULE_NOT_EVALUABLE: stored parameters that are not geometry are reported, not thrown', async () => {
		const harness = await stored(g3(), (m) => m.elements.push(wall('dup', [[0, 0], [2, 0]]) as ArchElement));
		expect(await only(harness, 'MODULE_NOT_EVALUABLE')).toEqual([expect.objectContaining({ severity: 'ERROR', message: expect.stringContaining('WALL_COLLINEAR_OVERLAP') })]);
		expect(await harness.text('describe_scene')).toContain('NOT EVALUABLE (WALL_COLLINEAR_OVERLAP)');
		expect(await only(await written(...g3().elements), 'MODULE_NOT_EVALUABLE')).toEqual([]);
	});
});

describe('check_model contract', () => {
	test('order, totals, minSeverity, limit, moduleId and clean models', async () => {
		const harness = await written(...g9().elements, space('out', 'Luar', [8, 8]) as ArchElement, wall('stub', [[10, 0], [12, 0]]) as ArchElement);
		await harness.addModule({ ...g3(), moduleId: 'test/upper' });
		const all = await check(harness);
		expect(all.findings.map((f) => f.severity)).toEqual(['ERROR', 'WARNING', 'WARNING', 'INFO', 'INFO']);
		expect(all.totals).toEqual({ ERROR: 1, WARNING: 2, INFO: 2 });
		const warnings = await check(harness, { minSeverity: 'WARNING' });
		expect(warnings.findings).toHaveLength(3);
		expect(warnings.totals).toEqual(all.totals); // totals are never filtered by minSeverity
		const limited = await check(harness, { limit: 2 });
		expect([limited.findings.length, limited.hidden]).toEqual([2, 3]);
		expect(await harness.text('check_model', { limit: 2 })).toContain('… and 3 more');
		expect((await check(harness, { moduleId: 'test/upper' })).findings).toEqual([]);
		expect(await harness.text('check_model', { moduleId: 'test/upper' })).toContain('Findings: none');
		expect(all.findings.every((f) => f.key === `${f.code}:${f.scope}:${f.elementId ?? ''}:${(f.at ?? []).map((v) => v.toFixed(3)).join(',')}`)).toBe(true);
	});
	test('invalid arguments and unknown modules are catalogue errors; null means not given', async () => {
		const harness = await written(...g3().elements);
		expect(await harness.fails('check_model', { minSeverity: 'FATAL' })).toMatchObject({ code: 'INVALID_REQUEST', retryable: false, detail: { pointer: '/minSeverity' } });
		expect(await harness.fails('check_model', { limit: 0 })).toMatchObject({ code: 'INVALID_REQUEST', detail: { pointer: '/limit' } });
		expect(await harness.fails('check_model', { extra: 1 })).toMatchObject({ code: 'INVALID_REQUEST', detail: { pointer: '/extra' } });
		expect(await harness.fails('check_model', { moduleId: 'no/such' })).toMatchObject({ code: 'NOT_FOUND', detail: { moduleId: 'no/such' } });
		expect(await harness.text('check_model', { moduleId: null, minSeverity: 'INFO', limit: 100, format: 'text' })).toContain('all modules');
	});
	test('a module without defects and a new document report nothing', async () => {
		expect(await codes(await written(...g3().elements))).toEqual([]);
		expect(await codes(await newDocument())).toEqual([]);
	});
});
