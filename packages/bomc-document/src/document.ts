import type {
	BomcDocumentErrorCode,
	BomcGraph,
	BomcRevisionTokens,
	BomcSnapshot,
	Definition,
	DocumentEdit,
	Face,
	GraphBounds,
	Instance,
	Mesh,
	SolidMaterial
} from './types.js';

const EMPTY_TOKENS: BomcRevisionTokens = {
	name: 0, strings: 0, layout: 0, materials: 0, definitions: 0, instances: 0, transforms: 0, geometry: 0
};

export class BomcDocumentError extends Error {
	readonly code: BomcDocumentErrorCode;

	constructor(code: BomcDocumentErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'BomcDocumentError';
		this.code = code;
	}
}

type CreateOptions = { documentId: string; name?: string };
type MutableGraph = {
	documentId: string;
	name: string;
	rootDefinitionId: string;
	rootInstanceId: string;
	materials: SolidMaterial[];
	definitions: Definition[];
	meshes: Mesh[];
	instances: Instance[];
};
type InternalGraph = BomcGraph;

const GRAPH_KEYS = ['documentId', 'name', 'rootDefinitionId', 'rootInstanceId', 'materials', 'definitions', 'meshes', 'instances'];
const MATERIAL_KEYS = ['id', 'name', 'displayName', 'rgba', 'opacityU16'];
const DEFINITION_KEYS = ['id', 'name', 'kind', 'meshId'];
const MESH_KEYS = ['id', 'definitionId', 'positions', 'faces'];
const FACE_KEYS = ['id', 'outer', 'holes', 'triangles', 'normal', 'frontMaterialId', 'backMaterialId', 'hidden', 'surfaceCode', 'roleCode', 'label'];
const INSTANCE_KEYS = ['id', 'name', 'kind', 'ownerDefinitionId', 'definitionId', 'matrix', 'materialId', 'visible', 'roleCode', 'label'];
const ROOT_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function fail(code: BomcDocumentErrorCode, message: string, cause?: unknown): never {
	throw new BomcDocumentError(code, message, cause);
}

function invalid(message: string): never {
	return fail('INVALID_DOCUMENT', message);
}

function unsupported(message: string): never {
	return fail('UNSUPPORTED_FEATURE', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, expected: readonly string[], path: string): asserts value is Record<string, any> {
	if (!isRecord(value)) invalid(`${path} must be an ordinary record`);
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.some((key) => typeof key !== 'string')) unsupported(`${path} contains a symbol key outside web-core-v1`);
	const keys = ownKeys as string[];
	const allowed = new Set(expected);
	const extra = keys.find((key) => !allowed.has(key));
	if (extra) unsupported(`${path}.${extra} is outside web-core-v1`);
	const missing = expected.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
	if (missing) invalid(`${path}.${missing} is required`);
	for (const key of expected) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !('value' in descriptor)) unsupported(`${path}.${key} must be a data property`);
	}
}

function ordinaryArray(value: unknown, path: string): asserts value is readonly unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid(`${path} must be an ordinary array`);
	for (const key of Reflect.ownKeys(value)) {
		if (key === 'length') continue;
		if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length || String(Number(key)) !== key) {
			unsupported(`${path} has an unsupported non-index array property`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !('value' in descriptor)) unsupported(`${path}[${key}] must be a data property`);
	}
}

function wellFormedString(value: unknown, path: string, nonempty = false): asserts value is string {
	if (typeof value !== 'string') invalid(`${path} must be a string`);
	if (nonempty && value.length === 0) invalid(`${path} must not be empty`);
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) invalid(`${path} contains an unmatched high surrogate`);
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) invalid(`${path} contains an unmatched low surrogate`);
	}
}

function nullableString(value: unknown, path: string) {
	if (value !== null) wellFormedString(value, path);
}

function finiteNumber(value: unknown, path: string): asserts value is number {
	if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${path} must be finite`);
}

function unsigned(value: unknown, max: number, path: string): asserts value is number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max || Object.is(value, -0)) {
		invalid(`${path} must be an unsigned integer in range`);
	}
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function copyFace(face: Face): Face {
	return {
		...face,
		outer: [...face.outer],
		holes: face.holes.map((ring) => [...ring]),
		triangles: [...face.triangles],
		normal: [...face.normal] as [number, number, number]
	};
}

function copyMaterial(material: SolidMaterial): SolidMaterial {
	return { ...material, rgba: [...material.rgba] as [number, number, number, number] };
}

function copyDefinition(definition: Definition): Definition {
	return { ...definition };
}

function copyMesh(mesh: Mesh): Mesh {
	return { ...mesh, positions: [...mesh.positions], faces: mesh.faces.map(copyFace) };
}

function copyInstance(instance: Instance): Instance {
	return { ...instance, matrix: [...instance.matrix] };
}

function cloneGraph(graph: BomcGraph): MutableGraph {
	return {
		documentId: graph.documentId,
		name: graph.name,
		rootDefinitionId: graph.rootDefinitionId,
		rootInstanceId: graph.rootInstanceId,
		materials: graph.materials.map(copyMaterial),
		definitions: graph.definitions.map(copyDefinition),
		meshes: graph.meshes.map(copyMesh),
		instances: graph.instances.map(copyInstance)
	};
}

function putRecord<T extends { id: string }>(rows: readonly T[], replacement: T): T[] {
	const index = rows.findIndex((row) => row.id === replacement.id);
	const next = rows.slice();
	if (index < 0) next.push(replacement);
	else next[index] = replacement;
	return next;
}

function deleteRecord<T extends { id: string }>(rows: readonly T[], id: string, path: string): T[] {
	const index = rows.findIndex((row) => row.id === id);
	if (index < 0) invalid(`${path} cannot delete missing ID ${JSON.stringify(id)}`);
	return [...rows.slice(0, index), ...rows.slice(index + 1)];
}

function validateEditRecord(type: string, value: unknown, path: string) {
	const graph = {
		documentId: 'validation-document', name: '', rootDefinitionId: 'root-definition', rootInstanceId: 'root-instance',
		materials: type === 'put-material' ? [value] : [],
		definitions: type === 'put-definition' ? [value] : [],
		meshes: type === 'put-mesh' ? [value] : [],
		instances: type === 'put-instance' ? [value] : []
	};
	try {
		validateGraphShape(graph);
	} catch (error) {
		if (error instanceof BomcDocumentError) throw new BomcDocumentError(error.code, `${path}: ${error.message}`, error);
		throw error;
	}
}

function deepFreeze<T>(root: T): T {
	const seen = new WeakSet<object>();
	const stack: object[] = [];
	if (typeof root === 'object' && root !== null) stack.push(root);
	while (stack.length) {
		const current = stack.pop()!;
		if (seen.has(current)) continue;
		seen.add(current);
		for (const key of Object.keys(current)) {
			const value = (current as Record<string, unknown>)[key];
			if (typeof value === 'object' && value !== null) stack.push(value);
		}
		Object.freeze(current);
	}
	return root;
}

function canonicalize(graph: MutableGraph): BomcGraph {
	const rootDefinition = graph.rootDefinitionId;
	const rootInstance = graph.rootInstanceId;
	return {
		documentId: graph.documentId,
		name: graph.name,
		rootDefinitionId: rootDefinition,
		rootInstanceId: rootInstance,
		materials: graph.materials.slice().sort((a, b) => compareCodeUnits(a.id, b.id)),
		definitions: graph.definitions.slice().sort((a, b) => a.id === rootDefinition ? -1 : b.id === rootDefinition ? 1 : compareCodeUnits(a.id, b.id)),
		meshes: graph.meshes.slice().sort((a, b) => compareCodeUnits(a.id, b.id)).map((mesh) => ({ ...mesh, faces: mesh.faces.slice().sort((a, b) => compareCodeUnits(a.id, b.id)) })),
		instances: graph.instances.slice().sort((a, b) => a.id === rootInstance ? -1 : b.id === rootInstance ? 1 : compareCodeUnits(a.id, b.id))
	};
}

function validateRecordTable(value: unknown, path: string): readonly unknown[] {
	ordinaryArray(value, path);
	return value;
}

function validateGraphShape(graph: unknown): asserts graph is BomcGraph {
	exactKeys(graph, GRAPH_KEYS, 'graph');
	wellFormedString(graph.documentId, 'graph.documentId', true);
	wellFormedString(graph.name, 'graph.name');
	wellFormedString(graph.rootDefinitionId, 'graph.rootDefinitionId', true);
	wellFormedString(graph.rootInstanceId, 'graph.rootInstanceId', true);
	validateRecordTable(graph.materials, 'graph.materials');
	validateRecordTable(graph.definitions, 'graph.definitions');
	validateRecordTable(graph.meshes, 'graph.meshes');
	validateRecordTable(graph.instances, 'graph.instances');
	for (let index = 0; index < graph.materials.length; index += 1) {
		const row = graph.materials[index];
		exactKeys(row, MATERIAL_KEYS, `materials[${index}]`);
		wellFormedString(row.id, `materials[${index}].id`, true);
		wellFormedString(row.name, `materials[${index}].name`);
		nullableString(row.displayName, `materials[${index}].displayName`);
		ordinaryArray(row.rgba, `materials[${index}].rgba`);
		if (row.rgba.length !== 4) invalid(`materials[${index}].rgba must have four entries`);
		for (const [channel, channelValue] of row.rgba.entries()) unsigned(channelValue, 255, `materials[${index}].rgba[${channel}]`);
		unsigned(row.opacityU16, 65535, `materials[${index}].opacityU16`);
	}
	for (let index = 0; index < graph.definitions.length; index += 1) {
		const row = graph.definitions[index];
		exactKeys(row, DEFINITION_KEYS, `definitions[${index}]`);
		wellFormedString(row.id, `definitions[${index}].id`, true);
		wellFormedString(row.name, `definitions[${index}].name`);
		if (row.kind !== 'model' && row.kind !== 'component' && row.kind !== 'group') invalid(`definitions[${index}].kind is unsupported`);
		nullableString(row.meshId, `definitions[${index}].meshId`);
	}
	for (let meshIndex = 0; meshIndex < graph.meshes.length; meshIndex += 1) {
		const mesh = graph.meshes[meshIndex];
		exactKeys(mesh, MESH_KEYS, `meshes[${meshIndex}]`);
		wellFormedString(mesh.id, `meshes[${meshIndex}].id`, true);
		wellFormedString(mesh.definitionId, `meshes[${meshIndex}].definitionId`, true);
		ordinaryArray(mesh.positions, `meshes[${meshIndex}].positions`);
		if (mesh.positions.length % 3 !== 0) invalid(`meshes[${meshIndex}].positions must contain XYZ triples`);
		for (let valueIndex = 0; valueIndex < mesh.positions.length; valueIndex += 1) finiteNumber(mesh.positions[valueIndex], `meshes[${meshIndex}].positions[${valueIndex}]`);
		ordinaryArray(mesh.faces, `meshes[${meshIndex}].faces`);
		if (mesh.faces.length === 0) invalid(`meshes[${meshIndex}] must contain at least one face`);
		const validatedMesh = mesh as Mesh;
		for (let faceIndex = 0; faceIndex < mesh.faces.length; faceIndex += 1) validateFace(mesh.faces[faceIndex], validatedMesh, meshIndex, faceIndex);
	}
	for (let index = 0; index < graph.instances.length; index += 1) {
		const row = graph.instances[index];
		exactKeys(row, INSTANCE_KEYS, `instances[${index}]`);
		wellFormedString(row.id, `instances[${index}].id`, true);
		wellFormedString(row.name, `instances[${index}].name`);
		if (row.kind !== 'root' && row.kind !== 'component' && row.kind !== 'group') invalid(`instances[${index}].kind is unsupported`);
		nullableString(row.ownerDefinitionId, `instances[${index}].ownerDefinitionId`);
		wellFormedString(row.definitionId, `instances[${index}].definitionId`, true);
		ordinaryArray(row.matrix, `instances[${index}].matrix`);
		if (row.matrix.length !== 16) invalid(`instances[${index}].matrix must contain 16 values`);
		for (let component = 0; component < 16; component += 1) finiteNumber(row.matrix[component], `instances[${index}].matrix[${component}]`);
		nullableString(row.materialId, `instances[${index}].materialId`);
		if (typeof row.visible !== 'boolean') invalid(`instances[${index}].visible must be boolean`);
		unsigned(row.roleCode, 23, `instances[${index}].roleCode`);
		nullableString(row.label, `instances[${index}].label`);
	}
}

function validateFace(faceValue: unknown, mesh: Mesh, meshIndex: number, faceIndex: number) {
	const path = `meshes[${meshIndex}].faces[${faceIndex}]`;
	exactKeys(faceValue, FACE_KEYS, path);
	const face = faceValue as unknown as Face;
	wellFormedString(face.id, `${path}.id`, true);
	ordinaryArray(face.outer, `${path}.outer`);
	ordinaryArray(face.holes, `${path}.holes`);
	ordinaryArray(face.triangles, `${path}.triangles`);
	ordinaryArray(face.normal, `${path}.normal`);
	if (face.normal.length !== 3) invalid(`${path}.normal must contain three values`);
	const normal = face.normal as readonly number[];
	normal.forEach((value, axis) => finiteNumber(value, `${path}.normal[${axis}]`));
	const normalLength = Math.hypot(normal[0]!, normal[1]!, normal[2]!);
	if (!Number.isFinite(normalLength) || normalLength === 0 || Math.abs(normalLength - 1) > 1e-9) invalid(`${path}.normal must be a unit vector within 1e-9`);
	const vertexCount = mesh.positions.length / 3;
	const ringValues: readonly (readonly number[])[] = [face.outer, ...face.holes];
	if (ringValues[0]!.length < 3) invalid(`${path}.outer must contain at least three vertices`);
	const faceVertices = new Set<number>();
	for (let ringIndex = 0; ringIndex < ringValues.length; ringIndex += 1) {
		const ring = ringValues[ringIndex]!;
		if (ring.length < 3) invalid(`${path}.holes[${ringIndex - 1}] must contain at least three vertices`);
		const seen = new Set<number>();
		for (let item = 0; item < ring.length; item += 1) {
			const vertex = ring[item];
			unsigned(vertex, 0xffffffff, `${path}.ring[${ringIndex}][${item}]`);
			if (vertex >= vertexCount) invalid(`${path}.ring[${ringIndex}] references a missing position`);
			if (seen.has(vertex)) invalid(`${path}.ring[${ringIndex}] repeats a vertex`);
			seen.add(vertex);
			faceVertices.add(vertex);
		}
		if (ring[0] === ring[ring.length - 1]) invalid(`${path}.ring[${ringIndex}] repeats its closing vertex`);
	}
	if (face.triangles.length === 0 || face.triangles.length % 3 !== 0) invalid(`${path}.triangles must contain complete triangles`);
	const positions = mesh.positions;
	for (let triangleOffset = 0; triangleOffset < face.triangles.length; triangleOffset += 3) {
		const aIndex = face.triangles[triangleOffset]!;
		const bIndex = face.triangles[triangleOffset + 1]!;
		const cIndex = face.triangles[triangleOffset + 2]!;
		for (const [slot, vertex] of [[0, aIndex], [1, bIndex], [2, cIndex]] as const) {
			unsigned(vertex, 0xffffffff, `${path}.triangles[${triangleOffset + slot}]`);
			if (vertex >= vertexCount || !faceVertices.has(vertex)) invalid(`${path}.triangle references a vertex outside its rings`);
		}
		if (aIndex === bIndex || bIndex === cIndex || cIndex === aIndex) invalid(`${path}.triangle has repeated vertices`);
		const ax = positions[aIndex * 3]!; const ay = positions[aIndex * 3 + 1]!; const az = positions[aIndex * 3 + 2]!;
		const abx = positions[bIndex * 3]! - ax; const aby = positions[bIndex * 3 + 1]! - ay; const abz = positions[bIndex * 3 + 2]! - az;
		const acx = positions[cIndex * 3]! - ax; const acy = positions[cIndex * 3 + 1]! - ay; const acz = positions[cIndex * 3 + 2]! - az;
		const crossX = aby * acz - abz * acy; const crossY = abz * acx - abx * acz; const crossZ = abx * acy - aby * acx;
		const orientation = crossX * normal[0]! + crossY * normal[1]! + crossZ * normal[2]!;
		if (![crossX, crossY, crossZ, orientation].every(Number.isFinite) || orientation <= 0) invalid(`${path}.triangle is degenerate or reversed against its normal`);
	}
	const first = face.outer[0]!;
	const planeX = positions[first * 3]!; const planeY = positions[first * 3 + 1]!; const planeZ = positions[first * 3 + 2]!;
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (const vertex of faceVertices) {
		const point = [positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!];
		for (let axis = 0; axis < 3; axis += 1) {
			min[axis] = Math.min(min[axis]!, point[axis]!);
			max[axis] = Math.max(max[axis]!, point[axis]!);
		}
	}
	const diagonal = Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
	const planeTolerance = 1e-9 * Math.max(1, diagonal);
	for (const vertex of faceVertices) {
		const point = [positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!];
		const distance = (point[0] - planeX) * normal[0]! + (point[1] - planeY) * normal[1]! + (point[2] - planeZ) * normal[2]!;
		if (!Number.isFinite(distance) || Math.abs(distance) > planeTolerance) invalid(`${path} vertices are not planar within tolerance`);
	}
	nullableString(face.frontMaterialId, `${path}.frontMaterialId`);
	nullableString(face.backMaterialId, `${path}.backMaterialId`);
	if (typeof face.hidden !== 'boolean') invalid(`${path}.hidden must be boolean`);
	unsigned(face.surfaceCode, 15, `${path}.surfaceCode`);
	unsigned(face.roleCode, 23, `${path}.roleCode`);
	nullableString(face.label, `${path}.label`);
}

function validateReferencesAndRoot(graph: BomcGraph) {
	const definitions = new Map(graph.definitions.map((definition) => [definition.id, definition]));
	const materials = new Set(graph.materials.map((material) => material.id));
	const meshes = new Map(graph.meshes.map((mesh) => [mesh.id, mesh]));
	const idSet = new Set<string>();
	const addId = (id: string, path: string) => {
		if (idSet.has(id)) invalid(`${path} duplicates global ID ${JSON.stringify(id)}`);
		idSet.add(id);
	};
	for (const material of graph.materials) addId(material.id, 'material ID');
	for (const definition of graph.definitions) addId(definition.id, 'definition ID');
	for (const mesh of graph.meshes) {
		addId(mesh.id, 'mesh ID');
		for (const face of mesh.faces) addId(face.id, 'face ID');
	}
	for (const instance of graph.instances) addId(instance.id, 'instance ID');
	const modelDefinitions = graph.definitions.filter((definition) => definition.kind === 'model');
	const rootInstances = graph.instances.filter((instance) => instance.kind === 'root');
	if (modelDefinitions.length !== 1 || modelDefinitions[0]?.id !== graph.rootDefinitionId) invalid('graph must have exactly one model definition matching rootDefinitionId');
	if (rootInstances.length !== 1 || rootInstances[0]?.id !== graph.rootInstanceId) invalid('graph must have exactly one root instance matching rootInstanceId');
	const rootDefinition = definitions.get(graph.rootDefinitionId);
	const rootInstance = graph.instances.find((instance) => instance.id === graph.rootInstanceId);
	if (!rootDefinition || !rootInstance || rootDefinition.kind !== 'model' || rootInstance.definitionId !== rootDefinition.id || rootInstance.ownerDefinitionId !== null || rootInstance.kind !== 'root') {
		invalid('root definition and root instance do not form the required root pair');
	}
	if (rootInstance.matrix.some((value, index) => !Object.is(value, ROOT_MATRIX[index]))) invalid('root instance matrix must be positive-zero identity');
	const meshByDefinition = new Map<string, Mesh>();
	for (const mesh of graph.meshes) {
		const definition = definitions.get(mesh.definitionId);
		if (!definition || definition.meshId !== mesh.id) invalid(`mesh ${mesh.id} does not match its definition.meshId`);
		if (meshByDefinition.has(mesh.definitionId)) invalid(`definition ${mesh.definitionId} owns more than one mesh`);
		meshByDefinition.set(mesh.definitionId, mesh);
	}
	for (const definition of graph.definitions) {
		if (definition.meshId !== null) {
			const mesh = meshes.get(definition.meshId);
			if (!mesh || mesh.definitionId !== definition.id) invalid(`definition ${definition.id} has an invalid mesh reference`);
		} else if (meshByDefinition.has(definition.id)) invalid(`definition ${definition.id} is missing its mesh reference`);
	}
	for (const mesh of graph.meshes) {
		for (const face of mesh.faces) {
			if (face.frontMaterialId !== null && !materials.has(face.frontMaterialId)) invalid(`face ${face.id} has a missing front material`);
			if (face.backMaterialId !== null && !materials.has(face.backMaterialId)) invalid(`face ${face.id} has a missing back material`);
		}
	}
	for (const instance of graph.instances) {
		if (instance.materialId !== null && !materials.has(instance.materialId)) invalid(`instance ${instance.id} has a missing material`);
		const target = definitions.get(instance.definitionId);
		if (!target) invalid(`instance ${instance.id} has a missing definition`);
		if (instance.id === graph.rootInstanceId) continue;
		const owner = instance.ownerDefinitionId === null ? undefined : definitions.get(instance.ownerDefinitionId);
		if (!owner) invalid(`instance ${instance.id} has a missing owner definition`);
		if (target.kind === 'model' || instance.kind !== target.kind || (instance.kind !== 'component' && instance.kind !== 'group')) {
			invalid(`instance ${instance.id} kind does not match its target definition`);
		}
	}
	assertAcyclicDefinitions(graph);
}

function assertAcyclicDefinitions(graph: BomcGraph) {
	const adjacency = new Map<string, string[]>();
	for (const definition of graph.definitions) adjacency.set(definition.id, []);
	for (const instance of graph.instances) {
		if (instance.ownerDefinitionId !== null) adjacency.get(instance.ownerDefinitionId)!.push(instance.definitionId);
	}
	for (const children of adjacency.values()) children.sort(compareCodeUnits);
	const colors = new Map<string, 0 | 1 | 2>();
	for (const start of [...adjacency.keys()].sort(compareCodeUnits)) {
		if (colors.get(start) === 2) continue;
		const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
		colors.set(start, 1);
		while (stack.length) {
			const top = stack[stack.length - 1]!;
			const children = adjacency.get(top.id)!;
			if (top.next >= children.length) {
				colors.set(top.id, 2);
				stack.pop();
				continue;
			}
			const child = children[top.next++]!;
			const color = colors.get(child) ?? 0;
			if (color === 1) invalid(`definition instantiation cycle reaches ${child}`);
			if (color === 0) {
				colors.set(child, 1);
				stack.push({ id: child, next: 0 });
			}
		}
	}
}

function validateAndCanonicalize(input: BomcGraph): BomcGraph {
	validateGraphShape(input);
	const graph = canonicalize(input as unknown as MutableGraph);
	validateReferencesAndRoot(graph);
	validateMatrices(graph);
	const bounds = deriveGraphBounds(graph);
	if ([...bounds.min, ...bounds.max].some((value) => !Number.isFinite(value))) invalid('root bounds are not finite');
	return graph;
}

function matrixDeterminant(matrix: readonly number[]): number {
	const [a, b, c, d, e, f, g, h, i] = [matrix[0]!, matrix[1]!, matrix[2]!, matrix[4]!, matrix[5]!, matrix[6]!, matrix[8]!, matrix[9]!, matrix[10]!];
	return a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
}

function validateMatrices(graph: BomcGraph) {
	for (const instance of graph.instances) {
		const matrix = instance.matrix;
		if (matrix[3] !== 0 || Object.is(matrix[3], -0) || matrix[7] !== 0 || Object.is(matrix[7], -0) || matrix[11] !== 0 || Object.is(matrix[11], -0) || matrix[15] !== 1) {
			invalid(`instance ${instance.id} matrix must be affine with positive-zero bottom-row entries`);
		}
		const determinant = matrixDeterminant(matrix);
		if (!Number.isFinite(determinant) || determinant === 0) invalid(`instance ${instance.id} matrix must have a finite nonzero determinant`);
	}
}

function unionPoint(bounds: { min: number[]; max: number[] } | null, point: readonly number[]) {
	if (point.some((value) => !Number.isFinite(value))) invalid('transformed graph bounds overflowed');
	if (!bounds) return { min: [...point], max: [...point] };
	for (let axis = 0; axis < 3; axis += 1) {
		bounds.min[axis] = Math.min(bounds.min[axis]!, point[axis]!);
		bounds.max[axis] = Math.max(bounds.max[axis]!, point[axis]!);
	}
	return bounds;
}

function transformPoint(matrix: readonly number[], point: readonly number[]): [number, number, number] {
	return [
		matrix[0]! * point[0]! + matrix[4]! * point[1]! + matrix[8]! * point[2]! + matrix[12]!,
		matrix[1]! * point[0]! + matrix[5]! * point[1]! + matrix[9]! * point[2]! + matrix[13]!,
		matrix[2]! * point[0]! + matrix[6]! * point[1]! + matrix[10]! * point[2]! + matrix[14]!
	];
}

function includeTransformedBounds(
	into: { min: number[]; max: number[] } | null,
	child: GraphBounds,
	matrix: readonly number[]
) {
	let bounds = into;
	for (let mask = 0; mask < 8; mask += 1) {
		const corner = [0, 1, 2].map((axis) => (mask & (1 << axis)) ? child.max[axis]! : child.min[axis]!);
		bounds = unionPoint(bounds, transformPoint(matrix, corner));
	}
	return bounds;
}

/** Conservative model-root bounds, computed child-before-parent without recursion. */
export function deriveGraphBounds(graph: BomcGraph): GraphBounds {
	const meshBounds = new Map<string, GraphBounds>();
	for (const mesh of graph.meshes) {
		const min = [Infinity, Infinity, Infinity];
		const max = [-Infinity, -Infinity, -Infinity];
		for (let offset = 0; offset < mesh.positions.length; offset += 3) {
			for (let axis = 0; axis < 3; axis += 1) {
				min[axis] = Math.min(min[axis]!, mesh.positions[offset + axis]!);
				max[axis] = Math.max(max[axis]!, mesh.positions[offset + axis]!);
			}
		}
		meshBounds.set(mesh.definitionId, { min: min as [number, number, number], max: max as [number, number, number] });
	}
	const dependencies = new Map(graph.definitions.map((definition) => [definition.id, 0]));
	const parentsByChild = new Map<string, string[]>();
	const childInstancesByOwner = new Map<string, Instance[]>();
	for (const instance of graph.instances) {
		if (instance.ownerDefinitionId === null) continue;
		dependencies.set(instance.ownerDefinitionId, (dependencies.get(instance.ownerDefinitionId) ?? 0) + 1);
		const parents = parentsByChild.get(instance.definitionId) ?? [];
		parents.push(instance.ownerDefinitionId);
		parentsByChild.set(instance.definitionId, parents);
		const ownedChildren = childInstancesByOwner.get(instance.ownerDefinitionId) ?? [];
		ownedChildren.push(instance);
		childInstancesByOwner.set(instance.ownerDefinitionId, ownedChildren);
	}
	const ready = [...dependencies].filter(([, count]) => count === 0).map(([id]) => id).sort(compareCodeUnits);
	const definitionBounds = new Map<string, GraphBounds | null>();
	let processed = 0;
	while (ready.length) {
		const definitionId = ready.shift()!;
		processed += 1;
		const sourceBounds = meshBounds.get(definitionId);
		let own = sourceBounds ? { min: [...sourceBounds.min], max: [...sourceBounds.max] } : null;
		for (const childInstance of childInstancesByOwner.get(definitionId) ?? []) {
			const childBounds = definitionBounds.get(childInstance.definitionId);
			if (childBounds) own = includeTransformedBounds(own, childBounds, childInstance.matrix);
		}
		definitionBounds.set(definitionId, own ? { min: own.min as [number, number, number], max: own.max as [number, number, number] } : null);
		for (const parent of parentsByChild.get(definitionId) ?? []) {
			const remaining = (dependencies.get(parent) ?? 0) - 1;
			dependencies.set(parent, remaining);
			if (remaining === 0) {
				ready.push(parent);
				ready.sort(compareCodeUnits);
			}
		}
	}
	if (processed !== graph.definitions.length) invalid('definition instantiation graph is cyclic');
	const rootBounds = definitionBounds.get(graph.rootDefinitionId) ?? null;
	if (!rootBounds) return { min: [0, 0, 0], max: [0, 0, 0] };
	const rootInstance = graph.instances.find((instance) => instance.id === graph.rootInstanceId)!;
	const transformed = includeTransformedBounds(null, rootBounds, rootInstance.matrix)!;
	return { min: transformed.min as [number, number, number], max: transformed.max as [number, number, number] };
}

function collectStrings(graph: BomcGraph): Set<string> {
	const strings = new Set<string>([graph.documentId, graph.name]);
	for (const material of graph.materials) {
		strings.add(material.id); strings.add(material.name);
		if (material.displayName !== null) strings.add(material.displayName);
	}
	for (const definition of graph.definitions) { strings.add(definition.id); strings.add(definition.name); }
	for (const mesh of graph.meshes) {
		strings.add(mesh.id);
		for (const face of mesh.faces) {
			strings.add(face.id);
			if (face.label !== null) strings.add(face.label);
		}
	}
	for (const instance of graph.instances) {
		strings.add(instance.id); strings.add(instance.name);
		if (instance.label !== null) strings.add(instance.label);
	}
	return strings;
}

function equalValue(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (typeof left !== typeof right || left === null || right === null || typeof left !== 'object') return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		for (let index = 0; index < left.length; index += 1) if (!equalValue(left[index], right[index])) return false;
		return true;
	}
	const leftKeys = Object.keys(left as object);
	const rightKeys = Object.keys(right as object);
	if (leftKeys.length !== rightKeys.length || leftKeys.some((key) => !rightKeys.includes(key))) return false;
	return leftKeys.every((key) => equalValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
	if (left.size !== right.size) return false;
	for (const value of left) if (!right.has(value)) return false;
	return true;
}

function layoutIdentity(graph: BomcGraph): string {
	return JSON.stringify([
		graph.materials.map((row) => row.id),
		graph.definitions.map((row) => row.id),
		graph.meshes.map((row) => [row.id, row.faces.map((face) => face.id)]),
		graph.instances.map((row) => row.id)
	]);
}

function withoutInstanceMatrices(instances: readonly Instance[]) {
	return instances.map(({ matrix: _matrix, ...instance }) => instance);
}

function transformIdentity(instances: readonly Instance[]) {
	return instances.map((instance) => [instance.id, instance.matrix]);
}

function safeIncrement(value: number, label: string) {
	if (value >= Number.MAX_SAFE_INTEGER) fail('RESOURCE_LIMIT', `${label} counter is exhausted`);
	return value + 1;
}

export class BomcDocument {
	private graph: InternalGraph | null;
	private revisionValue: number;
	private tokensValue: BomcRevisionTokens;
	private cachedSnapshot: BomcSnapshot | null = null;
	private closed = false;

	private constructor(graph: BomcGraph, revision: number, tokens: BomcRevisionTokens) {
		this.graph = deepFreeze(graph);
		this.revisionValue = revision;
		this.tokensValue = deepFreeze({ ...tokens });
	}

	static create(options: CreateOptions): BomcDocument {
		if (!isRecord(options)) invalid('create options must be a record');
		const keys = Object.keys(options);
		if (keys.some((key) => key !== 'documentId' && key !== 'name')) unsupported('create options contain an unsupported field');
		wellFormedString(options.documentId, 'documentId', true);
		const name = options.name === undefined ? 'Untitled' : options.name;
		wellFormedString(name, 'name');
		const graph: BomcGraph = {
			documentId: options.documentId,
			name,
			rootDefinitionId: `${options.documentId}:definition:root`,
			rootInstanceId: `${options.documentId}:instance:root`,
			materials: [],
			definitions: [{ id: `${options.documentId}:definition:root`, name: 'Document Root', kind: 'model', meshId: null }],
			meshes: [],
			instances: [{
				id: `${options.documentId}:instance:root`, name: 'Root', kind: 'root', ownerDefinitionId: null,
				definitionId: `${options.documentId}:definition:root`, matrix: [...ROOT_MATRIX], materialId: null,
				visible: true, roleCode: 0, label: null
			}]
		};
		const canonical = validateAndCanonicalize(graph);
		return new BomcDocument(canonical, 0, EMPTY_TOKENS);
	}

	static fromGraph(graph: BomcGraph, revision = 0): BomcDocument {
		unsigned(revision, Number.MAX_SAFE_INTEGER, 'revision');
		validateGraphShape(graph);
		const owned = cloneGraph(graph);
		const canonical = validateAndCanonicalize(owned);
		const tokens = Object.fromEntries(Object.keys(EMPTY_TOKENS).map((key) => [key, revision])) as unknown as BomcRevisionTokens;
		return new BomcDocument(canonical, revision, tokens);
	}

	transact(edits: readonly DocumentEdit[]): number {
		this.assertOpen();
		ordinaryArray(edits, 'edits');
		const current = this.graph!;
		const draft: MutableGraph = {
			documentId: current.documentId,
			name: current.name,
			rootDefinitionId: current.rootDefinitionId,
			rootInstanceId: current.rootInstanceId,
			materials: current.materials as SolidMaterial[],
			definitions: current.definitions as Definition[],
			meshes: current.meshes as Mesh[],
			instances: current.instances as Instance[]
		};
		for (let index = 0; index < edits.length; index += 1) this.applyEdit(draft, edits[index], index);
		const canonical = validateAndCanonicalize(draft);
		if (equalValue(current, canonical)) return this.revisionValue;
		if (this.revisionValue >= Number.MAX_SAFE_INTEGER) fail('RESOURCE_LIMIT', 'document revision counter is exhausted');
		const changes = {
			name: !Object.is(current.name, canonical.name),
			strings: !sameStringSet(collectStrings(current), collectStrings(canonical)),
			layout: layoutIdentity(current) !== layoutIdentity(canonical),
			materials: !equalValue(current.materials, canonical.materials),
			definitions: !equalValue(current.definitions, canonical.definitions),
			instances: !equalValue(withoutInstanceMatrices(current.instances), withoutInstanceMatrices(canonical.instances)),
			transforms: !equalValue(transformIdentity(current.instances), transformIdentity(canonical.instances)),
			geometry: !equalValue(current.meshes, canonical.meshes)
		};
		const nextTokens = { ...this.tokensValue };
		for (const key of Object.keys(changes) as Array<keyof typeof changes>) {
			if (changes[key]) nextTokens[key] = safeIncrement(nextTokens[key], `${key} revision`);
		}
		this.graph = deepFreeze(canonical);
		this.revisionValue += 1;
		this.tokensValue = deepFreeze(nextTokens);
		this.cachedSnapshot = null;
		return this.revisionValue;
	}

	snapshot(): BomcSnapshot {
		this.assertOpen();
		if (!this.cachedSnapshot) {
			this.cachedSnapshot = deepFreeze({ graph: this.graph!, revision: this.revisionValue, tokens: { ...this.tokensValue } });
		}
		return this.cachedSnapshot;
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.graph = null;
		this.cachedSnapshot = null;
		this.tokensValue = { ...EMPTY_TOKENS };
	}

	private assertOpen() {
		if (this.closed || this.graph === null) fail('CLOSED', 'document is closed');
	}

	private applyEdit(draft: MutableGraph, editValue: unknown, index: number) {
		const path = `edits[${index}]`;
		if (!isRecord(editValue)) invalid(`${path} must be a record`);
		const type = editValue.type;
		if (type === 'set-name') {
			exactKeys(editValue, ['type', 'name'], path);
			wellFormedString(editValue.name, `${path}.name`);
			draft.name = editValue.name;
			return;
		}
		if (type === 'put-material' || type === 'put-definition' || type === 'put-mesh' || type === 'put-instance') {
			exactKeys(editValue, ['type', 'value'], path);
			validateEditRecord(type, editValue.value, `${path}.value`);
			if (type === 'put-material') draft.materials = putRecord(draft.materials, copyMaterial(editValue.value as SolidMaterial));
			else if (type === 'put-definition') draft.definitions = putRecord(draft.definitions, copyDefinition(editValue.value as Definition));
			else if (type === 'put-mesh') draft.meshes = putRecord(draft.meshes, copyMesh(editValue.value as Mesh));
			else draft.instances = putRecord(draft.instances, copyInstance(editValue.value as Instance));
			return;
		}
		if (type === 'delete-material' || type === 'delete-definition' || type === 'delete-mesh' || type === 'delete-instance') {
			exactKeys(editValue, ['type', 'id'], path);
			wellFormedString(editValue.id, `${path}.id`, true);
			if (type === 'delete-material') draft.materials = deleteRecord(draft.materials, editValue.id, path);
			else if (type === 'delete-definition') draft.definitions = deleteRecord(draft.definitions, editValue.id, path);
			else if (type === 'delete-mesh') draft.meshes = deleteRecord(draft.meshes, editValue.id, path);
			else draft.instances = deleteRecord(draft.instances, editValue.id, path);
			return;
		}
		unsupported(`${path}.type ${JSON.stringify(type)} is outside web-core-v1`);
	}
}
