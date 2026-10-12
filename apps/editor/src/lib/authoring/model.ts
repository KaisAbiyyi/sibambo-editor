import { Matrix4, Vector3 } from 'three';
import type { BomcGraph, DocumentEdit, Face, Instance, Mesh } from '@sibambo/bomc-document';
import {
	AuthoringGeometryError,
	isNeutralMaterial,
	isLegacyMaterial,
	isAuthoredMaterial,
	buildRectangleEdit,
	buildPlanarRectangleEdit,
	buildFaceLoopEdit,
	buildPushPullFaceEdit,
	buildExtrusionEdit,
	validateEditableSubset,
	faceFromRing,
	compactReferencedVertices,
	type GeometryEdit,
} from './geometry.js';
import { preparePolygon } from './polygon.js';
import type { AuthoringPoint, ModelAction, ModelSelection } from './protocol.js';
import { constructionGuides } from './construction-guides.js';
import { assertAffine, meshThrough, normalThrough } from './affine.js';
import { curvePoints, orderedPath, sweepProfile } from './curves.js';
import { organization, instanceVisible, structuralDefinitions, validateOrganization, type ModelOrganization } from './organization.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const SCHEMA = 'sibambo-editor-model-v1';
type Primitive = { id: string; ownerDefinitionId: string; start: AuthoringPoint; end: AuthoringPoint };
export type ModelMetadata = {
	schema: typeof SCHEMA;
	guides: (Primitive & { kind: 'line' | 'point' })[];
	looseEdges: Primitive[];
	organization?: ModelOrganization;
};
type MutableGraph = Omit<BomcGraph, 'materials' | 'definitions' | 'meshes' | 'instances'> & {
	materials: BomcGraph['materials'][number][];
	definitions: BomcGraph['definitions'][number][];
	meshes: Mesh[];
	instances: Instance[];
};
function fail(message: string): never {
	throw new AuthoringGeometryError(message);
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const point = (mesh: Mesh, index: number): AuthoringPoint => [
	mesh.positions[index * 3]!,
	mesh.positions[index * 3 + 1]!,
	mesh.positions[index * 3 + 2]!,
];
const samePoint = (a: AuthoringPoint, b: AuthoringPoint) =>
	a.every((v, i) => Math.abs(v - b[i]!) <= 1e-9 * Math.max(1, Math.abs(v), Math.abs(b[i]!)));
const edgeMatches = (a: AuthoringPoint, b: AuthoringPoint, c: AuthoringPoint, d: AuthoringPoint) =>
	(samePoint(a, c) && samePoint(b, d)) || (samePoint(a, d) && samePoint(b, c));
const toPoint = (v: Vector3): AuthoringPoint => [v.x, v.y, v.z];
export const transformPoint = (p: AuthoringPoint, m: Matrix4): AuthoringPoint =>
	toPoint(new Vector3(...p).applyMatrix4(m));

export function modelMetadata(graph: BomcGraph): ModelMetadata {
	const label = graph.instances.find((i) => i.id === graph.rootInstanceId)?.label;
	if (label === null || label === undefined) return { schema: SCHEMA, guides: [], looseEdges: [] };
	let value: unknown;
	try {
		value = JSON.parse(label);
	} catch {
		return fail('Unsupported root metadata.');
	}
	if (!value || typeof value !== 'object') return fail('Unsupported root metadata.');
	const metadata = value as ModelMetadata;
	if (
		metadata.schema !== SCHEMA ||
		!Array.isArray(metadata.guides) ||
		!Array.isArray(metadata.looseEdges) ||
		!['guides,looseEdges,schema','guides,looseEdges,organization,schema'].includes(Object.keys(metadata).sort().join(','))
	)
		return fail('Unsupported authoring metadata schema.');
	if(metadata.organization!==undefined)validateOrganization(metadata.organization,graph);
	const ids = new Set<string>();
	for (const item of [...metadata.guides, ...metadata.looseEdges]) {
		if (
			!item ||
			typeof item.id !== 'string' ||
			ids.has(item.id) ||
			typeof item.ownerDefinitionId !== 'string' ||
			![item.start, item.end].every((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)) ||
			!graph.definitions.some((d) => d.id === item.ownerDefinitionId)
		)
			fail('Invalid authoring guide/edge metadata.');
		ids.add(item.id);
		const expectedKeys = 'kind' in item ? 'end,id,kind,ownerDefinitionId,start' : 'end,id,ownerDefinitionId,start';
		if (Object.keys(item).sort().join(',') !== expectedKeys || !item.id.startsWith(graph.documentId + ':'))
			fail('Invalid authoring primitive identity or fields.');
	}
	if (metadata.guides.some((g) => g.kind !== 'line' && g.kind !== 'point')) fail('Invalid guide kind.');
	if (metadata.guides.length + metadata.looseEdges.length > 20000) fail('Authoring primitive budget exceeded.');
	return structuredClone(metadata);
}

export function contextTransform(graph: BomcGraph, path: readonly string[]): { definitionId: string; matrix: Matrix4 } {
	let definitionId = graph.rootDefinitionId;
	const matrix = new Matrix4();
	if (path.length > 32) fail('Edit context is too deeply nested.');
	for (const id of path) {
		const instance = graph.instances.find((i) => i.id === id && i.ownerDefinitionId === definitionId);
		if (!instance) fail('Edit context no longer exists; return to the model root.');
		matrix.multiply(new Matrix4().fromArray(instance.matrix));
		definitionId = instance.definitionId;
	}
	return { definitionId, matrix };
}

/** A temporary, canonical flat view for the existing face kernel. Never saved. */
export function definitionGraph(graph: BomcGraph, definitionId: string, world?: Matrix4): BomcGraph {
	const definition = graph.definitions.find((d) => d.id === definitionId);
	if (!definition) fail('Missing edit definition.');
	const source = graph.meshes.find((m) => m.id === definition.meshId);
	const rootDefinitionId = graph.documentId + ':definition:root',
		rootInstanceId = graph.documentId + ':instance:root';
	let mesh: Mesh | null =
		source && source.faces.length
			? { ...source, id: graph.documentId + ':mesh:root', definitionId: rootDefinitionId }
			: null;
	if (mesh && world) {
		mesh = meshThrough(mesh, world);
	}
	return {
		...graph,
		rootDefinitionId,
		rootInstanceId,
		materials: mesh
			? graph.materials.filter((material) =>
					mesh!.faces.some((face) => face.frontMaterialId === material.id || face.backMaterialId === material.id),
				)
			: [],
		definitions: [{ id: rootDefinitionId, name: 'Document Root', kind: 'model', meshId: mesh?.id ?? null }],
		instances: [
			{
				id: rootInstanceId,
				name: 'Root',
				kind: 'root',
				ownerDefinitionId: null,
				definitionId: rootDefinitionId,
				matrix: IDENTITY,
				materialId: null,
				visible: true,
				roleCode: 0,
				label: null,
			},
		],
		meshes: mesh ? [mesh] : [],
	};
}
export function contextGraph(graph: BomcGraph, path: readonly string[], world = false): BomcGraph {
	const context = contextTransform(graph, path);
	const flat = definitionGraph(graph, context.definitionId, world ? context.matrix : undefined);
	constructionGuides.set(
		flat,
		[
			...modelMetadata(graph).guides,
			...modelMetadata(graph).looseEdges.map((edge) => ({ ...edge, kind: 'edge' as const })),
		]
			.filter((g) => g.ownerDefinitionId === context.definitionId)
			.map((g) => ({
				...g,
				start: world ? transformPoint(g.start, context.matrix) : g.start,
				end: world ? transformPoint(g.end, context.matrix) : g.end,
			})),
	);
	return flat;
}
export function modelOccurrences(graph: BomcGraph, includeHidden = false): { definitionId: string; path: string[]; matrix: Matrix4; materialId: string | null }[] {
	const org=organization(graph);
	const output: { definitionId: string; path: string[]; matrix: Matrix4; materialId: string | null }[] = [];
	const visit = (definitionId: string, path: string[], matrix: Matrix4, ancestors: Set<string>, materialId: string | null) => {
		if (output.length >= 10000 || path.length > 32 || ancestors.has(definitionId))
			fail('Cyclic or excessive authoring hierarchy.');
		output.push({ definitionId, path, matrix, materialId });
		const next = new Set(ancestors).add(definitionId);
		for (const instance of graph.instances
			.filter((i) => i.ownerDefinitionId === definitionId && (includeHidden || instanceVisible(graph,i.id,org)))
			.sort((a, b) => cmp(a.id, b.id)))
			visit(
				instance.definitionId,
				[...path, instance.id],
				matrix.clone().multiply(new Matrix4().fromArray(instance.matrix)),
				next,
				instance.materialId ?? materialId,
			);
	};
	visit(graph.rootDefinitionId, [], new Matrix4(), new Set(), null);
	return output;
}
export function validateAuthoringDocument(graph: BomcGraph): ReturnType<typeof validateEditableSubset> {
	if (graph.instances.length === 1 && graph.definitions.length === 1 && graph.instances[0]?.label === null)
		return validateEditableSubset(graph);
	try {
		const root = graph.instances.find((i) => i.id === graph.rootInstanceId);
		if (
			graph.rootDefinitionId !== graph.documentId + ':definition:root' ||
			graph.rootInstanceId !== graph.documentId + ':instance:root' ||
			!root ||
			root.kind !== 'root' ||
			root.name !== 'Root' ||
			root.ownerDefinitionId !== null ||
			root.definitionId !== graph.rootDefinitionId ||
			root.matrix.some((v, i) => v !== IDENTITY[i]) ||
			root.materialId !== null ||
			!root.visible ||
			root.roleCode !== 0
		)
			fail('Unsupported authoring root.');
		modelMetadata(graph);
		if (
			graph.materials.length > 512 ||
			graph.materials.some((material) => !isNeutralMaterial(graph, material) && !isLegacyMaterial(graph, material) && !isAuthoredMaterial(graph,material))
		)
			fail('Unsupported authoring material.');
		const reachable = structuralDefinitions(graph);
		if (reachable.size !== graph.definitions.length) fail('Unreachable definitions cannot be edited.');
		for (const instance of graph.instances.filter((i) => i.kind !== 'root')) {
			let label: unknown;
			try {
				label = JSON.parse(instance.label ?? 'null');
			} catch {
				fail('Unsupported container label.');
			}
			if (
				!Array.isArray(label) ||
				label.length !== 2 ||
				label[0] !== 'sibambo-editor-container-v1' ||
				!Number.isSafeInteger(label[1]) ||
				label[1] < 1 ||
				!instance.id.startsWith(graph.documentId + ':instance:op:') ||
				(instance.materialId !== null && !graph.materials.some(m=>m.id===instance.materialId)) ||
				typeof instance.visible !== 'boolean' ||
				instance.roleCode !== 0 ||
				(instance.kind !== 'group' && instance.kind !== 'component') ||
				graph.definitions.find((d) => d.id === instance.definitionId)?.kind !== instance.kind
			)
				fail('Unsupported container attributes.');
			if (
				instance.matrix[3] !== 0 ||
				instance.matrix[7] !== 0 ||
				instance.matrix[11] !== 0 ||
				instance.matrix[15] !== 1
			)
				fail('Projective container transforms are unsupported.');
			assertAffine(instance.matrix);
		}
		const entities = [];
		for (const definition of graph.definitions) {
			const result = validateEditableSubset(definitionGraph(graph, definition.id));
			if (!result.editable) fail(result.reason);
			entities.push(...result.entities);
		}
		return { editable: true, entities };
	} catch (error) {
		return { editable: false, reason: error instanceof Error ? error.message : 'Invalid authoring model.' };
	}
}
export function nextModelSequence(graph: BomcGraph): number {
	let max = 0;
	const metadata = modelMetadata(graph);
	const org=organization(graph);
	for (const id of [
		...graph.definitions,
		...graph.meshes,
		...graph.instances,
		...graph.materials,
		...graph.meshes.flatMap((m) => m.faces),
		...metadata.guides,
		...metadata.looseEdges,
		...org.tags,...org.assets,
	].map((x) => x.id)) {
		for (const match of id.matchAll(/:(?:rectangle|face|op):(\d+)/g)) max = Math.max(max, Number(match[1]));
	}
	for (const face of graph.meshes.flatMap((m) => m.faces))
		for (const match of (face.label ?? '').matchAll(/:(?:rectangle|face|op):(\d+)/g))
			max = Math.max(max, Number(match[1]));
	if (!Number.isSafeInteger(max) || max >= Number.MAX_SAFE_INTEGER - 1) fail('Authoring sequence exhausted.');
	return max + 1;
}
function diff(before: BomcGraph, after: BomcGraph): GeometryEdit {
	const forward: DocumentEdit[] = [],
		inverse: DocumentEdit[] = [];
	for (const [field, put, del] of [
		['materials', 'put-material', 'delete-material'],
		['definitions', 'put-definition', 'delete-definition'],
		['meshes', 'put-mesh', 'delete-mesh'],
		['instances', 'put-instance', 'delete-instance'],
	] as const) {
		const old = new Map(before[field].map((x) => [x.id, x])),
			next = new Map(after[field].map((x) => [x.id, x]));
		for (const [id, value] of next)
			if (JSON.stringify(value) !== JSON.stringify(old.get(id))) {
				forward.push({ type: put, value } as DocumentEdit);
				inverse.push(
					old.has(id) ? ({ type: put, value: old.get(id) } as DocumentEdit) : ({ type: del, id } as DocumentEdit),
				);
			}
		for (const [id, value] of old)
			if (!next.has(id)) {
				forward.push({ type: del, id } as DocumentEdit);
				inverse.push({ type: put, value } as DocumentEdit);
			}
	}
	return { forward, inverse };
}
export function meshEdges(mesh: Mesh): { start: AuthoringPoint; end: AuthoringPoint; faceIds: string[] }[] {
	const map = new Map<string, { start: AuthoringPoint; end: AuthoringPoint; faceIds: string[] }>();
	for (const face of mesh.faces)
		for (const ring of [face.outer, ...face.holes])
			for (let i = 0; i < ring.length; i++) {
				const a = ring[i]!,
					b = ring[(i + 1) % ring.length]!,
					key = a < b ? a + ':' + b : b + ':' + a;
				const edge = map.get(key) ?? { start: point(mesh, a), end: point(mesh, b), faceIds: [] };
				edge.faceIds.push(face.id);
				map.set(key, edge);
			}
	return [...map.values()];
}
export function offsetLoop(mesh: Mesh, ring: readonly number[], normal: AuthoringPoint, distance: number): AuthoringPoint[] {
	const points = ring.map((i) => new Vector3(...point(mesh, i))),
		n = new Vector3(...normal),
		result: AuthoringPoint[] = [];
	const orientation = new Vector3();
	for (let i = 0; i < points.length; i++) orientation.add(points[i]!.clone().cross(points[(i + 1) % points.length]!));
	if (orientation.dot(n) < 0) points.reverse();
	for (let i = 0; i < points.length; i++) {
		const previous = points[(i + points.length - 1) % points.length]!,
			current = points[i]!,
			next = points[(i + 1) % points.length]!;
		const a = current.clone().sub(previous).normalize(),
			b = next.clone().sub(current).normalize();
		const inwardA = n.clone().cross(a),
			inwardB = n.clone().cross(b);
		const bisector = inwardA.add(inwardB),
			denominator = bisector.dot(n.clone().cross(a));
		if (Math.abs(denominator) < 1e-9) fail('Offset has a reversing or degenerate corner.');
		result.push(toPoint(current.clone().addScaledVector(bisector, distance / denominator)));
	}
	preparePolygon(result, normal, { canonicalizeStart: false });
	// An inset must stay at least the requested distance from every original segment.
	// This rejects crossed, inverted and collapsed offsets, including small convex loops.
	if (distance > 0)
		for (const p of result) {
			const v = new Vector3(...p);
			for (let i = 0; i < points.length; i++) {
				const a = points[i]!,
					b = points[(i + 1) % points.length]!,
					ab = b.clone().sub(a);
				const t = Math.max(0, Math.min(1, v.clone().sub(a).dot(ab) / ab.lengthSq()));
				if (v.distanceTo(a.clone().addScaledVector(ab, t)) < distance - 1e-8)
					fail('Offset collapses or crosses the source boundary.');
			}
		}
	return result;
}
export function buildModelEdit(
	graph: BomcGraph,
	path: readonly string[],
	action: ModelAction,
	sequence: number,
): GeometryEdit & { entityId: string } {
	if (action.type === 'curve' && action.curveKind !== 'arc') {
		if (action.sweepDegrees !== 360) fail('Circle and Polygon use a closed 360-degree perimeter.');
		return buildModelEdit(graph, path, { type: 'raw', command: { kind: 'CREATE_FACE_LOOP', points: curvePoints(action.center, action.first, action.normal, action.segments), normal: action.normal } }, sequence);
	}
	const validation = validateAuthoringDocument(graph);
	if (!validation.editable) fail(validation.reason);
	if (!Number.isSafeInteger(sequence) || sequence < 1) fail('Invalid operation sequence.');
	const next = structuredClone(graph) as MutableGraph,
		metadata = modelMetadata(graph);
	const org=organization(graph);
	const context = contextTransform(graph, path),
		owner = context.definitionId,
		world = context.matrix,
		inverseWorld = world.clone().invert();
	const op = graph.documentId + ':op:' + sequence;
	let counter = 0,
		entityId = graph.rootInstanceId;
	const alloc = (kind: string) => graph.documentId + ':' + kind + ':op:' + sequence + ':' + ++counter;
	const ownerMesh = () => next.meshes.find((m) => m.definitionId === owner);
	const setMesh = (definitionId: string, value: Mesh | null) => {
		const definition = next.definitions.find((d) => d.id === definitionId)!;
		const oldId = definition.meshId;
		next.meshes = next.meshes.filter((m) => m.id !== oldId);
		if (value?.faces.length) {
			const mesh = compactReferencedVertices({
				...value,
				id: oldId ?? (definitionId === next.rootDefinitionId ? next.documentId + ':mesh:root' : alloc('mesh')),
				definitionId,
				faces: [...value.faces].sort((a, b) => cmp(a.id, b.id)),
			});
			next.meshes.push(mesh);
			definition.meshId = mesh.id;
		} else definition.meshId = null;
	};
	const makeFace = (
		mesh: Mesh,
		id: string,
		outer: readonly number[],
		normal: AuthoringPoint,
		holes: readonly (readonly number[])[] = [],
		source?: Face,
	) =>
		faceFromRing(
			mesh,
			id,
			outer,
			source?.frontMaterialId ?? next.materials[0]!.id,
			source?.backMaterialId ?? null,
			JSON.stringify(['sibambo-editor-shape-v2', 'split', id, op]),
			normal,
			holes,
		);
	const selection = 'selection' in action ? action.selection : [];
	const selectedFaces = new Set<string>(),
		selectedInstances = new Set<string>();
	const selectedEdges: Extract<ModelSelection, { type: 'edge' }>[] = [];
	for (const selected of selection) {
		if (selected.type === 'face') {
			if (!ownerMesh()?.faces.some((f) => f.id === selected.id))
				fail('Selected face is outside the active edit context.');
			selectedFaces.add(selected.id);
		} else if (selected.type === 'instance') {
			if (!next.instances.some((i) => i.id === selected.id && i.ownerDefinitionId === owner))
				fail('Selected container is outside the active edit context.');
			selectedInstances.add(selected.id);
		} else {
			const edge = {
				...selected,
				start: transformPoint(selected.start, inverseWorld),
				end: transformPoint(selected.end, inverseWorld),
			};
			if (
				![
					...(ownerMesh() ? meshEdges(ownerMesh()!) : []),
					...metadata.looseEdges.filter((e) => e.ownerDefinitionId === owner),
				].some((e) => edgeMatches(e.start, e.end, edge.start, edge.end))
			)
				fail('Selected edge no longer exists.');
			selectedEdges.push(edge);
		}
	}
	const cloneDefinition = (definitionId: string): string => {
		const source = next.definitions.find((d) => d.id === definitionId)!;
		const id = alloc('definition'),
			clone = { ...source, id, meshId: null as string | null };
		next.definitions.push(clone);
		const mesh = next.meshes.find((m) => m.id === source.meshId);
		if (mesh)
			setMesh(id, {
				...mesh,
				faces: mesh.faces.map((f) =>
					makeFace(mesh, next.documentId + ':face:' + sequence + ':copy:' + ++counter, f.outer, f.normal, f.holes, f),
				),
			});
		for (const child of [...next.instances.filter((i) => i.ownerDefinitionId === definitionId)]) {
			const childDefinition = child.kind === 'group' ? cloneDefinition(child.definitionId) : child.definitionId;
			const childId=alloc('instance');next.instances.push({ ...child, id: childId, ownerDefinitionId: id, definitionId: childDefinition });
			const assignment=org.assignments.find(a=>a.instanceId===child.id);if(assignment)org.assignments.push({...assignment,instanceId:childId});
		}
		for (const e of [...metadata.looseEdges.filter((e) => e.ownerDefinitionId === definitionId)])
			metadata.looseEdges.push({ ...e, id: alloc('edge'), ownerDefinitionId: id });
		for (const g of [...metadata.guides.filter((g) => g.ownerDefinitionId === definitionId)])
			metadata.guides.push({ ...g, id: alloc('guide'), ownerDefinitionId: id });
		return id;
	};
	if (action.type === 'raw') {
		const flat = contextGraph(graph, path, true),
			command = action.command;
		let edit: GeometryEdit;
		if (command.kind === 'CREATE_RECTANGLE') {
			entityId = graph.documentId + ':rectangle:' + sequence;
			edit =
				'points' in command
					? buildPlanarRectangleEdit(
							flat,
							entityId,
							command.points,
							command.normal,
						)
					: buildRectangleEdit(
							flat,
							entityId,
							command.first,
							command.opposite,
						);
		} else if (command.kind === 'CREATE_FACE_LOOP') {
			entityId = graph.documentId + ':face:' + sequence;
			edit = buildFaceLoopEdit(
				flat,
				entityId,
				command.points,
				command.normal,
				'line',
			);
		} else if (command.kind === 'PUSH_PULL_FACE') {
			entityId = command.faceId;
			edit = buildPushPullFaceEdit(flat, entityId, command.distance, sequence);
		} else {
			entityId = command.entityId;
			edit = buildExtrusionEdit(flat, entityId, command.distance);
		}
		const materialRedirect = new Map<string, string>();
		for (const item of edit.forward) {
			if (item.type === 'put-material') {
				const existing = next.materials.find((m) => m.id === item.value.id);
				const material =
					existing && JSON.stringify(existing) !== JSON.stringify(item.value)
						? { ...item.value, id: next.documentId + ':material:authoring-neutral' }
						: item.value;
				if (material.id !== item.value.id) materialRedirect.set(item.value.id, material.id);
				next.materials = next.materials.filter((m) => m.id !== material.id);
				next.materials.push(material);
			}
			if (item.type === 'put-mesh') {
				const localMesh = meshThrough(item.value, inverseWorld);
				setMesh(owner, {
					...localMesh,
					faces: localMesh.faces.map((face) => ({
						...face,
						frontMaterialId:
							face.frontMaterialId === null
								? null
								: (materialRedirect.get(face.frontMaterialId) ?? face.frontMaterialId),
						backMaterialId:
							face.backMaterialId === null ? null : (materialRedirect.get(face.backMaterialId) ?? face.backMaterialId),
					})),
				});
			}
		}
	} else if (action.type === 'group') {
		if (!selectedFaces.size && !selectedInstances.size && !selectedEdges.length)
			fail('Select geometry before creating a container.');
		const definitionId = alloc('definition'),
			instanceId = alloc('instance');
		next.definitions.push({ id: definitionId, name: action.name, kind: action.containerKind, meshId: null });
		const mesh = ownerMesh();
		if (mesh && selectedFaces.size) {
			setMesh(definitionId, { ...mesh, faces: mesh.faces.filter((f) => selectedFaces.has(f.id)) });
			setMesh(owner, { ...mesh, faces: mesh.faces.filter((f) => !selectedFaces.has(f.id)) });
		}
		for (const instance of next.instances)
			if (selectedInstances.has(instance.id)) instance.ownerDefinitionId = definitionId;
		for (const edge of selectedEdges) {
			metadata.looseEdges.push({
				id: alloc('edge'),
				ownerDefinitionId: definitionId,
				start: edge.start,
				end: edge.end,
			});
			metadata.looseEdges = metadata.looseEdges.filter(
				(e) => e.ownerDefinitionId !== owner || !edgeMatches(e.start, e.end, edge.start, edge.end),
			);
		}
		next.instances.push({
			id: instanceId,
			name: action.name,
			kind: action.containerKind,
			ownerDefinitionId: owner,
			definitionId,
			matrix: [...IDENTITY],
			visible: true,
			materialId: null,
			roleCode: 0,
			label: JSON.stringify(['sibambo-editor-container-v1', sequence]),
		});
		entityId = instanceId;
	} else if (action.type === 'unique') {
		const instance = next.instances.find((i) => i.id === action.instanceId && i.ownerDefinitionId === owner);
		if (!instance) fail('Select a container in this context.');
		instance.definitionId = cloneDefinition(instance.definitionId);
		entityId = instance.id;
	} else if (action.type === 'explode') {
		const instance = next.instances.find((i) => i.id === action.instanceId && i.ownerDefinitionId === owner);
		if (!instance) fail('Select a container in this context.');
		const matrix = new Matrix4().fromArray(instance.matrix),
			source = next.meshes.find((m) => m.definitionId === instance.definitionId);
		const original = ownerMesh(),
			positions = [...(original?.positions ?? [])],
			faces = [...(original?.faces ?? [])];
		if (source) {
			const start = positions.length / 3;
			for (let i = 0; i < source.positions.length / 3; i++) positions.push(...transformPoint(point(source, i), matrix));
			const expanded = { id: original?.id ?? '', definitionId: owner, positions, faces };
			for (const face of source.faces)
				faces.push(
					makeFace(
						expanded,
						next.documentId + ':face:' + sequence + ':explode:' + ++counter,
						face.outer.map((v) => v + start),
						normalThrough(face.normal, matrix),
						face.holes.map((r) => r.map((v) => v + start)),
						face,
					),
				);
			setMesh(owner, expanded);
		}
		for (const child of [...next.instances.filter((i) => i.ownerDefinitionId === instance.definitionId)])
			next.instances.push({
				...child,
				id: alloc('instance'),
				definitionId: child.kind === 'group' ? cloneDefinition(child.definitionId) : child.definitionId,
				ownerDefinitionId: owner,
				matrix: matrix.clone().multiply(new Matrix4().fromArray(child.matrix)).toArray(),
			});
		for (const e of metadata.looseEdges.filter((e) => e.ownerDefinitionId === instance.definitionId))
			metadata.looseEdges.push({
				...e,
				id: alloc('edge'),
				ownerDefinitionId: owner,
				start: transformPoint(e.start, matrix),
				end: transformPoint(e.end, matrix),
			});
		for (const g of metadata.guides.filter((e) => e.ownerDefinitionId === instance.definitionId))
			metadata.guides.push({
				...g,
				id: alloc('guide'),
				ownerDefinitionId: owner,
				start: transformPoint(g.start, matrix),
				end: transformPoint(g.end, matrix),
			});
		next.instances = next.instances.filter((i) => i.id !== instance.id);
	} else if (action.type === 'erase') {
		let mesh = ownerMesh();
		if (mesh) {
			const remove = new Set(selectedFaces);
			for (const edge of selectedEdges) {
				const candidate: ReturnType<typeof meshEdges>[number] | undefined = meshEdges(mesh).find((e) =>
					edgeMatches(edge.start, edge.end, e.start, e.end),
				);
				if (!candidate) continue;
				const pair: Face[] = candidate.faceIds.map((id) => mesh!.faces.find((f) => f.id === id)!);
				if (
					pair.length === 2 &&
					!pair.some((f) => remove.has(f.id)) &&
					new Vector3(...pair[0]!.normal).dot(new Vector3(...pair[1]!.normal)) > 1 - 1e-9
				) {
					// Erasing a coplanar divider heals the two faces, including a complete inset border.
					const directed = new Map<string, [number, number]>(),
						normal = new Vector3(...pair[0]!.normal);
					for (const face of pair)
						for (const [ringIndex, source] of [face.outer, ...face.holes].entries()) {
							let ring = [...source];
							let sum = new Vector3();
							for (let i = 0; i < ring.length; i++)
								sum.add(
									new Vector3(...point(mesh, ring[i]!)).cross(
										new Vector3(...point(mesh, ring[(i + 1) % ring.length]!)),
									),
								);
							if (sum.dot(normal) > 0 !== (ringIndex === 0)) ring.reverse();
							for (let i = 0; i < ring.length; i++) {
								const a = ring[i]!,
									b = ring[(i + 1) % ring.length]!,
									key = a < b ? a + ':' + b : b + ':' + a;
								if (directed.has(key)) directed.delete(key);
								else directed.set(key, [a, b]);
							}
						}
					const loops: number[][] = [];
					while (directed.size) {
						const first = directed.values().next().value!;
						const loop = [first[0]],
							start = first[0];
						let current = start;
						do {
							const entries = [...directed.entries()].filter(([, e]) => e[0] === current);
							if (entries.length !== 1) fail('Erasing this divider would create a branching boundary.');
							const [key, e] = entries[0]!;
							directed.delete(key);
							current = e[1];
							if (current !== start) loop.push(current);
						} while (current !== start);
						loops.push(loop);
					}
					loops.sort((a, b) => {
						const area = (ring: number[]) => {
							const sum = new Vector3();
							for (let i = 0; i < ring.length; i++)
								sum.add(
									new Vector3(...point(mesh!, ring[i]!)).cross(
										new Vector3(...point(mesh!, ring[(i + 1) % ring.length]!)),
									),
								);
							return Math.abs(sum.dot(normal));
						};
						return area(b) - area(a);
					});
					const merged = makeFace(mesh, pair[0]!.id, loops[0]!, pair[0]!.normal, loops.slice(1), pair[0]);
					mesh = { ...mesh, faces: [...mesh.faces.filter((f) => !pair.some((p) => p.id === f.id)), merged] };
				} else for (const id of candidate.faceIds) remove.add(id);
			}
			const retained = mesh.faces.filter((f) => !remove.has(f.id));
			for (const edge of meshEdges({ ...mesh, faces: mesh.faces.filter((f) => remove.has(f.id)) })) {
				if (selectedEdges.some((e) => edgeMatches(e.start, e.end, edge.start, edge.end))) continue;
				if (
					!meshEdges({ ...mesh, faces: retained }).some((e) => edgeMatches(e.start, e.end, edge.start, edge.end)) &&
					!metadata.looseEdges.some(
						(e) => e.ownerDefinitionId === owner && edgeMatches(e.start, e.end, edge.start, edge.end),
					)
				)
					metadata.looseEdges.push({ id: alloc('edge'), ownerDefinitionId: owner, start: edge.start, end: edge.end });
			}
			setMesh(owner, { ...mesh, faces: retained });
		}
		metadata.looseEdges = metadata.looseEdges.filter(
			(e) => e.ownerDefinitionId !== owner || !selectedEdges.some((s) => edgeMatches(s.start, s.end, e.start, e.end)),
		);
		next.instances = next.instances.filter((i) => !selectedInstances.has(i.id));
	} else if (action.type === 'transform' || action.type === 'scale') {
		const scaling = action.type === 'scale' ? action : null;
		const count = action.type === 'transform' ? action.count : 1;
		const delta = action.type === 'transform' ? action.delta : [0, 0, 0] as const;
		const radial = action.type === 'transform' ? action.radial : null;
		if (count < 1 || count > 100 || !Number.isInteger(count)) fail('Array count must be 1–100.');
		if (scaling && (!scaling.factors.every(v => Number.isFinite(v) && Math.abs(v) >= 1e-6 && Math.abs(v) <= 1e6) || !scaling.pivot.every(Number.isFinite)))
			fail('Scale factors must be finite and between 0.000001 and 1000000 in magnitude.');
		if (!delta.every(Number.isFinite) || (radial && !Number.isFinite(radial.angleDegrees)))
			fail('Move/array input must be finite.');
		if (!scaling && !radial && new Vector3(...delta).length() < 1e-6)
			fail('Move distance must be at least 0.000001 m.');
		const sourceMesh = ownerMesh(),
			sourceInstances = next.instances.filter((i) => selectedInstances.has(i.id));
		const rawFaces = sourceMesh?.faces.filter((f) => selectedFaces.has(f.id)) ?? [];
		const edgeVertices = selectedEdges.flatMap((e) =>
			sourceMesh
				? sourceMesh.positions.reduce<number[]>((found, _v, i) => {
						if (
							i % 3 === 0 &&
							(samePoint(point(sourceMesh, i / 3), e.start) || samePoint(point(sourceMesh, i / 3), e.end))
						)
							found.push(i / 3);
						return found;
					}, [])
				: [],
		);
		const rawVertices = new Set([...rawFaces.flatMap((f) => [f.outer, ...f.holes].flat()), ...edgeVertices]);
		const originalPositions = [...(sourceMesh?.positions ?? [])];
		const positions = [...originalPositions],
			faces = [...(sourceMesh?.faces ?? [])];
		const iterations = action.copy ? count : 1;
		for (let iteration = 1; iteration <= iterations; iteration++) {
			const factor = action.type === 'transform' && action.spacing === 'divide' ? iteration / count : iteration;
			const global = new Matrix4().makeTranslation(
				...(delta.map((v) => v * factor) as [number, number, number]),
			);
			if (scaling) {
				const p = scaling.pivot;
				global.multiply(new Matrix4().makeTranslation(...p)).multiply(new Matrix4().makeScale(...scaling.factors))
					.multiply(new Matrix4().makeTranslation(-p[0], -p[1], -p[2]));
			}
			if (radial) {
				const axis = { x: new Vector3(1, 0, 0), y: new Vector3(0, 1, 0), z: new Vector3(0, 0, 1) }[radial.axis],
					p = radial.pivot;
				global
					.multiply(new Matrix4().makeTranslation(...p))
					.multiply(new Matrix4().makeRotationAxis(axis, ((radial.angleDegrees * Math.PI) / 180) * factor))
					.multiply(new Matrix4().makeTranslation(-p[0], -p[1], -p[2]));
			}
			const local = inverseWorld.clone().multiply(global).multiply(world);
			for (const source of sourceInstances) {
				const matrix = local.clone().multiply(new Matrix4().fromArray(source.matrix)).toArray();
				if (action.copy) {
					const definitionId = source.kind === 'group' ? cloneDefinition(source.definitionId) : source.definitionId;
					const clone = { ...source, id: alloc('instance'), definitionId, matrix };
					next.instances.push(clone);
					const assignment=org.assignments.find(a=>a.instanceId===source.id);if(assignment)org.assignments.push({...assignment,instanceId:clone.id});
					entityId = clone.id;
				} else {
					source.matrix = matrix;
					entityId = source.id;
				}
			}
			if (sourceMesh && rawVertices.size) {
				if (action.copy) {
					const remap = new Map<number, number>();
					for (const vertex of rawVertices) {
						remap.set(vertex, positions.length / 3);
						positions.push(...transformPoint(point(sourceMesh, vertex), local));
					}
					const expanded = { ...sourceMesh, positions, faces };
					for (const face of rawFaces) {
						const id = next.documentId + ':face:' + sequence + ':copy:' + ++counter;
						faces.push(
							makeFace(
								expanded,
								id,
								face.outer.map((v) => remap.get(v)!),
								normalThrough(face.normal, local),
								face.holes.map((r) => r.map((v) => remap.get(v)!)),
								face,
							),
						);
						entityId = id;
					}
				} else {
					for (const vertex of rawVertices)
						positions.splice(vertex * 3, 3, ...transformPoint(point(sourceMesh, vertex), local));
					const expanded = { ...sourceMesh, positions, faces };
					for (let i = 0; i < faces.length; i++) {
						const face = faces[i]!;
						if ([face.outer, ...face.holes].flat().some((v) => rawVertices.has(v))) {
							const fullySelected = [face.outer, ...face.holes].flat().every(v => rawVertices.has(v));
							const normal = fullySelected ? normalThrough(face.normal, local) : preparePolygon(face.outer.map((v) => point(expanded, v))).normal;
							faces[i] = makeFace(expanded, face.id, face.outer, normal, face.holes, face);
						}
					}
					entityId = rawFaces[0]?.id ?? graph.rootInstanceId;
				}
			}
			for (const edge of selectedEdges) {
				const a = transformPoint(edge.start, local),
					b = transformPoint(edge.end, local);
				const loose = metadata.looseEdges.find(
					(e) => e.ownerDefinitionId === owner && edgeMatches(e.start, e.end, edge.start, edge.end),
				);
				if (loose) {
					if (action.copy) metadata.looseEdges.push({ ...loose, id: alloc('edge'), start: a, end: b });
					else {
						loose.start = a;
						loose.end = b;
					}
				} else if (
					action.copy &&
					!rawFaces.some((f) =>
						meshEdges({ ...sourceMesh!, faces: [f] }).some((e) => edgeMatches(e.start, e.end, edge.start, edge.end)),
					)
				)
					metadata.looseEdges.push({ id: alloc('edge'), ownerDefinitionId: owner, start: a, end: b });
			}
		}
		if (sourceMesh && rawVertices.size) setMesh(owner, { ...sourceMesh, positions, faces });
	} else if (action.type === 'offset') {
		if (!Number.isFinite(action.distance) || Math.abs(action.distance) < 1e-6)
			fail('Offset must be finite and at least 0.000001 m.');
		const localMesh = ownerMesh(), mesh = localMesh ? meshThrough(localMesh, world) : undefined,
			face = mesh?.faces.find((f) => f.id === action.faceId);
		if (!mesh || !face) fail('Select an active-context face for Offset.');
		const positions = [...mesh.positions],
			faces = mesh.faces.filter((f) => f.id !== face.id);
		const addLoop = (points: readonly AuthoringPoint[]) =>
			points.map((p) => {
				const i = positions.length / 3;
				positions.push(...p);
				return i;
			});
		const outer = addLoop(offsetLoop(mesh, face.outer, face.normal, action.distance));
		const expanded = { ...mesh, positions, faces };
		if (action.distance > 0) {
			const holes = face.holes.map((h) =>
				addLoop(offsetLoop(mesh, [...h].reverse(), face.normal, -action.distance)).reverse(),
			);
			// Existing face becomes the outer band. Hole bands keep existing reveals connected.
			faces.push(makeFace(expanded, face.id, face.outer, face.normal, [outer], face));
			entityId = next.documentId + ':face:' + sequence;
			faces.push(makeFace(expanded, entityId, outer, face.normal, holes, face));
			face.holes.forEach((hole, i) =>
				faces.push(
					makeFace(
						expanded,
						next.documentId + ':face:' + sequence + ':hole:' + i,
						[...holes[i]!].reverse(),
						face.normal,
						[hole],
						face,
					),
				),
			);
		} else {
			faces.push(face);
			entityId = next.documentId + ':face:' + sequence;
			faces.push(makeFace(expanded, entityId, outer, face.normal, [face.outer], face));
			face.holes.forEach((hole, i) => {
				const inside = addLoop(offsetLoop(mesh, [...hole].reverse(), face.normal, -action.distance));
				const coplanarChild = faces.find(
					(f) =>
						f.outer.length === hole.length &&
						f.outer.every((v) => hole.includes(v)) &&
						Math.abs(new Vector3(...f.normal).dot(new Vector3(...face.normal))) > 1 - 1e-9,
				);
				if (coplanarChild) {
					faces.splice(faces.indexOf(coplanarChild), 1);
					faces.push(
						makeFace(expanded, coplanarChild.id, inside, coplanarChild.normal, coplanarChild.holes, coplanarChild),
					);
				}
				faces.push(
					makeFace(
						expanded,
						next.documentId + ':face:' + sequence + ':hole:' + i,
						[...hole].reverse(),
						face.normal,
						[inside],
						face,
					),
				);
			});
		}
		setMesh(owner, meshThrough(expanded, inverseWorld));
	} else if(action.type==='paint') {
		if(!selectedFaces.size&&!selectedInstances.size)fail('Paint needs active-context faces or containers.');
		const material={id:alloc('material'),name:action.name.trim(),displayName:null,rgba:action.rgba,opacityU16:action.opacityU16};
		if(!isAuthoredMaterial(next,material))fail('Invalid solid material.');next.materials.push(material);
		const mesh=ownerMesh();if(mesh)setMesh(owner,{...mesh,faces:mesh.faces.map(f=>selectedFaces.has(f.id)?{...f,frontMaterialId:action.side==='back'?f.frontMaterialId:material.id,backMaterialId:action.side==='front'?f.backMaterialId:material.id}:f)});
		for(const instance of next.instances)if(selectedInstances.has(instance.id))instance.materialId=material.id;
	} else if(action.type==='tag-create') {
		if(!action.name.trim()||action.name.length>128||org.tags.some(t=>t.name.toLowerCase()===action.name.trim().toLowerCase()))fail('Tag name must be nonempty and unique.');
		org.tags.push({id:alloc('tag'),name:action.name.trim(),visible:true});metadata.organization=org;
	} else if(action.type==='tag-visibility') {
		const tag=org.tags.find(t=>t.id===action.tagId);if(!tag)fail('Unknown tag.');tag.visible=action.visible;metadata.organization=org;
	} else if(action.type==='tag-assign') {
		if(action.tagId!==null&&!org.tags.some(t=>t.id===action.tagId))fail('Unknown tag.');
		for(const id of action.instanceIds){if(!next.instances.some(i=>i.id===id&&i.ownerDefinitionId===owner))fail('Tag assignment is outside the active context.');org.assignments=org.assignments.filter(a=>a.instanceId!==id);if(action.tagId)org.assignments.push({instanceId:id,tagId:action.tagId});}metadata.organization=org;
	} else if(action.type==='entity-info') {
		const instance=next.instances.find(i=>i.id===action.instanceId&&i.ownerDefinitionId===owner);if(!instance||!action.name.trim()||action.name.length>128)fail('Select an active-context container and enter its name.');instance.name=action.name.trim();instance.visible=action.visible;
	} else if(action.type==='asset-create') {
		const instance=next.instances.find(i=>i.id===action.instanceId&&i.ownerDefinitionId===owner);if(!instance||!action.name.trim()||action.name.length>128)fail('Select an active-context container to add to the library.');
		const definitionId=instance.kind==='component'?instance.definitionId:cloneDefinition(instance.definitionId);
		next.definitions.find(d=>d.id===definitionId)!.kind='component';
		org.assets.push({id:alloc('asset'),name:action.name.trim(),definitionId});metadata.organization=org;
	} else if(action.type==='asset-insert') {
		const asset=org.assets.find(a=>a.id===action.assetId);if(!asset)fail('Unknown library asset.');
		if(!action.point.every(Number.isFinite))fail('Asset position must be finite.');
		entityId=alloc('instance');next.instances.push({id:entityId,name:asset.name,kind:'component',definitionId:asset.definitionId,ownerDefinitionId:owner,matrix:new Matrix4().makeTranslation(...transformPoint(action.point,inverseWorld)).toArray(),materialId:null,visible:true,roleCode:0,label:JSON.stringify(['sibambo-editor-container-v1',sequence])});
	} else if(action.type==='asset-delete') {
		if(!org.assets.some(a=>a.id===action.assetId))fail('Unknown library asset.');org.assets=org.assets.filter(a=>a.id!==action.assetId);metadata.organization=org;
	} else if (action.type === 'curve') {
		if (Math.abs(action.sweepDegrees) >= 360) fail('An open Arc must sweep less than 360 degrees. Use Circle for a closed loop.');
		const points = curvePoints(action.center, action.first, action.normal, action.segments, action.sweepDegrees).map(p => transformPoint(p, inverseWorld));
		for (let i = 0; i < points.length - 1; i++) metadata.looseEdges.push({ id: alloc('edge'), ownerDefinitionId: owner, start: points[i]!, end: points[i + 1]! });
	} else if (action.type === 'follow-me') {
		const source = ownerMesh(); if (!source) fail('Select a profile face.');
		const mesh = meshThrough(source, world), profile = mesh.faces.find(f => f.id === action.faceId);
		if (!profile) fail('Follow Me profile is outside the active context.');
		const available = [...meshEdges(mesh), ...metadata.looseEdges.filter(e => e.ownerDefinitionId === owner).map(e => ({ start: transformPoint(e.start, world), end: transformPoint(e.end, world) }))];
		if (!action.edges.every(e => available.some(a => edgeMatches(a.start, a.end, e.start, e.end)))) fail('Follow Me path includes an edge outside the active context.');
		const center = profile.outer.reduce((v, i) => v.add(new Vector3(...point(mesh, i))), new Vector3()).multiplyScalar(1 / profile.outer.length);
		const pathPoints = orderedPath(action.edges, toPoint(center));
		const prefix = next.documentId + ':face:' + sequence + ':sweep';
		const swept = sweepProfile(mesh, profile, pathPoints, prefix);
		entityId = swept.faces.find(face=>face.id.startsWith(prefix+':'))!.id;
		setMesh(owner, meshThrough(swept, inverseWorld));
	} else if (action.type === 'guide') {
		const start = transformPoint(action.start, inverseWorld),
			end = transformPoint(action.end, inverseWorld);
		if (action.guideKind === 'line' && new Vector3(...start).distanceTo(new Vector3(...end)) < 1e-6)
			fail('Guide needs two distinct points.');
		metadata.guides.push({
			id: alloc('guide'),
			ownerDefinitionId: owner,
			start: action.guideKind === 'point' ? end : start,
			end,
			kind: action.guideKind,
		});
	} else if (action.type === 'clear-guides')
		metadata.guides = metadata.guides.filter((g) => g.ownerDefinitionId !== owner);

	// Collect only unreachable definitions; shared Component definitions remain alive.
	const reachable = new Set<string>();
	const collect = (id: string) => {
		if (reachable.has(id)) return;
		reachable.add(id);
		for (const child of next.instances.filter((i) => i.ownerDefinitionId === id)) collect(child.definitionId);
	};
	collect(next.rootDefinitionId);
	for(const asset of org.assets)collect(asset.definitionId);
	next.instances = next.instances.filter(
		(i) => i.kind === 'root' || (i.ownerDefinitionId !== null && reachable.has(i.ownerDefinitionId)),
	);
	next.definitions = next.definitions.filter((d) => reachable.has(d.id));
	next.meshes = next.meshes.filter((m) => reachable.has(m.definitionId));
	metadata.guides = metadata.guides.filter((g) => reachable.has(g.ownerDefinitionId));
	metadata.looseEdges = metadata.looseEdges.filter((g) => reachable.has(g.ownerDefinitionId));
	if(metadata.organization){org.assignments=org.assignments.filter(a=>next.instances.some(i=>i.id===a.instanceId));metadata.organization=org;}
	next.instances.find((i) => i.id === next.rootInstanceId)!.label = JSON.stringify(metadata);
	for (const field of ['materials', 'definitions', 'meshes', 'instances'] as const)
		next[field].sort((a, b) => cmp(a.id, b.id));
	const result = validateAuthoringDocument(next);
	if (!result.editable) fail('Operation rejected atomically: ' + result.reason);
	const edit = diff(graph, next);
	// A paired root metadata record identifies the expanded transaction contract.
	if (!edit.forward.some((e) => e.type === 'put-instance' && e.value.id === graph.rootInstanceId)) {
		edit.forward.push({ type: 'put-instance', value: next.instances.find((i) => i.id === next.rootInstanceId)! });
		edit.inverse.push({ type: 'put-instance', value: graph.instances.find((i) => i.id === graph.rootInstanceId)! });
	}
	return { ...edit, entityId };
}
