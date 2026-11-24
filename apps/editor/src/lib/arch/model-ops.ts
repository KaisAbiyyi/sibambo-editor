/**
 * SIB-MCP-MODELING-001 v2.3 C11 (WP7) — `arch/model-ops.ts`.
 *
 * Validates `model_ops` arguments against `model-ops.schema.json`, refuses targeting
 * managed architecture groups (`MANAGED_MODULE`), lowers every op into a `MODEL_EDIT`
 * builder backed by `model.ts::buildModelEdit(stagedGraph, path, action, S + k)` for
 * `stageAndCommit` (atomic scratch staging + composite history entry), and computes
 * world-space receipt `entityIds` and `bounds`.
 */
import type { BomcGraph, DocumentEdit } from '@sibambo/bomc-document';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { Vector3 } from 'three';
import { buildModelEdit, definitionGraph, modelMetadata, modelOccurrences } from '../authoring/model.js';
import type { FlatAuthoringCommand, ModelAction, ModelSelection } from '../authoring/protocol.js';
import { AgentToolFailure } from './errors.js';
import validateModelOpsSchema from './model-ops.validator.generated.js';
import { utf8Bytes } from './schema.js';
import type { AgentCommit, AgentEditBuilder } from './tools.js';

const MAX_REQUEST_BYTES = 256 * 1024;

type ModelOpInput =
	| { path?: string[]; command: FlatAuthoringCommand }
	| { path?: string[]; action: ModelAction };

type ModelOpsArgs = {
	ops: ModelOpInput[];
	baseRevision?: number | null;
};

export type ModelOpsBounds = {
	min: [number, number, number];
	max: [number, number, number];
};

export type ModelOpsPlan = {
	builders: AgentEditBuilder[];
	receipt: (commit: AgentCommit) => {
		revision: number;
		entityIds: string[];
		bounds: ModelOpsBounds | null;
		changed: boolean;
	};
};

const cleanZero = (v: number): number => (v === 0 ? 0 : v);

function validateArgs(args: Record<string, unknown>): ModelOpsArgs {
	let bytes: number;
	try {
		bytes = utf8Bytes(JSON.stringify(args));
	} catch {
		throw new AgentToolFailure('INVALID_REQUEST', 'model_ops arguments must be JSON-serializable.');
	}
	if (bytes > MAX_REQUEST_BYTES) {
		throw new AgentToolFailure('BUDGET_EXCEEDED', `model_ops request (${bytes} B) exceeds 256 KiB.`, { bytes });
	}
	if (!validateModelOpsSchema(args)) {
		const errors = ((validateModelOpsSchema as any).errors ?? []) as Array<{
			instancePath?: string;
			keyword?: string;
			message?: string;
		}>;
		const overOps = errors.find((e) => e.instancePath === '/ops' && e.keyword === 'maxItems');
		if (overOps) {
			throw new AgentToolFailure('BUDGET_EXCEEDED', 'model_ops accepts at most 32 ops per call.');
		}
		const first = errors[0];
		const pointer = first?.instancePath ?? '';
		const message = first?.message ? `${pointer || '/'}: ${first.message}` : 'Invalid model_ops arguments.';
		throw new AgentToolFailure('INVALID_REQUEST', message, { pointer });
	}
	return args as unknown as ModelOpsArgs;
}

type ManagedTargets = {
	instToModule: Map<string, string>;
	faceToModule: Map<string, string>;
};

function collectManagedTargets(graph: BomcGraph): ManagedTargets {
	const instToModule = new Map<string, string>();
	const faceToModule = new Map<string, string>();
	const arch = modelMetadata(graph).arch;
	if (!arch || arch.modules.length === 0) return { instToModule, faceToModule };

	const instById = new Map(graph.instances.map((i) => [i.id, i]));
	const defById = new Map(graph.definitions.map((d) => [d.id, d]));
	const meshById = new Map(graph.meshes.map((m) => [m.id, m]));
	const childrenByDef = new Map<string, string[]>();
	for (const inst of graph.instances) {
		if (!inst.ownerDefinitionId) continue;
		const list = childrenByDef.get(inst.ownerDefinitionId);
		if (list) list.push(inst.id);
		else childrenByDef.set(inst.ownerDefinitionId, [inst.id]);
	}

	for (const entry of arch.modules) {
		const moduleId = entry.module.moduleId;
		instToModule.set(entry.instanceId, moduleId);
		const stack = [entry.instanceId];
		const visitedDefs = new Set<string>();
		while (stack.length > 0) {
			const instId = stack.pop()!;
			instToModule.set(instId, moduleId);
			const inst = instById.get(instId);
			if (!inst || visitedDefs.has(inst.definitionId)) continue;
			visitedDefs.add(inst.definitionId);
			const def = defById.get(inst.definitionId);
			const mesh = def?.meshId ? meshById.get(def.meshId) : undefined;
			if (mesh) {
				for (const face of mesh.faces) faceToModule.set(face.id, moduleId);
			}
			const children = childrenByDef.get(inst.definitionId);
			if (children) {
				for (const childId of children) stack.push(childId);
			}
		}
	}
	return { instToModule, faceToModule };
}

function failManaged(moduleId: string, opIndex: number, target: Record<string, string>): never {
	throw new AgentToolFailure(
		'MANAGED_MODULE',
		`Managed architecture module ${moduleId} cannot be modified with model_ops; use edit_model.`,
		{ moduleId, opIndex, ...target }
	);
}

function assertOpNotManaged(op: ModelOpInput, opIndex: number, managed: ManagedTargets): void {
	if (managed.instToModule.size === 0 && managed.faceToModule.size === 0) return;

	for (const stepId of op.path ?? []) {
		const modId = managed.instToModule.get(stepId);
		if (modId) failManaged(modId, opIndex, { instanceId: stepId });
	}

	const checkSelection = (selection: readonly ModelSelection[]) => {
		for (const item of selection) {
			if (item.type === 'instance') {
				const modId = managed.instToModule.get(item.id);
				if (modId) failManaged(modId, opIndex, { instanceId: item.id });
			} else if (item.type === 'face') {
				const modId = managed.faceToModule.get(item.id);
				if (modId) failManaged(modId, opIndex, { faceId: item.id });
			}
		}
	};

	const checkCommand = (command: FlatAuthoringCommand) => {
		if (command.kind === 'PUSH_PULL_FACE') {
			const modId = managed.faceToModule.get(command.faceId);
			if (modId) failManaged(modId, opIndex, { faceId: command.faceId });
		} else if (command.kind === 'EXTRUDE_RECTANGLE') {
			const modId = managed.faceToModule.get(command.entityId);
			if (modId) failManaged(modId, opIndex, { entityId: command.entityId });
		}
	};

	if ('command' in op) {
		checkCommand(op.command);
		return;
	}

	const action = op.action;
	switch (action.type) {
		case 'raw':
			checkCommand(action.command);
			break;
		case 'group':
		case 'erase':
		case 'transform':
		case 'scale':
		case 'paint':
			checkSelection(action.selection);
			break;
		case 'unique':
		case 'explode':
		case 'entity-info':
		case 'asset-create': {
			const modId = managed.instToModule.get(action.instanceId);
			if (modId) failManaged(modId, opIndex, { instanceId: action.instanceId });
			break;
		}
		case 'tag-assign':
			for (const id of action.instanceIds) {
				const modId = managed.instToModule.get(id);
				if (modId) failManaged(modId, opIndex, { instanceId: id });
			}
			break;
		case 'offset':
		case 'follow-me': {
			const modId = managed.faceToModule.get(action.faceId);
			if (modId) failManaged(modId, opIndex, { faceId: action.faceId });
			break;
		}
	}
}

function lowerOpToAction(op: ModelOpInput): ModelAction {
	return 'action' in op ? op.action : { type: 'raw', command: op.command };
}

function createdMetadataIds(
	action: ModelAction,
	beforeGraph: BomcGraph,
	forward: readonly DocumentEdit[]
): string[] {
	if (action.type !== 'tag-create' && action.type !== 'asset-create') return [];
	const rootEdit = forward.find(
		(e): e is Extract<DocumentEdit, { type: 'put-instance' }> =>
			e.type === 'put-instance' && e.value.id === beforeGraph.rootInstanceId
	);
	if (!rootEdit || !rootEdit.value.label) return [];
	try {
		const beforeOrg = modelMetadata(beforeGraph).organization;
		const afterParsed = JSON.parse(rootEdit.value.label) as {
			organization?: { tags?: Array<{ id: string }>; assets?: Array<{ id: string }> };
		};
		if (action.type === 'tag-create') {
			const prev = new Set((beforeOrg?.tags ?? []).map((t) => t.id));
			return (afterParsed.organization?.tags ?? []).filter((t) => !prev.has(t.id)).map((t) => t.id);
		}
		const prev = new Set((beforeOrg?.assets ?? []).map((a) => a.id));
		return (afterParsed.organization?.assets ?? []).filter((a) => !prev.has(a.id)).map((a) => a.id);
	} catch {
		return [];
	}
}

function affectedIdsForOp(
	action: ModelAction,
	editEntityId: string,
	beforeGraph: BomcGraph,
	forward: readonly DocumentEdit[]
): string[] {
	if (action.type === 'tag-create' || action.type === 'asset-create') {
		return createdMetadataIds(action, beforeGraph, forward);
	}
	if (editEntityId.length > 0 && editEntityId !== beforeGraph.rootInstanceId) {
		return [editEntityId];
	}

	switch (action.type) {
		case 'unique':
		case 'explode':
		case 'entity-info':
			return [action.instanceId];
		case 'tag-assign':
			return [...action.instanceIds];
		case 'tag-visibility':
			return [action.tagId];
		case 'asset-delete':
			return [action.assetId];
		case 'erase':
		case 'paint':
		case 'transform':
		case 'scale':
			return action.selection
				.filter((item): item is Extract<ModelSelection, { id: string }> => item.type !== 'edge')
				.map((item) => item.id);
		default:
			return editEntityId.length > 0 ? [editEntityId] : [];
	}
}

/** World-space bounding box matching `projectAuthoringScene` (meshes, loose edges, guides). */
function computeWorldBounds(graph: BomcGraph): ModelOpsBounds | null {
	const metadata = modelMetadata(graph);
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let minZ = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	let maxZ = Number.NEGATIVE_INFINITY;

	const include = (x: number, y: number, z: number) => {
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (z < minZ) minZ = z;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
		if (z > maxZ) maxZ = z;
	};

	const pointVec = new Vector3();
	for (const occurrence of modelOccurrences(graph)) {
		const flat = definitionGraph(graph, occurrence.definitionId);
		for (const mesh of flat.meshes) {
			for (let i = 0; i < mesh.positions.length; i += 3) {
				pointVec.set(mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!).applyMatrix4(occurrence.matrix);
				include(pointVec.x, pointVec.y, pointVec.z);
			}
		}
		for (const edge of metadata.looseEdges) {
			if (edge.ownerDefinitionId !== occurrence.definitionId) continue;
			pointVec.set(edge.start[0], edge.start[1], edge.start[2]).applyMatrix4(occurrence.matrix);
			include(pointVec.x, pointVec.y, pointVec.z);
			pointVec.set(edge.end[0], edge.end[1], edge.end[2]).applyMatrix4(occurrence.matrix);
			include(pointVec.x, pointVec.y, pointVec.z);
		}
		for (const guide of metadata.guides) {
			if (guide.ownerDefinitionId !== occurrence.definitionId) continue;
			pointVec.set(guide.start[0], guide.start[1], guide.start[2]).applyMatrix4(occurrence.matrix);
			include(pointVec.x, pointVec.y, pointVec.z);
			pointVec.set(guide.end[0], guide.end[1], guide.end[2]).applyMatrix4(occurrence.matrix);
			include(pointVec.x, pointVec.y, pointVec.z);
		}
	}

	if (!Number.isFinite(minX)) return null;
	return {
		min: [cleanZero(minX), cleanZero(minY), cleanZero(minZ)],
		max: [cleanZero(maxX), cleanZero(maxY), cleanZero(maxZ)]
	};
}

/**
 * Plan a C11 `model_ops` call without mutating `graph`.
 * Builders run sequentially on a scratch graph inside `stageAndCommit(..., slot, 'ops')`.
 */
export function planModelOps(graph: BomcGraph, rawArgs: Record<string, unknown>): ModelOpsPlan {
	const args = validateArgs(rawArgs);
	const managed = collectManagedTargets(graph);
	for (let index = 0; index < args.ops.length; index += 1) {
		assertOpNotManaged(args.ops[index]!, index, managed);
	}

	let latestBounds = computeWorldBounds(graph);
	const collectedIds: string[] = [];
	const seenIds = new Set<string>();
	const recordId = (id: string) => {
		if (id.length > 0 && !seenIds.has(id)) {
			seenIds.add(id);
			collectedIds.push(id);
		}
	};

	const builders: AgentEditBuilder[] = args.ops.map((op, index) => {
		const path = op.path ?? [];
		const action = lowerOpToAction(op);
		const isLast = index === args.ops.length - 1;
		return (stagedGraph, sequence) => {
			const edit = buildModelEdit(stagedGraph, path, action, sequence);
			const opIds = affectedIdsForOp(action, edit.entityId, stagedGraph, edit.forward);
			for (const id of opIds) recordId(id);
			if (isLast) {
				const probe = BomcDocument.fromGraph(stagedGraph);
				try {
					probe.transact(edit.forward);
					latestBounds = computeWorldBounds(probe.snapshot().graph);
				} finally {
					probe.dispose();
				}
			}
			return {
				entityId: edit.entityId || (opIds[0] ?? ''),
				forward: edit.forward,
				inverse: edit.inverse
			};
		};
	});

	return {
		builders,
		receipt: (commit: AgentCommit) => {
			for (const id of commit.entityIds) recordId(id);
			return {
				revision: commit.revision,
				entityIds: [...collectedIds],
				bounds: latestBounds,
				changed: commit.changed
			};
		}
	};
}
