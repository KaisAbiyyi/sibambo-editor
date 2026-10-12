import { describe, expect, test } from 'bun:test';
import { BomcDocument } from '@sibambo/bomc-document/document';
import {
	buildPlanarRectangleEdit,
	buildRectangleEdit,
	buildPushPullFaceEdit,
	journalEntry,
} from '../../src/lib/authoring/geometry.js';
import { AuthoringHistory, validateAuthoringCheckpoint } from '../../src/lib/authoring/history.js';
import {
	buildModelEdit,
	contextGraph,
	nextModelSequence,
	validateAuthoringDocument,
	modelMetadata,
} from '../../src/lib/authoring/model.js';
import type { ModelAction } from '../../src/lib/authoring/protocol.js';
import { parseLength } from '../../src/lib/authoring/dimensions.js';
import { projectAuthoringScene } from '../../src/lib/authoring/scene.js';

const ID = '6120c783-9aa5-4b1b-af99-72a16f789154';
function setup() {
	const doc = BomcDocument.create({ documentId: ID, name: 'Model editing' });
	const history = new AuthoringHistory(null);
	const faceId = `${ID}:rectangle:1`;
	history.execute(
		doc,
		journalEntry(
			buildPlanarRectangleEdit(
				doc.snapshot().graph,
				faceId,
				[
					[0, 0, 0],
					[4, 0, 0],
					[4, 0, 3],
					[0, 0, 3],
				],
				[0, 1, 0],
			),
		),
	);
	return {
		doc,
		history,
		faceId,
		run(action: ModelAction, path: readonly string[] = []) {
			const edit = buildModelEdit(doc.snapshot().graph, path, action, nextModelSequence(doc.snapshot().graph));
			history.execute(doc, journalEntry(edit));
			return edit.entityId;
		},
	};
}

describe('canonical model editing', () => {
	test('Explode separates nested Groups from a remaining shared Component instance', () => {
		const s = setup();
		try {
			const group = s.run({
				type: 'group',
				selection: [{ type: 'face', id: s.faceId }],
				containerKind: 'group',
				name: 'Nested Group',
			});
			const component = s.run({
				type: 'group',
				selection: [{ type: 'instance', id: group }],
				containerKind: 'component',
				name: 'Assembly',
			});
			s.run({
				type: 'transform',
				selection: [{ type: 'instance', id: component }],
				delta: [5, 0, 0],
				copy: true,
				count: 1,
				spacing: 'multiply',
				radial: null,
			});
			s.run({ type: 'explode', instanceId: component });
			const graph = s.doc.snapshot().graph,
				groups = graph.instances.filter((i) => i.kind === 'group');
			expect(groups).toHaveLength(2);
			expect(new Set(groups.map((i) => i.definitionId)).size).toBe(2);
			expect(validateAuthoringDocument(graph).editable).toBe(true);
		} finally {
			s.doc.dispose();
		}
	});
	test('model admission rejects foreign metadata and projective transforms; altered container journals cannot replay', () => {
		const s = setup();
		try {
			s.run({ type: 'group', containerKind: 'component', name: 'Owned', selection: [{ type: 'face', id: s.faceId }] });
			const graph = s.doc.snapshot().graph,
				projective = structuredClone(graph);
			(projective.instances.find((i) => i.kind === 'component')!.matrix as number[])[3] = 0.1;
			expect(validateAuthoringDocument(projective).editable).toBe(false);
			const foreign = structuredClone(graph);
			foreign.instances.find((i) => i.kind === 'root')!.label = JSON.stringify({
				schema: 'sibambo-editor-model-v1',
				guides: [
					{ id: ID + ':guide:op:3:1', ownerDefinitionId: 'missing', start: [0, 0, 0], end: [1, 0, 0], kind: 'line' },
				],
				looseEdges: [],
			});
			expect(validateAuthoringDocument(foreign).editable).toBe(false);
			const checkpoint = {
				snapshot: s.doc.snapshot(),
				sequence: nextModelSequence(graph),
				history: s.history.checkpoint(),
			};
			expect(() => validateAuthoringCheckpoint(checkpoint, { replayHistory: true })).not.toThrow();
			const corrupt = structuredClone(checkpoint),
				inverse = corrupt.history.undo.at(-1)!.inverse.find((edit) => edit.type === 'put-mesh');
			if (!inverse || inverse.type !== 'put-mesh') throw new Error('Expected inverse root mesh.');
			(inverse.value.positions as number[])[0] = 100;
			expect(() => validateAuthoringCheckpoint(corrupt, { replayHistory: true })).toThrow();
		} finally {
			s.doc.dispose();
		}
	});
	test('drawing into an empty context never recolors legacy geometry in another container', () => {
		const doc = BomcDocument.create({ documentId: ID, name: 'Legacy' });
		try {
			doc.transact(buildRectangleEdit(doc.snapshot().graph, ID + ':rectangle:1', [0, 0, 0], [2, 0, 2]).forward);
			const legacy = structuredClone(doc.snapshot().graph.materials[0]!);
			doc.transact(
				buildModelEdit(
					doc.snapshot().graph,
					[],
					{
						type: 'group',
						containerKind: 'group',
						name: 'Old',
						selection: [{ type: 'face', id: ID + ':rectangle:1' }],
					},
					2,
				).forward,
			);
			doc.transact(
				buildModelEdit(
					doc.snapshot().graph,
					[],
					{
						type: 'raw',
						command: {
							kind: 'CREATE_RECTANGLE',
							points: [
								[4, 0, 0],
								[6, 0, 0],
								[6, 0, 2],
								[4, 0, 2],
							],
							normal: [0, 1, 0],
						},
					},
					3,
				).forward,
			);
			expect(doc.snapshot().graph.materials.find((m) => m.id === legacy.id)).toEqual(legacy);
			expect(doc.snapshot().graph.materials).toHaveLength(2);
			expect(validateAuthoringDocument(doc.snapshot().graph).editable).toBe(true);
		} finally {
			doc.dispose();
		}
	});
	test('Offset keeps uniform thickness on a concave floor plan and on a face with multiple openings', () => {
		const s = setup();
		try {
			s.run({
				type: 'raw',
				command: {
					kind: 'CREATE_FACE_LOOP',
					points: [
						[8, 0, 0],
						[13, 0, 0],
						[13, 0, 2],
						[10, 0, 2],
						[10, 0, 5],
						[8, 0, 5],
					],
					normal: [0, 1, 0],
				},
			});
			let graph = s.doc.snapshot().graph;
			const irregular = graph.meshes[0]!.faces.find((f) => f.id !== s.faceId)!;
			const inner = s.run({ type: 'offset', faceId: irregular.id, distance: 0.2 });
			graph = s.doc.snapshot().graph;
			const mesh = graph.meshes[0]!,
				loop = mesh.faces.find((f) => f.id === inner)!;
			expect(new Set(loop.outer.map((v) => mesh.positions[v * 3]))).toEqual(new Set([8.2, 9.8, 12.8]));
			s.run({
				type: 'raw',
				command: {
					kind: 'CREATE_RECTANGLE',
					points: [
						[0.5, 0, 0.5],
						[1.1, 0, 0.5],
						[1.1, 0, 1.1],
						[0.5, 0, 1.1],
					],
					normal: [0, 1, 0],
				},
			});
			s.run({
				type: 'raw',
				command: {
					kind: 'CREATE_RECTANGLE',
					points: [
						[2, 0, 1.5],
						[2.6, 0, 1.5],
						[2.6, 0, 2.1],
						[2, 0, 2.1],
					],
					normal: [0, 1, 0],
				},
			});
			expect(s.doc.snapshot().graph.meshes[0]!.faces.find((f) => f.id === s.faceId)!.holes).toHaveLength(2);
			s.run({ type: 'offset', faceId: s.faceId, distance: 0.1 });
			expect(validateAuthoringDocument(s.doc.snapshot().graph).editable).toBe(true);
		} finally {
			s.doc.dispose();
		}
		const outward = setup();
		try {
			outward.run({
				type: 'raw',
				command: {
					kind: 'CREATE_RECTANGLE',
					points: [
						[1, 0, 1],
						[2, 0, 1],
						[2, 0, 2],
						[1, 0, 2],
					],
					normal: [0, 1, 0],
				},
			});
			outward.run({ type: 'offset', faceId: outward.faceId, distance: -0.1 });
			expect(validateAuthoringDocument(outward.doc.snapshot().graph).editable).toBe(true);
		} finally {
			outward.doc.dispose();
		}
	});
	test('Eraser heals a coplanar inset border and edge-only Copy retains an independent wire', () => {
		const s = setup();
		try {
			const inner = s.run({ type: 'offset', faceId: s.faceId, distance: 0.2 }),
				graph = s.doc.snapshot().graph,
				mesh = graph.meshes[0]!,
				face = mesh.faces.find((f) => f.id === inner)!;
			const vertex = (i: number) => mesh.positions.slice(i * 3, i * 3 + 3) as [number, number, number];
			const edge = { type: 'edge' as const, start: vertex(face.outer[0]!), end: vertex(face.outer[1]!) };
			s.run({
				type: 'transform',
				selection: [edge],
				delta: [0, 3, 0],
				copy: true,
				count: 1,
				spacing: 'multiply',
				radial: null,
			});
			expect(modelMetadata(s.doc.snapshot().graph).looseEdges).toHaveLength(1);
			s.run({ type: 'erase', selection: [edge] });
			expect(s.doc.snapshot().graph.meshes[0]!.faces).toHaveLength(1);
			expect(s.doc.snapshot().graph.meshes[0]!.faces[0]!.holes).toHaveLength(0);
		} finally {
			s.doc.dispose();
		}
	});
	test('length input preserves exact metric/imperial scale and rejects incomplete/nonfinite text', () => {
		expect(parseLength('250mm')).toBe(0.25);
		expect(parseLength('12in')).toBeCloseTo(0.3048, 12);
		expect(parseLength('5\' 6"')).toBeCloseTo(1.6764, 12);
		expect(parseLength('-3.5cm')).toBe(-0.035);
		for (const value of ['', '1e', 'Infinity', '1cm extra']) expect(() => parseLength(value)).toThrow();
	});
	test('Group copies are independent, divided/radial arrays use the original transform, and nested Explode preserves world geometry', () => {
		const s = setup();
		try {
			const id = s.run({
				type: 'group',
				selection: [{ type: 'face', id: s.faceId }],
				containerKind: 'group',
				name: 'Panel',
			});
			s.run({
				type: 'transform',
				selection: [{ type: 'instance', id }],
				delta: [6, 0, 0],
				copy: true,
				count: 3,
				spacing: 'divide',
				radial: null,
			});
			let graph = s.doc.snapshot().graph;
			const children = graph.instances.filter((i) => i.kind === 'group');
			expect(children.map((i) => i.matrix[12]).sort()).toEqual([0, 2, 4, 6]);
			expect(new Set(children.map((i) => i.definitionId)).size).toBe(4);
			const nested = s.run({
				type: 'group',
				selection: [{ type: 'instance', id }],
				containerKind: 'group',
				name: 'Nested',
			});
			s.run({
				type: 'transform',
				selection: [{ type: 'instance', id: nested }],
				delta: [0, 0, 0],
				copy: true,
				count: 2,
				spacing: 'multiply',
				radial: { axis: 'y', pivot: [0, 0, 0], angleDegrees: 90 },
			});
			graph = s.doc.snapshot().graph;
			expect(graph.instances.filter((i) => i.ownerDefinitionId === graph.rootDefinitionId)).toHaveLength(6);
			s.run({ type: 'explode', instanceId: nested });
			expect(validateAuthoringDocument(s.doc.snapshot().graph).editable).toBe(true);
		} finally {
			s.doc.dispose();
		}
	});
	test('raw face copy, outward Offset, and projection include canonical container transforms', () => {
		const s = setup();
		try {
			s.run({
				type: 'transform',
				selection: [{ type: 'face', id: s.faceId }],
				delta: [8, 0, 0],
				copy: true,
				count: 1,
				spacing: 'multiply',
				radial: null,
			});
			expect(s.doc.snapshot().graph.meshes[0]!.faces).toHaveLength(2);
			s.run({ type: 'offset', faceId: s.faceId, distance: -0.2 });
			expect(s.doc.snapshot().graph.meshes[0]!.faces).toHaveLength(3);
			const id = s.run({
				type: 'group',
				selection: s.doc.snapshot().graph.meshes[0]!.faces.map((f) => ({ type: 'face' as const, id: f.id })),
				containerKind: 'component',
				name: 'Geometry',
			});
			s.run({
				type: 'transform',
				selection: [{ type: 'instance', id }],
				delta: [20, 0, 0],
				copy: false,
				count: 1,
				spacing: 'multiply',
				radial: null,
			});
			const projected = projectAuthoringScene(s.doc.snapshot(), { faceStyle: 'shaded-textures' } as never);
			expect(projected.bounds.min.x).toBeCloseTo(19.8, 10);
			expect(projected.bounds.max.x).toBe(32);
			projected.group.traverse((object) => {
				const render = object as any;
				render.geometry?.dispose();
				if (Array.isArray(render.material)) render.material.forEach((m: any) => m.dispose());
				else render.material?.dispose();
			});
		} finally {
			s.doc.dispose();
		}
	});
	test('Group isolates selected connected faces, shared Component copies edit together, Make Unique separates, and Undo restores exact graph', () => {
		const s = setup();
		try {
			s.history.execute(s.doc, journalEntry(buildPushPullFaceEdit(s.doc.snapshot().graph, s.faceId, 2, 2)));
			const before = s.doc.snapshot().graph;
			const selection = before.meshes[0]!.faces.map((f) => ({ type: 'face' as const, id: f.id }));
			const instanceId = s.run({ type: 'group', selection, containerKind: 'component', name: 'Cabinet' });
			expect(s.doc.snapshot().graph.instances).toHaveLength(2);
			expect(contextGraph(s.doc.snapshot().graph, []).meshes).toHaveLength(0);
			expect(contextGraph(s.doc.snapshot().graph, [instanceId]).meshes[0]!.faces).toHaveLength(6);
			expect(s.history.undo(s.doc)).toBe(true);
			expect(s.doc.snapshot().graph).toEqual(before);
			expect(s.history.redo(s.doc)).toBe(true);
			s.run({
				type: 'transform',
				selection: [{ type: 'instance', id: instanceId }],
				delta: [5, 0, 0],
				copy: true,
				count: 2,
				spacing: 'multiply',
				radial: null,
			});
			const graph = s.doc.snapshot().graph;
			const children = graph.instances.filter((i) => i.kind !== 'root');
			expect(children).toHaveLength(3);
			expect(new Set(children.map((i) => i.definitionId)).size).toBe(1);
			expect(children.map((i) => i.matrix[12]).sort((a, b) => a! - b!)).toEqual([0, 5, 10]);
			const cap = contextGraph(graph, [instanceId]).meshes[0]!.faces.find((f) => f.normal[1] === 1)!;
			s.run({ type: 'raw', command: { kind: 'PUSH_PULL_FACE', faceId: cap.id, distance: 0.5 } }, [instanceId]);
			expect(contextGraph(s.doc.snapshot().graph, [children[1]!.id]).meshes[0]!.positions).toContain(2.5);
			s.run({ type: 'unique', instanceId: children[1]!.id });
			expect(
				new Set(
					s.doc
						.snapshot()
						.graph.instances.filter((i) => i.kind !== 'root')
						.map((i) => i.definitionId),
				).size,
			).toBe(2);
			expect(validateAuthoringDocument(s.doc.snapshot().graph)).toMatchObject({ editable: true });
		} finally {
			s.doc.dispose();
		}
	});

	test('inward Offset preserves source footprint and creates an editable inner face; invalid collapse is atomic', () => {
		const s = setup();
		try {
			const inner = s.run({ type: 'offset', faceId: s.faceId, distance: 0.2 });
			const graph = s.doc.snapshot().graph,
				mesh = graph.meshes[0]!;
			expect(mesh.faces.find((f) => f.id === s.faceId)!.holes).toHaveLength(1);
			expect(
				mesh.faces
					.find((f) => f.id === inner)!
					.outer.map((i) => mesh.positions.slice(i * 3, i * 3 + 3))
					.sort(),
			).toEqual(
				[
					[0.2, 0, 0.2],
					[0.2, 0, 2.8],
					[3.8, 0, 0.2],
					[3.8, 0, 2.8],
				].sort(),
			);
			expect(() => s.run({ type: 'offset', faceId: inner, distance: 2 })).toThrow();
			expect(s.doc.snapshot().graph).toEqual(graph);
			s.run({ type: 'raw', command: { kind: 'PUSH_PULL_FACE', faceId: s.faceId, distance: 2.7 } });
			expect(validateAuthoringDocument(s.doc.snapshot().graph)).toMatchObject({ editable: true });
		} finally {
			s.doc.dispose();
		}
	});

	test('face erase preserves boundary wires; persistent guides survive canonical history', () => {
		const s = setup();
		try {
			s.run({ type: 'guide', start: [0, 0, 0], end: [4, 0, 0], guideKind: 'line' });
			s.run({ type: 'erase', selection: [{ type: 'face', id: s.faceId }] });
			expect(contextGraph(s.doc.snapshot().graph, []).meshes).toHaveLength(0);
			expect(modelMetadata(s.doc.snapshot().graph).looseEdges).toHaveLength(4);
			expect(modelMetadata(s.doc.snapshot().graph).guides).toHaveLength(1);
			expect(s.history.undo(s.doc)).toBe(true);
			expect(contextGraph(s.doc.snapshot().graph, []).meshes[0]!.faces).toHaveLength(1);
		} finally {
			s.doc.dispose();
		}
	});
});
