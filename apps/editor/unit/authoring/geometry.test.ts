import { describe, expect, test } from 'bun:test';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { buildExtrusionEdit, buildRectangleEdit, validateEditableSubset } from '../../src/lib/authoring/geometry.js';

const DOCUMENT_ID = 'a4f2d141-64e1-4c62-8d0d-53623f71a220';

describe('canonical authoring geometry', () => {
	test('creates precision Float64-domain rectangle edits and exact inverse transaction', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		try {
			const before = document.snapshot();
			const entityId = `${DOCUMENT_ID}:rectangle:1`;
			const first = [0.123456789012345, 0, 0.234567890123456] as const;
			const opposite = [1.987654321098765, 0, 2.345678901234567] as const;
			const edit = buildRectangleEdit(before.graph, entityId, first, opposite);

			expect(document.snapshot()).toEqual(before);
			expect(edit.forward.map((row) => row.type)).toEqual(['put-material', 'put-definition', 'put-mesh']);
			expect(edit.inverse.map((row) => row.type)).toEqual(['delete-mesh', 'put-definition', 'delete-material']);
			document.transact(edit.forward);
			const graph = document.snapshot().graph;
			const mesh = graph.meshes[0]!;
			const face = mesh.faces[0]!;
			expect(mesh.positions).toEqual([
				0.123456789012345, 0, 0.234567890123456,
				0.123456789012345, 0, 2.345678901234567,
				1.987654321098765, 0, 2.345678901234567,
				1.987654321098765, 0, 0.234567890123456
			]);
			expect(face).toMatchObject({
				id: entityId, outer: [0, 1, 2, 3], holes: [], triangles: [0, 1, 2, 0, 2, 3],
				normal: [0, 1, 0], frontMaterialId: `${DOCUMENT_ID}:material:default`,
				backMaterialId: `${DOCUMENT_ID}:material:default`, hidden: false, surfaceCode: 0, roleCode: 0,
				label: JSON.stringify(['sibambo-editor-shape-v1', 'rectangle', entityId])
			});
			expect(graph.materials[0]).toEqual({
				id: `${DOCUMENT_ID}:material:default`, name: 'Default', displayName: null,
				rgba: [155, 28, 49, 255], opacityU16: 65535
			});
			expect(validateEditableSubset(graph)).toMatchObject({ editable: true });

			document.transact(edit.inverse);
			expect(document.snapshot().graph).toEqual(before.graph);
		} finally { document.dispose(); }
	});

	test('keeps twelve rectangles in serializer-compatible code-unit face order', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		try {
			for (let sequence = 1; sequence <= 12; sequence += 1) {
				const graph = document.snapshot().graph;
				document.transact(buildRectangleEdit(
					graph,
					`${DOCUMENT_ID}:rectangle:${sequence}`,
					[(sequence - 1) * 3, 0, 0],
					[(sequence - 1) * 3 + 1, 0, 1]
				).forward);
			}
			const faces = document.snapshot().graph.meshes[0]!.faces.map((face) => face.id);
			expect(faces).toEqual([
				`${DOCUMENT_ID}:rectangle:1`, `${DOCUMENT_ID}:rectangle:10`, `${DOCUMENT_ID}:rectangle:11`,
				`${DOCUMENT_ID}:rectangle:12`, `${DOCUMENT_ID}:rectangle:2`, `${DOCUMENT_ID}:rectangle:3`,
				`${DOCUMENT_ID}:rectangle:4`, `${DOCUMENT_ID}:rectangle:5`, `${DOCUMENT_ID}:rectangle:6`,
				`${DOCUMENT_ID}:rectangle:7`, `${DOCUMENT_ID}:rectangle:8`, `${DOCUMENT_ID}:rectangle:9`
			]);
			expect(validateEditableSubset(document.snapshot().graph)).toMatchObject({ editable: true });
		} finally { document.dispose(); }
	});

	test('replaces a flat rectangle with canonical positive and negative signed prisms', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		try {
			const entityId = `${DOCUMENT_ID}:rectangle:1`;
			const first = buildRectangleEdit(document.snapshot().graph, entityId, [0, 0, 0], [2, 0, 3]);
			document.transact(first.forward);
			const flatGraph = document.snapshot().graph;
			for (const distance of [2.7, -2.7]) {
				const extrusion = buildExtrusionEdit(document.snapshot().graph, entityId, distance);
				document.transact(extrusion.forward);
				const graph = document.snapshot().graph;
				const subset = validateEditableSubset(graph);
				expect(subset.editable).toBe(true);
				if (!subset.editable) continue;
				expect(subset.entities).toHaveLength(1);
				expect(subset.entities[0]).toMatchObject({ kind: 'extrusion', entityId, distance });
				const faces = graph.meshes[0]!.faces;
				expect(faces).toHaveLength(6);
				expect(faces.map((face) => face.id)).toEqual([
					`${entityId}:cap`, entityId, `${entityId}:side:0`, `${entityId}:side:1`,
					`${entityId}:side:2`, `${entityId}:side:3`
				].sort());
				expect(faces.find((face) => face.id === entityId)?.normal).toEqual(distance > 0 ? [0, -1, 0] : [0, 1, 0]);
				expect(faces.find((face) => face.id === `${entityId}:cap`)?.normal).toEqual(distance > 0 ? [0, 1, 0] : [0, -1, 0]);
				document.transact(extrusion.inverse);
				expect(document.snapshot().graph).toEqual(flatGraph);
			}
		} finally { document.dispose(); }
	});

	test('rejects nonfinite, off-plane, undersized, and near-zero geometry before mutation', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		try {
			const before = document.snapshot();
			for (const [first, opposite] of [
				[[0, 0, 0], [0, 0, 1]],
				[[0, 0, 0], [1, 0, 1e-7]],
				[[0, 1, 0], [1, 0, 1]],
				[[0, -0, 0], [1, 0, 1]],
				[[0, 0, 0], [Number.NaN, 0, 1]]
			] as const) {
				expect(() => buildRectangleEdit(before.graph, `${DOCUMENT_ID}:rectangle:1`, first, opposite)).toThrow();
			}
			expect(() => buildExtrusionEdit(before.graph, `${DOCUMENT_ID}:rectangle:1`, -1e-7)).toThrow();
			expect(document.snapshot()).toEqual(before);
		} finally { document.dispose(); }
	});

	test('does not reuse an existing rectangle ID or permit a second extrusion', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		try {
			const entityId = `${DOCUMENT_ID}:rectangle:1`;
			document.transact(buildRectangleEdit(document.snapshot().graph, entityId, [0, 0, 0], [2, 0, 3]).forward);
			const flatGraph = document.snapshot().graph;
			expect(() => buildRectangleEdit(flatGraph, entityId, [4, 0, 0], [6, 0, 3])).toThrow();
			const extrusion = buildExtrusionEdit(flatGraph, entityId, 2.7);
			document.transact(extrusion.forward);
			const prismGraph = document.snapshot().graph;
			expect(() => buildExtrusionEdit(prismGraph, entityId, -1)).toThrow();
			expect(document.snapshot().graph).toEqual(prismGraph);
		} finally { document.dispose(); }
	});
});
