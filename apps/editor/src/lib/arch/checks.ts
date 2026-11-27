/**
 * SIB-MCP-MODELING-001 v2.3 C13 (with v2.4 A2/A4) — `arch/checks.ts`: `check_model` and the finding set shared with
 * `describe_scene`/`describe_element`.
 *
 * Rules over managed modules live in `findings.ts` (also used by the `edit_model` receipt). This file adds what needs the
 * whole document: a space seed inside a wall (the evaluator raises it), stored parameters that cannot be evaluated,
 * and TINY_EDGE/SLIVER_FACE over freeform meshes. Findings never block anything.
 */
import { AgentToolFailure } from './errors.js';
import {
	collectManagedFindings, makeFinding, SEVERITY_RANK, SLIVER_FACE_MAX, sortFindings, TINY_EDGE_MAX,
	type ArchFinding, type FindingSeverity
} from './findings.js';
import { freeformOccurrences, graphEdgeGeometries, graphFaceGeometry, type ReadModule, type ReadScene } from './read-model.js';
import { a2, fa, fm, fp, line, m3, more, p2, q, type P2 } from './textfmt.js';
import { choice, integer, optionalString, strictArgs } from './read-args.js';

export const FREEFORM_SCOPE = 'freeform';

/** What to do about a finding whose fix is not a coordinate or value of its own (v1.0 rule table, retained). */
const HINTS: Readonly<Record<string, string>> = {
	WALL_GAP: 'move the wall endpoint to the fix point, or close the wall path',
	WALL_FREE_END: 'intentional stub? otherwise extend to a wall',
	SPACE_NOT_ENCLOSED: 'close the walls around the seed; see WALL_GAP findings',
	ROOM_SOLID_LEAK: 'the centrelines close but the wall bodies do not meet; adjust thickness, side or height so that they touch',
	SPACE_SEED_IN_WALL: 'move seedPoint inside the room',
	SPACE_DUPLICATE: 'remove one space',
	WALL_BASE_MISMATCH: 'set baseElevation to the slab top',
	ELEMENT_FLOATING: 'lower to 0 or add a slab',
	DOOR_CLEARANCE: 'widen/raise the opening',
	SLAB_OVERLAP: 'separate the slabs or merge them into one',
	TINY_EDGE: 'near-miss coordinates; snap to exact values',
	SLIVER_FACE: 'near-miss coordinates; snap to exact values',
	WALL_STAGGERED_CONTINUATION: 'put both walls on the same side, or add a connecting wall',
	MODULE_DETACHED: 'tell the owner; they may Undo their edit inside the group',
	MODULE_ORPHANED: 'the owner may Undo the removal, or use edit_model remove_module',
	MODULE_NOT_EVALUABLE: 'tell the owner; the stored parameters are not valid geometry'
};

export type SceneFinding = ArchFinding & { hint: string | null };

function freeformFindings(scene: ReadScene): ArchFinding[] {
	const out = new Map<string, ArchFinding>();
	const add = (f: ArchFinding) => {
		if (!out.has(f.key)) out.set(f.key, f);
	};
	for (const o of freeformOccurrences(scene)) {
		for (const edge of graphEdgeGeometries(o.mesh, o.owner, o.toWorld)) {
			if (edge.length >= TINY_EDGE_MAX) continue;
			const mid = [0, 1, 2].map((k) => (edge.a[k]! + edge.b[k]!) / 2) as [number, number, number];
			add(makeFinding('TINY_EDGE', 'WARNING', FREEFORM_SCOPE, o.owner, `Freeform edge shorter than ${TINY_EDGE_MAX} m.`, mid));
		}
		for (const face of o.mesh.faces) {
			const g = graphFaceGeometry(scene, o.mesh, face, o.toWorld);
			if (g.area >= SLIVER_FACE_MAX) continue;
			add(makeFinding('SLIVER_FACE', 'WARNING', FREEFORM_SCOPE, face.id, `Freeform face has sliver area ${g.area.toExponential(2)} m².`, g.centroid));
		}
	}
	return [...out.values()];
}

/** Every finding of the document, sorted ERROR → WARNING → INFO then identity key. */
export function collectSceneFindings(scene: ReadScene): SceneFinding[] {
	const records = new Map([...scene.modules].map(([id, read]) => [id, read.record]));
	const evaluated = new Map([...scene.modules].flatMap(([id, read]) => (read.evaluated ? [[id, read.evaluated] as const] : [])));
	const extra: ArchFinding[] = [];
	for (const read of scene.modules.values()) {
		for (const seed of read.seedsInWall) {
			const name = read.module.elements.find((e) => e.elementId === seed.elementId)!.name as string;
			extra.push(makeFinding('SPACE_SEED_IN_WALL', 'ERROR', read.moduleId, seed.elementId, `Space "${name}" (${seed.elementId}) has its seedPoint inside a wall.`, seed.at));
		}
		if (read.failure) {
			extra.push(makeFinding('MODULE_NOT_EVALUABLE', 'ERROR', read.moduleId, read.failure.elementId, `Stored parameters cannot be evaluated: ${read.failure.reason}.`));
		}
	}
	return sortFindings([...collectManagedFindings(records, evaluated), ...extra, ...freeformFindings(scene)]).map((f) => ({ ...f, hint: HINTS[f.code] ?? null }));
}

export function totalsOf(findings: readonly ArchFinding[]): Record<FindingSeverity, number> {
	const totals: Record<FindingSeverity, number> = { ERROR: 0, WARNING: 0, INFO: 0 };
	for (const f of findings) totals[f.severity] += 1;
	return totals;
}

export const issuesLine = (t: Record<FindingSeverity, number>): string => `Issues: ERROR ${t.ERROR} · WARNING ${t.WARNING} · INFO ${t.INFO}`;

// ─── shared rows: spaces (v2.4 A2 pair) and evaluator diagnostics (v2.4 A7) ──────────────────────────────────────

export type SpaceRow = {
	id: string; name: string; enclosed: boolean | null; authoredEnclosed: boolean | null;
	area: number | null; clear: { width: number; depth: number } | null; seed: P2; seedInWall: boolean;
};

export function spaceRows(read: ReadModule): SpaceRow[] {
	if (!read.evaluated) return [];
	const rows: SpaceRow[] = read.evaluated.spaces.map((s) => ({
		id: `${read.moduleId}:${s.elementId}`, name: s.name, enclosed: s.enclosed, authoredEnclosed: s.authoredEnclosed,
		area: s.enclosed ? a2(s.area) : null,
		clear: s.bbox ? { width: m3(s.bbox.maxX - s.bbox.minX), depth: m3(s.bbox.maxY - s.bbox.minY) } : null,
		seed: p2(s.seed), seedInWall: false
	}));
	for (const seed of read.seedsInWall) {
		const name = read.module.elements.find((e) => e.elementId === seed.elementId)!.name as string;
		rows.push({ id: `${read.moduleId}:${seed.elementId}`, name, enclosed: null, authoredEnclosed: null, area: null, clear: null, seed: p2(seed.at), seedInWall: true });
	}
	return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function spaceLine(row: SpaceRow): string {
	const area = row.area === null ? '—' : `${fa(row.area)} m²`;
	const state = row.seedInWall
		? 'SEED IN WALL'
		: `enclosed:${row.enclosed} authoredEnclosed:${row.authoredEnclosed === null ? 'unknown' : row.authoredEnclosed}`;
	const tail = row.clear ? `clear ${fm(row.clear.width)}×${fm(row.clear.depth)} (bbox)` : `${row.enclosed === false ? 'NOT ENCLOSED ' : ''}(seed ${fp(row.seed)})`;
	return `  ${row.id}  ${q(row.name)}  ${area}  ${state}  ${tail}`;
}

export type DiagnosticRow = { moduleId: string; code: string; at: P2; elements: [string, string]; overlap: number };

export function diagnosticRows(read: ReadModule): DiagnosticRow[] {
	return (read.evaluated?.diagnostics ?? []).map((d) => ({ moduleId: read.moduleId, code: d.code, at: p2(d.at), elements: [...d.elements], overlap: m3(d.overlap) }));
}

export const diagnosticLine = (d: DiagnosticRow): string => `  ${d.moduleId}  ${d.code} at ${fp(d.at)} elements ${d.elements.join(' | ')} overlap ${fm(d.overlap)}`;

// ─── finding rows ────────────────────────────────────────────────────────────────────────────────────────────────

export type FindingRow = {
	code: string; severity: FindingSeverity; scope: string; elementId: string | null;
	at: readonly number[] | null; message: string; fix: unknown; hint: string | null; key: string;
};

export const findingRow = (f: SceneFinding): FindingRow => ({
	code: f.code, severity: f.severity, scope: f.scope, elementId: f.elementId, at: f.at ?? null, message: f.message, fix: f.fix ?? null, hint: f.hint, key: f.key
});

export function findingLine(f: FindingRow): string {
	const fix = Array.isArray(f.fix)
		? ` · fix ${fp(f.fix as number[])}`
		: f.fix && typeof f.fix === 'object'
			? ` · fix ${Object.entries(f.fix).map(([k, v]) => `${k} ${fm(v as number)}`).join(', ')}`
			: '';
	const target = f.elementId === null ? f.scope : f.scope === FREEFORM_SCOPE ? `${f.scope} ${f.elementId}` : `${f.scope}:${f.elementId}`;
	return `  ${f.severity} ${f.code}  ${target}${f.at ? ` at ${fp(f.at)}` : ''}  ${line(f.message)}${fix}${f.hint ? ` · ${f.hint}` : ''}`;
}

// ─── check_model ─────────────────────────────────────────────────────────────────────────────────────────────────

export type CheckArgs = { moduleId: string | null; minSeverity: FindingSeverity; limit: number; format: 'text' | 'json' };

export function parseCheckArgs(raw: Record<string, unknown>): CheckArgs {
	const args = strictArgs('check_model', raw, ['moduleId', 'minSeverity', 'limit', 'format']);
	return {
		moduleId: optionalString(args, 'moduleId'),
		minSeverity: choice(args, 'minSeverity', ['ERROR', 'WARNING', 'INFO'] as const, 'INFO'),
		limit: integer(args, 'limit', 1, 1000, 100),
		format: choice(args, 'format', ['text', 'json'] as const, 'text')
	};
}

export function checkModel(scene: ReadScene, revision: number, args: CheckArgs): Record<string, unknown> {
	if (args.moduleId !== null && !scene.modules.has(args.moduleId)) {
		throw new AgentToolFailure('NOT_FOUND', `Module ${line(args.moduleId)} does not exist.`, { moduleId: args.moduleId });
	}
	const modules = [...scene.modules.values()].filter((m) => args.moduleId === null || m.moduleId === args.moduleId);
	const scoped = collectSceneFindings(scene).filter((f) => args.moduleId === null || f.scope === args.moduleId);
	const listed = scoped.filter((f) => SEVERITY_RANK[f.severity] <= SEVERITY_RANK[args.minSeverity]);
	const shown = listed.slice(0, args.limit);
	const data = {
		tool: 'check_model' as const, format: 'json' as const, revision, moduleId: args.moduleId, minSeverity: args.minSeverity,
		totals: totalsOf(scoped),
		modules: modules.map((m) => ({ moduleId: m.moduleId, state: m.state })),
		findings: shown.map(findingRow), hidden: listed.length - shown.length,
		spaces: modules.flatMap(spaceRows), diagnostics: modules.flatMap(diagnosticRows)
	};
	if (args.format === 'json') return data;
	const lines = [
		`check_model · revision ${revision} · ${args.moduleId ?? 'all modules'} · minSeverity ${args.minSeverity}`,
		issuesLine(data.totals),
		...(data.findings.length ? ['Findings:', ...data.findings.map(findingLine)] : ['Findings: none']),
		...more(data.hidden, 'raise limit= or filter with moduleId=/minSeverity='),
		...(data.modules.some((m) => m.state !== 'ok') ? ['Module state:', ...data.modules.filter((m) => m.state !== 'ok').map((m) => `  ${m.moduleId}  ${m.state.toUpperCase()}`)] : []),
		...(data.spaces.length ? ['Spaces:', ...data.spaces.map(spaceLine)] : []),
		...(data.diagnostics.length ? ['Diagnostics:', ...data.diagnostics.map(diagnosticLine)] : [])
	];
	return { format: 'text', text: lines.join('\n') };
}
