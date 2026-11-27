/**
 * SIB-MCP-MODELING-001 v2.3 C11 (WP7) — `arch/model-ops.ts`.
 *
 * Validates `model_ops` arguments against `model-ops.schema.json`, refuses targeting
 * managed architecture groups (`MANAGED_MODULE`), lowers every op into a `MODEL_EDIT`
 * builder backed by `model.ts::buildModelEdit(stagedGraph, path, action, S + k)` for
 * `stageAndCommit` (atomic scratch staging + composite history entry), and computes
 * world-space receipt `entityIds` and `bounds`.
 */
import type { BomcGraph, DocumentEdit, Face, Mesh } from '@sibambo/bomc-document';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { Vector3 } from 'three';
import {
	buildModelEdit,
	contextTransform,
	definitionGraph,
	modelMetadata,
	modelOccurrences,
	nextModelSequence
} from '../authoring/model.js';
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

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type ManagedTargets = {
	instToModule: Map<string, string>;
	ancestorToModule: Map<string, string>;
	aliasInstToModule: Map<string, string>;
	defToModule: Map<string, string>;
	meshToModule: Map<string, string>;
	faceToModule: Map<string, string>;
	tagToModule: Map<string, string>;
	assetToModule: Map<string, string>;
};

function collectManagedTargets(graph: BomcGraph): ManagedTargets {
	const instToModule = new Map<string, string>();
	const ancestorToModule = new Map<string, string>();
	const aliasInstToModule = new Map<string, string>();
	const defToModule = new Map<string, string>();
	const meshToModule = new Map<string, string>();
	const faceToModule = new Map<string, string>();
	const tagToModule = new Map<string, string>();
	const assetToModule = new Map<string, string>();
	const meta = modelMetadata(graph);
	const arch = meta.arch;
	if (!arch || arch.modules.length === 0) {
		return {
			instToModule,
			ancestorToModule,
			aliasInstToModule,
			defToModule,
			meshToModule,
			faceToModule,
			tagToModule,
			assetToModule
		};
	}

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

	// Pass 1: downward walk from every managed container instance.
	for (const entry of arch.modules) {
		const moduleId = entry.module.moduleId;
		if (!instById.has(entry.instanceId)) continue;
		instToModule.set(entry.instanceId, moduleId);
		const stack = [entry.instanceId];
		const visitedDefs = new Set<string>();
		while (stack.length > 0) {
			const instId = stack.pop()!;
			if (!instToModule.has(instId)) instToModule.set(instId, moduleId);
			const inst = instById.get(instId);
			if (!inst) continue;
			if (!defToModule.has(inst.definitionId)) defToModule.set(inst.definitionId, moduleId);
			if (visitedDefs.has(inst.definitionId)) continue;
			visitedDefs.add(inst.definitionId);
			const def = defById.get(inst.definitionId);
			const mesh = def?.meshId ? meshById.get(def.meshId) : undefined;
			if (def?.meshId && !meshToModule.has(def.meshId)) meshToModule.set(def.meshId, moduleId);
			if (mesh) {
				for (const face of mesh.faces) {
					if (!faceToModule.has(face.id)) faceToModule.set(face.id, moduleId);
				}
			}
			const children = childrenByDef.get(inst.definitionId);
			if (children) {
				for (const childId of children) stack.push(childId);
			}
		}
	}

	// Ensure faces on any definition aliasing a managed mesh are also marked protected.
	for (const mesh of graph.meshes) {
		const modId = meshToModule.get(mesh.id);
		if (!modId) continue;
		for (const face of mesh.faces) {
			if (!faceToModule.has(face.id)) faceToModule.set(face.id, modId);
		}
	}

	// Pass 2: detect ancestor containers (whose subtree holds a managed instance)
	// and non-managed instances aliasing a managed definition or managed mesh.
	for (const inst of graph.instances) {
		if (inst.id === graph.rootInstanceId || instToModule.has(inst.id)) continue;
		const def = defById.get(inst.definitionId);
		const directAlias =
			defToModule.get(inst.definitionId) ??
			(def?.meshId ? meshToModule.get(def.meshId) : undefined);
		if (directAlias) {
			aliasInstToModule.set(inst.id, directAlias);
		}

		const defStack = [inst.definitionId];
		const visitedDefs = new Set<string>();
		let ancestorMod: string | undefined;
		while (defStack.length > 0 && !ancestorMod) {
			const defId = defStack.pop()!;
			if (visitedDefs.has(defId)) continue;
			visitedDefs.add(defId);
			for (const childId of childrenByDef.get(defId) ?? []) {
				const hit = instToModule.get(childId);
				if (hit) {
					ancestorMod = hit;
					break;
				}
				const childInst = instById.get(childId);
				if (childInst) defStack.push(childInst.definitionId);
			}
		}
		if (ancestorMod) {
			ancestorToModule.set(inst.id, ancestorMod);
		}
	}

	// Pass 3: protect tags assigned to any managed/ancestor/alias instance and library assets
	// whose definition subtree reaches any managed instance, ancestor, or protected definition/mesh.
	const org = meta.organization;
	if (org) {
		for (const assignment of org.assignments) {
			const modId =
				instToModule.get(assignment.instanceId) ??
				ancestorToModule.get(assignment.instanceId) ??
				aliasInstToModule.get(assignment.instanceId);
			if (modId && !tagToModule.has(assignment.tagId)) {
				tagToModule.set(assignment.tagId, modId);
			}
		}
		for (const asset of org.assets) {
			const defStack = [asset.definitionId];
			const visitedDefs = new Set<string>();
			let hitMod: string | undefined;
			while (defStack.length > 0 && !hitMod) {
				const defId = defStack.pop()!;
				if (visitedDefs.has(defId)) continue;
				visitedDefs.add(defId);
				const def = defById.get(defId);
				hitMod =
					defToModule.get(defId) ??
					(def?.meshId ? meshToModule.get(def.meshId) : undefined);
				if (hitMod) break;
				for (const childId of childrenByDef.get(defId) ?? []) {
					hitMod =
						instToModule.get(childId) ??
						ancestorToModule.get(childId) ??
						aliasInstToModule.get(childId);
					if (hitMod) break;
					const childInst = instById.get(childId);
					if (childInst) defStack.push(childInst.definitionId);
				}
			}
			if (hitMod) {
				assetToModule.set(asset.id, hitMod);
			}
		}
	}

	return {
		instToModule,
		ancestorToModule,
		aliasInstToModule,
		defToModule,
		meshToModule,
		faceToModule,
		tagToModule,
		assetToModule
	};
}

function failManaged(moduleId: string, opIndex: number, target: Record<string, string>): never {
	throw new AgentToolFailure(
		'MANAGED_MODULE',
		`Managed architecture module ${moduleId} cannot be modified with model_ops; use edit_model.`,
		{ moduleId, opIndex, ...target }
	);
}

function assertOpNotManaged(op: ModelOpInput, opIndex: number, managed: ManagedTargets, graph: BomcGraph): void {
	if (
		managed.instToModule.size === 0 &&
		managed.ancestorToModule.size === 0 &&
		managed.aliasInstToModule.size === 0 &&
		managed.faceToModule.size === 0 &&
		managed.tagToModule.size === 0 &&
		managed.assetToModule.size === 0
	) {
		return;
	}

	const instById = new Map(graph.instances.map((i) => [i.id, i]));
	const defById = new Map(graph.definitions.map((d) => [d.id, d]));

	// Entering a managed container OR an instance aliasing a managed definition/mesh
	// would write directly into the managed mesh/subtree. Entering an ancestor container
	// is allowed only for freeform sibling ops; mutating the ancestor container itself is blocked below.
	for (const stepId of op.path ?? []) {
		const inst = instById.get(stepId);
		const def = inst ? defById.get(inst.definitionId) : undefined;
		const modId =
			managed.instToModule.get(stepId) ??
			managed.aliasInstToModule.get(stepId) ??
			(inst ? managed.defToModule.get(inst.definitionId) : undefined) ??
			(def?.meshId ? managed.meshToModule.get(def.meshId) : undefined);
		if (modId) failManaged(modId, opIndex, { instanceId: stepId });
	}

	const checkInstanceId = (instanceId: string) => {
		const modId =
			managed.instToModule.get(instanceId) ??
			managed.ancestorToModule.get(instanceId) ??
			managed.aliasInstToModule.get(instanceId);
		if (modId) failManaged(modId, opIndex, { instanceId });
	};

	const checkSelection = (selection: readonly ModelSelection[]) => {
		for (const item of selection) {
			if (item.type === 'instance') {
				checkInstanceId(item.id);
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
			const faceMod = managed.faceToModule.get(command.entityId);
			if (faceMod) failManaged(faceMod, opIndex, { entityId: command.entityId });
			const instMod =
				managed.instToModule.get(command.entityId) ??
				managed.ancestorToModule.get(command.entityId) ??
				managed.aliasInstToModule.get(command.entityId);
			if (instMod) failManaged(instMod, opIndex, { entityId: command.entityId });
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
		case 'asset-create':
			checkInstanceId(action.instanceId);
			break;
		case 'tag-assign':
			for (const id of action.instanceIds) checkInstanceId(id);
			break;
		case 'tag-visibility': {
			const modId = managed.tagToModule.get(action.tagId);
			if (modId) failManaged(modId, opIndex, { tagId: action.tagId });
			break;
		}
		case 'asset-insert':
		case 'asset-delete': {
			const modId = managed.assetToModule.get(action.assetId);
			if (modId) failManaged(modId, opIndex, { assetId: action.assetId });
			break;
		}
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

function faceSignature(mesh: Mesh, face: Face): string {
	const pt = (vi: number) =>
		`${cleanZero(mesh.positions[vi * 3]!)},${cleanZero(mesh.positions[vi * 3 + 1]!)},${cleanZero(mesh.positions[vi * 3 + 2]!)}`;
	const ringSig = (ring: readonly number[]) => ring.map(pt).join(';');
	return [
		face.frontMaterialId ?? '',
		face.backMaterialId ?? '',
		face.normal.map(cleanZero).join(','),
		ringSig(face.outer),
		face.holes.map(ringSig).join('|')
	].join('#');
}

function activeMesh(graph: BomcGraph, definitionId: string): Mesh | undefined {
	const def = graph.definitions.find((d) => d.id === definitionId);
	return def?.meshId ? graph.meshes.find((m) => m.id === def.meshId) : undefined;
}

/**
 * Derive operation-level public entity IDs from the real staged transition (`beforeGraph -> afterGraph`).
 * Deliberately scopes instances/faces/looseEdges/guides to the active editing context and reports the
 * newly created container ID for `group` (suppressing internal re-parented geometry moved inside it)
 * and active-context cloned/affected IDs for array/unique/explode/metadata ops, never leaking `rootInstanceId`.
 */
function diffAffectedIds(
	action: ModelAction,
	path: readonly string[],
	beforeGraph: BomcGraph,
	afterGraph: BomcGraph
): string[] {
	const ownerDefId = contextTransform(beforeGraph, path).definitionId;
	const rootIds = new Set([beforeGraph.rootInstanceId, afterGraph.rootInstanceId]);
	const isGroupAction = action.type === 'group';

	// 1. Context instances (created, modified, deleted)
	const beforeInsts = new Map(
		beforeGraph.instances
			.filter((i) => !rootIds.has(i.id) && i.ownerDefinitionId === ownerDefId)
			.map((i) => [i.id, i])
	);
	const afterInsts = new Map(
		afterGraph.instances
			.filter((i) => !rootIds.has(i.id) && i.ownerDefinitionId === ownerDefId)
			.map((i) => [i.id, i])
	);

	const instIds: string[] = [];
	for (const [id, inst] of afterInsts) {
		const prev = beforeInsts.get(id);
		if (!prev || JSON.stringify(prev) !== JSON.stringify(inst)) {
			instIds.push(id);
		}
	}
	if (!isGroupAction) {
		for (const id of beforeInsts.keys()) {
			if (!afterInsts.has(id)) instIds.push(id);
		}
	}
	instIds.sort(cmp);

	// 2. Context mesh faces (added, modified geometry/material, deleted)
	const faceIds: string[] = [];
	if (!isGroupAction) {
		const beforeMesh = activeMesh(beforeGraph, ownerDefId);
		const afterMesh = activeMesh(afterGraph, ownerDefId);
		const beforeFaces = new Map((beforeMesh?.faces ?? []).map((f) => [f.id, f]));
		const afterFaces = new Map((afterMesh?.faces ?? []).map((f) => [f.id, f]));
		if (afterMesh) {
			for (const [id, face] of afterFaces) {
				const prev = beforeFaces.get(id);
				if (!prev || faceSignature(beforeMesh!, prev) !== faceSignature(afterMesh, face)) {
					faceIds.push(id);
				}
			}
		}
		for (const id of beforeFaces.keys()) {
			if (!afterFaces.has(id)) faceIds.push(id);
		}
		faceIds.sort(cmp);
	}

	// 3. Context looseEdges & guides
	const beforeMeta = modelMetadata(beforeGraph);
	const afterMeta = modelMetadata(afterGraph);
	const edgeIds: string[] = [];
	if (!isGroupAction) {
		const beforeEdges = new Map(
			beforeMeta.looseEdges.filter((e) => e.ownerDefinitionId === ownerDefId).map((e) => [e.id, e])
		);
		const afterEdges = new Map(
			afterMeta.looseEdges.filter((e) => e.ownerDefinitionId === ownerDefId).map((e) => [e.id, e])
		);
		for (const [id, edge] of afterEdges) {
			const prev = beforeEdges.get(id);
			if (!prev || JSON.stringify(prev) !== JSON.stringify(edge)) edgeIds.push(id);
		}
		for (const id of beforeEdges.keys()) {
			if (!afterEdges.has(id)) edgeIds.push(id);
		}
		edgeIds.sort(cmp);
	}

	const beforeGuides = new Map(
		beforeMeta.guides.filter((g) => g.ownerDefinitionId === ownerDefId).map((g) => [g.id, g])
	);
	const afterGuides = new Map(
		afterMeta.guides.filter((g) => g.ownerDefinitionId === ownerDefId).map((g) => [g.id, g])
	);
	const guideIds: string[] = [];
	for (const [id, guide] of afterGuides) {
		const prev = beforeGuides.get(id);
		if (!prev || JSON.stringify(prev) !== JSON.stringify(guide)) guideIds.push(id);
	}
	for (const id of beforeGuides.keys()) {
		if (!afterGuides.has(id)) guideIds.push(id);
	}
	guideIds.sort(cmp);

	// 4. Organization metadata (tags, tag assignments, assets)
	const beforeOrg = beforeMeta.organization ?? { tags: [], assignments: [], assets: [] };
	const afterOrg = afterMeta.organization ?? { tags: [], assignments: [], assets: [] };
	const metaIds: string[] = [];

	const beforeTags = new Map(beforeOrg.tags.map((t) => [t.id, t]));
	const afterTags = new Map(afterOrg.tags.map((t) => [t.id, t]));
	for (const [id, tag] of afterTags) {
		const prev = beforeTags.get(id);
		if (!prev || JSON.stringify(prev) !== JSON.stringify(tag)) metaIds.push(id);
	}
	for (const id of beforeTags.keys()) {
		if (!afterTags.has(id)) metaIds.push(id);
	}

	const beforeAssigns = new Map(beforeOrg.assignments.map((a) => [a.instanceId, a.tagId]));
	const afterAssigns = new Map(afterOrg.assignments.map((a) => [a.instanceId, a.tagId]));
	for (const [instId, tagId] of afterAssigns) {
		if (!rootIds.has(instId) && beforeAssigns.get(instId) !== tagId) metaIds.push(instId);
	}
	for (const instId of beforeAssigns.keys()) {
		if (!rootIds.has(instId) && !afterAssigns.has(instId)) metaIds.push(instId);
	}

	const beforeAssets = new Map(beforeOrg.assets.map((a) => [a.id, a]));
	const afterAssets = new Map(afterOrg.assets.map((a) => [a.id, a]));
	for (const [id, asset] of afterAssets) {
		const prev = beforeAssets.get(id);
		if (!prev || JSON.stringify(prev) !== JSON.stringify(asset)) metaIds.push(id);
	}
	for (const id of beforeAssets.keys()) {
		if (!afterAssets.has(id)) metaIds.push(id);
	}
	metaIds.sort(cmp);

	const combined = [...faceIds, ...instIds, ...edgeIds, ...guideIds, ...metaIds];
	const deduped: string[] = [];
	const seen = new Set<string>(rootIds);
	for (const id of combined) {
		if (id.length > 0 && !seen.has(id)) {
			seen.add(id);
			deduped.push(id);
		}
	}
	return deduped;
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
 * When `graph` contains `arch.modules`, runs a scratch preflight across `ops[0..k]` so
 * entities/containers/tags/assets exposed mid-composite cannot bypass `MANAGED_MODULE`.
 * Builders then run sequentially inside `stageAndCommit(..., slot, 'ops')`.
 */
export function planModelOps(
	graph: BomcGraph,
	rawArgs: Record<string, unknown>,
	startSequence = nextModelSequence(graph)
): ModelOpsPlan {
	const args = validateArgs(rawArgs);
	const initialArch = modelMetadata(graph).arch;
	if (initialArch && initialArch.modules.length > 0) {
		const scratch = BomcDocument.fromGraph(graph);
		try {
			for (let index = 0; index < args.ops.length; index += 1) {
				const op = args.ops[index]!;
				const stagedGraph = scratch.snapshot().graph;
				const managed = collectManagedTargets(stagedGraph);
				assertOpNotManaged(op, index, managed, stagedGraph);
				try {
					const edit = buildModelEdit(stagedGraph, op.path ?? [], lowerOpToAction(op), startSequence + index);
					scratch.transact(edit.forward);
				} catch {
					// Non-MANAGED_MODULE command failures at step `index` are surfaced cleanly by stageAndCommit as INVALID_COMMAND { opIndex: index }.
					break;
				}
			}
		} finally {
			scratch.dispose();
		}
	}

	let latestBounds = computeWorldBounds(graph);
	const collectedIds: string[] = [];
	const seenIds = new Set<string>([graph.rootInstanceId]);
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
			const probe = BomcDocument.fromGraph(stagedGraph);
			let afterGraph: BomcGraph;
			try {
				probe.transact(edit.forward);
				afterGraph = probe.snapshot().graph;
				if (isLast) latestBounds = computeWorldBounds(afterGraph);
			} finally {
				probe.dispose();
			}
			const opIds = diffAffectedIds(action, path, stagedGraph, afterGraph);
			for (const id of opIds) recordId(id);
			const primaryEntityId =
				edit.entityId && edit.entityId !== stagedGraph.rootInstanceId && edit.entityId !== afterGraph.rootInstanceId
					? edit.entityId
					: (opIds[0] ?? '');
			return {
				entityId: primaryEntityId,
				forward: edit.forward,
				inverse: edit.inverse
			};
		};
	});

	return {
		builders,
		receipt: (commit: AgentCommit) => ({
			revision: commit.revision,
			entityIds: [...collectedIds],
			bounds: latestBounds,
			changed: commit.changed
		})
	};
}
