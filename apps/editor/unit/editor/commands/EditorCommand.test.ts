import { describe, expect, test } from 'bun:test';
import { EditableGeometryStore } from '../../../src/lib/editor/EditableGeometryStore';
import { createPlane, createRectangle, extrudeFace } from '../../../src/lib/editor/geometry/editable-geometry';
import { CommandHistory, CreateShapeCommand, PushPullCommand } from '../../../src/lib/editor/commands/EditorCommand';

describe('editor command history', () => {
	test('creates, undoes, and redoes a rectangle', () => {
		const store = new EditableGeometryStore();
		const history = new CommandHistory();
		const face = createRectangle('editable-face-1', createPlane([0, 0, 0], [0, 1, 0]), [0, 0, 0], [2, 0, 3]);

		history.execute(new CreateShapeCommand(store, face));
		expect(store.get(face.id)?.kind).toBe('face');
		expect(history.undo()).toBe(true);
		expect(store.get(face.id)).toBeUndefined();
		expect(history.redo()).toBe(true);
		expect(store.get(face.id)?.kind).toBe('face');
	});

	test('push/pull undo restores the original face and redo restores extrusion', () => {
		const store = new EditableGeometryStore();
		const history = new CommandHistory();
		const face = createRectangle('editable-face-2', createPlane([0, 0, 0], [0, 1, 0]), [0, 0, 0], [2, 0, 3]);
		store.set(face);
		const extrusion = extrudeFace(face, 1.5)!;

		history.execute(new PushPullCommand(store, extrusion));
		expect(store.get(face.id)?.kind).toBe('extrusion');
		expect(history.undo()).toBe(true);
		expect(store.get(face.id)?.kind).toBe('face');
		expect(history.redo()).toBe(true);
		expect(store.get(face.id)?.kind).toBe('extrusion');
	});
});
