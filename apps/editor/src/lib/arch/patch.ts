/**
 * SIB-MCP-MODELING-001 v2.3 C10 & v2.4 A4/A7 (WP6) — `arch/patch.ts`.
 *
 * Validates `edit_model` arguments against `edit-model.schema.json`, applies the sequential
 * patch ops to cloned ArchModules, enforces detach/orphan/cascade/material rules, evaluates
 * surviving touched modules with `purpose: 'write'` (v2.4 A4/A7), computes findings diffs,
 * and returns staged `AgentEditBuilder[]` + receipt builder for `stageAndCommit`.
 */
import type { BomcGraph } from '@sibambo/bomc-document';
import { bakeModule, type BakeEntryInput } from './bake.js';
import { IDENTITY_ROW_MAJOR } from './convention.js';
import validateEditModelSchema from './edit-model.validator.generated.js';
import { AgentToolFailure, toAgentToolFailure } from './errors.js';
import { evaluateModule, type EvaluatedModule } from './evaluate.js';
import { collectManagedFindings, diffFindings, type FindingsDiff } from './findings.js';
import type { Kernel } from './kernel.js';
import { effectiveModuleTransform, readManaged, type ManagedModuleRecord } from './managed.js';
import { MAX_ARCH_MODULES, type ArchEntry } from './metadata.js';
import {
	canonicalJson,
	MAX_MODULE_CANONICAL_BYTES,
	utf8Bytes,
	validateArchModule,
	type ArchElement,
	type ArchModule
} from './schema.js';
import type { AgentCommit, AgentEditBuilder } from './tools.js';

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_ELEMENTS_PER_MODULE = 128;

type MaterialSpec = ArchModule['materials'][number];

type EditChange =
	| { op: 'create_module'; moduleId: string; name?: string; transform?: number[]; materials?: MaterialSpec[] }
	| { op: 'remove_module'; moduleId: string }
	| { op: 'set_module'; moduleId: string; name?: string | null; transform?: number[] }
	| { op: 'add'; moduleId: string; element: ArchElement }
	| { op: 'update'; moduleId: string; elementId: string; set: Record<string, unknown> }
	| { op: 'remove'; moduleId: string; elementId: string; cascade?: boolean }
	| { op: 'set_material'; moduleId: string; material: MaterialSpec }
	| { op: 'remove_material'; moduleId: string; materialId: string };

type EditModelArgs = {
	changes: EditChange[];
	baseRevision?: number | null;
};

type WorkingModule = {
	moduleId: string;
	status: 'ok' | 'detached' | 'orphaned' | 'created' | 'removed';
	existingEntry: ArchEntry | null;
	replacedEntry: ArchEntry | null;
	module: ArchModule | null;
	transformExplicitlySet: boolean;
	touched: boolean;
	added: Set<string>;
	updated: Set<string>;
	removed: Set<string>;
};

export type ModuleReceipt = {
	moduleId: string;
	revision: number;
	added: string[];
	updated: string[];
	removed: string[];
	stats: { faces: number; hardEdges: number; triangles: number };
	bounds: { min: [number, number, number]; max: [number, number, number] } | null;
};

export type EditModelPlan = {
	builders: AgentEditBuilder[];
	receipt: (commit: AgentCommit) => {
		revision: number;
		entityIds: string[];
		modules: ModuleReceipt[];
		findings: FindingsDiff;
		next: string[];
	};
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function assertAffineTransform(t: readonly number[], pointer: string): void {
	if (t.length !== 16 || t.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
		throw new AgentToolFailure('INVALID_ELEMENT', 'Module transform must contain 16 finite numbers.', { pointer });
	}
	if (Math.abs(t[12]!) > 1e-9 || Math.abs(t[13]!) > 1e-9 || Math.abs(t[14]!) > 1e-9 || Math.abs(t[15]! - 1) > 1e-9) {
		throw new AgentToolFailure('INVALID_ELEMENT', 'Module transform bottom row must be [0, 0, 0, 1].', { pointer });
	}
	const det =
		t[0]! * (t[5]! * t[10]! - t[6]! * t[9]!) -
		t[1]! * (t[4]! * t[10]! - t[6]! * t[8]!) +
		t[2]! * (t[4]! * t[9]! - t[5]! * t[8]!);
	if (!Number.isFinite(det) || Math.abs(det) <= 1e-9) {
		throw new AgentToolFailure('INVALID_ELEMENT', 'Module transform must be invertible.', { pointer });
	}
}

function validateArgs(args: Record<string, unknown>): EditModelArgs {
	let bytes: number;
	try {
		bytes = utf8Bytes(JSON.stringify(args));
	} catch {
		throw new AgentToolFailure('INVALID_REQUEST', 'edit_model arguments must be JSON-serializable.');
	}
	if (bytes > MAX_REQUEST_BYTES) {
		throw new AgentToolFailure('BUDGET_EXCEEDED', `edit_model request (${bytes} B) exceeds 256 KiB.`, { bytes });
	}
	if (!validateEditModelSchema(args)) {
		const errors = ((validateEditModelSchema as any).errors ?? []) as Array<{
			instancePath?: string;
			keyword?: string;
			message?: string;
		}>;
		const overChanges = errors.find((e) => e.instancePath === '/changes' && e.keyword === 'maxItems');
		if (overChanges) {
			throw new AgentToolFailure('BUDGET_EXCEEDED', 'edit_model accepts at most 64 changes per call.');
		}
		const first = errors[0];
		const pointer = first?.instancePath ?? '';
		const message = first?.message ? `${pointer || '/'}: ${first.message}` : 'Invalid edit_model arguments.';
		if (pointer.startsWith('/changes/')) {
			throw new AgentToolFailure('INVALID_ELEMENT', message, { pointer });
		}
		throw new AgentToolFailure('INVALID_REQUEST', message, { pointer });
	}
	return args as unknown as EditModelArgs;
}

function bakedTriangleCount(evaluated: EvaluatedModule): number {
	let total = 0;
	for (const part of evaluated.parts) {
		for (const face of part.topology.faces) {
			const holeVerts = face.holes.reduce((sum, hole) => sum + hole.length, 0);
			total += face.outer.length + holeVerts + 2 * face.holes.length - 2;
		}
	}
	return total;
}

function evaluatedStats(evaluated: EvaluatedModule): { faces: number; hardEdges: number; triangles: number } {
	let faces = 0;
	let hardEdges = 0;
	for (const part of evaluated.parts) {
		faces += part.topology.faces.length;
		for (const edge of part.topology.edges) {
			if (edge.flag === 'hard') hardEdges += 1;
		}
	}
	return { faces, hardEdges, triangles: bakedTriangleCount(evaluated) };
}

function buildNextHints(findings: FindingsDiff, modules: readonly ModuleReceipt[]): string[] {
	const hints: string[] = [];
	if (findings.totals.ERROR > 0) {
		hints.push(`Fix ${findings.totals.ERROR} ERROR finding(s) reported in findings.new or inspect with describe_scene.`);
	} else if (findings.totals.WARNING > 0) {
		hints.push(`${findings.totals.WARNING} WARNING finding(s) present; inspect with describe_scene or review findings.new.`);
	}
	if (modules.some((m) => m.added.length > 0 || m.updated.length > 0)) {
		hints.push('Verify layout with get_floor_plan or describe_scene.');
	}
	return hints;
}

export function planEditModel(graph: BomcGraph, args: Record<string, unknown>, kernel: Kernel): EditModelPlan {
	const parsed = validateArgs(args);
	const existingRecords = readManaged(graph);

	const states = new Map<string, WorkingModule>();
	for (const [moduleId, rec] of existingRecords) {
		if (rec.state === 'ok') {
			const cloned = structuredClone(rec.entry.module);
			cloned.transform = effectiveModuleTransform(rec);
			states.set(moduleId, {
				moduleId,
				status: 'ok',
				existingEntry: rec.entry,
				replacedEntry: null,
				module: cloned,
				transformExplicitlySet: false,
				touched: false,
				added: new Set(),
				updated: new Set(),
				removed: new Set()
			});
		} else if (rec.state === 'detached') {
			states.set(moduleId, {
				moduleId,
				status: 'detached',
				existingEntry: rec.entry,
				replacedEntry: null,
				module: null,
				transformExplicitlySet: false,
				touched: false,
				added: new Set(),
				updated: new Set(),
				removed: new Set()
			});
		} else {
			states.set(moduleId, {
				moduleId,
				status: 'orphaned',
				existingEntry: rec.entry,
				replacedEntry: null,
				module: null,
				transformExplicitlySet: false,
				touched: false,
				added: new Set(),
				updated: new Set(),
				removed: new Set()
			});
		}
	}

	const requireAttached = (moduleId: string, pointer: string): WorkingModule => {
		const st = states.get(moduleId);
		if (!st || st.status === 'removed') {
			throw new AgentToolFailure('NOT_FOUND', `Managed module ${moduleId} does not exist.`, { moduleId, pointer });
		}
		if (st.status === 'detached') {
			throw new AgentToolFailure('MODULE_DETACHED', `Managed module ${moduleId} was edited inside its container and is detached.`, { moduleId, pointer });
		}
		if (st.status === 'orphaned' || !st.module) {
			throw new AgentToolFailure(
				'NOT_FOUND',
				`Managed module ${moduleId} is orphaned (its container was removed). Use remove_module or create_module.`,
				{ moduleId, state: 'orphaned', pointer }
			);
		}
		return st;
	};

	const markRemovedId = (st: WorkingModule, elementId: string) => {
		if (st.added.has(elementId)) {
			st.added.delete(elementId);
		} else {
			st.updated.delete(elementId);
			st.removed.add(elementId);
		}
	};

	parsed.changes.forEach((change, index) => {
		const ptr = `/changes/${index}`;
		switch (change.op) {
			case 'create_module': {
				const cur = states.get(change.moduleId);
				if (cur?.status === 'detached') {
					throw new AgentToolFailure('MODULE_DETACHED', `Managed module ${change.moduleId} is detached.`, {
						moduleId: change.moduleId,
						pointer: `${ptr}/moduleId`
					});
				}
				if (cur && (cur.status === 'ok' || cur.status === 'created')) {
					throw new AgentToolFailure('INVALID_ELEMENT', `Module ${change.moduleId} already exists.`, {
						moduleId: change.moduleId,
						pointer: `${ptr}/moduleId`
					});
				}
				if (change.transform !== undefined) assertAffineTransform(change.transform, `${ptr}/transform`);
				const hadAttachedRemoval =
					cur?.status === 'removed' && cur.existingEntry !== null && existingRecords.get(change.moduleId)?.state === 'ok';
				const replacedEntry = hadAttachedRemoval ? cur!.existingEntry : null;
				const module: ArchModule = {
					schemaVersion: '2.0.0',
					moduleId: change.moduleId,
					...(change.name !== undefined ? { name: change.name } : {}),
					revision: 1,
					transform: change.transform ? [...change.transform] : [...IDENTITY_ROW_MAJOR],
					materials: structuredClone(change.materials ?? []),
					elements: []
				};
				states.set(change.moduleId, {
					moduleId: change.moduleId,
					status: 'created',
					existingEntry: hadAttachedRemoval ? null : (cur?.existingEntry ?? null),
					replacedEntry,
					module,
					transformExplicitlySet: true,
					touched: true,
					added: new Set(),
					updated: new Set(),
					removed: new Set(replacedEntry ? replacedEntry.module.elements.map((e) => e.elementId) : [])
				});
				break;
			}
			case 'remove_module': {
				const cur = states.get(change.moduleId);
				if (!cur || cur.status === 'removed') {
					throw new AgentToolFailure('NOT_FOUND', `Managed module ${change.moduleId} does not exist.`, {
						moduleId: change.moduleId,
						pointer: `${ptr}/moduleId`
					});
				}
				if (cur.status === 'detached') {
					throw new AgentToolFailure('MODULE_DETACHED', `Managed module ${change.moduleId} is detached and cannot be removed.`, {
						moduleId: change.moduleId,
						pointer: `${ptr}/moduleId`
					});
				}
				if (cur.status === 'created' && !cur.existingEntry && !cur.replacedEntry) {
					states.delete(change.moduleId);
					break;
				}
				if (cur.replacedEntry) {
					cur.existingEntry = cur.replacedEntry;
					cur.replacedEntry = null;
				}
				cur.status = 'removed';
				cur.touched = true;
				cur.module = null;
				cur.added.clear();
				cur.updated.clear();
				cur.removed = new Set(cur.existingEntry ? cur.existingEntry.module.elements.map((e) => e.elementId) : []);
				break;
			}
			case 'set_module': {
				const st = requireAttached(change.moduleId, `${ptr}/moduleId`);
				if (change.name === undefined && change.transform === undefined) {
					throw new AgentToolFailure('INVALID_ELEMENT', 'set_module requires at least name or transform.', {
						moduleId: change.moduleId,
						pointer: ptr
					});
				}
				if (change.name !== undefined) {
					if (change.name === null) delete st.module!.name;
					else st.module!.name = change.name;
				}
				if (change.transform !== undefined) {
					assertAffineTransform(change.transform, `${ptr}/transform`);
					st.module!.transform = [...change.transform];
					st.transformExplicitlySet = true;
				}
				st.touched = true;
				break;
			}
			case 'add': {
				const st = requireAttached(change.moduleId, `${ptr}/moduleId`);
				if (st.module!.elements.some((e) => e.elementId === change.element.elementId)) {
					throw new AgentToolFailure('INVALID_ELEMENT', `Duplicate elementId ${change.element.elementId} in ${change.moduleId}.`, {
						moduleId: change.moduleId,
						elementId: change.element.elementId,
						pointer: `${ptr}/element/elementId`
					});
				}
				st.module!.elements.push(structuredClone(change.element));
				if (st.removed.has(change.element.elementId)) {
					st.removed.delete(change.element.elementId);
					st.updated.add(change.element.elementId);
				} else {
					st.added.add(change.element.elementId);
				}
				st.touched = true;
				break;
			}
			case 'update': {
				const st = requireAttached(change.moduleId, `${ptr}/moduleId`);
				const idx = st.module!.elements.findIndex((e) => e.elementId === change.elementId);
				if (idx < 0) {
					throw new AgentToolFailure('NOT_FOUND', `Element ${change.elementId} was not found in ${change.moduleId}.`, {
						moduleId: change.moduleId,
						elementId: change.elementId,
						pointer: `${ptr}/elementId`
					});
				}
				if ('kind' in change.set || 'elementId' in change.set) {
					throw new AgentToolFailure('INVALID_ELEMENT', 'Element kind and elementId are immutable.', {
						moduleId: change.moduleId,
						elementId: change.elementId,
						pointer: `${ptr}/set`
					});
				}
				const nextEl = structuredClone(st.module!.elements[idx]!) as Record<string, unknown>;
				for (const [key, val] of Object.entries(change.set)) {
					if (val === null) delete nextEl[key];
					else nextEl[key] = structuredClone(val);
				}
				st.module!.elements[idx] = nextEl as ArchElement;
				if (!st.added.has(change.elementId)) st.updated.add(change.elementId);
				st.touched = true;
				break;
			}
			case 'remove': {
				const st = requireAttached(change.moduleId, `${ptr}/moduleId`);
				const idx = st.module!.elements.findIndex((e) => e.elementId === change.elementId);
				if (idx < 0) {
					throw new AgentToolFailure('NOT_FOUND', `Element ${change.elementId} was not found in ${change.moduleId}.`, {
						moduleId: change.moduleId,
						elementId: change.elementId,
						pointer: `${ptr}/elementId`
					});
				}
				const target = st.module!.elements[idx]!;
				if (target.kind === 'wall') {
					const hosted = st.module!.elements.filter((e) => e.kind === 'opening' && e.hostElementId === target.elementId).map((e) => e.elementId);
					if (hosted.length > 0 && change.cascade !== true) {
						throw new AgentToolFailure(
							'INVALID_ELEMENT',
							`Wall ${target.elementId} hosts openings (${hosted.join(', ')}); pass cascade:true to remove them.`,
							{
								moduleId: change.moduleId,
								elementId: target.elementId,
								hostedOpenings: hosted,
								pointer: `${ptr}/cascade`
							}
						);
					}
					const toDrop = new Set([target.elementId, ...hosted]);
					st.module!.elements = st.module!.elements.filter((e) => !toDrop.has(e.elementId));
					for (const id of toDrop) markRemovedId(st, id);
				} else {
					st.module!.elements.splice(idx, 1);
					markRemovedId(st, target.elementId);
				}
				st.touched = true;
				break;
			}
			case 'set_material': {
				const st = requireAttached(change.moduleId, `${ptr}/moduleId`);
				const mat = structuredClone(change.material);
				const idx = st.module!.materials.findIndex((m) => m.materialId === mat.materialId);
				if (idx >= 0) st.module!.materials[idx] = mat;
				else st.module!.materials.push(mat);
				st.touched = true;
				break;
			}
			case 'remove_material': {
				const st = requireAttached(change.moduleId, `${ptr}/moduleId`);
				if (change.materialId.startsWith('sib-')) {
					throw new AgentToolFailure('INVALID_ELEMENT', `Built-in material ${change.materialId} cannot be removed.`, {
						moduleId: change.moduleId,
						pointer: `${ptr}/materialId`
					});
				}
				const idx = st.module!.materials.findIndex((m) => m.materialId === change.materialId);
				if (idx < 0) {
					throw new AgentToolFailure('NOT_FOUND', `Material ${change.materialId} was not found in ${change.moduleId}.`, {
						moduleId: change.moduleId,
						pointer: `${ptr}/materialId`
					});
				}
				const usedBy = st.module!.elements.find((e) => e.materialId === change.materialId);
				if (usedBy) {
					throw new AgentToolFailure(
						'INVALID_ELEMENT',
						`Material ${change.materialId} is referenced by element ${usedBy.elementId}.`,
						{ moduleId: change.moduleId, elementId: usedBy.elementId, pointer: `${ptr}/materialId` }
					);
				}
				st.module!.materials.splice(idx, 1);
				st.touched = true;
				break;
			}
		}
	});

	const activeCount = [...states.values()].filter((s) => s.status !== 'removed').length;
	if (activeCount > MAX_ARCH_MODULES) {
		throw new AgentToolFailure('BUDGET_EXCEEDED', `Document exceeds ${MAX_ARCH_MODULES} managed modules.`);
	}

	const touched = [...states.values()].filter((s) => s.touched).sort((a, b) => cmp(a.moduleId, b.moduleId));
	const evaluatedAfterTouched = new Map<string, EvaluatedModule>();

	for (const st of touched) {
		if (st.status === 'removed' || !st.module) continue;
		if (st.module.elements.length > MAX_ELEMENTS_PER_MODULE) {
			throw new AgentToolFailure('BUDGET_EXCEEDED', `Module ${st.moduleId} exceeds ${MAX_ELEMENTS_PER_MODULE} elements.`, {
				moduleId: st.moduleId
			});
		}
		if (utf8Bytes(canonicalJson(st.module)) > MAX_MODULE_CANONICAL_BYTES) {
			throw new AgentToolFailure('BUDGET_EXCEEDED', `Module ${st.moduleId} canonical JSON exceeds 64 KiB.`, {
				moduleId: st.moduleId
			});
		}
		try {
			validateArchModule(st.module);
			// v2.4 A4/A7: agent writes MUST evaluate with purpose:'write' (reject staggered continuations).
			const evaluated = evaluateModule(st.module, kernel, { purpose: 'write' });
			evaluatedAfterTouched.set(st.moduleId, evaluated);
		} catch (error) {
			throw toAgentToolFailure(error);
		}
	}

	// Findings before and after (using purpose:'read' for pre-existing modules).
	const beforeEvaluated = new Map<string, EvaluatedModule>();
	for (const [moduleId, rec] of existingRecords) {
		if (rec.state === 'ok') {
			beforeEvaluated.set(moduleId, evaluateModule(rec.entry.module, kernel, { purpose: 'read' }));
		}
	}
	const beforeFindings = collectManagedFindings(existingRecords, beforeEvaluated);

	const afterRecords = new Map<string, ManagedModuleRecord>();
	const afterEvaluated = new Map<string, EvaluatedModule>();
	const moduleReceipts: ModuleReceipt[] = [];

	for (const [moduleId, st] of [...states.entries()].sort((a, b) => cmp(a[0], b[0]))) {
		if (st.status === 'removed') continue;
		if (st.status === 'detached' || st.status === 'orphaned') {
			const existingRec = existingRecords.get(moduleId)!;
			afterRecords.set(moduleId, existingRec);
			continue;
		}
		const evaluated = evaluatedAfterTouched.get(moduleId) ?? beforeEvaluated.get(moduleId)!;
		afterEvaluated.set(moduleId, evaluated);
		const nextRevision =
			st.status === 'created'
				? 1
				: st.touched
					? st.existingEntry!.module.revision + 1
					: st.existingEntry!.module.revision;
		const nextModule: ArchModule = { ...st.module!, revision: nextRevision };
		afterRecords.set(moduleId, {
			entry: {
				instanceId: st.existingEntry?.instanceId ?? '',
				module: nextModule,
				bakedMeshSha256: st.existingEntry?.bakedMeshSha256 ?? ''
			},
			instance: existingRecords.get(moduleId)?.instance ?? null,
			state: 'ok'
		});
	}

	const afterFindings = collectManagedFindings(afterRecords, afterEvaluated);
	const findings = diffFindings(beforeFindings, afterFindings);

	// Order operations deterministically: removals first, then creates/updates.
	const removals = touched.filter((st) => st.status === 'removed');
	const upserts = touched.filter((st) => st.status !== 'removed');
	const ordered = [...removals, ...upserts];

	for (const st of ordered) {
		if (st.status === 'removed') {
			moduleReceipts.push({
				moduleId: st.moduleId,
				revision: st.existingEntry!.module.revision,
				added: [],
				updated: [],
				removed: [...st.removed].sort(cmp),
				stats: { faces: 0, hardEdges: 0, triangles: 0 },
				bounds: null
			});
		} else {
			const evaluated = evaluatedAfterTouched.get(st.moduleId)!;
			const nextRevision = st.status === 'created' ? 1 : st.existingEntry!.module.revision + 1;
			moduleReceipts.push({
				moduleId: st.moduleId,
				revision: nextRevision,
				added: [...st.added].sort(cmp),
				updated: [...st.updated].sort(cmp),
				removed: [...st.removed].sort(cmp),
				stats: evaluatedStats(evaluated),
				bounds: evaluated.bounds
			});
		}
	}
	moduleReceipts.sort((a, b) => cmp(a.moduleId, b.moduleId));

	const builders: AgentEditBuilder[] = [];
	for (const st of ordered) {
		if (st.status === 'removed') {
			builders.push((stagedGraph, sequence) => {
				try {
					const baked = bakeModule(stagedGraph, st.existingEntry!, null, sequence, 1);
					return { entityId: baked.instanceId || st.moduleId, forward: baked.forward, inverse: baked.inverse };
				} catch (error) {
					throw toAgentToolFailure(error);
				}
			});
			continue;
		}
		if (st.replacedEntry) {
			const oldEntry = st.replacedEntry;
			builders.push((stagedGraph, sequence) => {
				try {
					const baked = bakeModule(stagedGraph, oldEntry, null, sequence, 1);
					return { entityId: baked.instanceId || st.moduleId, forward: baked.forward, inverse: baked.inverse };
				} catch (error) {
					throw toAgentToolFailure(error);
				}
			});
		}
		builders.push((stagedGraph, sequence) => {
			try {
				const evaluated = evaluatedAfterTouched.get(st.moduleId)!;
				const input: BakeEntryInput = {
					module: st.module!,
					existing: st.status === 'created' ? null : st.existingEntry,
					applyTransform: st.transformExplicitlySet
				};
				const baked = bakeModule(stagedGraph, input, evaluated, sequence, 1);
				return { entityId: baked.instanceId, forward: baked.forward, inverse: baked.inverse };
			} catch (error) {
				throw toAgentToolFailure(error);
			}
		});
	}

	return {
		builders,
		receipt: (commit: AgentCommit) => ({
			revision: commit.revision,
			entityIds: commit.entityIds,
			modules: moduleReceipts,
			findings,
			next: buildNextHints(findings, moduleReceipts)
		})
	};
}
