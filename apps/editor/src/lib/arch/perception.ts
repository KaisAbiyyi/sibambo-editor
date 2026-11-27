/**
 * SIB-MCP-MODELING-001 v2.3 C12 (with v2.4 A2/A7) — `arch/perception.ts`: `describe_scene`, `describe_element`,
 * `query_region` and `measure`.
 *
 * Every tool builds ONE data object with rounded numbers; text is rendered from that object, JSON returns it (A17, T-P6).
 * Text results are `{format:'text', text}` (the relay shows `text`); JSON results never carry a `text` key, except `measure`,
 * which has no format parameter and returns both.
 */
import type { Matrix4 } from 'three';
import type { Face, Mesh } from '@sibambo/bomc-document';
import { contextTransform } from '../authoring/model.js';
import type { AgentContext } from '../authoring/protocol.js';
import {
	collectSceneFindings, diagnosticLine, diagnosticRows, findingLine, findingRow, issuesLine, spaceLine, spaceRows, totalsOf
} from './checks.js';
import type { SlabElement } from './elements.js';
import { AgentToolFailure } from './errors.js';
import { signedArea, type Vec2 } from './kernel.js';
import { choice, integer, invalid, optionalString, point3, strictArgs } from './read-args.js';
import {
	aggregates, apply, archEdgeGeometry, archFaceGeometry, boundsOf, decompose, elementPoints, freeformPlacement, graphEdgeGeometries,
	graphFaceGeometry, managedModuleOfPath, meshPoints, openingGeometry, pathKey, TO_Z_UP, worldZUp,
	type ArchEdgeRef, type ArchFaceRef, type EdgeGeometry, type FaceGeometry, type Occurrence, type Placement, type ReadModule, type ReadScene
} from './read-model.js';
import type { ArchElement } from './schema.js';
import {
	a2, AGENT_STATUS_UNKNOWN, d1, fa, fbounds, fd, fm, fnormal, fp, line, m3, more, p2, p3, q, type Bounds3, type P2, type P3
} from './textfmt.js';

const FORMATS = ['text', 'json'] as const;
const SELECTION_LIMIT = 50;
const RING_LIMIT = 32;
const LOOP_LIMIT = 16;
const ELEMENT_FINDINGS_LIMIT = 20;
const CHILD_LIMIT = 50;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Code-unit order with a trailing index compared as a number, so that `…:e2` precedes `…:e10` (no locale involved). */
function naturalCmp(a: string, b: string): number {
	const [, pa, na] = /^(.*?)(\d*)$/s.exec(a)!, [, pb, nb] = /^(.*?)(\d*)$/s.exec(b)!;
	return cmp(pa!, pb!) || Number(na || 0) - Number(nb || 0) || cmp(a, b);
}

const b3 = (b: Bounds3 | null): Bounds3 | null => (b ? { min: p3(b.min), max: p3(b.max) } : null);

type PlacementRow = { t: P3; r: P3 | null; s: P3 | null };
function placementRow(p: Placement): PlacementRow {
	const r = p.rotation.map(d1) as P3, s = p3(p.scale);
	return { t: p3(p.translation), r: r.some((v) => v !== 0) ? r : null, s: s.some((v) => v !== 1) ? s : null };
}
const placementText = (p: PlacementRow): string =>
	`t${fp(p.t)}${p.r ? ` r(${p.r.map(fd).join(',')})deg` : ''}${p.s ? ` s${fp(p.s)}` : ''}`;

const countKind = (read: ReadModule, kind: ArchElement['kind']): number => read.module.elements.filter((e) => e.kind === kind).length;

const STATE_NOTES: Readonly<Record<string, string>> = {
	detached: 'DETACHED (the owner edited inside the group; stored parameters may not match the geometry)',
	orphaned: 'ORPHANED (the container is gone; stored parameters only)'
};

// ─── describe_scene ──────────────────────────────────────────────────────────────────────────────────────────────

export function parseSceneArgs(raw: Record<string, unknown>) {
	const args = strictArgs('describe_scene', raw, ['query', 'limit', 'format']);
	return { query: optionalString(args, 'query'), limit: integer(args, 'limit', 1, 500, 50), format: choice(args, 'format', FORMATS, 'text') };
}

/** Occurrence paths are shown as ids; '' is the model root. */
const pathText = (path: readonly string[]): string => (path.length ? path.join(' > ') : 'model root');

type SelectionRow =
	| { type: 'face'; id: string; found: boolean; element: string | null; role: string | null; face: string | null; path: string[] }
	| { type: 'instance'; id: string; found: boolean; name: string | null; moduleId: string | null }
	| { type: 'edge'; start: P3; end: P3 };

/** Owner selection. Ids are relative to the edit context path; edge endpoints are converted to world Z-up (A17). */
function selectionRows(scene: ReadScene, context: AgentContext): SelectionRow[] {
	let definitionId: string | null = null;
	let matrix: Matrix4 | null = null;
	try {
		({ definitionId, matrix } = contextTransform(scene.graph, context.path));
	} catch {
		// The edit context vanished between the owner's click and this read; ids are then reported as not found.
	}
	const moduleId = managedModuleOfPath(scene, context.path);
	return context.selection.slice(0, SELECTION_LIMIT).map((s): SelectionRow => {
		if (s.type === 'edge') {
			const toWorld = (p: readonly number[]) => p3(matrix ? apply(TO_Z_UP.clone().multiply(matrix), p) : worldZUp(p));
			return { type: 'edge', start: toWorld(s.start), end: toWorld(s.end) };
		}
		if (s.type === 'instance') {
			const instance = scene.instanceById.get(s.id);
			const found = !!instance && instance.ownerDefinitionId === definitionId;
			return { type: 'instance', id: s.id, found, name: found ? instance.name : null, moduleId: found ? (scene.managedByInstance.get(s.id) ?? null) : null };
		}
		const mesh = definitionId === null ? undefined : scene.meshByDefinition.get(definitionId);
		const found = !!mesh?.faces.some((f) => f.id === s.id);
		const ref = found && moduleId !== null ? scene.modules.get(moduleId)!.faces.find((f) => f.graphFaceId === s.id) : undefined;
		return {
			type: 'face', id: s.id, found, element: ref ? `${ref.moduleId}:${ref.face.elementId}` : null, role: ref?.face.role ?? null, face: ref?.id ?? null,
			path: [...context.path]
		};
	});
}

function selectionText(row: SelectionRow): string {
	if (row.type === 'edge') return `edge ${fp(row.start)}-${fp(row.end)}`;
	if (!row.found) return `${row.type} ${row.id} (not found)`;
	if (row.type === 'instance') return `instance ${row.id} ${q(row.name!)}${row.moduleId ? ` (managed ${row.moduleId})` : ''}`;
	return `face ${row.id} (${row.element ? `${row.face} ${row.element} ${row.role}` : `in ${pathText(row.path)}`})`;
}

function moduleRow(read: ReadModule) {
	const evaluated = read.evaluated;
	return {
		moduleId: read.moduleId, name: read.module.name ?? null, revision: read.module.revision, state: read.state, instanceId: read.record.entry.instanceId,
		walls: countKind(read, 'wall'), slabs: countKind(read, 'slab'), openings: countKind(read, 'opening'), spaces: countKind(read, 'space'),
		faces: evaluated ? read.faces.length : null, hardEdges: evaluated ? read.edges.filter((e) => e.edge.flag === 'hard').length : null,
		bounds: b3(evaluated?.bounds ?? null),
		transform: read.placements.length ? placementRow(decompose(read.placements[0]!)) : null, occurrences: read.placements.length,
		failure: read.failure?.reason ?? null
	};
}

function moduleLine(m: ReturnType<typeof moduleRow>): string {
	const parts = [
		`  ${m.moduleId}${m.name ? ` ${q(m.name)}` : ''}`, `rev ${m.revision}`, `walls ${m.walls}`, `slabs ${m.slabs}`, `openings ${m.openings}`, `spaces ${m.spaces}`,
		...(m.faces !== null ? [`faces ${m.faces}`, `hard-edges ${m.hardEdges}`, fbounds(m.bounds)] : []),
		...(m.transform ? [`transform ${placementText(m.transform)}`] : []),
		...(m.occurrences > 1 ? [`occurrences ${m.occurrences}`] : []),
		...(m.state !== 'ok' ? [STATE_NOTES[m.state]!] : []),
		...(m.failure ? [`NOT EVALUABLE (${line(m.failure)})`] : [])
	];
	return parts.join('  ');
}

export function describeScene(scene: ReadScene, revision: number, context: AgentContext, args: ReturnType<typeof parseSceneArgs>): Record<string, unknown> {
	const { graph } = scene;
	const needle = args.query?.toLowerCase() ?? null;
	const hits = (...values: (string | null | undefined)[]) => needle === null || values.some((v) => v?.toLowerCase().includes(needle));
	const clip = <T>(all: readonly T[]) => ({ total: all.length, hidden: Math.max(0, all.length - args.limit), items: all.slice(0, args.limit) });

	const reads = [...scene.modules.values()];
	const modules = reads.filter((m) => hits(m.moduleId, m.module.name));
	const spaces = reads.flatMap(spaceRows).filter((s) => hits(s.id, s.name));
	const diagnostics = reads.flatMap(diagnosticRows).filter((d) => hits(d.moduleId, d.code, ...d.elements));

	const sums = aggregates(scene);
	const topLevel = graph.instances
		.filter((i) => i.ownerDefinitionId === graph.rootDefinitionId && !scene.managedByInstance.has(i.id))
		.sort((a, b) => cmp(a.id, b.id));
	const inside = new Map<string, string[]>(); // top-level instance → managed modules grouped inside it by the owner
	for (const read of reads) if (read.path.length > 1) inside.set(read.path[0]!, [...(inside.get(read.path[0]!) ?? []), read.moduleId]);
	const instances = topLevel
		.filter((i) => hits(i.id, i.name, scene.tagOf(i.id)))
		.map((i) => {
			const sum = sums.get(pathKey([i.id]));
			return { id: i.id, kind: i.kind, name: i.name, faces: sum?.faces ?? 0, bounds: b3(sum?.bounds ?? null), tag: scene.tagOf(i.id), visible: scene.visible(i.id), modules: inside.get(i.id) ?? [] };
		});
	const data = {
		tool: 'describe_scene' as const, format: 'json' as const, document: { name: graph.name, revision, mode: context.mode },
		/** Filled in by the main-thread host (writer/pause state never reaches the worker). */
		agents: null as null | { writer: string | null; paused: boolean },
		query: args.query,
		selection: { context: [...context.path], total: context.selection.length, items: selectionRows(scene, context) },
		modules: { count: reads.length, ...clip(modules.map(moduleRow)) },
		spaces: clip(spaces), diagnostics: clip(diagnostics),
		freeform: {
			groups: topLevel.filter((i) => i.kind === 'group').length, components: topLevel.filter((i) => i.kind === 'component').length,
			looseFaces: scene.meshByDefinition.get(graph.rootDefinitionId)?.faces.length ?? 0, ...clip(instances)
		},
		issues: totalsOf(collectSceneFindings(scene)),
		next: ['describe_element(ids)', 'query_region(box)', 'measure(a, b)', 'check_model()']
	};
	if (args.format === 'json') return data;

	const selection = data.selection;
	const inContext = selection.context.length ? ` [editing inside ${pathText(selection.context)}]` : '';
	const selectionLines = selection.items.length <= 1
		? [`Selection: ${selection.items.length ? selectionText(selection.items[0]!) : 'none'}${inContext}`]
		: [`Selection: ${selection.total}${inContext}`, ...selection.items.map((s) => `  ${selectionText(s)}`), ...more(selection.total - selection.items.length, 'selection is listed up to 50 entries')];
	const hint = 'use query=';
	const lines = [
		`Sibambo · document ${q(data.document.name)} · revision ${revision} · mode ${context.mode} · ${AGENT_STATUS_UNKNOWN}`,
		...(args.query ? [`Query: ${q(args.query)}`] : []),
		...selectionLines,
		`Arch modules ${data.modules.count}:`, ...data.modules.items.map(moduleLine), ...more(data.modules.hidden, hint),
		...(data.spaces.total ? ['Spaces:', ...data.spaces.items.map(spaceLine), ...more(data.spaces.hidden, hint)] : ['Spaces: none']),
		...(data.diagnostics.total ? ['Diagnostics:', ...data.diagnostics.items.map(diagnosticLine), ...more(data.diagnostics.hidden, 'use check_model()')] : []),
		`Freeform: groups ${data.freeform.groups} components ${data.freeform.components} loose-faces ${data.freeform.looseFaces}`,
		...data.freeform.items.map(
			(i) => `  ${i.id}  ${i.kind}  ${q(i.name)}  faces ${i.faces}  ${fbounds(i.bounds)}  tag ${i.tag === null ? '-' : q(i.tag)}  visible ${i.visible ? 'yes' : 'no'}${i.modules.length ? `  contains managed ${i.modules.join(', ')}` : ''}`
		),
		...more(data.freeform.hidden, hint),
		`${issuesLine(data.issues)} → check_model()`,
		`Next: ${data.next.join(' · ')}`
	];
	return { format: 'text', text: lines.join('\n') };
}

// ─── id resolution ───────────────────────────────────────────────────────────────────────────────────────────────

const ARCH_ID = /^([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)+):([a-z][a-z0-9-]{0,63}(?:\/(?:frame|glazing|leaf))?)(:f\d{1,6})?$/;

type Resolved =
	| { kind: 'element'; read: ReadModule; element: ArchElement }
	| { kind: 'arch-face'; read: ReadModule; ref: ArchFaceRef }
	| { kind: 'graph-face'; mesh: Mesh; face: Face; occurrence: Occurrence; occurrences: number }
	| { kind: 'instance'; occurrence: Occurrence; occurrences: number };

function resolver(scene: ReadScene): (id: string) => Resolved | null {
	const faceIndex = new Map<string, { mesh: Mesh; face: Face }>();
	for (const mesh of scene.graph.meshes) for (const face of mesh.faces) faceIndex.set(face.id, { mesh, face });
	return (id) => {
		const instanceHits = scene.occurrences.filter((o) => (o.path.at(-1) ?? scene.graph.rootInstanceId) === id);
		if (instanceHits.length) return { kind: 'instance', occurrence: instanceHits[0]!, occurrences: instanceHits.length };
		const hit = faceIndex.get(id);
		if (hit) {
			for (const read of scene.modules.values()) {
				const ref = read.faces.find((f) => f.graphFaceId === id);
				if (ref) return { kind: 'arch-face', read, ref };
			}
			const owners = scene.occurrences.filter((o) => o.definitionId === hit.mesh.definitionId);
			return owners.length ? { kind: 'graph-face', ...hit, occurrence: owners[0]!, occurrences: owners.length } : null;
		}
		const match = ARCH_ID.exec(id);
		const read = match ? scene.modules.get(match[1]!) : undefined;
		if (!match || !read) return null;
		if (match[3]) {
			const ref = read.faces.find((f) => f.id === id);
			return ref ? { kind: 'arch-face', read, ref } : null;
		}
		const element = read.module.elements.find((e) => e.elementId === match[2]);
		return element ? { kind: 'element', read, element } : null;
	};
}

/** Faces that belong to an element: its own, plus (walls) the reveals its openings cut into it. */
const facesOf = (read: ReadModule, element: ArchElement): ArchFaceRef[] => read.faces.filter((f) => f.face.elementId === element.elementId);

function edgesOf(read: ReadModule, element: ArchElement): ArchEdgeRef[] {
	const own = new Set(facesOf(read, element).map((f) => f.part.partId + '\u0000' + f.face.id));
	return read.edges.filter((e) => e.edge.faces.some((f) => own.has(e.part.partId + '\u0000' + f)));
}

// ─── rows ────────────────────────────────────────────────────────────────────────────────────────────────────────

function faceRow(g: FaceGeometry, frame: string) {
	return {
		faceId: g.id, frame, element: g.element, role: g.role, normal: p3(g.normal), normalText: fnormal(g.normal), area: a2(g.area), centroid: p3(g.centroid), material: g.material,
		loops: { outer: g.outer.map(p3), holes: g.holes.map((h) => h.map(p3)) }
	};
}

const loopText = (loop: readonly P3[]): string => loop.slice(0, LOOP_LIMIT).map(fp).join(' ') + (loop.length > LOOP_LIMIT ? ` +${loop.length - LOOP_LIMIT}` : '');

const faceLine = (f: ReturnType<typeof faceRow>): string =>
	`  ${f.faceId}  ${f.role ?? '-'}  normal ${f.normalText}  area ${fa(f.area)}  centroid ${fp(f.centroid)}  material ${f.material === null ? '-' : q(f.material)}  ` +
	`loops:[outer ${loopText(f.loops.outer)}${f.loops.holes.map((h) => ` | hole ${loopText(h)}`).join('')}]`;

function edgeRow(e: EdgeGeometry, frame: string) {
	return { edgeId: e.id, frame, a: p3(e.a), b: p3(e.b), length: m3(e.length), flag: e.flag, faces: e.faces, angle: e.angle === null ? null : d1(e.angle) };
}

const edgeLine = (e: ReturnType<typeof edgeRow>): string =>
	`  ${e.edgeId}  ${fp(e.a)}-${fp(e.b)}  len ${fm(e.length)}  ${e.flag}  faces ${e.faces.join('|') || '-'}  angle ${e.angle === null ? '-' : fd(e.angle)}`;

// ─── describe_element ────────────────────────────────────────────────────────────────────────────────────────────

export function parseElementArgs(raw: Record<string, unknown>) {
	const args = strictArgs('describe_element', raw, ['ids', 'detail', 'page', 'pageSize', 'format']);
	const ids = args.ids;
	if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || ids.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 512))
		throw invalid('ids must be 1..20 id strings (moduleId:elementId, face id or instance id).', '/ids');
	return {
		ids: [...new Set(ids as string[])], detail: choice(args, 'detail', ['summary', 'faces', 'edges'] as const, 'summary'),
		page: integer(args, 'page', 0, 1_000_000, 0), pageSize: integer(args, 'pageSize', 1, 400, 100), format: choice(args, 'format', FORMATS, 'text')
	};
}

const polygonArea = (ring: readonly (readonly [number, number])[]): number => Math.abs(signedArea(ring as Vec2[]));

function elementParameters(element: ArchElement): Record<string, unknown> {
	const num = (key: string) => m3(element[key] as number);
	switch (element.kind) {
		case 'wall': {
			const path = element.path as P2[];
			return {
				path: path.slice(0, RING_LIMIT).map(p2), pathPoints: path.length, closed: element.closed === true, thickness: num('thickness'), height: num('height'),
				baseElevation: m3((element.baseElevation as number | undefined) ?? 0), side: (element.side as string | undefined) ?? 'center', materialId: (element.materialId as string | undefined) ?? 'sib-default'
			};
		}
		case 'slab': {
			const outline = element.outline as P2[], holes = (element.holes as P2[][] | undefined) ?? [];
			return {
				outline: outline.slice(0, RING_LIMIT).map(p2), outlinePoints: outline.length, holes: holes.length, thickness: num('thickness'), topElevation: num('topElevation'),
				role: (element.role as string | undefined) ?? 'floor', materialId: (element.materialId as string | undefined) ?? 'sib-default'
			};
		}
		case 'opening': {
			const type = element.openingType as string;
			return {
				hostElementId: element.hostElementId, openingType: type, along: num('along'), width: num('width'), height: num('height'), sillHeight: num('sillHeight'),
				swing: type === 'door' ? ((element.swing as object | undefined) ?? { hinge: 'start', side: 'left' }) : null,
				materialId: (element.materialId as string | undefined) ?? (type === 'void' ? null : 'sib-frame')
			};
		}
		default:
			return { name: element.name, seedPoint: p2(element.seedPoint as P2) };
	}
}

function elementSummary(scene: ReadScene, read: ReadModule, element: ArchElement, findings: ReturnType<typeof collectSceneFindings>) {
	const evaluated = read.evaluated;
	const points = elementPoints(read, element);
	const own = findings.filter((f) => f.scope === read.moduleId && f.elementId === element.elementId);
	const base = {
		type: 'element' as const, id: `${read.moduleId}:${element.elementId}`, kind: element.kind, frame: `module ${read.moduleId}`, state: read.state,
		parameters: elementParameters(element),
		bounds: element.kind === 'space' ? null : b3(points ? boundsOf(points) : null),
		faces: evaluated && element.kind !== 'space' ? facesOf(read, element).length : null,
		hardEdges: evaluated && element.kind !== 'space' ? edgesOf(read, element).filter((e) => e.edge.flag === 'hard').length : null,
		findings: own.slice(0, ELEMENT_FINDINGS_LIMIT).map(findingRow), hiddenFindings: Math.max(0, own.length - ELEMENT_FINDINGS_LIMIT)
	};
	if (element.kind === 'wall') {
		const path = element.path as P2[];
		let length = 0;
		for (let i = 0; i + 1 < path.length; i++) length += Math.hypot(path[i + 1]![0] - path[i]![0], path[i + 1]![1] - path[i]![1]);
		if (element.closed === true) length += Math.hypot(path[0]![0] - path.at(-1)![0], path[0]![1] - path.at(-1)![1]);
		return {
			...base, length: m3(length),
			junctions: evaluated ? (evaluated.junctions[element.elementId] ?? []).map((j) => ({ at: p2(j.at), type: j.type, with: [...j.with] })) : null,
			openings: read.module.elements
				.filter((e) => e.kind === 'opening' && e.hostElementId === element.elementId)
				.sort((a, b) => (a.along as number) - (b.along as number) || cmp(a.elementId, b.elementId))
				.map((e) => ({ id: e.elementId, openingType: e.openingType as string, along: m3(e.along as number), width: m3(e.width as number), height: m3(e.height as number), sillHeight: m3(e.sillHeight as number) }))
		};
	}
	if (element.kind === 'slab') {
		const slab = element as unknown as SlabElement;
		const area = polygonArea(slab.outline) - (slab.holes ?? []).reduce((sum, hole) => sum + polygonArea(hole), 0);
		return { ...base, area: a2(area), volume: m3(area * slab.thickness) };
	}
	if (element.kind === 'opening') {
		const g = openingGeometry(read, element);
		return {
			...base,
			resolved: g ? { segment: { a: p2(g.segment.a), b: p2(g.segment.b) }, start: p3(g.start), end: p3(g.end), clearWidth: m3(g.clearWidth), clearHeight: m3(g.clearHeight) } : null
		};
	}
	const space = evaluated?.spaces.find((s) => s.elementId === element.elementId);
	const row = spaceRows(read).find((s) => s.id === base.id) ?? null;
	const bounding = new Set(read.faces.filter((f) => f.face.role === `interior:${element.elementId}`).map((f) => `${read.moduleId}:${f.face.elementId}`));
	return {
		...base, space: row, ring: (space?.ring ?? []).slice(0, RING_LIMIT).map(p2), ringPoints: space?.ring.length ?? 0, holes: space?.holes.length ?? 0,
		boundingWalls: [...bounding].sort(cmp)
	};
}

function valueText(value: unknown): string {
	if (value === null) return '-';
	if (typeof value === 'number') return fm(value);
	if (typeof value === 'string') return q(value);
	if (Array.isArray(value)) return typeof value[0] === 'number' ? fp(value as number[]) : (value as number[][]).map(fp).join(' ');
	if (typeof value === 'object') return Object.entries(value!).map(([k, v]) => `${k}:${v}`).join(',');
	return String(value);
}

function elementLines(e: ReturnType<typeof elementSummary>): string[] {
	const COUNTS = new Set(['pathPoints', 'outlinePoints', 'holes']);
	const p = e.parameters;
	const params = Object.entries(p)
		.filter(([key]) => !['pathPoints', 'outlinePoints'].includes(key))
		.map(([key, value]) => {
			const total = key === 'path' ? (p.pathPoints as number) : key === 'outline' ? (p.outlinePoints as number) : 0;
			return `${key} ${COUNTS.has(key) ? value : valueText(value)}${total > RING_LIMIT ? ` +${total - RING_LIMIT} more` : ''}`;
		});
	const lines = [`${e.id}  ${e.kind}  frame ${e.frame}${e.state === 'ok' ? '' : `  ${STATE_NOTES[e.state]}`}`, `  ${params.join('  ')}`];
	if (e.bounds) lines.push(`  bounds ${fbounds(e.bounds)}`);
	if ('length' in e) {
		lines.push(`  length ${fm(e.length)}`);
		if (e.junctions) lines.push(...(e.junctions.length ? e.junctions.map((j) => `  junction ${j.type} at ${fp(j.at)}${j.with.length ? ` with ${j.with.join(', ')}` : ''}`) : ['  junctions none']));
		lines.push(...(e.openings.length ? e.openings.map((o) => `  opening ${o.id} ${o.openingType} along ${fm(o.along)} w ${fm(o.width)} h ${fm(o.height)} sill ${fm(o.sillHeight)}`) : ['  openings none']));
	}
	if ('volume' in e) lines.push(`  net area ${fa(e.area)} m²  volume ${fm(e.volume)} m³`);
	if ('resolved' in e && e.resolved) {
		const r = e.resolved;
		lines.push(`  segment ${fp(r.segment.a)}-${fp(r.segment.b)}  span ${fp(r.start)}-${fp(r.end)}  clear ${fm(r.clearWidth)}×${fm(r.clearHeight)}`);
	}
	if ('ring' in e) {
		if (e.space) lines.push(spaceLine(e.space));
		if (e.ringPoints) lines.push(`  ring ${e.ring.map(fp).join(' ')}${e.ringPoints > RING_LIMIT ? ` +${e.ringPoints - RING_LIMIT} more` : ''}${e.holes ? `  holes ${e.holes}` : ''}`);
		lines.push(`  bounding walls ${e.boundingWalls.join(', ') || 'none'}`);
	}
	if (e.faces !== null) lines.push(`  faces ${e.faces}  hard-edges ${e.hardEdges}`);
	lines.push(...(e.findings.length ? ['  findings:', ...e.findings.map((f) => '  ' + findingLine(f)), ...more(e.hiddenFindings, 'use check_model()').map((l) => '    ' + l)] : ['  findings none']));
	return lines;
}

function instanceSummary(scene: ReadScene, occurrence: Occurrence, occurrences: number, sums: ReturnType<typeof aggregates>) {
	const id = occurrence.path.at(-1) ?? scene.graph.rootInstanceId;
	const instance = scene.instanceById.get(id)!;
	const mesh = scene.meshByDefinition.get(occurrence.definitionId);
	const children = scene.graph.instances.filter((i) => i.ownerDefinitionId === occurrence.definitionId).sort((a, b) => cmp(a.id, b.id));
	const sum = sums.get(pathKey(occurrence.path));
	const materials = new Set((mesh?.faces ?? []).flatMap((f) => [f.frontMaterialId, f.backMaterialId]).concat(instance.materialId).flatMap((m) => scene.materialName(m) ?? []));
	const moduleId = scene.managedByInstance.get(id) ?? null;
	const read = moduleId === null ? null : scene.modules.get(moduleId)!;
	return {
		type: 'instance' as const, id, kind: instance.kind, name: instance.name, frame: 'world',
		definition: { id: occurrence.definitionId, name: scene.definitionById.get(occurrence.definitionId)?.name ?? '' },
		path: [...occurrence.path], occurrences, managed: read ? { moduleId: read.moduleId, state: read.state } : null,
		bounds: b3(sum?.bounds ?? null),
		// A managed container's matrix already holds CONVENTION · T; its placement is the module transform T.
		placement: placementRow(read ? decompose(TO_Z_UP.clone().multiply(occurrence.matrix)) : freeformPlacement(occurrence.matrix)),
		faces: mesh?.faces.length ?? 0, subtreeFaces: sum?.faces ?? 0,
		children: children.slice(0, CHILD_LIMIT).map((c) => ({ id: c.id, kind: c.kind, name: c.name })), hiddenChildren: Math.max(0, children.length - CHILD_LIMIT),
		materials: [...materials].sort(cmp), tag: scene.tagOf(id), visible: id === scene.graph.rootInstanceId || scene.visible(id)
	};
}

function instanceLines(i: ReturnType<typeof instanceSummary>): string[] {
	return [
		`${i.id}  ${i.kind}  ${q(i.name)}  frame ${i.frame}${i.managed ? `  managed ${i.managed.moduleId} ${i.managed.state}` : ''}`,
		`  definition ${i.definition.id} ${q(i.definition.name)}  path ${pathText(i.path)}${i.occurrences > 1 ? `  occurrences ${i.occurrences} (first shown)` : ''}`,
		`  bounds ${fbounds(i.bounds)}  placement ${placementText(i.placement)}`,
		`  faces ${i.faces}  faces-with-children ${i.subtreeFaces}  tag ${i.tag === null ? '-' : q(i.tag)}  visible ${i.visible ? 'yes' : 'no'}`,
		`  materials ${i.materials.map(q).join(', ') || 'none'}`,
		...(i.children.length ? i.children.map((c) => `  child ${c.id} ${c.kind} ${q(c.name)}`) : ['  children none']),
		...more(i.hiddenChildren, 'describe the children by id').map((l) => '  ' + l)
	];
}

const worldOf = (o: Occurrence): Matrix4 => TO_Z_UP.clone().multiply(o.matrix);

export function describeElement(scene: ReadScene, revision: number, args: ReturnType<typeof parseElementArgs>): Record<string, unknown> {
	const resolve = resolver(scene);
	const entries = args.ids.map((id) => ({ id, hit: resolve(id) }));
	const missing = entries.filter((e) => !e.hit).map((e) => e.id);
	if (missing.length === entries.length) throw new AgentToolFailure('NOT_FOUND', `None of the ids exist: ${missing.map((id) => q(id)).join(', ')}.`, { ids: missing });
	const header = `describe_element · revision ${revision} · ${args.detail}`;
	const missingLines = missing.map((id) => `${q(id)}  not found`);

	if (args.detail === 'summary') {
		const findings = collectSceneFindings(scene);
		const sums = aggregates(scene);
		type FaceItem = { type: 'face'; path: string[]; occurrences: number } & ReturnType<typeof faceRow>;
		const items = entries.flatMap(({ hit }): (ReturnType<typeof elementSummary> | ReturnType<typeof instanceSummary> | FaceItem)[] => {
			if (!hit) return [];
			if (hit.kind === 'element') return [elementSummary(scene, hit.read, hit.element, findings)];
			if (hit.kind === 'instance') return [instanceSummary(scene, hit.occurrence, hit.occurrences, sums)];
			return [
				hit.kind === 'arch-face'
					? { type: 'face' as const, ...faceRow(archFaceGeometry(hit.ref, null), `module ${hit.read.moduleId}`), path: [...hit.read.path], occurrences: hit.read.placements.length }
					: { type: 'face' as const, ...faceRow(graphFaceGeometry(scene, hit.mesh, hit.face, worldOf(hit.occurrence)), 'world'), path: [...hit.occurrence.path], occurrences: hit.occurrences }
			];
		});
		const data = { tool: 'describe_element' as const, format: 'json' as const, revision, detail: args.detail, items, missing };
		if (args.format === 'json') return data;
		const lines = data.items.flatMap((item) =>
			item.type === 'element'
				? elementLines(item)
				: item.type === 'instance'
					? instanceLines(item)
					: [`face  frame ${item.frame}${item.element ? `  element ${item.element}` : ''}  path ${pathText(item.path)}${item.occurrences > 1 ? `  occurrences ${item.occurrences} (first shown)` : ''}`, faceLine(item)]
		);
		return { format: 'text', text: [header, ...lines, ...missingLines].join('\n') };
	}

	// Paged rows: only the requested page is turned into coordinates.
	const faces: (() => ReturnType<typeof faceRow>)[] = [];
	const edges: (() => ReturnType<typeof edgeRow>)[] = [];
	const notes: string[] = [];
	for (const { id, hit } of entries) {
		if (!hit) continue;
		if (hit.kind === 'element') {
			if (!hit.read.evaluated) notes.push(`${id}: no geometry (${hit.read.failure ? 'not evaluable' : hit.read.state})`);
			if (args.detail === 'faces') for (const ref of facesOf(hit.read, hit.element)) faces.push(() => faceRow(archFaceGeometry(ref, null), `module ${ref.moduleId}`));
			else for (const ref of edgesOf(hit.read, hit.element)) edges.push(() => edgeRow(archEdgeGeometry(ref, null), `module ${ref.moduleId}`));
		} else if (hit.kind === 'arch-face') {
			if (args.detail === 'faces') faces.push(() => faceRow(archFaceGeometry(hit.ref, null), `module ${hit.read.moduleId}`));
			else for (const ref of hit.read.edges.filter((e) => e.part === hit.ref.part && e.edge.faces.includes(hit.ref.face.id))) edges.push(() => edgeRow(archEdgeGeometry(ref, null), `module ${ref.moduleId}`));
		} else if (hit.kind === 'graph-face') {
			const owner = hit.occurrence.path.at(-1) ?? scene.graph.rootInstanceId;
			if (args.detail === 'faces') faces.push(() => faceRow(graphFaceGeometry(scene, hit.mesh, hit.face, worldOf(hit.occurrence)), 'world'));
			else for (const e of graphEdgeGeometries(hit.mesh, owner, worldOf(hit.occurrence)).filter((g) => g.faces.includes(hit.face.id))) edges.push(() => edgeRow(e, 'world'));
		} else {
			const moduleId = scene.managedByInstance.get(id);
			const read = moduleId === undefined ? undefined : scene.modules.get(moduleId)!;
			const mesh = scene.meshByDefinition.get(hit.occurrence.definitionId);
			if (read?.evaluated) {
				if (args.detail === 'faces') for (const ref of read.faces) faces.push(() => faceRow(archFaceGeometry(ref, null), `module ${ref.moduleId}`));
				else for (const ref of read.edges) edges.push(() => edgeRow(archEdgeGeometry(ref, null), `module ${ref.moduleId}`));
			} else if (mesh) {
				if (args.detail === 'faces') for (const face of mesh.faces) faces.push(() => faceRow(graphFaceGeometry(scene, mesh, face, worldOf(hit.occurrence)), 'world'));
				else for (const e of graphEdgeGeometries(mesh, id, worldOf(hit.occurrence))) edges.push(() => edgeRow(e, 'world'));
			}
		}
	}
	const total = args.detail === 'faces' ? faces.length : edges.length;
	const pages = Math.max(1, Math.ceil(total / args.pageSize));
	if (args.page >= pages) throw invalid(`page must be below ${pages} (${total} ${args.detail}, pageSize ${args.pageSize}).`, '/page');
	const slice = <T>(all: readonly (() => T)[]): T[] => all.slice(args.page * args.pageSize, (args.page + 1) * args.pageSize).map((make) => make());
	const data = {
		tool: 'describe_element' as const, format: 'json' as const, revision, detail: args.detail, page: args.page, pages, pageSize: args.pageSize, total,
		faces: slice(faces), edges: slice(edges), notes, missing
	};
	if (args.format === 'json') return data;
	let frame = '';
	const framed = (f: string, row: string): string[] => (f === frame ? [row] : ((frame = f), [`frame ${f}`, row]));
	const rows = [...data.faces.flatMap((f) => framed(f.frame, faceLine(f))), ...data.edges.flatMap((e) => framed(e.frame, edgeLine(e)))];
	return { format: 'text', text: [header, ...notes, ...rows, ...missingLines, `page ${data.page + 1}/${data.pages} (${data.total} ${data.detail}; page=${data.page})`].join('\n') };
}

// ─── query_region ────────────────────────────────────────────────────────────────────────────────────────────────

const INCLUDES = ['elements', 'instances', 'faces', 'edges'] as const;
type Include = (typeof INCLUDES)[number];

export function parseRegionArgs(raw: Record<string, unknown>) {
	const args = strictArgs('query_region', raw, ['box', 'point', 'radius', 'moduleId', 'include', 'limit', 'format']);
	let box: Bounds3 | null = null;
	let sphere: { point: P3; radius: number } | null = null;
	if (args.box !== undefined) {
		if (args.point !== undefined || args.radius !== undefined) throw invalid('Give either box, or point with radius.', '/box');
		const value = args.box as Record<string, unknown>;
		if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'max,min') throw invalid('box must be {min:[x,y,z], max:[x,y,z]}.', '/box');
		box = { min: point3(value.min, '/box/min'), max: point3(value.max, '/box/max') };
		if (box.min.some((v, k) => v > box!.max[k]!)) throw invalid('box.min must not exceed box.max on any axis.', '/box/min');
	} else {
		if (args.point === undefined || args.radius === undefined) throw invalid('Give either box, or point with radius.', '/box');
		if (typeof args.radius !== 'number' || !Number.isFinite(args.radius) || args.radius <= 0) throw invalid('radius must be a positive number.', '/radius');
		sphere = { point: point3(args.point, '/point'), radius: args.radius };
	}
	const include = args.include === undefined ? ['elements', 'instances'] : args.include;
	if (!Array.isArray(include) || include.length < 1 || include.some((v) => !INCLUDES.includes(v))) throw invalid(`include must list some of ${INCLUDES.join(', ')}.`, '/include');
	return { box, sphere, moduleId: optionalString(args, 'moduleId'), include: INCLUDES.filter((v) => (include as Include[]).includes(v)), limit: integer(args, 'limit', 1, 1000, 100), format: choice(args, 'format', FORMATS, 'text') };
}

type RegionRow = { kind: 'element' | 'instance' | 'face' | 'edge'; id: string; label: string; bounds: Bounds3 };

export function queryRegion(scene: ReadScene, revision: number, args: ReturnType<typeof parseRegionArgs>): Record<string, unknown> {
	if (args.moduleId !== null && !scene.modules.has(args.moduleId)) throw new AgentToolFailure('NOT_FOUND', `Module ${line(args.moduleId)} does not exist.`, { moduleId: args.moduleId });
	/** Closed intersection of an AABB with the region; `flat` ignores z (spaces are 2D). */
	const hit = (b: Bounds3, flat = false): boolean => {
		const axes = flat ? [0, 1] : [0, 1, 2];
		if (args.box) return axes.every((k) => b.max[k]! >= args.box!.min[k]! - 1e-9 && b.min[k]! <= args.box!.max[k]! + 1e-9);
		const gap = axes.map((k) => Math.max(0, b.min[k]! - args.sphere!.point[k]!, args.sphere!.point[k]! - b.max[k]!));
		return Math.hypot(...gap) <= args.sphere!.radius + 1e-9;
	};
	const want = new Set<Include>(args.include);
	const rows: RegionRow[] = [];
	const push = (kind: RegionRow['kind'], id: string, label: string, bounds: Bounds3 | null, flat = false) => {
		if (bounds && hit(bounds, flat)) rows.push({ kind, id, label, bounds: b3(bounds)! });
	};
	for (const read of scene.modules.values()) {
		if (args.moduleId !== null && read.moduleId !== args.moduleId) continue;
		if (!read.evaluated) continue;
		const frames: (Matrix4 | null)[] = args.moduleId !== null ? [null] : read.placements;
		frames.forEach((frame, n) => {
			const suffix = frames.length > 1 ? ` (occurrence ${n + 1}/${frames.length})` : '';
			const map = (p: P3): P3 => (frame ? apply(frame, p) : p);
			if (want.has('elements'))
				for (const element of read.module.elements) {
					const points = elementPoints(read, element);
					push('element', `${read.moduleId}:${element.elementId}`, element.kind + suffix, points ? boundsOf(points.map(map)) : null, element.kind === 'space');
				}
			if (want.has('faces'))
				for (const ref of read.faces) {
					const g = archFaceGeometry(ref, frame);
					push('face', g.id, (g.role ?? '-') + suffix, boundsOf(g.outer));
				}
			if (want.has('edges'))
				for (const ref of read.edges) {
					const g = archEdgeGeometry(ref, frame);
					push('edge', g.id, g.flag + suffix, boundsOf([g.a, g.b]));
				}
		});
	}
	if (args.moduleId === null) {
		const sums = aggregates(scene);
		for (const o of scene.occurrences) {
			const moduleId = managedModuleOfPath(scene, o.path);
			if (moduleId !== null && scene.modules.get(moduleId)!.evaluated) continue; // described by its elements
			const mesh = scene.meshByDefinition.get(o.definitionId);
			const toWorld = worldOf(o);
			const id = o.path.at(-1) ?? scene.graph.rootInstanceId;
			if (want.has('instances')) {
				// The root has no box of its own: only its loose faces are reported, under the root instance id.
				if (o.path.length === 0) push('instance', id, 'loose faces', mesh ? boundsOf(meshPoints(mesh, toWorld)) : null);
				else push('instance', id, `${scene.instanceById.get(id)!.kind} ${q(scene.instanceById.get(id)!.name)}`, sums.get(pathKey(o.path))?.bounds ?? null);
			}
			if (!mesh) continue;
			if (want.has('faces')) for (const face of mesh.faces) push('face', face.id, 'freeform', boundsOf(graphFaceGeometry(scene, mesh, face, toWorld).outer));
			if (want.has('edges')) for (const e of graphEdgeGeometries(mesh, id, toWorld)) push('edge', e.id, 'freeform', boundsOf([e.a, e.b]));
		}
	}
	const order = { element: 0, instance: 1, face: 2, edge: 3 } as const;
	rows.sort((a, b) => order[a.kind] - order[b.kind] || naturalCmp(a.id, b.id) || cmp(a.label, b.label));
	const shown = rows.slice(0, args.limit);
	const count = (kind: RegionRow['kind']) => rows.filter((r) => r.kind === kind).length;
	const state = args.moduleId === null ? null : scene.modules.get(args.moduleId)!;
	const data = {
		tool: 'query_region' as const, format: 'json' as const, revision, frame: args.moduleId === null ? 'world' : `module ${args.moduleId}`, include: args.include,
		region: args.box ? { box: b3(args.box)!, sphere: null } : { box: null, sphere: { point: p3(args.sphere!.point), radius: m3(args.sphere!.radius) } },
		counts: { element: count('element'), instance: count('instance'), face: count('face'), edge: count('edge') },
		matches: shown, hidden: rows.length - shown.length,
		note: state && !state.evaluated ? (state.failure ? 'NOT EVALUABLE' : STATE_NOTES[state.state]!) : null
	};
	if (args.format === 'json') return data;
	const region = data.region.box ? `box ${fbounds(data.region.box)}` : `point ${fp(data.region.sphere!.point)} radius ${fm(data.region.sphere!.radius)}`;
	const lines = [
		`query_region · revision ${revision} · frame ${data.frame} · ${region}`,
		`Matches: elements ${data.counts.element} · instances ${data.counts.instance} · faces ${data.counts.face} · edges ${data.counts.edge} (searched: ${data.include.join(', ')})`,
		...(data.note ? [data.note] : []),
		...data.matches.map((r) => `  ${r.kind}  ${r.id}  ${r.label}  ${fbounds(r.bounds)}`),
		...more(data.hidden, 'raise limit= or narrow the region')
	];
	return { format: 'text', text: lines.join('\n') };
}

// ─── measure ─────────────────────────────────────────────────────────────────────────────────────────────────────

const SUPPORTED = 'Supported: point–point, point–face, element/instance–element/instance (bbox-gap), and {spaceId} alone (clear width/depth/area).';

type Operand = { key: 'point'; point: P3 } | { key: 'faceId' | 'elementId' | 'instanceId' | 'spaceId'; id: string };

function operand(value: unknown, pointer: string): Operand {
	const record = value as Record<string, unknown>;
	const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(record).filter((k) => record[k] !== null) : [];
	const key = keys[0];
	if (keys.length !== 1 || !['point', 'faceId', 'elementId', 'instanceId', 'spaceId'].includes(key!)) {
		throw invalid('Expected exactly one of {point}, {faceId}, {elementId}, {instanceId} or {spaceId}.', pointer);
	}
	if (key === 'point') return { key, point: point3(record.point, `${pointer}/point`) };
	const id = record[key!];
	if (typeof id !== 'string' || id.length < 1 || id.length > 512) throw invalid(`${key} must be an id string.`, `${pointer}/${key}`);
	return { key: key as 'faceId', id };
}

export function parseMeasureArgs(raw: Record<string, unknown>) {
	const args = strictArgs('measure', raw, ['a', 'b', 'moduleId']);
	return { a: operand(args.a, '/a'), b: args.b === undefined ? null : operand(args.b, '/b'), moduleId: optionalString(args, 'moduleId') };
}

type V3 = readonly number[];
const sub = (a: V3, b: V3): P3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: V3, b: V3): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: V3, b: V3): P3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];

/** Signed distance to the face plane, whether the foot lies in the face polygon (its boundary counts), and the nearest face point. */
export function pointToFace(point: P3, face: Pick<FaceGeometry, 'outer' | 'holes' | 'normal'>): { signed: number; foot: P3; inside: boolean; nearest: P3; distance: number } {
	const n = face.normal;
	const signed = dot(sub(point, face.outer[0]!), n);
	const foot: P3 = [point[0] - signed * n[0], point[1] - signed * n[1], point[2] - signed * n[2]];
	const u0: P3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
	const w = cross(n, u0), length = Math.hypot(...w);
	const v: P3 = [w[0] / length, w[1] / length, w[2] / length];
	const u = cross(v, n);
	const flat = (p: V3): P2 => [dot(sub(p, foot), u), dot(sub(p, foot), v)];
	let crossings = 0;
	let nearest: P3 = face.outer[0]!, best = Infinity;
	for (const loop of [face.outer, ...face.holes])
		for (let i = 0; i < loop.length; i++) {
			const a3 = loop[i]!, c3 = loop[(i + 1) % loop.length]!;
			const a = flat(a3), c = flat(c3);
			if (a[1] <= 0 !== c[1] <= 0 && a[0] + (-a[1] / (c[1] - a[1])) * (c[0] - a[0]) > 0) crossings++;
			const d: P2 = [c[0] - a[0], c[1] - a[1]];
			const len2 = d[0] * d[0] + d[1] * d[1];
			const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(a[0] * d[0] + a[1] * d[1]) / len2));
			const distance = Math.hypot(a[0] + t * d[0], a[1] + t * d[1]);
			if (distance < best) {
				best = distance;
				nearest = [a3[0] + t * (c3[0] - a3[0]), a3[1] + t * (c3[1] - a3[1]), a3[2] + t * (c3[2] - a3[2])];
			}
		}
	const inside = crossings % 2 === 1 || best <= 1e-6;
	if (inside) nearest = foot;
	return { signed, foot, inside, nearest, distance: Math.hypot(...sub(point, nearest)) };
}

export function measure(scene: ReadScene, revision: number, args: ReturnType<typeof parseMeasureArgs>): Record<string, unknown> {
	if (args.moduleId !== null && !scene.modules.has(args.moduleId)) throw new AgentToolFailure('NOT_FOUND', `Module ${line(args.moduleId)} does not exist.`, { moduleId: args.moduleId });
	const unsupported = () => invalid(SUPPORTED, '/b');
	const resolve = resolver(scene);
	const find = (o: Exclude<Operand, { key: 'point' }>): Resolved => {
		// With moduleId, architectural ids may be given without their module prefix.
		const hit = (args.moduleId !== null ? resolve(`${args.moduleId}:${o.id}`) : null) ?? resolve(o.id);
		if (!hit) throw new AgentToolFailure('NOT_FOUND', `${o.key} ${q(o.id)} does not exist.`, { [o.key]: o.id });
		return hit;
	};
	const evaluated = (read: ReadModule, id: string): ReadModule => {
		if (read.evaluated) return read;
		throw new AgentToolFailure(read.state === 'detached' ? 'MODULE_DETACHED' : 'NOT_FOUND', `${q(id)} has no architectural geometry (${read.failure ? 'not evaluable' : read.state}).`, { moduleId: read.moduleId });
	};
	const moduleOf = (hit: Resolved): string | null => (hit.kind === 'element' || hit.kind === 'arch-face' ? hit.read.moduleId : null);

	const done = (frame: string, data: Record<string, unknown>, text: string) => ({ tool: 'measure', revision, frame, ...data, text: `measure · revision ${revision} · frame ${frame}\n${text}` });
	const { a, b } = args;

	if (a.key === 'spaceId') {
		if (b !== null) throw unsupported();
		const hit = find(a);
		if (hit.kind !== 'element' || hit.element.kind !== 'space') throw invalid(`${q(a.id)} is not a space.`, '/a/spaceId');
		const read = evaluated(hit.read, a.id);
		const row = spaceRows(read).find((s) => s.id === `${read.moduleId}:${hit.element.elementId}`)!;
		return done(`module ${read.moduleId}`, { kind: 'space', space: row }, spaceLine(row));
	}
	if (b === null || b.key === 'spaceId') throw unsupported();

	const hits = [a, b].map((o) => (o.key === 'point' ? null : find(o)));
	const modules = hits.map((h) => (h ? moduleOf(h) : null));
	// Frame: the given module; otherwise module-local only when both operands belong to the same module; otherwise world.
	const frameModule = args.moduleId ?? (modules[0] !== null && modules[0] === modules[1] ? modules[0] : null);
	const frame = frameModule === null ? 'world' : `module ${frameModule}`;
	const fromWorld = (): Matrix4 => {
		const placement = scene.modules.get(frameModule!)!.placements[0];
		if (!placement) throw new AgentToolFailure('NOT_FOUND', `Module ${frameModule} has no placement (orphaned).`, { moduleId: frameModule! });
		return placement.clone().invert();
	};
	/** Matrix from an architectural module's local frame into the result frame; null = already there. */
	const fromModule = (read: ReadModule): Matrix4 | null => {
		if (read.moduleId === frameModule) return null;
		const world = read.placements[0]!;
		return frameModule === null ? world : fromWorld().multiply(world);
	};
	const fromOccurrence = (o: Occurrence): Matrix4 => (frameModule === null ? worldOf(o) : fromWorld().multiply(worldOf(o)));

	if (a.key === 'point' && b.key === 'point') {
		const delta = sub(b.point, a.point);
		const data = { kind: 'point-point', distance: m3(Math.hypot(...delta)), delta: p3(delta) };
		return done(frame, data, `distance ${fm(data.distance)}  dx ${fm(data.delta[0])} dy ${fm(data.delta[1])} dz ${fm(data.delta[2])}`);
	}
	if ((a.key === 'point' && b.key === 'faceId') || (a.key === 'faceId' && b.key === 'point')) {
		const point = (a.key === 'point' ? a.point : (b as { point: P3 }).point);
		const hit = hits[a.key === 'faceId' ? 0 : 1]!;
		if (hit.kind !== 'arch-face' && hit.kind !== 'graph-face') throw invalid('faceId does not name a face.', a.key === 'faceId' ? '/a/faceId' : '/b/faceId');
		const face = hit.kind === 'arch-face' ? archFaceGeometry(hit.ref, fromModule(hit.read)) : graphFaceGeometry(scene, hit.mesh, hit.face, fromOccurrence(hit.occurrence));
		const r = pointToFace(point, face);
		const data = { kind: 'point-face', faceId: face.id, normal: p3(face.normal), signedDistance: m3(r.signed), inside: r.inside, foot: p3(r.foot), nearest: p3(r.nearest), distance: m3(r.distance) };
		return done(
			frame, data,
			`face ${face.id}  normal ${fp(data.normal)}  plane distance ${fm(data.signedDistance)}  foot ${fp(data.foot)} inside ${data.inside ? 'yes' : 'no'}  nearest ${fp(data.nearest)}  distance ${fm(data.distance)}`
		);
	}
	const boxed = (o: Operand, hit: Resolved | null, pointer: string): { id: string; bounds: Bounds3 } => {
		if (!hit || (o.key !== 'elementId' && o.key !== 'instanceId')) throw unsupported();
		let points: P3[] = [];
		let id = '';
		if (o.key === 'elementId') {
			if (hit.kind !== 'element' || hit.element.kind === 'space') throw invalid('elementId must name a wall, slab or opening (use {spaceId} alone for spaces).', pointer);
			const read = evaluated(hit.read, o.id), map = fromModule(read);
			id = `${read.moduleId}:${hit.element.elementId}`;
			points = (elementPoints(read, hit.element) ?? []).map((p) => (map ? apply(map, p) : p));
		} else {
			if (hit.kind !== 'instance') throw invalid('instanceId must name an instance.', pointer);
			id = hit.occurrence.path.at(-1) ?? scene.graph.rootInstanceId;
			const { path } = hit.occurrence;
			for (const child of scene.occurrences) {
				if (!path.every((p, k) => child.path[k] === p)) continue;
				const mesh = scene.meshByDefinition.get(child.definitionId);
				if (mesh) points.push(...meshPoints(mesh, fromOccurrence(child)));
			}
		}
		const bounds = boundsOf(points);
		if (!bounds) throw new AgentToolFailure('NOT_FOUND', `${q(o.key === 'elementId' || o.key === 'instanceId' ? (o as { id: string }).id : '')} has no geometry to measure.`);
		return { id, bounds };
	};
	const first = boxed(a, hits[0]!, '/a'), second = boxed(b, hits[1]!, '/b');
	const gap = [0, 1, 2].map((k) => Math.max(second.bounds.min[k]! - first.bounds.max[k]!, first.bounds.min[k]! - second.bounds.max[k]!)) as P3;
	const data = {
		kind: 'bbox-gap', a: { id: first.id, bounds: b3(first.bounds)! }, b: { id: second.id, bounds: b3(second.bounds)! }, gap: p3(gap),
		distance: m3(Math.hypot(...gap.map((g) => Math.max(0, g)))), overlapping: gap.every((g) => g < 0)
	};
	return done(
		frame, data,
		`bbox-gap  dx ${fm(data.gap[0])} dy ${fm(data.gap[1])} dz ${fm(data.gap[2])} (negative = overlap on that axis)  distance ${fm(data.distance)}  overlapping ${data.overlapping ? 'yes' : 'no'}\n` +
			`  a ${data.a.id}  ${fbounds(data.a.bounds)}\n  b ${data.b.id}  ${fbounds(data.b.bounds)}`
	);
}
