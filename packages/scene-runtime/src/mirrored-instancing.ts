import type { PreparedRuntimeGeometryGroup, PreparedRuntimeGeometryScene } from './prepared-types.js';
import { preparedRuntimeGroupBuffers } from './surface-batching.js';

export type MirroredInstancingMetrics = {
	inputGroupCount: number;
	outputGroupCount: number;
	splitGroupCount: number;
	mirroredOccurrenceCount: number;
	allocatedTypedArrayBytes: number;
	preparationMs: number;
};

type OccurrenceRows = number[];
type NumericTypedArray = Uint16Array | Uint32Array | Int32Array;
type NumericArray = NumericTypedArray | number[];
type IndexArray = Uint16Array | Uint32Array;

const OCCURRENCE_FIELDS = new Set([
	'occurrenceHandles',
	'occurrenceDefinitionIds',
	'occurrenceInstanceIds',
	'occurrenceHierarchyDepths',
	'occurrenceInstanceIndices',
	'occurrenceTagIndices',
	'occurrenceHierarchyIndices',
	'sourceOccurrenceIndices'
]);

const INTEGER_ARRAY_OCCURRENCE_FIELDS = new Set([
	'occurrenceInstanceIndices',
	'occurrenceTagIndices',
	'occurrenceHierarchyIndices'
]);

/**
 * Normalize reflected instance transforms in the derived render scene so that
 * instanced draws keep front-face winding consistent with ordinary Mesh draws.
 * Source/canonical scene data and source edge sets are never modified.
 */
export function normalizePreparedMirroredInstances(scene: PreparedRuntimeGeometryScene): MirroredInstancingMetrics {
	const startedAt = now();
	const inputGroups = scene.groups;
	const stagedGroups: PreparedRuntimeGeometryGroup[] = [];
	const allocatedBuffers = new Set<ArrayBuffer>();
	let splitGroupCount = 0;
	let mirroredOccurrenceCount = 0;
	const sourceByIndex = new Map(scene.meshes.map((mesh) => [mesh.sourceMeshIndex, mesh]));

	for (let groupIndex = 0; groupIndex < inputGroups.length; groupIndex += 1) {
		const group = inputGroups[groupIndex]!;
		const occurrenceCount = validateMatrices(group, groupIndex);
		const positiveRows: number[] = [];
		const negativeRows: number[] = [];
		for (let occurrenceIndex = 0; occurrenceIndex < occurrenceCount; occurrenceIndex += 1) {
			const determinant = matrixDeterminant(group.matrices, occurrenceIndex * 16);
			if (!Number.isFinite(determinant)) invalid(groupIndex, occurrenceIndex, 'matrix determinant is not finite');
			(determinant < 0 ? negativeRows : positiveRows).push(occurrenceIndex);
		}

		if (negativeRows.length === 0) {
			stagedGroups.push(group);
			continue;
		}

		validateOccurrenceFields(group, occurrenceCount, groupIndex);
		const source = sourceByIndex.get(group.sourceMeshIndex);
		if (!source) invalid(groupIndex, undefined, `source mesh ${group.sourceMeshIndex} is missing`);
		const buffers = preparedRuntimeGroupBuffers(group, source);
		validateGeometry(group, buffers, groupIndex);

		if (positiveRows.length > 0) splitGroupCount += 1;
		mirroredOccurrenceCount += negativeRows.length;
		if (positiveRows.length > 0) stagedGroups.push(makePartition(group, positiveRows, groupIndex, allocatedBuffers));
		stagedGroups.push(makePartition(group, negativeRows, groupIndex, allocatedBuffers, buffers));
	}

	// Publish only after every group has been validated and every derived buffer exists.
	// Preserve the original list identity when a repeated invocation is a no-op.
	const groupsChanged = stagedGroups.length !== inputGroups.length || stagedGroups.some((group, index) => group !== inputGroups[index]);
	if (groupsChanged) scene.groups = stagedGroups;
	return {
		inputGroupCount: inputGroups.length,
		outputGroupCount: stagedGroups.length,
		splitGroupCount,
		mirroredOccurrenceCount,
		allocatedTypedArrayBytes: [...allocatedBuffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
		preparationMs: Math.max(0, now() - startedAt)
	};
}

function now(): number {
	const value = globalThis.performance?.now?.() ?? Date.now();
	return Number.isFinite(value) ? value : 0;
}

function invalid(groupIndex: number, occurrenceIndex: number | undefined, detail: string): never {
	const where = occurrenceIndex === undefined ? `group ${groupIndex}` : `group ${groupIndex} occurrence ${occurrenceIndex}`;
	throw new Error(`Prepared reflection invalid: ${where}: ${detail}.`);
}

function validateMatrices(group: PreparedRuntimeGeometryGroup, groupIndex: number): number {
	if (group.matrices.length % 16 !== 0) invalid(groupIndex, undefined, 'matrix length is not divisible by 16');
	const occurrenceCount = group.matrices.length / 16;
	for (let occurrenceIndex = 0; occurrenceIndex < occurrenceCount; occurrenceIndex += 1) {
		const offset = occurrenceIndex * 16;
		for (let component = 0; component < 16; component += 1) {
			if (!Number.isFinite(group.matrices[offset + component])) invalid(groupIndex, occurrenceIndex, `matrix component ${component} is not finite`);
		}
		if (group.matrices[offset + 3] !== 0 || group.matrices[offset + 7] !== 0 || group.matrices[offset + 11] !== 0) {
			invalid(groupIndex, occurrenceIndex, 'matrix is not affine');
		}
		if (group.matrices[offset + 15] !== 1) invalid(groupIndex, occurrenceIndex, 'affine matrix element 15 is not one');
	}
	return occurrenceCount;
}

function matrixDeterminant(matrices: Float32Array, offset: number): number {
	const a = matrices[offset]!;
	const b = matrices[offset + 1]!;
	const c = matrices[offset + 2]!;
	const d = matrices[offset + 4]!;
	const e = matrices[offset + 5]!;
	const f = matrices[offset + 6]!;
	const g = matrices[offset + 8]!;
	const h = matrices[offset + 9]!;
	const i = matrices[offset + 10]!;
	return a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
}

function validateOccurrenceFields(group: PreparedRuntimeGeometryGroup, occurrenceCount: number, groupIndex: number) {
	for (const key of Object.keys(group)) {
		if ((key.startsWith('occurrence') || key === 'sourceOccurrenceIndices') && !OCCURRENCE_FIELDS.has(key)) {
			invalid(groupIndex, undefined, `unrecognized occurrence field ${key}`);
		}
	}
	for (const key of OCCURRENCE_FIELDS) {
		const value = (group as unknown as Record<string, unknown>)[key];
		if (value === undefined) continue;
		if (!Array.isArray(value) && !ArrayBuffer.isView(value)) invalid(groupIndex, undefined, `${key} is not an array`);
		const length = Array.isArray(value) ? value.length : ArrayBuffer.isView(value) && 'length' in value ? Number(value.length) : -1;
		if (length !== occurrenceCount) invalid(groupIndex, undefined, `${key} length does not match matrix rows`);
		if (key === 'occurrenceHandles' || key === 'occurrenceDefinitionIds' || key === 'occurrenceInstanceIds') {
			if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) invalid(groupIndex, undefined, `${key} must be a string array`);
		} else if (key === 'occurrenceInstanceIndices' || key === 'occurrenceHierarchyIndices') {
			if (!(value instanceof Uint32Array) && !Array.isArray(value)) invalid(groupIndex, undefined, `${key} must be Uint32Array or number[]`);
		} else if (key === 'occurrenceTagIndices') {
			if (!(value instanceof Int32Array) && !Array.isArray(value)) invalid(groupIndex, undefined, `${key} must be Int32Array or number[]`);
		} else if (key === 'occurrenceHierarchyDepths' && !(value instanceof Uint16Array)) invalid(groupIndex, undefined, `${key} must be Uint16Array`);
		else if (key === 'sourceOccurrenceIndices' && !(value instanceof Uint32Array)) invalid(groupIndex, undefined, `${key} must be Uint32Array`);
		if (
			Array.isArray(value) &&
			INTEGER_ARRAY_OCCURRENCE_FIELDS.has(key) &&
			value.some((entry) => typeof entry !== 'number' || !Number.isSafeInteger(entry))
		) {
			invalid(groupIndex, undefined, `${key} contains a non-integer row value`);
		}
	}
}

function validateGeometry(
	group: PreparedRuntimeGeometryGroup,
	buffers: ReturnType<typeof preparedRuntimeGroupBuffers>,
	groupIndex: number
) {
	const { positions, normals, uvs } = buffers;
	if (positions.length % 3 !== 0) invalid(groupIndex, undefined, 'position length is not divisible by three');
	if (normals && normals.length !== positions.length) invalid(groupIndex, undefined, 'normal length does not match positions');
	if (uvs && uvs.length !== positions.length / 3 * 2) invalid(groupIndex, undefined, 'UV length does not match position vertices');
	validateIndexStream(group.indices, positions.length / 3, groupIndex, 'full indices');
	if (group.solidIndices) validateIndexStream(group.solidIndices, positions.length / 3, groupIndex, 'solid indices');
	const fullTriangleCount = group.indices.length / 3;
	for (const [name, values] of [
		['sourceFaceIndicesByTriangle', group.sourceFaceIndicesByTriangle],
		['sourceTagIndicesByTriangle', group.sourceTagIndicesByTriangle],
		['sourceFrontMaterialIndicesByTriangle', group.sourceFrontMaterialIndicesByTriangle],
		['sourceBackMaterialIndicesByTriangle', group.sourceBackMaterialIndicesByTriangle],
		['sourceFaceAreasByTriangle', group.sourceFaceAreasByTriangle]
	] as const) {
		if (values && values.length !== fullTriangleCount) invalid(groupIndex, undefined, `${name} length does not match full triangles`);
	}
	if (group.solidSourceTriangleIndices) {
		const solidTriangleCount = (group.solidIndices?.length ?? 0) / 3;
		if (group.solidSourceTriangleIndices.length !== solidTriangleCount) invalid(groupIndex, undefined, 'solid source-triangle map length does not match solid triangles');
		for (let index = 0; index < group.solidSourceTriangleIndices.length; index += 1) {
			if (group.solidSourceTriangleIndices[index]! >= fullTriangleCount) invalid(groupIndex, undefined, `solid source-triangle map entry ${index} is outside full triangles`);
		}
	}
	const bounds = group.localBounds;
	const boundsValues = [...bounds.min, ...bounds.max, ...bounds.sphereCenter, bounds.sphereRadius];
	if (boundsValues.some((value) => !Number.isFinite(value)) || bounds.sphereRadius < 0) invalid(groupIndex, undefined, 'local bounds are not finite');
	for (let axis = 0; axis < 3; axis += 1) if (bounds.min[axis]! > bounds.max[axis]!) invalid(groupIndex, undefined, `local bounds axis ${axis} is inverted`);
}

function validateIndexStream(indices: IndexArray, vertexCount: number, groupIndex: number, name: string) {
	if (!(indices instanceof Uint16Array) && !(indices instanceof Uint32Array)) invalid(groupIndex, undefined, `${name} must be Uint16Array or Uint32Array`);
	if (indices.length % 3 !== 0) invalid(groupIndex, undefined, `${name} length is not divisible by three`);
	for (let index = 0; index < indices.length; index += 1) {
		if (indices[index]! >= vertexCount) invalid(groupIndex, undefined, `${name} entry ${index} is outside positions`);
	}
}

function track<T extends ArrayBufferView>(value: T, allocatedBuffers: Set<ArrayBuffer>): T {
	allocatedBuffers.add(value.buffer as ArrayBuffer);
	return value;
}

function selectNumbers<T extends NumericArray>(values: T | undefined, rows: OccurrenceRows, allocatedBuffers: Set<ArrayBuffer>): T | undefined {
	if (values === undefined) return undefined;
	const selected = rows.map((row) => values?.[row] ?? row);
	if (Array.isArray(values)) return selected as T;
	const typedValues = values as NumericTypedArray;
	const Constructor = typedValues.constructor as { new(source: ArrayLike<number>): NumericTypedArray };
	return track(new Constructor(selected), allocatedBuffers) as T;
}

function selectStrings(values: string[] | undefined, rows: OccurrenceRows): string[] | undefined {
	return values === undefined ? undefined : rows.map((row) => values[row]!);
}

function selectMatrixRows(matrices: Float32Array, rows: OccurrenceRows, allocatedBuffers: Set<ArrayBuffer>): Float32Array {
	const result = track(new Float32Array(rows.length * 16), allocatedBuffers);
	rows.forEach((row, index) => result.set(matrices.subarray(row * 16, row * 16 + 16), index * 16));
	return result;
}

function cloneIndexStream<T extends IndexArray>(indices: T, reverseWinding: boolean, allocatedBuffers: Set<ArrayBuffer>): T {
	const Constructor = indices.constructor as { new(source: ArrayLike<number>): T };
	const copy = track(new Constructor(indices), allocatedBuffers);
	if (reverseWinding) {
		for (let index = 0; index < copy.length; index += 3) {
			const second = copy[index + 1]!;
			copy[index + 1] = copy[index + 2]!;
			copy[index + 2] = second;
		}
	}
	return copy;
}

function makePartition(
	group: PreparedRuntimeGeometryGroup,
	rows: OccurrenceRows,
	groupIndex: number,
	allocatedBuffers: Set<ArrayBuffer>,
	buffers?: ReturnType<typeof preparedRuntimeGroupBuffers>
): PreparedRuntimeGeometryGroup {
	const negative = buffers !== undefined;
	const matrices = selectMatrixRows(group.matrices, rows, allocatedBuffers);
	const sourceOccurrenceIndices = group.sourceOccurrenceIndices
		? selectNumbers(group.sourceOccurrenceIndices, rows, allocatedBuffers) as Uint32Array
		: track(new Uint32Array(rows), allocatedBuffers);
	if (!(sourceOccurrenceIndices instanceof Uint32Array)) {
		invalid(groupIndex, undefined, 'sourceOccurrenceIndices is not Uint32Array');
	}
	track(sourceOccurrenceIndices, allocatedBuffers);
	const partition: PreparedRuntimeGeometryGroup = {
		...group,
		matrices,
		occurrenceHandles: selectStrings(group.occurrenceHandles, rows),
		occurrenceDefinitionIds: selectStrings(group.occurrenceDefinitionIds, rows),
		occurrenceInstanceIds: selectStrings(group.occurrenceInstanceIds, rows),
		occurrenceHierarchyDepths: selectNumbers(group.occurrenceHierarchyDepths, rows, allocatedBuffers),
		occurrenceInstanceIndices: selectNumbers(group.occurrenceInstanceIndices, rows, allocatedBuffers),
		occurrenceTagIndices: selectNumbers(group.occurrenceTagIndices, rows, allocatedBuffers),
		occurrenceHierarchyIndices: selectNumbers(group.occurrenceHierarchyIndices, rows, allocatedBuffers),
		sourceOccurrenceIndices
	};
	if (!negative) return partition;

	const reflectedPositions = track(new Float32Array(buffers.positions), allocatedBuffers);
	for (let index = 0; index < reflectedPositions.length; index += 3) reflectedPositions[index] = -reflectedPositions[index]!;
	const reflectedNormals = buffers.normals ? track(new Float32Array(buffers.normals), allocatedBuffers) : undefined;
	if (reflectedNormals) for (let index = 0; index < reflectedNormals.length; index += 3) reflectedNormals[index] = -reflectedNormals[index]!;
	const negativeMatrices = partition.matrices;
	for (let row = 0; row < rows.length; row += 1) {
		const offset = row * 16;
		for (let component = 0; component < 4; component += 1) negativeMatrices[offset + component] = -negativeMatrices[offset + component]!;
	}
	const oldBounds = group.localBounds;
	return {
		...partition,
		indices: cloneIndexStream(group.indices, true, allocatedBuffers),
		solidIndices: group.solidIndices ? cloneIndexStream(group.solidIndices, true, allocatedBuffers) : undefined,
		batchPositions: reflectedPositions,
		batchNormals: reflectedNormals,
		batchUvs: buffers.uvs,
		localBounds: {
			min: [-oldBounds.max[0], oldBounds.min[1], oldBounds.min[2]],
			max: [-oldBounds.min[0], oldBounds.max[1], oldBounds.max[2]],
			sphereCenter: [-oldBounds.sphereCenter[0], oldBounds.sphereCenter[1], oldBounds.sphereCenter[2]],
			sphereRadius: oldBounds.sphereRadius
		}
	};
}
