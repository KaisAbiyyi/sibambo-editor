import { describe, expect, test } from 'bun:test';
import { BomcDocument, BomcDocumentError, deriveGraphBounds } from './document.js';
import { createEmptyGraph, createNestedGraph, createPrecisionGraph } from './test-fixtures/documents.js';

describe('canonical BOMC document', () => {
	test('creates a blank graph with stable root identity and immutable snapshot ownership', () => {
		const document = BomcDocument.create({ documentId: 'fixture:empty' });
		const snapshot = document.snapshot();
		expect(snapshot.revision).toBe(0);
		expect(snapshot.graph.documentId).toBe('fixture:empty');
		expect(snapshot.graph.name).toBe('Untitled');
		expect(snapshot.graph.definitions).toHaveLength(1);
		expect(snapshot.graph.instances).toHaveLength(1);
		expect(Object.isFrozen(snapshot.graph)).toBe(true);
		expect(Object.isFrozen(snapshot.graph.instances[0]!.matrix)).toBe(true);
		expect(document.snapshot()).toBe(snapshot);
		document.dispose();
		document.dispose();
		expect(() => document.snapshot()).toThrowError(BomcDocumentError);
	});

	test('copies caller arrays, canonicalizes record order, and preserves exact scalar values', () => {
		const input = createPrecisionGraph();
		const originalX = input.meshes[0]!.positions[0]!;
		const document = BomcDocument.fromGraph(input);
		(input.meshes[0]!.positions as number[])[0] = 99;
		const snapshot = document.snapshot();
		expect(snapshot.graph.meshes[0]!.positions[0]).toBe(originalX);
		expect(snapshot.graph.meshes[0]!.positions[0]).not.toBe(Math.fround(originalX));
		expect(Object.is(snapshot.graph.meshes[0]!.faces[0]!.normal[1], -0)).toBe(true);
	});

	test('commits ordered edits atomically and advances only the affected revision tokens', () => {
		const source = createPrecisionGraph();
		const rootDefinition = source.definitions[0]!;
		const childDefinitionId = 'fixture:precision:definition:editable-child';
		const graph = {
			...source,
			definitions: [{ ...rootDefinition, meshId: null }, { id: childDefinitionId, name: 'Editable child', kind: 'component' as const, meshId: source.meshes[0]!.id }],
			meshes: [{ ...source.meshes[0]!, definitionId: childDefinitionId }],
			instances: [
				source.instances[0]!,
				{ id: 'fixture:precision:instance:editable-child', name: 'Editable child', kind: 'component' as const, ownerDefinitionId: rootDefinition.id, definitionId: childDefinitionId, matrix: [...source.instances[0]!.matrix], materialId: null, visible: true, roleCode: 0, label: null }
			]
		};
		const document = BomcDocument.fromGraph(graph);
		const first = document.snapshot();
		expect(document.transact([{ type: 'set-name', name: first.graph.name }])).toBe(0);
		expect(document.snapshot()).toBe(first);
		const child = { ...first.graph.instances.find((row) => row.kind !== 'root')!, matrix: [...first.graph.instances.find((row) => row.kind !== 'root')!.matrix] };
		child.matrix[12] = 2.125;
		document.transact([{ type: 'put-instance', value: child }]);
		const moved = document.snapshot();
		expect(moved.revision).toBe(1);
		expect(moved.tokens.transforms).toBe(first.tokens.transforms + 1);
		expect(moved.tokens.instances).toBe(first.tokens.instances);
		expect(moved.tokens.geometry).toBe(first.tokens.geometry);
		expect(first.graph.instances[0]!.matrix[12]).toBe(0);
		const beforeFailure = document.snapshot();
		const invalid = { ...child, matrix: [...child.matrix] };
		invalid.matrix[0] = 0;
		expect(() => document.transact([{ type: 'put-instance', value: invalid }])).toThrow();
		expect(document.snapshot()).toBe(beforeFailure);
	});

	test('validates the full graph after an edit batch and does not publish partial references', () => {
		const document = BomcDocument.fromGraph(createPrecisionGraph());
		const before = document.snapshot();
		const mesh = before.graph.meshes[0]!;
		expect(() => document.transact([
			{ type: 'delete-mesh', id: mesh.id }
		])).toThrow();
		expect(document.snapshot()).toBe(before);
	});

	test('failed cyclic references in otherwise unused definitions leave graph, revision, and all tokens unchanged', () => {
		const document = BomcDocument.fromGraph(createEmptyGraph());
		const before = document.snapshot();
		const definitionA = { id: 'fixture:unused:a', name: 'unused A', kind: 'group' as const, meshId: null };
		const definitionB = { id: 'fixture:unused:b', name: 'unused B', kind: 'group' as const, meshId: null };
		const matrix = [...before.graph.instances[0]!.matrix];
		const instanceA = {
			id: 'fixture:unused:instance:a', name: 'A', kind: 'group' as const, ownerDefinitionId: definitionB.id,
			definitionId: definitionA.id, matrix, materialId: null, visible: true, roleCode: 0, label: null
		};
		const instanceB = {
			id: 'fixture:unused:instance:b', name: 'B', kind: 'group' as const, ownerDefinitionId: definitionA.id,
			definitionId: definitionB.id, matrix, materialId: null, visible: true, roleCode: 0, label: null
		};
		expect(() => document.transact([
			{ type: 'put-definition', value: definitionA }, { type: 'put-definition', value: definitionB },
			{ type: 'put-instance', value: instanceA }, { type: 'put-instance', value: instanceB }
		])).toThrow(BomcDocumentError);
		expect(document.snapshot()).toBe(before);
		expect(document.snapshot().revision).toBe(0);
		expect(document.snapshot().tokens).toEqual(before.tokens);
		document.dispose();
	});

	test('set-name restore and identical puts are exact no-ops', () => {
		const document = BomcDocument.fromGraph(createPrecisionGraph());
		const before = document.snapshot();
		expect(document.transact([
			{ type: 'set-name', name: 'temporary name' },
			{ type: 'set-name', name: before.graph.name }
		])).toBe(0);
		expect(document.snapshot()).toBe(before);
		expect(document.transact([{ type: 'put-instance', value: before.graph.instances[0]! }])).toBe(0);
		expect(document.snapshot()).toBe(before);
		document.dispose();
	});

	test('rejects malformed tuple widths, negative-zero integers, invalid Unicode, non-finite points, and bad triangles', () => {
		const base = createPrecisionGraph();
		const wrongNormal = structuredClone(base);
		(wrongNormal.meshes[0]!.faces[0]!.normal as unknown as number[]).pop();
		const negativeZeroInteger = structuredClone(base);
		(negativeZeroInteger.meshes[0]!.faces[0] as { surfaceCode: number }).surfaceCode = -0;
		const invalidUnicode = { ...base, name: '\ud800' };
		const nonFinite = structuredClone(base);
		(nonFinite.meshes[0]!.positions as number[])[0] = Number.POSITIVE_INFINITY;
		const degenerate = structuredClone(base);
		const degenerateTriangles = degenerate.meshes[0]!.faces[0]!.triangles as number[];
		degenerateTriangles[1] = degenerateTriangles[0]!;
		const reversed = structuredClone(base);
		const reversedTriangles = reversed.meshes[0]!.faces[0]!.triangles as number[];
		[reversedTriangles[1], reversedTriangles[2]] = [
			reversedTriangles[2]!, reversedTriangles[1]!
		];
		for (const invalid of [wrongNormal, negativeZeroInteger, invalidUnicode, nonFinite, degenerate, reversed]) {
			expect(() => BomcDocument.fromGraph(invalid as never)).toThrow(BomcDocumentError);
		}
	});

	test('computes nested, invisible-inclusive bounds while excluding unreachable definition geometry', () => {
		const graph = createNestedGraph();
		const bounds = deriveGraphBounds(graph);
		expect(bounds.min).toEqual([0, 0, 0]);
		expect(bounds.max).toEqual([13, 5, 0]);
		expect(() => BomcDocument.fromGraph(graph)).not.toThrow();
	});

	test('empty translated child instances do not create model geometry bounds', () => {
		const graph = createEmptyGraph();
		const childDefinition = { id: 'fixture:empty:definition:child', name: 'Empty child', kind: 'group' as const, meshId: null };
		const childMatrix = [...graph.instances[0]!.matrix];
		childMatrix[12] = 100; childMatrix[13] = -200; childMatrix[14] = 300;
		const childInstance = {
			id: 'fixture:empty:instance:child', name: 'Empty translated child', kind: 'group' as const,
			ownerDefinitionId: graph.rootDefinitionId, definitionId: childDefinition.id, matrix: childMatrix,
			materialId: null, visible: true, roleCode: 0, label: null
		};
		const withChild = { ...graph, definitions: [...graph.definitions, childDefinition], instances: [...graph.instances, childInstance] };
		expect(deriveGraphBounds(withChild)).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
		expect(() => BomcDocument.fromGraph(withChild)).not.toThrow();
	});

	test('rejects typed-array aliases, unknown fields, broken IDs and malformed root transforms', () => {
		const graph = createEmptyGraph();
		const typed = { ...graph, meshes: [{ id: 'm', definitionId: graph.rootDefinitionId, positions: new Float64Array(0), faces: [] }] };
		expect(() => BomcDocument.fromGraph(typed as never)).toThrow();
		expect(() => BomcDocument.fromGraph({ ...graph, extra: true } as never)).toThrow();
		const root = graph.instances[0]!;
		const transformed = { ...graph, instances: [{ ...root, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2] }] };
		expect(() => BomcDocument.fromGraph(transformed as never)).toThrow();
	});
});
