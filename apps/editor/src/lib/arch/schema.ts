/**
 * SIB-MCP-MODELING-001 v2.1 C2 — ArchModule v2 validation (pure; no kernel import).
 * Structural rules come from the generated AJV validator; this file adds the
 * semantic checks JSON Schema cannot express.
 */
import validateArchModuleSchema from './arch-module-v2.validator.generated.js';

export const BUILT_IN_MATERIAL_IDS = Object.freeze(['sib-default', 'sib-frame', 'sib-glass', 'sib-door'] as const);
export const MAX_MODULE_CANONICAL_BYTES = 64 * 1024;

export type ArchElement = { elementId: string; kind: 'wall' | 'slab' | 'opening' | 'space'; [key: string]: unknown };
export type ArchModule = {
	schemaVersion: '2.0.0';
	moduleId: string;
	revision: number;
	name?: string;
	transform: number[];
	materials: { materialId: string; rgba: number[]; opacity: number }[];
	elements: ArchElement[];
};

export class ArchSchemaError extends Error {
	constructor(readonly pointer: string, message: string) {
		super(`${pointer || '/'}: ${message}`);
	}
}

/** Canonical JSON: object keys sorted by code unit, arrays in order, no whitespace. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		if (typeof value === 'number' && !Number.isFinite(value)) throw new ArchSchemaError('', 'non-finite number');
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
	const keys = Object.keys(value as Record<string, unknown>).sort();
	return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k])).join(',') + '}';
}

export function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** Throws ArchSchemaError on the first violation. */
export function validateArchModule(module: unknown): asserts module is ArchModule {
	if (!validateArchModuleSchema(module)) {
		const first = (validateArchModuleSchema as any).errors?.[0];
		throw new ArchSchemaError(first?.instancePath ?? '', first?.message ?? 'invalid ArchModule v2');
	}
	const value = module as ArchModule;
	if (utf8Bytes(canonicalJson(value)) > MAX_MODULE_CANONICAL_BYTES) throw new ArchSchemaError('', 'module canonical JSON exceeds 64 KiB');
	const materialIds = new Set<string>();
	value.materials.forEach((material, index) => {
		if (materialIds.has(material.materialId)) throw new ArchSchemaError(`/materials/${index}/materialId`, 'duplicate materialId');
		materialIds.add(material.materialId);
	});
	const elements = new Map<string, ArchElement>();
	value.elements.forEach((element, index) => {
		if (elements.has(element.elementId)) throw new ArchSchemaError(`/elements/${index}/elementId`, 'duplicate elementId');
		elements.set(element.elementId, element);
	});
	value.elements.forEach((element, index) => {
		const materialId = element.materialId as string | undefined;
		if (materialId !== undefined && !materialIds.has(materialId) && !(BUILT_IN_MATERIAL_IDS as readonly string[]).includes(materialId))
			throw new ArchSchemaError(`/elements/${index}/materialId`, 'material is neither declared nor built-in');
		if (element.kind === 'opening') {
			const host = elements.get(element.hostElementId as string);
			if (!host || host.kind !== 'wall') throw new ArchSchemaError(`/elements/${index}/hostElementId`, 'host must be a wall in the same module');
		}
		if (element.kind === 'wall' && element.closed === true) {
			const path = element.path as number[][];
			if (path.length < 3) throw new ArchSchemaError(`/elements/${index}/path`, 'a closed wall needs at least 3 points');
			const first = path[0]!, last = path[path.length - 1]!;
			if (Math.abs(first[0]! - last[0]!) <= 1e-9 && Math.abs(first[1]! - last[1]!) <= 1e-9)
				throw new ArchSchemaError(`/elements/${index}/path`, 'a closed wall must not repeat its first point');
		}
	});
}
