import type { PreparedRuntimeGeometryGroup, PreparedRuntimeGeometryScene } from './prepared-types.js';
import {
	prepareSolidCoplanarScene as prepareSolidCoplanarSceneCore,
	type GeometryPreparationProgress,
	type SolidGeometryTolerancePolicy
} from './solid-coplanar-resolution-core.js';

export * from './solid-coplanar-resolution-core.js';

const OCCURRENCE_ROW_FIELDS = new Set([
	'occurrenceHandles',
	'occurrenceDefinitionIds',
	'occurrenceInstanceIds',
	'occurrenceHierarchyDepths',
	'occurrenceInstanceIndices',
	'occurrenceTagIndices',
	'occurrenceHierarchyIndices',
	'sourceOccurrenceIndices'
]);
const ROW_HANDLE_PREFIX = '__sibambo_solid_row__';

function invalid(groupIndex: number, reason: string): never {
	throw new Error(`Prepared solid invalid: group ${groupIndex}: ${reason}.`);
}

function assertLength(groupIndex: number, field: string, value: ArrayLike<unknown>, rows: number) {
	if (value.length !== rows) invalid(groupIndex, `${field} length ${value.length} does not match matrix rows ${rows}`);
}

function validateStringRows(groupIndex: number, field: string, value: unknown, rows: number) {
	if (value === undefined) return;
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) invalid(groupIndex, `${field} must be a string array`);
	assertLength(groupIndex, field, value, rows);
}

function validateRows(scene: PreparedRuntimeGeometryScene) {
	for (const [groupIndex, group] of scene.groups.entries()) {
		if (!(group.matrices instanceof Float32Array)) invalid(groupIndex, 'matrices must be Float32Array');
		if (group.matrices.length === 0 || group.matrices.length % 16 !== 0) {
			invalid(groupIndex, `matrices length ${group.matrices.length} is not a nonzero multiple of 16`);
		}
		const rows = group.matrices.length / 16;
		for (const key of Object.keys(group)) {
			if ((key.startsWith('occurrence') || key === 'sourceOccurrenceIndices') && !OCCURRENCE_ROW_FIELDS.has(key)) {
				invalid(groupIndex, `unknown occurrence row field ${key}`);
			}
		}
		validateStringRows(groupIndex, 'occurrenceHandles', group.occurrenceHandles, rows);
		validateStringRows(groupIndex, 'occurrenceDefinitionIds', group.occurrenceDefinitionIds, rows);
		validateStringRows(groupIndex, 'occurrenceInstanceIds', group.occurrenceInstanceIds, rows);
		if (group.occurrenceHierarchyDepths !== undefined) {
			if (!(group.occurrenceHierarchyDepths instanceof Uint16Array)) invalid(groupIndex, 'occurrenceHierarchyDepths must be Uint16Array');
			assertLength(groupIndex, 'occurrenceHierarchyDepths', group.occurrenceHierarchyDepths, rows);
		}
		if (group.occurrenceInstanceIndices !== undefined) {
			const value = group.occurrenceInstanceIndices;
			if (!(value instanceof Uint32Array) && !(Array.isArray(value) && value.every(Number.isSafeInteger))) {
				invalid(groupIndex, 'occurrenceInstanceIndices must be Uint32Array or a safe-integer number array');
			}
			assertLength(groupIndex, 'occurrenceInstanceIndices', value, rows);
		}
		if (group.occurrenceTagIndices !== undefined) {
			const value = group.occurrenceTagIndices;
			if (!(value instanceof Int32Array) && !(Array.isArray(value) && value.every(Number.isSafeInteger))) {
				invalid(groupIndex, 'occurrenceTagIndices must be Int32Array or a safe-integer number array');
			}
			assertLength(groupIndex, 'occurrenceTagIndices', value, rows);
		}
		if (group.occurrenceHierarchyIndices !== undefined) {
			if (!(group.occurrenceHierarchyIndices instanceof Uint32Array)) invalid(groupIndex, 'occurrenceHierarchyIndices must be Uint32Array');
			assertLength(groupIndex, 'occurrenceHierarchyIndices', group.occurrenceHierarchyIndices, rows);
		}
		if (group.sourceOccurrenceIndices !== undefined) {
			if (!(group.sourceOccurrenceIndices instanceof Uint32Array)) invalid(groupIndex, 'sourceOccurrenceIndices must be Uint32Array');
			assertLength(groupIndex, 'sourceOccurrenceIndices', group.sourceOccurrenceIndices, rows);
		}
	}
}

function stringRows(values: string[] | undefined, rows: readonly number[]) {
	return values ? rows.map((row) => values[row]) : undefined;
}
function uint16Rows(values: Uint16Array | undefined, rows: readonly number[]) {
	return values ? Uint16Array.from(rows.map((row) => values[row])) : undefined;
}
function uint32Rows(values: Uint32Array | undefined, rows: readonly number[]) {
	return values ? Uint32Array.from(rows.map((row) => values[row])) : undefined;
}
function uint32OrNumberRows(values: Uint32Array | number[] | undefined, rows: readonly number[]) {
	if (values === undefined) return undefined;
	const selected = rows.map((row) => values[row]);
	return values instanceof Uint32Array ? Uint32Array.from(selected) : selected;
}
function int32OrNumberRows(values: Int32Array | number[] | undefined, rows: readonly number[]) {
	if (values === undefined) return undefined;
	const selected = rows.map((row) => values[row]);
	return values instanceof Int32Array ? Int32Array.from(selected) : selected;
}

function sentinelHandle(groupIndex: number, row: number) {
	return `${ROW_HANDLE_PREFIX}${groupIndex}:${row}`;
}
function parseSentinel(handle: string | undefined) {
	if (!handle?.startsWith(ROW_HANDLE_PREFIX)) return null;
	const [groupText, rowText] = handle.slice(ROW_HANDLE_PREFIX.length).split(':');
	const groupIndex = Number(groupText);
	const row = Number(rowText);
	return Number.isSafeInteger(groupIndex) && Number.isSafeInteger(row) ? { groupIndex, row } : null;
}

function repairDerivedGroup(
	group: PreparedRuntimeGeometryGroup,
	sourceGroups: readonly PreparedRuntimeGeometryGroup[],
	workingGroups: readonly PreparedRuntimeGeometryGroup[]
): PreparedRuntimeGeometryGroup {
	const identityIndex = workingGroups.indexOf(group);
	if (identityIndex >= 0) return sourceGroups[identityIndex];
	const sentinels = group.occurrenceHandles ?? [];
	if (sentinels.length === 0) throw new Error('Prepared solid internal: derived group lost occurrence row sentinels.');
	const parsed = sentinels.map(parseSentinel);
	if (parsed.some((entry) => !entry)) throw new Error('Prepared solid internal: invalid occurrence row sentinel.');
	const sourceIndex = parsed[0]!.groupIndex;
	if (parsed.some((entry) => entry!.groupIndex !== sourceIndex)) throw new Error('Prepared solid internal: mixed source rows in one derived group.');
	const source = sourceGroups[sourceIndex];
	if (!source) throw new Error('Prepared solid internal: derived group references an unknown source group.');
	const rows = parsed.map((entry) => entry!.row);
	return {
		...group,
		occurrenceHandles: stringRows(source.occurrenceHandles, rows),
		occurrenceDefinitionIds: stringRows(source.occurrenceDefinitionIds, rows),
		occurrenceInstanceIds: stringRows(source.occurrenceInstanceIds, rows),
		occurrenceHierarchyDepths: uint16Rows(source.occurrenceHierarchyDepths, rows),
		occurrenceInstanceIndices: uint32OrNumberRows(source.occurrenceInstanceIndices, rows),
		occurrenceTagIndices: int32OrNumberRows(source.occurrenceTagIndices, rows),
		occurrenceHierarchyIndices: uint32Rows(source.occurrenceHierarchyIndices, rows),
		sourceOccurrenceIndices: source.sourceOccurrenceIndices
			? Uint32Array.from(rows.map((row) => source.sourceOccurrenceIndices![row]))
			: Uint32Array.from(rows)
	};
}

function restoreSuppressionHandles(
	suppressions: PreparedRuntimeGeometryScene['solidCoplanarSuppressions'],
	sourceGroups: readonly PreparedRuntimeGeometryGroup[]
) {
	if (!suppressions) return suppressions;
	const restore = (handle: string | undefined) => {
		const row = parseSentinel(handle);
		return row ? sourceGroups[row.groupIndex]?.occurrenceHandles?.[row.row] : handle;
	};
	return suppressions.map((entry) => ({
		...entry,
		winner: { ...entry.winner, occurrenceHandle: restore(entry.winner.occurrenceHandle) },
		loser: { ...entry.loser, occurrenceHandle: restore(entry.loser.occurrenceHandle) }
	}));
}

export function prepareSolidCoplanarScene(
	scene: PreparedRuntimeGeometryScene,
	decodedPrecision = 0.00003,
	customPolicy?: Partial<SolidGeometryTolerancePolicy>,
	onProgress?: (progress: GeometryPreparationProgress) => void
) {
	validateRows(scene);
	const sourceGroups = scene.groups;
	const workingGroups = sourceGroups.map((group, groupIndex) => ({
		...group,
		occurrenceHandles: Array.from(
			{ length: group.matrices.length / 16 },
			(_, row) => sentinelHandle(groupIndex, row)
		)
	}));
	let publishedGroups: PreparedRuntimeGeometryGroup[] = workingGroups;
	const workingScene: PreparedRuntimeGeometryScene = { ...scene, groups: workingGroups };
	Object.defineProperty(workingScene, 'groups', {
		configurable: true,
		enumerable: true,
		get: () => publishedGroups,
		set: (groups: PreparedRuntimeGeometryGroup[]) => {
			publishedGroups = groups.map((group) => repairDerivedGroup(group, sourceGroups, workingGroups));
			scene.groups = publishedGroups;
		}
	});
	const metrics = prepareSolidCoplanarSceneCore(workingScene, decodedPrecision, customPolicy, onProgress);
	scene.groups = publishedGroups;
	scene.solidEdgeSets = workingScene.solidEdgeSets;
	scene.solidCoplanarResolution = workingScene.solidCoplanarResolution;
	scene.solidCoplanarSuppressions = restoreSuppressionHandles(workingScene.solidCoplanarSuppressions, sourceGroups);
	return metrics;
}
