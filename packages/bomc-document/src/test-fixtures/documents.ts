import type { BomcGraph, Definition, Face, Instance, Mesh, SolidMaterial } from '../types.js';

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const id = (fixture: string, kind: string, row: number | string) => `fixture:${fixture}:${kind}:${row}`;

function rootGraph(fixture: string, name = fixture): BomcGraph {
	const rootDefinitionId = id(fixture, 'definition', 'root');
	const rootInstanceId = id(fixture, 'instance', 'root');
	return {
		documentId: id(fixture, 'document', 'main'), name, rootDefinitionId, rootInstanceId,
		materials: [], definitions: [{ id: rootDefinitionId, name: rootDefinitionId, kind: 'model', meshId: null }], meshes: [],
		instances: [{ id: rootInstanceId, name: rootInstanceId, kind: 'root', ownerDefinitionId: null, definitionId: rootDefinitionId, matrix: identity(), materialId: null, visible: true, roleCode: 0, label: null }]
	};
}

function face(fixture: string, row: number, outer: number[], triangles: number[], normal: [number, number, number], extra: Partial<Face> = {}): Face {
	return {
		id: id(fixture, 'face', row), outer, holes: [], triangles, normal, frontMaterialId: null, backMaterialId: null,
		hidden: false, surfaceCode: 0, roleCode: 0, label: null, ...extra
	};
}

function attachMesh(graph: BomcGraph, fixture: string, positions: number[], faces: Face[], definitionIndex = 0): BomcGraph {
	const definitions = [...graph.definitions];
	const owner = definitions[definitionIndex]!;
	const meshId = id(fixture, 'mesh', 0);
	definitions[definitionIndex] = { ...owner, meshId };
	return { ...graph, definitions, meshes: [{ id: meshId, definitionId: owner.id, positions, faces }] };
}

export function createEmptyGraph(): BomcGraph { return { ...rootGraph('empty', 'Untitled'), documentId: 'fixture:empty' }; }

export function createPrecisionGraph(): BomcGraph {
	const x = 1.0000000000000002; const y = -0.125; const z = 0.00100000000001;
	return attachMesh(rootGraph('precision'), 'precision', [x, y, z, x + 2, y, z, x + 2, y + 1, z, x, y + 1, z], [
		face('precision', 0, [0, 1, 2, 3], [0, 1, 2, 0, 2, 3], [0, -0, 1])
	]);
}

export function createOriginGraph(): BomcGraph {
	const graph = attachMesh(rootGraph('origin'), 'origin', [-0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [
		face('origin', 0, [0, 1, 2, 3], [0, 1, 2, 0, 2, 3], [0, 0, 1])
	]);
	return graph;
}

export function createHoleGraph(): BomcGraph {
	const positions = [0, 0, 0, 4, 0, 0, 4, 4, 0, 0, 4, 0, 1, 1, 0, 1, 3, 0, 3, 3, 0, 3, 1, 0];
	const hole = face('hole', 0, [0, 1, 2, 3], [0, 1, 7, 0, 7, 4, 1, 2, 6, 1, 6, 7, 2, 3, 5, 2, 5, 6, 3, 0, 4, 3, 4, 5], [0, 0, 1]);
	hole.holes = [[4, 5, 6, 7]];
	return attachMesh(rootGraph('hole'), 'hole', positions, [hole]);
}

export function createConcaveGraph(): BomcGraph {
	return attachMesh(rootGraph('concave'), 'concave', [0, 0, 0, 3, 0, 0, 3, 1, 0, 1, 1, 0, 1, 3, 0, 0, 3, 0], [
		face('concave', 0, [0, 1, 2, 3, 4, 5], [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5], [0, 0, 1])
	]);
}

function extrusion(fixture: string, height: number): BomcGraph {
	const positions = [0, 0, 0, 2, 0, 0, 2, 1, 0, 0, 1, 0, 0, 0, height, 2, 0, height, 2, 1, height, 0, 1, height];
	const loops: Array<{ ring: number[]; normal: [number, number, number] }> = height > 0 ? [
		{ ring: [3, 2, 1, 0], normal: [0, 0, -1] }, { ring: [4, 5, 6, 7], normal: [0, 0, 1] },
		{ ring: [0, 1, 5, 4], normal: [0, -1, 0] }, { ring: [1, 2, 6, 5], normal: [1, 0, 0] },
		{ ring: [2, 3, 7, 6], normal: [0, 1, 0] }, { ring: [3, 0, 4, 7], normal: [-1, 0, 0] }
	] : [
		{ ring: [0, 1, 2, 3], normal: [0, 0, 1] }, { ring: [7, 6, 5, 4], normal: [0, 0, -1] },
		{ ring: [4, 5, 1, 0], normal: [0, -1, 0] }, { ring: [5, 6, 2, 1], normal: [1, 0, 0] },
		{ ring: [6, 7, 3, 2], normal: [0, 1, 0] }, { ring: [7, 4, 0, 3], normal: [-1, 0, 0] }
	];
	const faces = loops.map(({ ring, normal }, index) => face(fixture, index, ring, [ring[0]!, ring[1]!, ring[2]!, ring[0]!, ring[2]!, ring[3]!], normal));
	return attachMesh(rootGraph(fixture), fixture, positions, faces);
}

export function createExtrusionPositiveGraph(): BomcGraph { return extrusion('extrusion-positive', 0.5); }
export function createExtrusionNegativeGraph(): BomcGraph { return extrusion('extrusion-negative', -0.5); }

export function createSharedGraph(): BomcGraph {
	const graph = rootGraph('shared');
	const definitionId = id('shared', 'definition', 'component');
	const meshId = id('shared', 'mesh', 0);
	const precision = createPrecisionGraph().meshes[0]!;
	const component: Definition = { id: definitionId, name: definitionId, kind: 'component', meshId };
	const first: Instance = {
		id: id('shared', 'instance', 0), name: id('shared', 'instance', 0), kind: 'component', ownerDefinitionId: graph.rootDefinitionId,
		definitionId, matrix: [2.5, 0, 0, 0, 0, 0.75, 0, 0, 0, 0, 1, 0, 1.1234567890123456, 0, 0, 1],
		materialId: null, visible: true, roleCode: 0, label: null
	};
	const second: Instance = {
		id: id('shared', 'instance', 1), name: id('shared', 'instance', 1), kind: 'component', ownerDefinitionId: graph.rootDefinitionId,
		definitionId, matrix: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 6, 0, 0, 1],
		materialId: null, visible: true, roleCode: 0, label: null
	};
	return {
		...graph,
		definitions: [{ ...graph.definitions[0]!, meshId: null }, component],
		meshes: [{ ...precision, id: meshId, definitionId }], instances: [graph.instances[0]!, first, second]
	};
}

export function createNestedGraph(): BomcGraph {
	const graph = rootGraph('nested');
	const groupDefinitionId = id('nested', 'definition', 'group');
	const componentDefinitionId = id('nested', 'definition', 'component');
	const meshId = id('nested', 'mesh', 0);
	const unusedDefinitionId = id('nested', 'definition', 'unused');
	const unusedMeshId = id('nested', 'mesh', 1);
	const concave = createConcaveGraph().meshes[0]!;
	const group: Definition = { id: groupDefinitionId, name: groupDefinitionId, kind: 'group', meshId: null };
	const component: Definition = { id: componentDefinitionId, name: componentDefinitionId, kind: 'component', meshId };
	const unused: Definition = { id: unusedDefinitionId, name: unusedDefinitionId, kind: 'component', meshId: unusedMeshId };
	const groupInstance: Instance = {
		id: id('nested', 'instance', 'group'), name: id('nested', 'instance', 'group'), kind: 'group', ownerDefinitionId: graph.rootDefinitionId,
		definitionId: groupDefinitionId, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1], materialId: null, visible: true, roleCode: 0, label: null
	};
	const nestedInstance: Instance = {
		id: id('nested', 'instance', 'nested'), name: id('nested', 'instance', 'nested'), kind: 'component', ownerDefinitionId: groupDefinitionId,
		definitionId: componentDefinitionId, matrix: [1, 0, 0, 0, 0.25, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], materialId: null, visible: true, roleCode: 0, label: null
	};
	const invisible: Instance = {
		id: id('nested', 'instance', 'invisible'), name: id('nested', 'instance', 'invisible'), kind: 'component', ownerDefinitionId: graph.rootDefinitionId,
		definitionId: componentDefinitionId, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1], materialId: null, visible: false, roleCode: 0, label: null
	};
	const unusedPositions = concave.positions.map((value, index) => index % 3 === 0 ? value + 1000 : value);
	const unusedFaces = concave.faces.map((row, index) => ({ ...row, id: id('nested', 'unused-face', index) }));
	return {
		...graph,
		definitions: [{ ...graph.definitions[0]!, meshId: null }, group, component, unused],
		meshes: [{ ...concave, id: meshId, definitionId: componentDefinitionId }, { ...concave, id: unusedMeshId, definitionId: unusedDefinitionId, positions: unusedPositions, faces: unusedFaces }],
		instances: [graph.instances[0]!, groupInstance, nestedInstance, invisible]
	};
}

export function createColorGraph(): BomcGraph {
	const graph = createHoleGraph();
	const materialA: SolidMaterial = { id: id('color', 'material', 0), name: id('color', 'material', 0), displayName: null, rgba: [155, 28, 49, 255], opacityU16: 65535 };
	const materialB: SolidMaterial = { id: id('color', 'material', 1), name: id('color', 'material', 1), displayName: 'Biru 🟦', rgba: [0, 128, 255, 128], opacityU16: 32768 };
	const originalMesh = graph.meshes[0]!;
	const coloredFace = { ...originalMesh.faces[0]!, id: id('color', 'face', 0), frontMaterialId: materialA.id, backMaterialId: materialB.id, surfaceCode: 9, roleCode: 7, label: 'Pintu utama' };
	const materials = [materialA, materialB];
	const root = rootGraph('color');
	const withMesh = attachMesh({ ...root, materials }, 'color', [...originalMesh.positions], [coloredFace]);
	return withMesh;
}

export function createHiddenColorGraph(): BomcGraph {
	const graph = createColorGraph();
	return { ...graph, meshes: graph.meshes.map((mesh) => ({ ...mesh, faces: mesh.faces.map((row) => ({ ...row, hidden: true })) })) };
}

export function createInvisibleColorGraph(): BomcGraph {
	const graph = createColorGraph();
	return { ...graph, instances: graph.instances.map((row) => row.kind === 'root' ? row : { ...row, visible: false }) };
}

export function createWidthGraph(): BomcGraph {
	const graph = createPrecisionGraph();
	const materials = Array.from({ length: 256 }, (_, index) => {
		const materialId = id('width', 'material', index.toString().padStart(3, '0'));
		return { id: materialId, name: materialId, displayName: null, rgba: [index % 256, 0, 0, 255] as const, opacityU16: 65535 };
	});
	return { ...graph, materials };
}

export function createFacesBenchmarkGraph(): BomcGraph {
	const graph = rootGraph('benchmark-faces', 'B-FACES');
	const definitionId = id('benchmark-faces', 'definition', 'main');
	const meshId = id('benchmark-faces', 'mesh', 0);
	const positions: number[] = [];
	const faces: Face[] = [];
	for (let row = 0; row < 100; row += 1) for (let column = 0; column < 200; column += 1) {
		const faceRow = row * 200 + column;
		const x = column * 2; const y = row * 2; const vertex = positions.length / 3;
		positions.push(x, y, 0, x + 1, y, 0, x + 1, y + 1, 0, x, y + 1, 0);
		faces.push(face('benchmark-faces', faceRow, [vertex, vertex + 1, vertex + 2, vertex + 3], [vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3], [0, 0, 1]));
	}
	return { ...graph, definitions: [{ ...graph.definitions[0]!, meshId: null }, { id: definitionId, name: 'main', kind: 'component', meshId }], meshes: [{ id: meshId, definitionId, positions, faces }], instances: [graph.instances[0]!, { id: id('benchmark-faces', 'instance', 'main'), name: 'main', kind: 'component', ownerDefinitionId: graph.rootDefinitionId, definitionId, matrix: identity(), materialId: null, visible: true, roleCode: 0, label: null }] };
}

export function createInstancesBenchmarkGraph(): BomcGraph {
	const graph = rootGraph('benchmark-instances', 'B-INSTANCES');
	const definitionId = id('benchmark-instances', 'definition', 'main');
	const meshId = id('benchmark-instances', 'mesh', 0);
	const base = createPrecisionGraph().meshes[0]!;
	const instances: Instance[] = [graph.instances[0]!];
	for (let index = 0; index < 5000; index += 1) {
		const instanceId = id('benchmark-instances', 'instance', index.toString().padStart(5, '0'));
		const matrix = identity(); matrix[12] = 3 * index;
		instances.push({ id: instanceId, name: index === 0 ? 'main' : instanceId, kind: 'component', ownerDefinitionId: graph.rootDefinitionId, definitionId, matrix, materialId: null, visible: true, roleCode: 0, label: null });
	}
	return { ...graph, definitions: [{ ...graph.definitions[0]!, meshId: null }, { id: definitionId, name: 'main', kind: 'component', meshId }], meshes: [{ ...base, id: meshId, definitionId }], instances };
}

export const documentFixtures = Object.freeze({
	empty: createEmptyGraph, precision: createPrecisionGraph, origin: createOriginGraph, hole: createHoleGraph,
	concave: createConcaveGraph, extrusionPositive: createExtrusionPositiveGraph, extrusionNegative: createExtrusionNegativeGraph,
	shared: createSharedGraph, nested: createNestedGraph, color: createColorGraph, hiddenColor: createHiddenColorGraph,
	invisibleColor: createInvisibleColorGraph, width: createWidthGraph
});
