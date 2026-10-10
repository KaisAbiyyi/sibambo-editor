import { describe, expect, test } from 'bun:test';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { buildExtrusionEdit, buildRectangleEdit, validateEditableSubset } from '../../src/lib/authoring/geometry.js';

const DOCUMENT_ID = 'a4f2d141-64e1-4c62-8d0d-53623f71a220';

describe('flat authoring subset admission', () => {
	test('admits the exact empty root and independently authored rectangles', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		try {
			expect(validateEditableSubset(document.snapshot().graph)).toEqual({ editable: true, entities: [] });
			for (let sequence = 1; sequence <= 2; sequence += 1) {
				const graph = document.snapshot().graph;
				document.transact(buildRectangleEdit(
					graph,
					`${DOCUMENT_ID}:rectangle:${sequence}`,
					[(sequence - 1) * 4, 0, 0],
					[(sequence - 1) * 4 + 2, 0, 3]
				).forward);
			}
			const result = validateEditableSubset(document.snapshot().graph);
			expect(result.editable).toBe(true);
			if (result.editable) expect(result.entities.map((entity) => entity.entityId)).toEqual([
				`${DOCUMENT_ID}:rectangle:1`, `${DOCUMENT_ID}:rectangle:2`
			]);
		} finally { document.dispose(); }
	});

	test('admits independent rectangles and one canonical signed prism per rectangle', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		try {
			const firstId = `${DOCUMENT_ID}:rectangle:1`;
			const secondId = `${DOCUMENT_ID}:rectangle:2`;
			document.transact(buildRectangleEdit(document.snapshot().graph, firstId, [0, 0, 0], [2, 0, 3]).forward);
			document.transact(buildRectangleEdit(document.snapshot().graph, secondId, [4, 0, 0], [6, 0, 3]).forward);
			document.transact(buildExtrusionEdit(document.snapshot().graph, firstId, -2.7).forward);
			const result = validateEditableSubset(document.snapshot().graph);
			expect(result.editable).toBe(true);
			if (result.editable) expect(result.entities.map(({ entityId, kind, distance }) => ({ entityId, kind, distance }))).toEqual([
				{ entityId: firstId, kind: 'extrusion', distance: -2.7 },
				{ entityId: secondId, kind: 'rectangle', distance: null }
			]);
			expect(() => buildExtrusionEdit(document.snapshot().graph, firstId, 1)).toThrow();
		} finally { document.dispose(); }
	});

	test('keeps a kernel-valid graph with a noncanonical claimed shape label viewer-only', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		try {
			const entityId = `${DOCUMENT_ID}:rectangle:1`;
			document.transact(buildRectangleEdit(document.snapshot().graph, entityId, [0, 0, 0], [2, 0, 3]).forward);
			const graph = document.snapshot().graph;
			const mesh = graph.meshes[0]!;
			const tamperedMesh = {
				...mesh,
				faces: mesh.faces.map((face) => ({
					...face,
					label: ` [${JSON.stringify('sibambo-editor-shape-v1')},${JSON.stringify('rectangle')},${JSON.stringify(entityId)}] `
				}))
			};
			document.transact([{ type: 'put-mesh', value: tamperedMesh }]);
			expect(validateEditableSubset(document.snapshot().graph)).toMatchObject({ editable: false });
		} finally { document.dispose(); }
	});

	test('rejects duplicate claimed entity identity and nested component graphs without repair', () => {
		const duplicated = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		try {
			const firstId = `${DOCUMENT_ID}:rectangle:1`;
			const secondId = `${DOCUMENT_ID}:rectangle:2`;
			duplicated.transact(buildRectangleEdit(duplicated.snapshot().graph, firstId, [0, 0, 0], [2, 0, 3]).forward);
			duplicated.transact(buildRectangleEdit(duplicated.snapshot().graph, secondId, [4, 0, 0], [6, 0, 3]).forward);
			const mesh = duplicated.snapshot().graph.meshes[0]!;
			duplicated.transact([{
				type: 'put-mesh',
				value: {
					...mesh,
					faces: mesh.faces.map((face) => face.id === secondId
						? { ...face, label: JSON.stringify(['sibambo-editor-shape-v1', 'rectangle', firstId]) }
						: face)
				}
			}]);
			expect(validateEditableSubset(duplicated.snapshot().graph)).toMatchObject({ editable: false });
		} finally { duplicated.dispose(); }

		const nested = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		try {
			const childDefinitionId = `${DOCUMENT_ID}:definition:child`;
			nested.transact([
				{ type: 'put-definition', value: { id: childDefinitionId, name: 'Nested', kind: 'component', meshId: null } },
				{ type: 'put-instance', value: {
					id: `${DOCUMENT_ID}:instance:child`, name: 'Nested', kind: 'component',
					ownerDefinitionId: `${DOCUMENT_ID}:definition:root`, definitionId: childDefinitionId,
					matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
					materialId: null, visible: true, roleCode: 0, label: null
				} }
			]);
			expect(validateEditableSubset(nested.snapshot().graph)).toMatchObject({ editable: false });
		} finally { nested.dispose(); }
	});

	test('rejects extra materials instead of normalizing a broader valid graph', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		try {
			document.transact([{ type: 'put-material', value: {
				id: `${DOCUMENT_ID}:material:extra`, name: 'Extra', displayName: null,
				rgba: [1, 2, 3, 255], opacityU16: 65535
			} }]);
			expect(validateEditableSubset(document.snapshot().graph)).toMatchObject({ editable: false });
			expect(document.snapshot().graph.materials).toHaveLength(1);
		} finally { document.dispose(); }
	});
});
