/**
 * WP4 → WP5 compatibility PROBE (test-only). It checks the structural PRECONDITIONS the C9 topology/bake stage relies on
 * and reports a literal run of C9 steps 1–2 (drop degenerate triangles, group coplanar same-material triangles across
 * shared edges). It does NOT implement loops, collinear removal, edges, roles or baking, and its numbers are not CP5
 * results.
 */
import type { MeshExport } from '../../../src/lib/arch/kernel';

export type ProbeResult = {
	/** every directed edge occurs once and so does its reverse (closed, consistently oriented surface) */
	watertight: boolean;
	/** triangles sharing the same vertex triple (zero-thickness internal faces) */
	duplicateFaces: number;
	/** triangles whose vertices are not all distinct, which no later stage can interpret */
	collapsed: number;
	/** C9 step 1: area < 1e-12 */
	degenerate: number;
	/** non-degenerate triangles smaller than 1e-6 m² */
	tiny: number;
	/** triangles without a part tag (WP5 needs attribution for roles) */
	untagged: number;
	/** C9 step 2 groups after dropping degenerates */
	groups: number;
	/** groups whose total area is below 1e-6 m² (fragments created by slivers or rounding) */
	tinyGroups: number;
	/** enclosed volume from the exported double-precision vertices */
	volume: number;
};

export function topologyProbe(mesh: MeshExport, materialOfTag: (tag: number) => string): ProbeResult {
	const { positions: p, triangles: t, triTag } = mesh;
	const count = t.length / 3;
	const directed = new Map<string, number>();
	const triples = new Map<string, number>();
	let collapsed = 0;
	for (let i = 0; i < count; i++) {
		const [a, b, c] = [t[i * 3]!, t[i * 3 + 1]!, t[i * 3 + 2]!];
		if (a === b || b === c || a === c) collapsed++;
		for (const [u, v] of [[a, b], [b, c], [c, a]] as const) directed.set(`${u},${v}`, (directed.get(`${u},${v}`) ?? 0) + 1);
		const key = [a, b, c].sort((x, y) => x - y).join(',');
		triples.set(key, (triples.get(key) ?? 0) + 1);
	}
	let watertight = true;
	for (const [key, n] of directed) {
		const [u, v] = key.split(',');
		if (n !== 1 || directed.get(`${v},${u}`) !== 1) {
			watertight = false;
			break;
		}
	}
	const duplicateFaces = [...triples.values()].filter((n) => n > 1).length;

	const normal = new Float64Array(count * 3), offset = new Float64Array(count), area = new Float64Array(count);
	let degenerate = 0, tiny = 0, untagged = 0;
	const alive: number[] = [];
	let volume = 0;
	for (let i = 0; i < count; i++) {
		if (triTag[i]! < 0) untagged++;
		const a = t[i * 3]! * 3, b = t[i * 3 + 1]! * 3, c = t[i * 3 + 2]! * 3;
		const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
		const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
		const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		const len = Math.hypot(nx, ny, nz);
		area[i] = len / 2;
		volume += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6;
		if (area[i]! < 1e-12) {
			degenerate++;
			continue;
		}
		if (area[i]! < 1e-6) tiny++;
		normal.set([nx / len, ny / len, nz / len], i * 3);
		offset[i] = (nx / len) * p[a]! + (ny / len) * p[a + 1]! + (nz / len) * p[a + 2]!;
		alive.push(i);
	}
	// C9 step 2: union-find across shared (undirected) edges
	const parent = new Map<number, number>(alive.map((i) => [i, i]));
	const find = (x: number): number => {
		while (parent.get(x) !== x) {
			parent.set(x, parent.get(parent.get(x)!)!);
			x = parent.get(x)!;
		}
		return x;
	};
	const owner = new Map<string, number>();
	for (const i of alive) {
		for (const [u, v] of [[t[i * 3]!, t[i * 3 + 1]!], [t[i * 3 + 1]!, t[i * 3 + 2]!], [t[i * 3 + 2]!, t[i * 3]!]] as const) {
			const other = owner.get(`${v},${u}`); // the neighbour traverses the shared edge the other way
			if (other !== undefined) {
				const dotN = normal[i * 3]! * normal[other * 3]! + normal[i * 3 + 1]! * normal[other * 3 + 1]! + normal[i * 3 + 2]! * normal[other * 3 + 2]!;
				if (dotN >= 1 - 1e-9 && Math.abs(offset[i]! - offset[other]!) <= 1e-6 && materialOfTag(triTag[i]!) === materialOfTag(triTag[other]!)) parent.set(find(i), find(other));
			}
			owner.set(`${u},${v}`, i);
		}
	}
	const groupArea = new Map<number, number>();
	for (const i of alive) groupArea.set(find(i), (groupArea.get(find(i)) ?? 0) + area[i]!);
	return {
		watertight, duplicateFaces, collapsed, degenerate, tiny, untagged,
		groups: groupArea.size,
		tinyGroups: [...groupArea.values()].filter((a) => a < 1e-6).length,
		volume: Math.round(volume * 1e9) / 1e9
	};
}
