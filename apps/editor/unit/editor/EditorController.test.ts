import { describe, expect, test } from 'bun:test';
import { EditableGeometryStore } from '../../src/lib/editor/EditableGeometryStore';
import { EditorController } from '../../src/lib/editor/EditorController';
import type { EditorSelectionHit } from '../../src/lib/editor/EditorState';
import { createPlane } from '../../src/lib/editor/geometry/editable-geometry';

describe('EditorController cancellation', () => {
	test('Escape-style cancellation clears a pending rectangle without committing', () => {
		const store = new EditableGeometryStore();
		const controller = new EditorController(store);
		controller.setTool('rectangle');
		controller.click(hit([0, 0, 0]), 100);
		controller.move(hit([2, 0, 3]), 80);
		expect(controller.preview.entity?.kind).toBe('face');

		controller.cancel();
		expect(controller.preview.entity).toBeNull();
		expect(store.size).toBe(0);
	});
});

function hit(point: [number, number, number]): EditorSelectionHit {
	const plane = createPlane([0, 0, 0], [0, 1, 0], [1, 0, 0]);
	return {
		point,
		plane,
		face: { id: 'ground', kind: 'face', shape: 'derived', plane, outer: [], holes: [], color: '#9b1c31' },
		distance: 1,
		imported: false
	};
}
