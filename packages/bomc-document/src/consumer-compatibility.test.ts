import { describe, expect, test } from 'bun:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { BomcDocument } from './document.js';
import { BomcWriter } from './writer.js';
import { loadSection, parseDirectory } from './binary.js';
import type { BomcGraph } from './types.js';
import {
	createColorGraph, createConcaveGraph, createEmptyGraph, createExtrusionNegativeGraph, createExtrusionPositiveGraph,
	createHiddenColorGraph, createHoleGraph, createInvisibleColorGraph, createNestedGraph, createOriginGraph,
	createPrecisionGraph, createSharedGraph, createWidthGraph
} from './test-fixtures/documents.js';

type LoaderResult = {
	version: string;
	profile: string;
	modelName?: string;
	faces: Array<{ sourceFaceIndex?: number }>;
	preparedRuntimeScene: {
		meshes: Array<{ sourceMeshIndex: number; positions: Float32Array }>;
		groups: Array<{ sourceMeshIndex: number; indices: Uint16Array | Uint32Array; matrices: Float32Array; renderSide?: string; materialIndex?: number; sourceFaceIndicesByTriangle?: Uint32Array }>;
		occurrenceHierarchy?: { parentIndices: Int32Array; instanceIndices: Uint32Array; tagIndices: Int32Array };
		edgeSets?: Array<{ positions: Float32Array }>;
		totalTriangles?: number;
	};
	appearance: { materials: Array<{ baseColorRgba?: [number, number, number, number]; opacity: number; textureAsset?: string }>; assets: Array<{ path: string; bytes: Uint8Array }> };
	counts: { materials: number; tags: number; meshes: number; faces: number; definitions: number; instances: number; transforms: number; textures: number; edges: number };
	encodingContract?: { profile: string };
	diagnostics: { coverage: { eligible: number; analytical: number; visualRetained: number; fallback: number; excluded: number; unaccounted: number }; visibility: { totalFaces: number }; triangleOwnership: { sourceFaces: number }; occurrences: { renderOccurrenceCount: number; hierarchyNodeCount: number } };
};
type BomcLoaderConstructor = new () => { load(buffer: ArrayBuffer, sourceName?: string, options?: { prepareSolid?: boolean }): Promise<LoaderResult> };

const fixtures: ReadonlyArray<[string, () => BomcGraph]> = [
	['empty', createEmptyGraph], ['precision', createPrecisionGraph], ['origin', createOriginGraph], ['hole', createHoleGraph],
	['concave', createConcaveGraph], ['extrusion-positive', createExtrusionPositiveGraph], ['extrusion-negative', createExtrusionNegativeGraph],
	['shared', createSharedGraph], ['nested', createNestedGraph], ['color', createColorGraph], ['hidden-color', createHiddenColorGraph],
	['invisible-color', createInvisibleColorGraph], ['width', createWidthGraph]
];
const appRoots = [
	['Editor', path.resolve(process.cwd(), 'packages/e4-import/src/bomc-loader.ts')],
	['Rooms', path.resolve(process.cwd(), '../sibambo-rooms/packages/e4-import/src/bomc-loader.ts')],
	['Benchmark', path.resolve(process.cwd(), '../sibambo-benchmark/packages/e4-import/src/bomc-loader.ts')]
] as const;

function sourceEdges(graph: BomcGraph) {
	let count = 0;
	for (const mesh of graph.meshes) {
		const edges = new Set<string>();
		for (const face of mesh.faces) for (const ring of [face.outer, ...face.holes]) for (let index = 0; index < ring.length; index += 1) {
			const left = ring[index]!; const right = ring[(index + 1) % ring.length]!;
			edges.add(left < right ? `${left}:${right}` : `${right}:${left}`);
		}
		count += edges.size;
	}
	return count;
}

describe('the three unchanged BOMC readers accept web-core writer fixtures', () => {
	for (const [app, loaderPath] of appRoots) {
		test(`${app} reads each canonical fixture without solid suppression`, async () => {
			const moduleUrl = pathToFileURL(loaderPath).href;
			const module = await import(moduleUrl) as { BomcLoader: BomcLoaderConstructor };
			for (const [fixtureName, factory] of fixtures) {
				const graph = factory();
				const document = BomcDocument.fromGraph(graph);
				const writer = new BomcWriter(document, { compressionMode: 'store-only' });
				try {
					const output = await writer.write();
					const buffer = output.bytes.buffer.slice(output.bytes.byteOffset, output.bytes.byteOffset + output.bytes.byteLength) as ArrayBuffer;
					const directory = parseDirectory(output.bytes, 'web-core');
					const modelSection = await loadSection(output.bytes, directory.sections.find((section) => section.type === 1)!);
					const expectedStringWidth = fixtureName === 'width' ? 2 : 1;
					expect([...modelSection.subarray(0, 4)], `${app}/${fixtureName} source-coordinate metadata`).toEqual([1, 1, expectedStringWidth, 5]);
					const loaded = await new module.BomcLoader().load(buffer, '', { prepareSolid: false });
					const faceCount = graph.meshes.reduce((sum, mesh) => sum + mesh.faces.length, 0);
					expect(loaded.version, `${app}/${fixtureName} container version`).toBe('1.2');
					expect(loaded.profile, `${app}/${fixtureName} profile`).toBe('production');
					expect(loaded.encodingContract?.profile, `${app}/${fixtureName} encoding profile`).toBe('exact');
					expect(loaded.modelName, `${app}/${fixtureName} model name`).toBe(graph.name);
					expect(loaded.sourceFileName, `${app}/${fixtureName} null source-name fallback`).toBe('');
					expect(loaded.counts, `${app}/${fixtureName} table counts`).toEqual({
						materials: graph.materials.length, tags: 0, meshes: graph.meshes.length, faces: faceCount,
						definitions: graph.definitions.length, instances: graph.instances.length, transforms: graph.instances.length,
						textures: 0, edges: sourceEdges(graph)
					});
					expect(loaded.diagnostics.triangleOwnership.sourceFaces, `${app}/${fixtureName} source faces`).toBe(faceCount);
					expect(loaded.diagnostics.coverage).toEqual({ eligible: faceCount, analytical: faceCount, visualRetained: 0, fallback: 0, excluded: 0, unaccounted: 0 });
					expect(loaded.diagnostics.visibility.totalFaces, `${app}/${fixtureName} source visibility rows`).toBe(faceCount);
					const renderedSourceFaceIndices = new Set(loaded.preparedRuntimeScene.groups.flatMap((group) => [...(group.sourceFaceIndicesByTriangle ?? [])]));
					expect([...renderedSourceFaceIndices].every((index) => index < faceCount), `${app}/${fixtureName} rendered source-face references are in range`).toBe(true);
					if (loaded.preparedRuntimeScene.groups.some((group) => group.indices.length > 0)) expect(renderedSourceFaceIndices.size, `${app}/${fixtureName} rendered source-face references exist`).toBeGreaterThan(0);
					expect(loaded.appearance.assets, `${app}/${fixtureName} generated assets`).toEqual([]);
					for (const runtimeMesh of loaded.preparedRuntimeScene.meshes) {
						const sourceMesh = graph.meshes[runtimeMesh.sourceMeshIndex];
						if (!sourceMesh) throw new Error(`${app}/${fixtureName} runtime mesh refers to missing source row ${runtimeMesh.sourceMeshIndex}.`);
						const expectedVertices = new Set(sourceMesh.faces.filter((face) => !face.hidden).flatMap((face) => [...face.triangles]).map((vertex) => pointKey([
							Math.fround(sourceMesh.positions[vertex * 3]!), Math.fround(sourceMesh.positions[vertex * 3 + 2]!), Math.fround(-sourceMesh.positions[vertex * 3 + 1]!)
						])));
						const actualVertices = new Set(Array.from({ length: runtimeMesh.positions.length / 3 }, (_, vertex) => pointKey([runtimeMesh.positions[vertex * 3]!, runtimeMesh.positions[vertex * 3 + 1]!, runtimeMesh.positions[vertex * 3 + 2]!])));
						expect(actualVertices, `${app}/${fixtureName} source Float32 narrowing and viewer-axis point set`).toEqual(expectedVertices);
					}
					const hierarchy = loaded.preparedRuntimeScene.occurrenceHierarchy;
					expect(hierarchy, `${app}/${fixtureName} occurrence ownership table`).toBeDefined();
					expect(hierarchy!.parentIndices).toHaveLength(loaded.diagnostics.occurrences.hierarchyNodeCount);
					expect(hierarchy!.instanceIndices.every((index) => index < graph.instances.length)).toBe(true);
					if (fixtureName === 'color') {
						expect(loaded.appearance.materials.map((material) => material.baseColorRgba)).toEqual([[155 / 255, 28 / 255, 49 / 255, 1], [0, 128 / 255, 1, 128 / 255]]);
						expect(loaded.appearance.materials.map((material) => material.opacity)).toEqual([1, 32768 / 65535]);
						expect([...new Set(loaded.preparedRuntimeScene.groups.map((group) => group.materialIndex).filter((value) => value !== undefined))].sort()).toEqual([0, 1]);
						expect(loaded.preparedRuntimeScene.groups.some((group) => group.renderSide === 'back')).toBe(true);
					}
					if (fixtureName === 'hole') {
						let visibleHoleArea = 0;
						for (const group of loaded.preparedRuntimeScene.groups) {
							const mesh = loaded.preparedRuntimeScene.meshes[group.sourceMeshIndex]!;
							for (let triangle = 0; triangle < group.indices.length / 3; triangle += 1) {
								if (group.sourceFaceIndicesByTriangle?.[triangle] !== 0) continue;
								const [a, b, c] = [0, 1, 2].map((corner) => group.indices[triangle * 3 + corner]! * 3);
								visibleHoleArea += Math.abs((mesh.positions[b]! - mesh.positions[a]!) * (mesh.positions[c + 2]! - mesh.positions[a + 2]!) - (mesh.positions[b + 2]! - mesh.positions[a + 2]!) * (mesh.positions[c]! - mesh.positions[a]!)) / 2;
							}
						}
						expect(visibleHoleArea, `${app} hole fixture triangulates around its hole`).toBeCloseTo(12, 5);
					}
					if (fixtureName === 'shared') {
						expect(loaded.preparedRuntimeScene.meshes).toHaveLength(1);
						expect(loaded.diagnostics.occurrences.renderOccurrenceCount).toBe(2);
					}
					if (fixtureName === 'hidden-color') expect(loaded.diagnostics.visibility.totalFaces).toBe(faceCount);
				} finally {
					writer.dispose();
					document.dispose();
				}
			}
		});
	}
});

function coordinateKey(value: number) { return Object.is(value, -0) ? '-0' : String(value); }
function pointKey(point: readonly number[]) { return point.map(coordinateKey).join(','); }
