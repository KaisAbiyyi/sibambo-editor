import { describe, expect, test } from 'bun:test';
import { BomcDocument } from '@sibambo/bomc-document/document';
import {
	buildExtrusionEdit,
	buildFaceLoopEdit,
	buildPlanarRectangleEdit,
	buildPushPullFaceEdit,
	buildRectangleEdit,
	journalEntry,
	validateEditableSubset
} from '../../src/lib/authoring/geometry.js';
import { AuthoringHistory } from '../../src/lib/authoring/history.js';
import { buildAuthoringTopology } from '../../src/lib/authoring/topology.js';

const DOCUMENT_ID = '6120c783-9aa5-4b1b-af99-72a16f789154';

function createNeutralRectangle() {
	const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Push Pull' });
	const history = new AuthoringHistory(null);
	const faceId = `${DOCUMENT_ID}:rectangle:1`;
	history.execute(document, journalEntry(buildPlanarRectangleEdit(
		document.snapshot().graph,
		faceId,
		[[0, 0, 0], [4, 0, 0], [4, 0, 3], [0, 0, 3]],
		[0, 1, 0]
	)));
	return { document, history, faceId };
}

function vertexPositions(graph: ReturnType<BomcDocument['snapshot']>['graph'], faceId: string) {
	const mesh = graph.meshes[0]!;
	const face = mesh.faces.find((candidate) => candidate.id === faceId)!;
	return face.outer.map((vertex) => mesh.positions.slice(vertex * 3, vertex * 3 + 3));
}

describe('authoring topology v2 Push/Pull', () => {
	test('new faces use neutral material while v1 maroon remains explicit and unchanged', () => {
		const legacy = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Legacy' });
		try {
			const legacyId = `${DOCUMENT_ID}:rectangle:1`;
			legacy.transact(buildRectangleEdit(legacy.snapshot().graph, legacyId, [0, 0, 0], [2, 0, 2]).forward);
			expect(legacy.snapshot().graph.materials[0]?.rgba).toEqual([155, 28, 49, 255]);

			legacy.transact(buildPlanarRectangleEdit(
				legacy.snapshot().graph,
				`${DOCUMENT_ID}:rectangle:2`,
				[[4, 0, 0], [6, 0, 0], [6, 0, 2], [4, 0, 2]],
				[0, 1, 0]
			).forward);
			const graph = legacy.snapshot().graph;
			expect(graph.materials.find((material) => material.id === `${DOCUMENT_ID}:material:default`)?.rgba).toEqual([155, 28, 49, 255]);
			expect(graph.materials.find((material) => material.id === `${DOCUMENT_ID}:material:authoring-neutral`)?.rgba).toEqual([226, 226, 226, 255]);
			expect(validateEditableSubset(graph)).toMatchObject({ editable: true });
		} finally { legacy.dispose(); }

		const neutral = createNeutralRectangle();
		try {
			expect(neutral.document.snapshot().graph.materials).toEqual([{
				id: `${DOCUMENT_ID}:material:default`,
				name: 'Default',
				displayName: null,
				rgba: [226, 226, 226, 255],
				opacityU16: 65535
			}]);
		} finally { neutral.document.dispose(); }
	});

	test('pushes a neutral face to a closed box, then repeats top and side Push/Pull while staying manifold', () => {
		const { document, history, faceId } = createNeutralRectangle();
		try {
			const flat = document.snapshot().graph;
			history.execute(document, journalEntry(buildPushPullFaceEdit(flat, faceId, 2.7, 2)));
			const firstBox = document.snapshot().graph;
			const firstMesh = firstBox.meshes[0]!;
			expect(firstMesh.faces).toHaveLength(6);
			expect([...buildAuthoringTopology(firstMesh).edges.values()].every((edge) => edge.faceIds.length === 2)).toBe(true);
			expect(validateEditableSubset(firstBox)).toMatchObject({ editable: true });

			const topFaceId = `${DOCUMENT_ID}:op:2:cap`;
			const bottomBeforeTop = JSON.parse(JSON.stringify(firstMesh.faces.find((face) => face.id === faceId)));
			const bottomVerticesBeforeTop = vertexPositions(firstBox, faceId);
			history.execute(document, journalEntry(buildPushPullFaceEdit(firstBox, topFaceId, 1.1, 3)));
			const secondBox = document.snapshot().graph;
			expect(validateEditableSubset(secondBox)).toMatchObject({ editable: true });
			expect([...buildAuthoringTopology(secondBox.meshes[0]!).edges.values()].every((edge) => edge.faceIds.length === 2)).toBe(true);
			expect(secondBox.meshes[0]!.faces.find((face) => face.id === faceId)).toEqual(bottomBeforeTop);
			expect(vertexPositions(secondBox, faceId)).toEqual(bottomVerticesBeforeTop);
			expect(Math.max(...vertexPositions(secondBox, topFaceId).map((point) => point[1]!))).toBeCloseTo(3.8, 12);

			const sideFaceId = `${DOCUMENT_ID}:op:2:side:0`;
			const sideBefore = secondBox.meshes[0]!.faces.find((face) => face.id === sideFaceId)!;
			const sidePointsBefore = vertexPositions(secondBox, sideFaceId);
			history.execute(document, journalEntry(buildPushPullFaceEdit(secondBox, sideFaceId, 0.8, 4)));
			const sidePushed = document.snapshot().graph;
			expect(validateEditableSubset(sidePushed)).toMatchObject({ editable: true });
			expect([...buildAuthoringTopology(sidePushed.meshes[0]!).edges.values()].every((edge) => edge.faceIds.length === 2)).toBe(true);
			const sidePointsAfter = vertexPositions(sidePushed, sideFaceId);
			for (let index = 0; index < sidePointsBefore.length; index += 1) {
				const before = sidePointsBefore[index]!;
				const after = sidePointsAfter[index]!;
				const delta = after.map((value, axis) => value - before[axis]!) as [number, number, number];
				const projected = delta[0] * sideBefore.normal[0] + delta[1] * sideBefore.normal[1] + delta[2] * sideBefore.normal[2];
				expect(projected).toBeCloseTo(0.8, 12);
			}

			expect(history.undo(document)).toBe(true);
			expect(document.snapshot().graph).toEqual(secondBox);
			expect(history.undo(document)).toBe(true);
			expect(document.snapshot().graph).toEqual(firstBox);
		} finally { document.dispose(); }
	});

	test('allows an in-bounds negative pull and rejects collapse through the opposite boundary without mutation', () => {
		const { document, history, faceId } = createNeutralRectangle();
		try {
			history.execute(document, journalEntry(buildPushPullFaceEdit(document.snapshot().graph, faceId, 2.7, 2)));
			const box = document.snapshot().graph;
			const topFaceId = `${DOCUMENT_ID}:op:2:cap`;
			const negative = buildPushPullFaceEdit(box, topFaceId, -0.5, 3);
			history.execute(document, journalEntry(negative));
			expect(validateEditableSubset(document.snapshot().graph)).toMatchObject({ editable: true });
			expect(history.undo(document)).toBe(true);
			expect(document.snapshot().graph).toEqual(box);

			const before = document.snapshot();
			const historyBefore = history.checkpoint();
			expect(() => buildPushPullFaceEdit(before.graph, topFaceId, -2.7, 3)).toThrow(/cross|collapse/i);
			expect(document.snapshot()).toEqual(before);
			expect(history.checkpoint()).toEqual(historyBefore);
			expect(() => buildPushPullFaceEdit(before.graph, `${DOCUMENT_ID}:missing-face`, 1, 3)).toThrow(/no longer exists/i);
		} finally { document.dispose(); }
	});

	test('upgrades a legacy v1 prism only through an acknowledged supported face edit', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Legacy prism' });
		try {
			const entityId = `${DOCUMENT_ID}:rectangle:1`;
			document.transact(buildRectangleEdit(document.snapshot().graph, entityId, [0, 0, 0], [4, 0, 3]).forward);
			document.transact(buildExtrusionEdit(document.snapshot().graph, entityId, 2.7).forward);
			const legacyBox = document.snapshot().graph;
			expect(validateEditableSubset(legacyBox)).toMatchObject({ editable: true });
			expect(legacyBox.materials[0]?.rgba).toEqual([155, 28, 49, 255]);

			const topFaceId = `${entityId}:cap`;
			const edit = buildPushPullFaceEdit(legacyBox, topFaceId, 0.6, 2);
			document.transact(edit.forward);
			const upgraded = document.snapshot().graph;
			expect(validateEditableSubset(upgraded)).toMatchObject({ editable: true });
			expect(upgraded.materials[0]?.rgba).toEqual([155, 28, 49, 255]);
			expect(upgraded.meshes[0]!.faces.find((face) => face.id === topFaceId)?.label).toContain('sibambo-editor-shape-v2');
		} finally { document.dispose(); }
	});

	test('rejects coplanar overlap and edge-interior T junctions that would require topology splitting', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Splits' });
		try {
			document.transact(buildPlanarRectangleEdit(
				document.snapshot().graph,
				`${DOCUMENT_ID}:rectangle:1`,
				[[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4]],
				[0, 1, 0]
			).forward);
			const before = document.snapshot();
			expect(() => buildFaceLoopEdit(
				before.graph,
				`${DOCUMENT_ID}:face:2`,
				[[1, 0, 1], [3, 0, 1], [3, 0, 3], [1, 0, 3]],
				[0, 1, 0]
			)).toThrow(/overlap|splitting/i);
			expect(() => buildFaceLoopEdit(
				before.graph,
				`${DOCUMENT_ID}:face:2`,
				[[2, 0, 0], [2, 2, 0], [4, 2, 0], [4, 0, 0]],
				[0, 0, 1]
			)).toThrow(/existing edge|splitting/i);
			expect(document.snapshot()).toEqual(before);
		} finally { document.dispose(); }
	});
});
