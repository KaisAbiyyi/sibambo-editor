/**
 * SIB-MCP-MODELING-001 v2.1 A20/C9a — validation of the root-metadata key `arch`.
 * Pure and cheap enough for the main thread: it never imports the geometry kernel.
 * Called from `authoring/model.ts::modelMetadata`, so it runs inside every
 * `validateAuthoringDocument` (owner actions included) and must fail closed.
 */
import type { BomcGraph } from '@sibambo/bomc-document';
import { canonicalJson, utf8Bytes, validateArchModule, type ArchModule } from './schema.js';

export const ARCH_SCHEMA = 'sibambo-arch-v2';
export const MAX_ARCH_MODULES = 64;
export const MAX_ARCH_BYTES = 512 * 1024;

export type ArchEntry = { instanceId: string; module: ArchModule; bakedMeshSha256: string };
export type ArchMetadata = { schema: typeof ARCH_SCHEMA; modules: ArchEntry[] };

function reject(detail: string): never {
	throw new Error('Unsupported arch metadata: ' + detail);
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactKeys(value: unknown, keys: string): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys;
}

/** Order of checks follows the plan (C9a steps 1–9). */
export function validateArchMetadata(value: unknown, graph: BomcGraph): asserts value is ArchMetadata {
	if (!exactKeys(value, 'modules,schema') || value.schema !== ARCH_SCHEMA) reject('expected {schema:"sibambo-arch-v2", modules:[...]}.');
	const modules = value.modules;
	if (!Array.isArray(modules) || modules.length > MAX_ARCH_MODULES) reject(`modules must be an array of at most ${MAX_ARCH_MODULES} entries.`);
	const instancePattern = new RegExp(`^${escapeRegex(graph.documentId)}:instance:op:[1-9]\\d*:[1-9]\\d*$`);
	const instanceIds = new Set<string>();
	const moduleIds = new Set<string>();
	let previousModuleId: string | null = null;
	modules.forEach((entry, index) => {
		if (!exactKeys(entry, 'bakedMeshSha256,instanceId,module')) reject(`entry ${index} must have exactly instanceId, module, bakedMeshSha256.`);
		if (typeof entry.instanceId !== 'string' || !instancePattern.test(entry.instanceId)) reject(`entry ${index} instanceId is not a container id of this document.`);
		if (typeof entry.bakedMeshSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.bakedMeshSha256)) reject(`entry ${index} bakedMeshSha256 must be 64 lowercase hex characters.`);
		try {
			validateArchModule(entry.module);
		} catch (error) {
			reject(`entry ${index} module ${error instanceof Error ? error.message : 'is invalid'}`);
		}
		const moduleId = (entry.module as ArchModule).moduleId;
		if (instanceIds.has(entry.instanceId)) reject(`entry ${index} duplicates instanceId.`);
		if (moduleIds.has(moduleId)) reject(`entry ${index} duplicates moduleId ${moduleId}.`);
		if (previousModuleId !== null && !(previousModuleId < moduleId)) reject('modules must be sorted by moduleId.');
		instanceIds.add(entry.instanceId);
		moduleIds.add(moduleId);
		previousModuleId = moduleId;
	});
	if (utf8Bytes(JSON.stringify(value)) > MAX_ARCH_BYTES) reject('the arch value exceeds 512 KiB.');
	for (const entry of modules as ArchEntry[]) {
		const instance = graph.instances.find((candidate) => candidate.id === entry.instanceId);
		if (instance && instance.kind !== 'group') reject(`entry for ${entry.module.moduleId} must point at a group container.`);
	}
}

/** Canonical digest input for A5 `bakedMeshSha256` (sorted keys over {positions, faces}). */
export function meshDigestInput(mesh: { positions: readonly number[]; faces: readonly unknown[] }): string {
	return canonicalJson({ faces: mesh.faces, positions: mesh.positions });
}
