import { describe, expect, test } from 'bun:test';
import { DoubleSide, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial } from 'three';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { DEFAULT_DISPLAY_STATE, sourceEdgeMaterialDescriptor, type DisplayState } from '@sibambo/viewport';
import { buildExtrusionEdit, buildPlanarRectangleEdit, buildRectangleEdit } from '../../src/lib/authoring/geometry.js';
import { projectAuthoringScene } from '../../src/lib/authoring/scene.js';

const DOCUMENT_ID = 'a4f2d141-64e1-4c62-8d0d-53623f71a220';

function disposeProjection(group: ReturnType<typeof projectAuthoringScene>['group']) {
	group.traverse((object) => {
		const drawable = object as typeof object & { geometry?: { dispose(): void }; material?: { dispose(): void } | Array<{ dispose(): void }> };
		drawable.geometry?.dispose();
		if (Array.isArray(drawable.material)) for (const material of drawable.material) material.dispose();
		else drawable.material?.dispose();
	});
}

describe('canonical authoring projection', () => {
	test('keeps canonical numbers intact and converts them only into dedicated render buffers', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		try {
			const first = [0.123456789012345, 0, 0.234567890123456] as const;
			const opposite = [1.987654321098765, 0, 2.345678901234567] as const;
			document.transact(buildRectangleEdit(document.snapshot().graph, `${DOCUMENT_ID}:rectangle:1`, first, opposite).forward);
			const snapshot = document.snapshot();
			const projection = projectAuthoringScene(snapshot, DEFAULT_DISPLAY_STATE);
			try {
				const faceMesh = projection.group.children.find((child) => child instanceof Mesh) as Mesh;
				const edges = projection.group.children.find((child) => child instanceof LineSegments) as LineSegments;
				const position = faceMesh.geometry.getAttribute('position');
				expect(position.array).toBeInstanceOf(Float32Array);
				expect(position.array[0]).toBe(Math.fround(first[0]));
				expect(snapshot.graph.meshes[0]!.positions[0]).toBe(first[0]);
				expect(snapshot.graph.meshes[0]!.positions[0]).not.toBe(position.array[0]);
				expect(faceMesh.geometry.index?.array).toEqual(new Uint16Array([0, 1, 2, 0, 2, 3]));
				expect(faceMesh.userData).toMatchObject({
					authoringFaceId: `${DOCUMENT_ID}:rectangle:1`,
					authoringEntityId: `${DOCUMENT_ID}:rectangle:1`,
					authoringKind: 'rectangle'
				});
				expect((faceMesh.material as MeshStandardMaterial).color.getHexString()).toBe('9b1c31');
				expect((faceMesh.material as MeshStandardMaterial).side).toBe(DoubleSide);
				expect((faceMesh.material as MeshStandardMaterial).roughness).toBe(0.88);
				expect((faceMesh.material as MeshStandardMaterial).metalness).toBe(0.02);
				expect(edges.geometry.getAttribute('position').count).toBe(8);
				expect(projection.bounds).toEqual({
					min: { x: first[0], y: 0, z: first[2] },
					max: { x: opposite[0], y: 0, z: opposite[2] }
				});
			} finally { disposeProjection(projection.group); }
		} finally { document.dispose(); }
	});

	test('projects signed prism faces and keeps every face material and geometry dedicated', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		try {
			const entityId = `${DOCUMENT_ID}:rectangle:1`;
			document.transact(buildRectangleEdit(document.snapshot().graph, entityId, [0, 0, 0], [2, 0, 3]).forward);
			document.transact(buildExtrusionEdit(document.snapshot().graph, entityId, 2.7).forward);
			const projection = projectAuthoringScene(document.snapshot(), DEFAULT_DISPLAY_STATE);
			try {
				const faces = projection.group.children.filter((child) => child instanceof Mesh) as Mesh[];
				expect(faces).toHaveLength(6);
				expect(new Set(faces.map((face) => face.geometry)).size).toBe(6);
				expect(new Set(faces.map((face) => face.material)).size).toBe(6);
				expect(faces.find((face) => face.name === `${entityId}:side:0`)?.userData.authoringEntityId).toBe(entityId);
				expect(projection.bounds).toEqual({ min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2.7, z: 3 } });
			} finally { disposeProjection(projection.group); }
		} finally { document.dispose(); }
	});

	test('projects new v2 faces with neutral material while preserving legacy maroon v1 faces', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		try {
			document.transact(buildRectangleEdit(document.snapshot().graph, `${DOCUMENT_ID}:rectangle:1`, [0, 0, 0], [2, 0, 2]).forward);
			document.transact(buildPlanarRectangleEdit(
				document.snapshot().graph,
				`${DOCUMENT_ID}:rectangle:2`,
				[[4, 0, 0], [6, 0, 0], [6, 0, 2], [4, 0, 2]],
				[0, 1, 0]
			).forward);
			const projection = projectAuthoringScene(document.snapshot(), DEFAULT_DISPLAY_STATE);
			try {
				const faces = projection.group.children.filter((child) => child instanceof Mesh) as Mesh[];
				const legacy = faces.find((face) => face.name === `${DOCUMENT_ID}:rectangle:1`)!;
				const neutral = faces.find((face) => face.name === `${DOCUMENT_ID}:rectangle:2`)!;
				expect((legacy.material as MeshStandardMaterial).color.getHexString()).toBe('9b1c31');
				expect((neutral.material as MeshStandardMaterial).color.getHexString()).toBe('e2e2e2');
			} finally { disposeProjection(projection.group); }
		} finally { document.dispose(); }
	});

	test('uses viewport edge policy and hides only face meshes in wireframe', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		try {
			document.transact(buildRectangleEdit(document.snapshot().graph, `${DOCUMENT_ID}:rectangle:1`, [0, 0, 0], [2, 0, 3]).forward);
			const wireframe: DisplayState = { faceStyle: 'wireframe', effects: { xray: false, ambientOcclusion: false } };
			const projection = projectAuthoringScene(document.snapshot(), wireframe);
			try {
				const faceMesh = projection.group.children.find((child) => child instanceof Mesh) as Mesh;
				const edges = projection.group.children.find((child) => child instanceof LineSegments) as LineSegments;
				expect(faceMesh.visible).toBe(false);
				expect(edges.visible).toBe(true);
				expect(edges.material).toBeInstanceOf(LineBasicMaterial);
				expect((edges.material as LineBasicMaterial).toneMapped).toBe(false);
				expect((edges.material as LineBasicMaterial).opacity).toBe(sourceEdgeMaterialDescriptor(wireframe).opacity);
			} finally { disposeProjection(projection.group); }
		} finally { document.dispose(); }
	});

	test('uses the exact canonical empty bounds and rejects unsupported authoring graphs', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		try {
			const empty = projectAuthoringScene(document.snapshot(), DEFAULT_DISPLAY_STATE);
			expect(empty.group.children).toHaveLength(0);
			expect(empty.bounds).toEqual({ min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 3, z: 5 } });
			const entityId = `${DOCUMENT_ID}:rectangle:1`;
			document.transact(buildRectangleEdit(document.snapshot().graph, entityId, [0, 0, 0], [2, 0, 3]).forward);
			const graph = document.snapshot().graph;
			const mesh = graph.meshes[0]!;
			document.transact([{ type: 'put-mesh', value: {
				...mesh,
				faces: mesh.faces.map((face) => ({ ...face, label: 'not-an-authoring-label' }))
			} }]);
			expect(() => projectAuthoringScene(document.snapshot(), DEFAULT_DISPLAY_STATE)).toThrow();
		} finally { document.dispose(); }
	});
});
