/**
 * SIB-MCP-MODELING-001 v2.3 C9 (WP5) — `arch/managed.ts`: read-only inspection of managed
 * architectural modules stored in root metadata (`arch`), reporting `ok`, `detached`, or `orphaned`.
 */
import type { BomcGraph, Instance, Mesh } from '@sibambo/bomc-document';
import { modelMetadata } from '../authoring/model.js';
import { fromInstanceMatrix } from './convention.js';
import { meshDigestInput, type ArchEntry } from './metadata.js';
import { sha256Hex } from './sha256.js';

export type ManagedState = 'ok' | 'detached' | 'orphaned';

export type ManagedModuleRecord = {
	entry: ArchEntry;
	instance: Instance | null;
	state: ManagedState;
};

/** Effective module->document row-major transform decoded from the container instance matrix (A10/A20). */
export function effectiveModuleTransform(record: Pick<ManagedModuleRecord, 'entry' | 'instance'>): number[] {
	return record.instance ? fromInstanceMatrix(record.instance.matrix) : [...record.entry.module.transform];
}

/** Current mesh digest used by `bakedMeshSha256` (A5). */
export function currentMeshSha256(mesh: Pick<Mesh, 'positions' | 'faces'> | null): string {
	return sha256Hex(meshDigestInput(mesh ?? { positions: [], faces: [] }));
}

/**
 * Inspect all managed modules in `modelMetadata(graph).arch`.
 * - `orphaned`: container instance is missing from `graph.instances`
 * - `detached`: container mesh SHA-256 differs from `entry.bakedMeshSha256`
 * - `ok`: container instance and baked mesh match `entry`
 */
export function readManaged(graph: BomcGraph): Map<string, ManagedModuleRecord> {
	const metadata = modelMetadata(graph);
	const result = new Map<string, ManagedModuleRecord>();
	const arch = metadata.arch;
	if (!arch) return result;

	const instanceById = new Map(graph.instances.map((i) => [i.id, i]));
	const definitionById = new Map(graph.definitions.map((d) => [d.id, d]));
	const meshById = new Map(graph.meshes.map((m) => [m.id, m]));

	for (const entry of arch.modules) {
		const instance = instanceById.get(entry.instanceId) ?? null;
		if (!instance) {
			result.set(entry.module.moduleId, { entry, instance: null, state: 'orphaned' });
			continue;
		}
		const definition = definitionById.get(instance.definitionId) ?? null;
		const mesh = definition?.meshId ? (meshById.get(definition.meshId) ?? null) : null;
		const state: ManagedState = currentMeshSha256(mesh) === entry.bakedMeshSha256 ? 'ok' : 'detached';
		result.set(entry.module.moduleId, { entry, instance, state });
	}
	return result;
}
