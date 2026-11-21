/**
 * SIB-MCP-MODELING-001 v2.3 C9 (WP5) — `arch/bake.ts`: admission-canonical bake of an
 * evaluated `ArchModule` into a BomcDocument container group + root `arch` metadata, with
 * paired forward/inverse `DocumentEdit`s and `validateAuthoringDocument` enforcement.
 */
import type { BomcGraph, Definition, DocumentEdit, Face, Instance, Mesh, SolidMaterial } from '@sibambo/bomc-document';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { faceFromRing, v2FaceLabel } from '../authoring/geometry.js';
import { modelMetadata, validateAuthoringDocument } from '../authoring/model.js';
import { fromInstanceMatrix, toInstanceMatrix } from './convention.js';
import { ArchError, budgetExceeded, invalidGeometry } from './errors.js';
import type { EvaluatedModule } from './evaluate.js';
import {
	ARCH_SCHEMA,
	MAX_ARCH_BYTES,
	MAX_ARCH_MODULES,
	meshDigestInput,
	type ArchEntry,
	type ArchMetadata
} from './metadata.js';
import { canonicalJson, MAX_MODULE_CANONICAL_BYTES, utf8Bytes, type ArchModule } from './schema.js';
import { sha256Hex } from './sha256.js';

const MAX_BAKED_POSITIONS = 8192;
const MAX_BAKED_FACES = 4096;
const MAX_BAKED_TRIANGLES = 20000;
const MAX_RING_VERTICES = 256;
const MAX_DOCUMENT_MATERIALS = 512;

const BUILT_IN_MATERIAL_DEFS: Readonly<Record<string, { rgba: readonly [number, number, number, number]; opacity: number }>> = {
	'sib-default': { rgba: [199, 204, 212, 255], opacity: 1 },
	'sib-frame': { rgba: [120, 98, 76, 255], opacity: 1 },
	'sib-glass': { rgba: [160, 200, 230, 90], opacity: 0.35 },
	'sib-door': { rgba: [150, 120, 90, 255], opacity: 1 }
};

export type BakeEntryInput =
	| ArchModule
	| ArchEntry
	| { module: ArchModule; existing?: ArchEntry | null };

export type BakeResult = {
	forward: DocumentEdit[];
	inverse: DocumentEdit[];
	instanceId: string;
	bakedMeshSha256: string;
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const pad5 = (n: number) => String(n).padStart(5, '0');
const cleanZero = (v: number): number => (v === 0 ? 0 : v);

function resolveEntry(
	graph: BomcGraph,
	input: BakeEntryInput
): { module: ArchModule; existing: ArchEntry | null; currentArch: ArchMetadata } {
	const meta = modelMetadata(graph);
	const currentArch: ArchMetadata = meta.arch ?? { schema: ARCH_SCHEMA, modules: [] };
	if ('schemaVersion' in input) {
		const existing = currentArch.modules.find((m) => m.module.moduleId === input.moduleId) ?? null;
		return { module: input, existing, currentArch };
	}
	if ('instanceId' in input && 'bakedMeshSha256' in input) {
		return { module: input.module, existing: input, currentArch };
	}
	const existing =
		input.existing !== undefined
			? input.existing
			: (currentArch.modules.find((m) => m.module.moduleId === input.module.moduleId) ?? null);
	return { module: input.module, existing, currentArch };
}

function sameMaterial(a: SolidMaterial, b: SolidMaterial): boolean {
	return (
		a.id === b.id &&
		a.name === b.name &&
		a.displayName === b.displayName &&
		a.rgba[0] === b.rgba[0] &&
		a.rgba[1] === b.rgba[1] &&
		a.rgba[2] === b.rgba[2] &&
		a.rgba[3] === b.rgba[3] &&
		a.opacityU16 === b.opacityU16
	);
}

function buildBakedMaterial(documentId: string, materialId: string, module: ArchModule): SolidMaterial {
	const bakedId = `${documentId}:material:op:arch-${materialId}`;
	const builtin = BUILT_IN_MATERIAL_DEFS[materialId];
	if (builtin) {
		return {
			id: bakedId,
			name: materialId,
			displayName: null,
			rgba: [builtin.rgba[0], builtin.rgba[1], builtin.rgba[2], builtin.rgba[3]],
			opacityU16: Math.round(builtin.opacity * 65535)
		};
	}
	const declared = module.materials.find((m) => m.materialId === materialId);
	if (!declared) throw invalidGeometry('UNKNOWN_MATERIAL', materialId);
	return {
		id: bakedId,
		name: declared.materialId,
		displayName: null,
		rgba: [declared.rgba[0]!, declared.rgba[1]!, declared.rgba[2]!, declared.rgba[3]!],
		opacityU16: Math.round(declared.opacity * 65535)
	};
}

/**
 * Fail closed when `matId` with `bakedMat` would collide with another managed module or
 * silently recolor non-target geometry (mesh faces, instance overrides, or shared definitions/meshes)
 * still referencing `${documentId}:material:op:arch-${matId}` (A7).
 */
function assertNoMaterialCollision(
	graph: BomcGraph,
	module: ArchModule,
	currentArch: ArchMetadata,
	existingInstId: string | null,
	existingDefId: string | null,
	existingMeshId: string | null,
	matId: string,
	bakedMat: SolidMaterial,
	prevMat: SolidMaterial | undefined
): void {
	for (const other of currentArch.modules) {
		if (other.module.moduleId === module.moduleId) continue;
		const otherDeclared = other.module.materials.find((m) => m.materialId === matId);
		if (!otherDeclared) continue;
		const otherBaked = buildBakedMaterial(graph.documentId, matId, other.module);
		if (!sameMaterial(otherBaked, bakedMat)) {
			throw new ArchError(
				'INVALID_GEOMETRY',
				{ reason: 'MATERIAL_COLLISION', moduleId: module.moduleId, elementId: matId },
				`INVALID_GEOMETRY MATERIAL_COLLISION (${matId}): conflicts with module ${other.module.moduleId}`
			);
		}
	}

	if (prevMat && !sameMaterial(prevMat, bakedMat)) {
		const existingMeshShared =
			existingMeshId !== null &&
			((existingDefId !== null &&
				graph.instances.some((inst) => inst.id !== existingInstId && inst.definitionId === existingDefId)) ||
				graph.definitions.some((def) => def.id !== existingDefId && def.meshId === existingMeshId));
		const referencedElsewhere =
			graph.instances.some((inst) => inst.id !== existingInstId && inst.materialId === bakedMat.id) ||
			graph.meshes.some(
				(mesh) =>
					(existingMeshShared || mesh.id !== existingMeshId) &&
					mesh.faces.some((face) => face.frontMaterialId === bakedMat.id || face.backMaterialId === bakedMat.id)
			);
		if (referencedElsewhere) {
			throw new ArchError(
				'INVALID_GEOMETRY',
				{ reason: 'MATERIAL_COLLISION', moduleId: module.moduleId, elementId: matId },
				`INVALID_GEOMETRY MATERIAL_COLLISION (${matId}): material is still referenced in document`
			);
		}
	}
}

function assertAdmittedNext(graph: BomcGraph, edits: readonly DocumentEdit[], moduleId: string): BomcGraph {
	const doc = BomcDocument.fromGraph(graph);
	try {
		doc.transact(edits);
		const nextGraph = structuredClone(doc.snapshot().graph);
		const valid = validateAuthoringDocument(nextGraph);
		if (!valid.editable) throw invalidGeometry(`ADMISSION:${valid.reason}`).withModule(moduleId);
		return nextGraph;
	} finally {
		doc.dispose();
	}
}

/**
 * Bake or remove one managed module into `graph`, returning paired `forward`/`inverse` `DocumentEdit`s.
 * - When `evaluated === null`, removes the module (and its container group if attached; orphans only remove `arch` entry).
 * - Otherwise bakes topology faces into a module-local Z-up group mesh using `faceFromRing` + `v2FaceLabel` (B1/A4).
 */
export function bakeModule(
	graph: BomcGraph,
	entryInput: BakeEntryInput,
	evaluated: EvaluatedModule | null,
	S: number,
	counterStart = 1
): BakeResult {
	if (!Number.isSafeInteger(S) || S < 1) throw invalidGeometry('INVALID_SEQUENCE');
	if (!Number.isSafeInteger(counterStart) || counterStart < 1) throw invalidGeometry('INVALID_COUNTER');

	const { module, existing, currentArch } = resolveEntry(graph, entryInput);
	const rootInstance = graph.instances.find((i) => i.id === graph.rootInstanceId);
	if (!rootInstance) throw invalidGeometry('MISSING_ROOT_INSTANCE').withModule(module.moduleId);
	const metadata = modelMetadata(graph);

	// Removal path (`evaluated === null`)
	if (evaluated === null) {
		if (!existing) {
			return { forward: [], inverse: [], instanceId: '', bakedMeshSha256: '' };
		}
		const remaining = currentArch.modules.filter((m) => m.module.moduleId !== existing.module.moduleId);
		const nextMeta = { ...metadata, arch: { schema: ARCH_SCHEMA, modules: remaining } };
		const nextRoot: Instance = { ...rootInstance, label: JSON.stringify(nextMeta) };

		const forward: DocumentEdit[] = [];
		const inverse: DocumentEdit[] = [{ type: 'put-instance', value: rootInstance }];

		const oldInst = graph.instances.find((i) => i.id === existing.instanceId) ?? null;
		if (oldInst) {
			const oldDef = graph.definitions.find((d) => d.id === oldInst.definitionId) ?? null;
			const oldMesh = oldDef?.meshId ? (graph.meshes.find((m) => m.id === oldDef.meshId) ?? null) : null;
			const defShared = oldDef ? graph.instances.some((i) => i.id !== oldInst.id && i.definitionId === oldDef.id) : false;
			const meshShared = oldMesh ? graph.definitions.some((d) => d.id !== oldDef?.id && d.meshId === oldMesh.id) : false;

			forward.push({ type: 'delete-instance', id: oldInst.id });
			if (oldDef && !defShared) {
				forward.push({ type: 'delete-definition', id: oldDef.id });
				if (oldMesh && !meshShared) forward.push({ type: 'delete-mesh', id: oldMesh.id });
			}
			if (oldMesh && !defShared && !meshShared) inverse.push({ type: 'put-mesh', value: oldMesh });
			if (oldDef && !defShared) inverse.push({ type: 'put-definition', value: oldDef });
			inverse.push({ type: 'put-instance', value: oldInst });
		}
		forward.push({ type: 'put-instance', value: nextRoot });

		assertAdmittedNext(graph, forward, module.moduleId);
		return { forward, inverse, instanceId: existing.instanceId, bakedMeshSha256: '' };
	}

	// Create / update path
	const existingInst = existing ? (graph.instances.find((i) => i.id === existing.instanceId) ?? null) : null;
	const existingDef = existingInst ? (graph.definitions.find((d) => d.id === existingInst.definitionId) ?? null) : null;
	const existingMesh = existingDef?.meshId ? (graph.meshes.find((m) => m.id === existingDef.meshId) ?? null) : null;

	// Re-bake preserves A4 IDs and replaces the mesh in place. If an owner
	// instance/definition also references these IDs, any geometry update would
	// silently modify that other occurrence even with identical materials.
	// Fail closed rather than mutating aliased owner geometry.
	const definitionShared = existingDef !== null &&
		graph.instances.some((inst) => inst.id !== existingInst?.id && inst.definitionId === existingDef.id);
	const meshShared = existingMesh !== null &&
		graph.definitions.some((def) => def.id !== existingDef?.id && def.meshId === existingMesh.id);
	if (existingInst && (definitionShared || meshShared)) {
		throw new ArchError(
			'INVALID_GEOMETRY',
			{ reason: 'SHARED_MANAGED_GEOMETRY', moduleId: module.moduleId },
			'INVALID_GEOMETRY SHARED_MANAGED_GEOMETRY: managed definition or mesh is shared'
		);
	}


	const instanceId = existingInst ? existingInst.id : `${graph.documentId}:instance:op:${S}:${counterStart}`;
	const definitionId = existingDef ? existingDef.id : `${graph.documentId}:definition:op:${S}:${counterStart}`;
	const meshId = existingMesh ? existingMesh.id : `${graph.documentId}:mesh:op:${S}:${counterStart}`;
	const containerLabel = existingInst?.label ?? JSON.stringify(['sibambo-editor-container-v1', S]);
	const instanceMatrix = existingInst ? [...existingInst.matrix] : toInstanceMatrix(module.transform).map(cleanZero);
	const effectiveTransform = fromInstanceMatrix(instanceMatrix).map(cleanZero);
	const nextRevision = existingInst ? existing!.module.revision + 1 : module.revision;

	// Step 1: Collect loop vertices per part in first-use order across sorted parts and faces.
	const positions: number[] = [];
	const usedMaterialIds = new Set<string>();
	type FaceBuildSpec = {
		outer: number[];
		holes: number[][];
		normal: [number, number, number];
		materialId: string;
	};
	const faceSpecs: FaceBuildSpec[] = [];

	for (const part of evaluated.parts) {
		const topo = part.topology;
		const localToBaked = new Map<number, number>();
		const mapVert = (localIdx: number): number => {
			let bakedIdx = localToBaked.get(localIdx);
			if (bakedIdx === undefined) {
				bakedIdx = positions.length / 3;
				if (bakedIdx >= MAX_BAKED_POSITIONS) {
					throw budgetExceeded('BAKED_POSITIONS_LIMIT', module.moduleId);
				}
				localToBaked.set(localIdx, bakedIdx);
				positions.push(
					cleanZero(topo.positions[localIdx * 3]!),
					cleanZero(topo.positions[localIdx * 3 + 1]!),
					cleanZero(topo.positions[localIdx * 3 + 2]!)
				);
			}
			return bakedIdx;
		};

		for (const face of topo.faces) {
			if (faceSpecs.length >= MAX_BAKED_FACES) {
				throw budgetExceeded('BAKED_FACES_LIMIT', face.elementId);
			}
			if (face.outer.length > MAX_RING_VERTICES || face.holes.some((h) => h.length > MAX_RING_VERTICES)) {
				throw invalidGeometry('RING_TOO_LONG', face.elementId).withModule(module.moduleId);
			}
			const outer = face.outer.map(mapVert);
			const holes = face.holes.map((h) => h.map(mapVert));
			usedMaterialIds.add(face.materialId);
			faceSpecs.push({
				outer,
				holes,
				normal: [cleanZero(face.normal[0]), cleanZero(face.normal[1]), cleanZero(face.normal[2])],
				materialId: face.materialId
			});
		}
	}

	// Step 2–3: Material collision check + puts (A7) + canonical Face objects sorted by code-unit id.
	const existingMaterialById = new Map(graph.materials.map((m) => [m.id, m]));
	const putMaterials: SolidMaterial[] = [];
	const inverseMaterialEdits: DocumentEdit[] = [];
	let newMaterialCount = 0;
	const checkedMaterialIds = new Set<string>(usedMaterialIds);
	for (const declared of module.materials) checkedMaterialIds.add(declared.materialId);
	for (const matId of [...checkedMaterialIds].sort(cmp)) {
		const bakedMat = buildBakedMaterial(graph.documentId, matId, module);
		const prevMat = existingMaterialById.get(bakedMat.id);
		assertNoMaterialCollision(
			graph,
			module,
			currentArch,
			existingInst?.id ?? null,
			existingDef?.id ?? null,
			existingMesh?.id ?? null,
			matId,
			bakedMat,
			prevMat
		);
		if (!usedMaterialIds.has(matId)) continue;
		if (!prevMat) {
			newMaterialCount += 1;
			putMaterials.push(bakedMat);
			inverseMaterialEdits.push({ type: 'delete-material', id: bakedMat.id });
		} else if (!sameMaterial(prevMat, bakedMat)) {
			putMaterials.push(bakedMat);
			inverseMaterialEdits.push({ type: 'put-material', value: prevMat });
		}
	}
	if (graph.materials.length + newMaterialCount > MAX_DOCUMENT_MATERIALS) {
		throw budgetExceeded('MATERIALS_LIMIT', module.moduleId);
	}

	const meshDraft: Mesh = { id: meshId, definitionId, positions, faces: [] };
	let totalTriangles = 0;
	const bakedFaces: Face[] = faceSpecs.map((spec, k) => {
		const faceId = `${graph.documentId}:op:${S}:arch-face:${pad5(k)}`;
		const frontMaterialBakedId = `${graph.documentId}:material:op:arch-${spec.materialId}`;
		const face = faceFromRing(
			meshDraft,
			faceId,
			spec.outer,
			frontMaterialBakedId,
			null,
			v2FaceLabel(faceId, 'line'),
			spec.normal,
			spec.holes
		);
		totalTriangles += face.triangles.length / 3;
		if (totalTriangles > MAX_BAKED_TRIANGLES) {
			throw budgetExceeded('BAKED_TRIANGLES_LIMIT', module.moduleId);
		}
		return {
			...face,
			normal: [cleanZero(face.normal[0]), cleanZero(face.normal[1]), cleanZero(face.normal[2])]
		};
	});
	bakedFaces.sort((a, b) => cmp(a.id, b.id));

	const hasMesh = bakedFaces.length > 0;
	const nextMesh: Mesh | null = hasMesh ? { id: meshId, definitionId, positions, faces: bakedFaces } : null;
	const bakedMeshSha256 = sha256Hex(meshDigestInput(nextMesh ?? { positions: [], faces: [] }));

	// Step 4–5: Definition, Container Instance, and Root `arch` metadata.
	const nextDefinition: Definition = {
		id: definitionId,
		name: module.moduleId,
		kind: 'group',
		meshId: hasMesh ? meshId : null
	};
	const nextInstance: Instance = {
		id: instanceId,
		name: module.moduleId,
		kind: 'group',
		ownerDefinitionId: existingInst ? existingInst.ownerDefinitionId : graph.rootDefinitionId,
		definitionId,
		matrix: instanceMatrix,
		materialId: existingInst ? existingInst.materialId : null,
		visible: existingInst ? existingInst.visible : true,
		roleCode: 0,
		label: containerLabel
	};

	const bakedModule: ArchModule = {
		...module,
		revision: nextRevision,
		transform: effectiveTransform
	};
	if (utf8Bytes(canonicalJson(bakedModule)) > MAX_MODULE_CANONICAL_BYTES) {
		throw budgetExceeded('ARCH_MODULE_BYTES_LIMIT', module.moduleId);
	}
	const nextEntry: ArchEntry = { instanceId, module: bakedModule, bakedMeshSha256 };
	const nextModules = [...currentArch.modules.filter((m) => m.module.moduleId !== module.moduleId), nextEntry].sort((a, b) =>
		cmp(a.module.moduleId, b.module.moduleId)
	);
	if (nextModules.length > MAX_ARCH_MODULES) {
		throw budgetExceeded('ARCH_MODULES_LIMIT', module.moduleId);
	}
	const nextArch: ArchMetadata = { schema: ARCH_SCHEMA, modules: nextModules };
	if (utf8Bytes(JSON.stringify(nextArch)) > MAX_ARCH_BYTES) {
		throw budgetExceeded('ARCH_BYTES_LIMIT', module.moduleId);
	}
	const nextMetadata = { ...metadata, arch: nextArch };
	const nextRootInstance: Instance = { ...rootInstance, label: JSON.stringify(nextMetadata) };

	// Step 6: Forward & inverse DocumentEdits.
	const forward: DocumentEdit[] = [];
	for (const mat of putMaterials) forward.push({ type: 'put-material', value: mat });
	forward.push({ type: 'put-definition', value: nextDefinition });
	if (nextMesh) forward.push({ type: 'put-mesh', value: nextMesh });
	else if (existingMesh) forward.push({ type: 'delete-mesh', id: existingMesh.id });
	forward.push({ type: 'put-instance', value: nextInstance });
	forward.push({ type: 'put-instance', value: nextRootInstance });

	const inverse: DocumentEdit[] = [{ type: 'put-instance', value: rootInstance }];
	if (existingInst) {
		inverse.push({ type: 'put-instance', value: existingInst });
		inverse.push({ type: 'put-definition', value: existingDef! });
		if (existingMesh) inverse.push({ type: 'put-mesh', value: existingMesh });
		else if (nextMesh) inverse.push({ type: 'delete-mesh', id: nextMesh.id });
	} else {
		inverse.push({ type: 'delete-instance', id: instanceId });
		inverse.push({ type: 'delete-definition', id: definitionId });
		if (nextMesh) inverse.push({ type: 'delete-mesh', id: nextMesh.id });
	}
	inverse.push(...inverseMaterialEdits);

	// Step 7: Admission enforcement (`validateAuthoringDocument`).
	const nextGraph = assertAdmittedNext(graph, forward, module.moduleId);
	const canonicalMesh = nextMesh ? (nextGraph.meshes.find((m) => m.id === nextMesh.id) ?? null) : null;
	const canonicalDigest = sha256Hex(meshDigestInput(canonicalMesh ?? { positions: [], faces: [] }));
	if (canonicalDigest !== bakedMeshSha256) {
		throw invalidGeometry('ADMISSION:baked mesh digest drifted after canonicalization').withModule(module.moduleId);
	}

	return { forward, inverse, instanceId, bakedMeshSha256 };
}
