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

	test('subdivides a strictly contained coplanar loop but still rejects boundary T junctions', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Splits' });
		try {
			document.transact(buildPlanarRectangleEdit(
				document.snapshot().graph,
				`${DOCUMENT_ID}:rectangle:1`,
				[[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4]],
				[0, 1, 0]
			).forward);
			const before = document.snapshot();
			const contained = buildFaceLoopEdit(
				before.graph,
				`${DOCUMENT_ID}:face:2`,
				[[1, 0, 1], [3, 0, 1], [3, 0, 3], [1, 0, 3]],
				[0, 1, 0]
			);
			document.transact(contained.forward);
			expect(validateEditableSubset(document.snapshot().graph)).toMatchObject({ editable: true });
			expect(document.snapshot().graph.meshes[0]!.faces.find((face) => face.id === `${DOCUMENT_ID}:rectangle:1`)?.holes).toHaveLength(1);
			const afterContained = document.snapshot();
			expect(() => buildFaceLoopEdit(
				afterContained.graph,
				`${DOCUMENT_ID}:face:3`,
				[[2, 0, 0], [2, 2, 0], [4, 2, 0], [4, 0, 0]],
				[0, 0, 1]
			)).toThrow(/existing edge|splitting/i);
			expect(document.snapshot()).toEqual(afterContained);
		} finally { document.dispose(); }
	});

	test('subdivides an authored face for a contained Line/Rectangle loop and can Push/Pull the new inset face', () => {
		const { document, history, faceId } = createNeutralRectangle();
		try {
			history.execute(document, journalEntry(buildPushPullFaceEdit(document.snapshot().graph, faceId, 2.7, 2)));
			const box = document.snapshot().graph;
			const topFaceId = `${DOCUMENT_ID}:op:2:cap`;
			const top = box.meshes[0]!.faces.find((face) => face.id === topFaceId)!;
			const topPoints = top.outer.map((vertex) => {
				const offset = vertex * 3;
				return [box.meshes[0]!.positions[offset]!, box.meshes[0]!.positions[offset + 1]!, box.meshes[0]!.positions[offset + 2]!] as const;
			});
			const center = topPoints.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]] as [number, number, number], [0, 0, 0] as [number, number, number])
				.map((value) => value / topPoints.length) as [number, number, number];
			const inset = topPoints.map((point) => [
				center[0] + (point[0] - center[0]) * 0.4,
				center[1] + (point[1] - center[1]) * 0.4,
				center[2] + (point[2] - center[2]) * 0.4
			] as [number, number, number]);
			const insetFaceId = `${DOCUMENT_ID}:face:3`;
			history.execute(document, journalEntry(buildFaceLoopEdit(document.snapshot().graph, insetFaceId, inset, top.normal)));
			const split = document.snapshot().graph;
			const splitMesh = split.meshes[0]!;
			expect(validateEditableSubset(split)).toMatchObject({ editable: true });
			expect(splitMesh.faces.find((face) => face.id === topFaceId)?.holes).toHaveLength(1);
			expect(splitMesh.faces.find((face) => face.id === insetFaceId)).toBeDefined();
			const insetEdges = [...buildAuthoringTopology(splitMesh).edges.values()].filter((edge) => edge.faceIds.includes(insetFaceId));
			expect(insetEdges).toHaveLength(4);
			expect(insetEdges.every((edge) => edge.faceIds.length === 2)).toBe(true);

			history.execute(document, journalEntry(buildPushPullFaceEdit(split, insetFaceId, 0.6, 4)));
			const pushedInset = document.snapshot().graph;
			expect(validateEditableSubset(pushedInset)).toMatchObject({ editable: true });
			expect(pushedInset.meshes[0]!.faces.some((face) => face.id === insetFaceId)).toBe(true);
			expect(pushedInset.meshes[0]!.faces.filter((face) => face.id.startsWith(`${DOCUMENT_ID}:op:4:side:`))).toHaveLength(4);
			expect(pushedInset.meshes[0]!.faces.find((face) => face.id === topFaceId)?.holes).toHaveLength(1);
		} finally { document.dispose(); }
		});

	test('keeps a surrounding box face with a pushed child inset Push/Pull-editable', () => {
		const { document, history, faceId } = createNeutralRectangle();
		try {
			history.execute(document, journalEntry(buildPushPullFaceEdit(document.snapshot().graph, faceId, 2.7, 2)));
			const box = document.snapshot().graph;
			const topFaceId = `${DOCUMENT_ID}:op:2:cap`;
			const top = box.meshes[0]!.faces.find((face) => face.id === topFaceId)!;
			const topPoints = vertexPositions(box, topFaceId) as [number, number, number][];
			const center = topPoints.reduce(
				(sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]] as [number, number, number],
				[0, 0, 0] as [number, number, number]
			).map((value) => value / topPoints.length) as [number, number, number];
			const insetPoints = topPoints.map((point) => [
				center[0] + (point[0] - center[0]) * 0.4,
				center[1] + (point[1] - center[1]) * 0.4,
				center[2] + (point[2] - center[2]) * 0.4
			] as [number, number, number]);
			const insetFaceId = `${DOCUMENT_ID}:face:3`;
			history.execute(document, journalEntry(buildFaceLoopEdit(box, insetFaceId, insetPoints, top.normal)));
			history.execute(document, journalEntry(buildPushPullFaceEdit(document.snapshot().graph, insetFaceId, 0.6, 4)));

			const withChild = document.snapshot().graph;
			const meshBefore = withChild.meshes[0]!;
			const parentBefore = meshBefore.faces.find((face) => face.id === topFaceId)!;
			expect(parentBefore.holes).toHaveLength(1);
			const movedParentVertices = [...new Set([parentBefore.outer, ...parentBefore.holes].flatMap((ring) => [...ring]))];
			const parentPointsBefore = new Map(movedParentVertices.map((vertex) => [vertex, meshBefore.positions.slice(vertex * 3, vertex * 3 + 3)]));
			const childCapBefore = vertexPositions(withChild, insetFaceId);

			history.execute(document, journalEntry(buildPushPullFaceEdit(withChild, topFaceId, 0.2, 5)));
			const movedParent = document.snapshot().graph;
			const meshAfter = movedParent.meshes[0]!;
			const parentAfter = meshAfter.faces.find((face) => face.id === topFaceId)!;
			expect(validateEditableSubset(movedParent)).toMatchObject({ editable: true });
			expect([...buildAuthoringTopology(meshAfter).edges.values()].every((edge) => edge.faceIds.length === 2)).toBe(true);
			expect(parentAfter.holes).toHaveLength(1);
			for (const vertex of movedParentVertices) {
				const before = parentPointsBefore.get(vertex)!;
				const after = meshAfter.positions.slice(vertex * 3, vertex * 3 + 3);
				const delta = after.map((value, axis) => value - before[axis]!) as [number, number, number];
				expect(delta[0] * parentBefore.normal[0] + delta[1] * parentBefore.normal[1] + delta[2] * parentBefore.normal[2]).toBeCloseTo(0.2, 12);
			}
			expect(vertexPositions(movedParent, insetFaceId)).toEqual(childCapBefore);
			} finally { document.dispose(); }
		});

	test('extends an upper child box side past the lower slab footprint instead of treating the slab wall as an opposite boundary', () => {
		const { document, history, faceId } = createNeutralRectangle();
		try {
			history.execute(document, journalEntry(buildPushPullFaceEdit(document.snapshot().graph, faceId, 0.55, 2)));
			const slab = document.snapshot().graph;
			const topFaceId = `${DOCUMENT_ID}:op:2:cap`;
			const top = slab.meshes[0]!.faces.find((face) => face.id === topFaceId)!;
			const topPoints = vertexPositions(slab, topFaceId) as [number, number, number][];
			const center = topPoints.reduce(
				(sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]] as [number, number, number],
				[0, 0, 0] as [number, number, number]
			).map((value) => value / topPoints.length) as [number, number, number];
			const insetPoints = topPoints.map((point) => [
				center[0] + (point[0] - center[0]) * 0.46,
				center[1] + (point[1] - center[1]) * 0.46,
				center[2] + (point[2] - center[2]) * 0.46
			] as [number, number, number]);
			const childId = `${DOCUMENT_ID}:face:3`;
			history.execute(document, journalEntry(buildFaceLoopEdit(slab, childId, insetPoints, top.normal)));
			history.execute(document, journalEntry(buildPushPullFaceEdit(document.snapshot().graph, childId, 0.65, 4)));

			const stacked = document.snapshot().graph;
			const upperFront = stacked.meshes[0]!.faces
				.filter((face) => face.id.startsWith(`${DOCUMENT_ID}:op:4:side:`))
				.find((face) => face.normal[2] > 0.9);
			if (!upperFront) throw new Error('Raised child box has no +Z side face for overhang regression.');
			const beforePoints = vertexPositions(stacked, upperFront.id);

			// The upper cube side starts inside the lower slab footprint. Pull it far
			// enough to cross the slab's +Z outer wall; touching only along the shared
			// height boundary must not classify that lower wall as an opposite shell.
			history.execute(document, journalEntry(buildPushPullFaceEdit(stacked, upperFront.id, 1.2, 5)));
			const overhung = document.snapshot().graph;
			const afterPoints = vertexPositions(overhung, upperFront.id);
			for (let index = 0; index < beforePoints.length; index += 1) {
				const before = beforePoints[index]!;
				const moved = afterPoints[index]!;
				const delta = moved.map((value, axis) => value - before[axis]!) as [number, number, number];
				expect(delta[0] * upperFront.normal[0] + delta[1] * upperFront.normal[1] + delta[2] * upperFront.normal[2]).toBeCloseTo(1.2, 12);
			}
				expect(Math.max(...afterPoints.map((point) => point[2]!))).toBeGreaterThan(3);
				const slabTopAfter = overhung.meshes[0]!.faces.find((face) => face.id === topFaceId)!;
				expect(slabTopAfter.holes).toHaveLength(0);
				expect(slabTopAfter.outer.length).toBeGreaterThan(4);
				const underside = overhung.meshes[0]!.faces
					.filter((face) => face.id.startsWith(`${DOCUMENT_ID}:op:5:`) && face.normal[1] < -0.9)
					.flatMap((face) => vertexPositions(overhung, face.id));
				expect(underside.length).toBeGreaterThan(0);
				expect(Math.min(...underside.map((point) => point[2]!))).toBeGreaterThanOrEqual(3 - 1e-12);
				expect(validateEditableSubset(overhung)).toMatchObject({ editable: true });
			expect([...buildAuthoringTopology(overhung.meshes[0]!).edges.values()].every((edge) => edge.faceIds.length === 2)).toBe(true);
		} finally { document.dispose(); }
	});

	test('moves a surrounding side face past its protruding child cap without capping at the prior cube extent', () => {
		const { document, history, faceId } = createNeutralRectangle();
		try {
			history.execute(document, journalEntry(buildPushPullFaceEdit(document.snapshot().graph, faceId, 2.7, 2)));
			const box = document.snapshot().graph;
			const sideFaceId = `${DOCUMENT_ID}:op:2:side:1`;
			const side = box.meshes[0]!.faces.find((face) => face.id === sideFaceId)!;
			const sidePoints = vertexPositions(box, sideFaceId) as [number, number, number][];
			const center = sidePoints.reduce(
				(sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]] as [number, number, number],
				[0, 0, 0] as [number, number, number]
			).map((value) => value / sidePoints.length) as [number, number, number];
			const insetPoints = sidePoints.map((point) => [
				center[0] + (point[0] - center[0]) * 0.35,
				center[1] + (point[1] - center[1]) * 0.35,
				center[2] + (point[2] - center[2]) * 0.35
			] as [number, number, number]);
			const childId = `${DOCUMENT_ID}:face:3`;
			history.execute(document, journalEntry(buildFaceLoopEdit(box, childId, insetPoints, side.normal)));
			history.execute(document, journalEntry(buildPushPullFaceEdit(document.snapshot().graph, childId, 0.6, 4)));

			const withChild = document.snapshot().graph;
			const parentBefore = withChild.meshes[0]!.faces.find((face) => face.id === sideFaceId)!;
			const parentBeforePoints = vertexPositions(withChild, sideFaceId);
			const childBefore = vertexPositions(withChild, childId);

			// Move the surrounding face farther than the child protrusion. This changes
			// the former protrusion into a recess and must not be capped by its old box.
			history.execute(document, journalEntry(buildPushPullFaceEdit(withChild, sideFaceId, 1.0, 5)));
			const after = document.snapshot().graph;
			const parentAfterPoints = vertexPositions(after, sideFaceId);
			for (let index = 0; index < parentBeforePoints.length; index += 1) {
				const before = parentBeforePoints[index]!;
				const moved = parentAfterPoints[index]!;
				const delta = moved.map((value, axis) => value - before[axis]!) as [number, number, number];
				expect(delta[0] * parentBefore.normal[0] + delta[1] * parentBefore.normal[1] + delta[2] * parentBefore.normal[2]).toBeCloseTo(1.0, 12);
			}
			expect(vertexPositions(after, childId)).toEqual(childBefore);
			expect(validateEditableSubset(after)).toMatchObject({ editable: true });
			expect([...buildAuthoringTopology(after.meshes[0]!).edges.values()].every((edge) => edge.faceIds.length === 2)).toBe(true);
		} finally { document.dispose(); }
	});

	test('Push/Pulls the open surrounding parent after its child inset was raised', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Open parent with child' });
		const history = new AuthoringHistory(null);
		try {
			const parentId = `${DOCUMENT_ID}:rectangle:1`;
			const childId = `${DOCUMENT_ID}:face:2`;
			history.execute(document, journalEntry(buildPlanarRectangleEdit(
				document.snapshot().graph,
				parentId,
				[[0, 0, 0], [6, 0, 0], [6, 0, 6], [0, 0, 6]],
				[0, 1, 0]
			)));
			history.execute(document, journalEntry(buildFaceLoopEdit(
				document.snapshot().graph,
				childId,
				[[2, 0, 2], [4, 0, 2], [4, 0, 4], [2, 0, 4]],
				[0, 1, 0]
			)));
			history.execute(document, journalEntry(buildPushPullFaceEdit(document.snapshot().graph, childId, 1.4, 3)));

			const before = document.snapshot().graph;
			const beforeMesh = before.meshes[0]!;
			const parentBefore = beforeMesh.faces.find((face) => face.id === parentId)!;
			const childCapBefore = vertexPositions(before, childId);
			expect(parentBefore.holes).toHaveLength(1);
			const topologyBefore = buildAuthoringTopology(beforeMesh);
			const outerCounts = parentBefore.outer.map((vertex, index) => topologyBefore.edges.get(
				vertex < parentBefore.outer[(index + 1) % parentBefore.outer.length]!
					? `${vertex}:${parentBefore.outer[(index + 1) % parentBefore.outer.length]!}`
					: `${parentBefore.outer[(index + 1) % parentBefore.outer.length]!}:${vertex}`
			)?.faceIds.length ?? 0);
			const hole = parentBefore.holes[0]!;
			const holeCounts = hole.map((vertex, index) => topologyBefore.edges.get(
				vertex < hole[(index + 1) % hole.length]!
					? `${vertex}:${hole[(index + 1) % hole.length]!}`
					: `${hole[(index + 1) % hole.length]!}:${vertex}`
			)?.faceIds.length ?? 0);
			expect(outerCounts).toEqual([1, 1, 1, 1]);
			expect(holeCounts).toEqual([2, 2, 2, 2]);

			history.execute(document, journalEntry(buildPushPullFaceEdit(before, parentId, 0.35, 4)));
			const after = document.snapshot().graph;
			const afterMesh = after.meshes[0]!;
			const parentAfter = afterMesh.faces.find((face) => face.id === parentId)!;
			expect(validateEditableSubset(after)).toMatchObject({ editable: true });
			expect(parentAfter.holes).toHaveLength(1);
			for (const vertex of [...parentAfter.outer, ...parentAfter.holes[0]!]) {
				expect(afterMesh.positions[vertex * 3 + 1]).toBeCloseTo(0.35, 12);
			}
			expect(vertexPositions(after, childId)).toEqual(childCapBefore);
			expect(afterMesh.faces.filter((face) => face.id.startsWith(`${DOCUMENT_ID}:op:4:side:`))).toHaveLength(4);
			} finally { document.dispose(); }
		});

	test('moves a flat surrounding parent without dragging its nested child face', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Flat nested parent' });
		const history = new AuthoringHistory(null);
		try {
			const parentId = `${DOCUMENT_ID}:rectangle:1`;
			const childId = `${DOCUMENT_ID}:face:2`;
			history.execute(document, journalEntry(buildPlanarRectangleEdit(
				document.snapshot().graph,
				parentId,
				[[0, 0, 0], [6, 0, 0], [6, 0, 6], [0, 0, 6]],
				[0, 1, 0]
			)));
			history.execute(document, journalEntry(buildFaceLoopEdit(
				document.snapshot().graph,
				childId,
				[[2, 0, 2], [4, 0, 2], [4, 0, 4], [2, 0, 4]],
				[0, 1, 0]
			)));

			const split = document.snapshot().graph;
			const childBefore = vertexPositions(split, childId);
			history.execute(document, journalEntry(buildPushPullFaceEdit(split, parentId, 1.0, 3)));

			const raisedParent = document.snapshot().graph;
			const parentAfter = raisedParent.meshes[0]!.faces.find((face) => face.id === parentId)!;
			expect(parentAfter.outer.map((vertex) => raisedParent.meshes[0]!.positions[vertex * 3 + 1]!)).toEqual([1, 1, 1, 1]);
			expect(parentAfter.holes).toHaveLength(1);
			expect(parentAfter.holes[0]!.map((vertex) => raisedParent.meshes[0]!.positions[vertex * 3 + 1]!)).toEqual([1, 1, 1, 1]);
			expect(vertexPositions(raisedParent, childId)).toEqual(childBefore);
			expect(validateEditableSubset(raisedParent)).toMatchObject({ editable: true });
		} finally { document.dispose(); }
	});

	test('lets a nested child return to the surrounding level and then continue above it', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Nested level transition' });
		const history = new AuthoringHistory(null);
		try {
			const parentId = `${DOCUMENT_ID}:rectangle:1`;
			const childId = `${DOCUMENT_ID}:face:2`;
			history.execute(document, journalEntry(buildPlanarRectangleEdit(
				document.snapshot().graph,
				parentId,
				[[0, 0, 0], [6, 0, 0], [6, 0, 6], [0, 0, 6]],
				[0, 1, 0]
			)));
			history.execute(document, journalEntry(buildFaceLoopEdit(
				document.snapshot().graph,
				childId,
				[[2, 0, 2], [4, 0, 2], [4, 0, 4], [2, 0, 4]],
				[0, 1, 0]
			)));
			history.execute(document, journalEntry(buildPushPullFaceEdit(document.snapshot().graph, parentId, 1.0, 3)));

			const recessed = document.snapshot().graph;
			history.execute(document, journalEntry(buildPushPullFaceEdit(recessed, childId, 1.0, 4)));
			const level = document.snapshot().graph;
			const parentLevel = vertexPositions(level, parentId)[0]![1]!;
			expect(vertexPositions(level, childId).every((point) => Math.abs(point[1]! - parentLevel) < 1e-12)).toBe(true);
			expect(validateEditableSubset(level)).toMatchObject({ editable: true });

			history.execute(document, journalEntry(buildPushPullFaceEdit(level, childId, 0.5, 5)));
			const protruded = document.snapshot().graph;
			expect(vertexPositions(protruded, childId).every((point) => Math.abs(point[1]! - 1.5) < 1e-12)).toBe(true);
			expect(validateEditableSubset(protruded)).toMatchObject({ editable: true });
		} finally { document.dispose(); }
	});

	test('pulls a side inset past a disjoint parallel reveal while still respecting the true opposite shell boundary', () => {
		const { document, history, faceId } = createNeutralRectangle();
		try {
			history.execute(document, journalEntry(buildPushPullFaceEdit(document.snapshot().graph, faceId, 2.7, 2)));

			const box = document.snapshot().graph;
			const topFaceId = `${DOCUMENT_ID}:op:2:cap`;
			const top = box.meshes[0]!.faces.find((face) => face.id === topFaceId)!;
			const topPoints = vertexPositions(box, topFaceId) as [number, number, number][];
			const topCenter = topPoints.reduce(
				(sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]] as [number, number, number],
				[0, 0, 0] as [number, number, number]
			).map((value) => value / topPoints.length) as [number, number, number];
			const topInset = topPoints.map((point) => [
				topCenter[0] + (point[0] - topCenter[0]) * 0.45,
				topCenter[1] + (point[1] - topCenter[1]) * 0.45,
				topCenter[2] + (point[2] - topCenter[2]) * 0.45
			] as [number, number, number]);
			const topInsetId = `${DOCUMENT_ID}:face:3`;
			history.execute(document, journalEntry(buildFaceLoopEdit(box, topInsetId, topInset, top.normal)));
			history.execute(document, journalEntry(buildPushPullFaceEdit(document.snapshot().graph, topInsetId, 0.35, 4)));

			const withTopReveal = document.snapshot().graph;
			const frontFaceId = `${DOCUMENT_ID}:op:2:side:1`;
			const front = withTopReveal.meshes[0]!.faces.find((face) => face.id === frontFaceId)!;
			const frontPoints = vertexPositions(withTopReveal, frontFaceId) as [number, number, number][];
			const frontCenter = frontPoints.reduce(
				(sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]] as [number, number, number],
				[0, 0, 0] as [number, number, number]
			).map((value) => value / frontPoints.length) as [number, number, number];
			const sideInset = frontPoints.map((point) => [
				frontCenter[0] + (point[0] - frontCenter[0]) * 0.38,
				frontCenter[1] + (point[1] - frontCenter[1]) * 0.38,
				frontCenter[2] + (point[2] - frontCenter[2]) * 0.38
			] as [number, number, number]);
			const sideInsetId = `${DOCUMENT_ID}:face:5`;
				history.execute(document, journalEntry(buildFaceLoopEdit(withTopReveal, sideInsetId, sideInset, front.normal)));

				const splitSide = document.snapshot().graph;
				const splitMesh = splitSide.meshes[0]!;
				const driftedSplit = {
					...splitSide,
					meshes: [{
						...splitMesh,
						faces: splitMesh.faces.map((face) => face.id === sideInsetId
							? { ...face, normal: [0, -4e-15, 1] as [number, number, number] }
							: face)
					}]
				};
				expect(validateEditableSubset(driftedSplit)).toMatchObject({ editable: true });
				const validPocket = buildPushPullFaceEdit(driftedSplit, sideInsetId, -1.0, 6);
				const putMesh = validPocket.forward.find((edit) => edit.type === 'put-mesh');
				if (!putMesh || putMesh.type !== 'put-mesh') throw new Error('Inset Push/Pull did not publish a canonical mesh replacement.');
				const recessed = { ...driftedSplit, meshes: [putMesh.value] };
				expect(validateEditableSubset(recessed)).toMatchObject({ editable: true });
				expect(recessed.meshes[0]!.faces.find((face) => face.id === sideInsetId)).toBeDefined();
				expect(() => buildPushPullFaceEdit(driftedSplit, sideInsetId, -3.0, 6)).toThrow(/cross|collapse/i);
			} finally { document.dispose(); }
		});
});
