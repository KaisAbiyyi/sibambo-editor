import { describe, expect, test } from 'bun:test';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Scene } from 'three';
import { EditableGeometryStore } from '../../src/lib/editor/EditableGeometryStore';
import { EditorRuntime } from '../../src/lib/editor/EditorRuntime';
import { createPlane, createRectangle, extrudeFace } from '../../src/lib/editor/geometry/editable-geometry';

describe('editable runtime isolation', () => {
	test('shape and push/pull updates leave imported shared geometry untouched', () => {
		const scene = new Scene();
		const imported = new Group();
		imported.name = 'ImportedBuildingLayer';
		const importedGeometry = new BoxGeometry(1, 1, 1);
		const importedMesh = new Mesh(importedGeometry, new MeshBasicMaterial());
		imported.add(importedMesh);
		scene.add(imported);
		const position = importedGeometry.getAttribute('position');
		const importedChildren = imported.children.length;

		const store = new EditableGeometryStore();
		const runtime = new EditorRuntime(store, () => {});
		scene.add(runtime.root, runtime.overlay);
		const plane = createPlane([0, 0, 0], [0, 1, 0]);
		const face = createRectangle('editable-face', plane, [0, 0, 0], [2, 0, 2]);
		store.set(face);
		store.set(extrudeFace(face, 1)!);
		runtime.setPreview(extrudeFace(face, 2), null);

		expect(imported.children).toHaveLength(importedChildren);
		expect(importedMesh.geometry).toBe(importedGeometry);
		expect(importedGeometry.getAttribute('position')).toBe(position);
		expect(runtime.stats().entityCount).toBe(1);
		runtime.dispose();
		importedGeometry.dispose();
		(importedMesh.material as MeshBasicMaterial).dispose();
	});
});
