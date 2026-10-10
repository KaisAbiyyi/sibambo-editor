import { describe, expect, test } from 'bun:test';
import { Mesh, Object3D, Ray, Vector3 } from 'three';
import { BomcDocument } from '@sibambo/bomc-document/document';
import type { PreparedSceneViewport } from '@sibambo/viewport';
import { buildExtrusionEdit, buildRectangleEdit, journalEntry, validateEditableSubset } from '../../src/lib/authoring/geometry.js';
import { AuthoringHistory } from '../../src/lib/authoring/history.js';
import type { AuthoringCheckpoint, AuthoringCommand, AuthoringResult } from '../../src/lib/authoring/protocol.js';
import { AuthoringToolController } from '../../src/lib/authoring/tools.js';

const DOCUMENT_ID = 'a4f2d141-64e1-4c62-8d0d-53623f71a220';

function pointer(clientX: number, clientY: number, pointerId = 1): PointerEvent {
	return Object.assign(new Event('pointer'), {
		pointerId, clientX, clientY, button: 0, isPrimary: true
	}) as PointerEvent;
}

function createHarness(rectangles: readonly { first: [number, number, number]; opposite: [number, number, number] }[] = []) {
	const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
	const history = new AuthoringHistory(null);
	let sequence = 1;
	for (const rectangle of rectangles) {
		const graph = document.snapshot().graph;
		history.execute(document, journalEntry(buildRectangleEdit(graph, `${DOCUMENT_ID}:rectangle:${sequence}`, rectangle.first, rectangle.opposite)));
		sequence += 1;
	}
	let checkpoint: AuthoringCheckpoint = { snapshot: document.snapshot(), sequence, history: history.checkpoint() };
	const overlays = new Map<string, object>();
	const disposedObjects = new WeakSet<object>();
	let duplicateDisposal = false;
	const disposeOverlay = (overlay: object) => {
		if (!(overlay instanceof Object3D)) return;
		overlay.traverse((object) => {
			const drawable = object as Object3D & {
				geometry?: { dispose(): void };
				material?: { dispose(): void } | Array<{ dispose(): void }>;
			};
			for (const resource of [drawable.geometry, ...(Array.isArray(drawable.material) ? drawable.material : drawable.material ? [drawable.material] : [])]) {
				if (!resource) continue;
				if (disposedObjects.has(resource)) duplicateDisposal = true;
				disposedObjects.add(resource);
				resource.dispose();
			}
		});
	};
	const submitted: AuthoringCommand[] = [];
	const errors: string[] = [];
	const selections: (string | null)[] = [];
	let controller: AuthoringToolController;
	let rayFactory: (clientX: number, clientY: number) => Ray | null = (clientX, clientY) =>
		new Ray(new Vector3(clientX, 10, clientY), new Vector3(0, -1, 0));
	const viewport = {
		rayFromScreen(clientX: number, clientY: number) {
			return rayFactory(clientX, clientY);
		},
		setDomainOverlay(key: string, overlay: object | null) {
			const previous = overlays.get(key);
			if (previous) disposeOverlay(previous);
			overlays.delete(key);
			if (overlay) overlays.set(key, overlay);
		}
	} as unknown as Pick<PreparedSceneViewport, 'rayFromScreen' | 'setDomainOverlay'>;
	const submitCommand = async (command: AuthoringCommand): Promise<AuthoringResult> => {
		submitted.push(command);
		const entityId = command.kind === 'CREATE_RECTANGLE' ? `${DOCUMENT_ID}:rectangle:${sequence}` : command.entityId;
		const edit = command.kind === 'CREATE_RECTANGLE'
			? buildRectangleEdit(document.snapshot().graph, entityId, command.first, command.opposite)
			: buildExtrusionEdit(document.snapshot().graph, entityId, command.distance);
		const changed = history.execute(document, journalEntry(edit));
		if (!changed) throw new Error('Test dispatcher did not commit the authoring command.');
		if (command.kind === 'CREATE_RECTANGLE') sequence += 1;
		checkpoint = { snapshot: document.snapshot(), sequence, history: history.checkpoint() };
		controller.setCheckpoint(checkpoint);
		return {
			kind: 'authoring', checkpoint,
			canUndo: history.canUndo, canRedo: history.canRedo,
			dirty: history.dirty(checkpoint.snapshot.graph),
			commandResult: { entityId }
		};
	};
	controller = new AuthoringToolController({
		viewport, getCheckpoint: () => checkpoint, submitCommand,
		onSelectionChange: (entityId) => selections.push(entityId),
		onError: (message) => errors.push(message)
	});
	return {
		document, history, controller, viewport, overlays, submitted, errors, selections,
		getCheckpoint: () => checkpoint,
		hasDuplicateDisposal: () => duplicateDisposal,
		getOverlayCount: () => overlays.size,
		setRayFactory: (factory: (clientX: number, clientY: number) => Ray | null) => { rayFactory = factory; },
		close: () => { controller.dispose(); document.dispose(); }
	};
}

function click(controller: AuthoringToolController, x: number, y: number, pointerId = 1) {
	controller.handlePointerDown(pointer(x, y, pointerId), false);
	controller.handlePointerUp(pointer(x, y, pointerId), false);
}

async function flush() { await new Promise((resolve) => setTimeout(resolve, 0)); }

describe('canonical authoring tools', () => {
	test('uses two ground-plane clicks, transfers previews, and selects only after command ACK', async () => {
		const harness = createHarness();
		try {
			harness.controller.setTool('rectangle');
			click(harness.controller, 1, 1);
			harness.controller.handlePointerMove(pointer(3, 4), false);
			const preview = harness.overlays.get('editor-authoring-preview') as { children: unknown[] };
			expect(preview.children.filter((child) => child instanceof Mesh)).toHaveLength(1);
			expect(harness.getCheckpoint().snapshot.graph.meshes).toHaveLength(0);
			click(harness.controller, 3, 4);
			await flush();
			expect(harness.submitted).toEqual([{
				kind: 'CREATE_RECTANGLE', first: [1, 0, 1], opposite: [3, 0, 4]
			}]);
			const subset = validateEditableSubset(harness.getCheckpoint().snapshot.graph);
			expect(subset.editable).toBe(true);
			if (subset.editable) expect(subset.entities.map((entity) => entity.entityId)).toEqual([`${DOCUMENT_ID}:rectangle:1`]);
			expect(harness.controller.selectedEntityId).toBe(`${DOCUMENT_ID}:rectangle:1`);
			expect(harness.overlays.has('editor-authoring-selection')).toBe(true);
			expect(harness.overlays.has('editor-authoring-preview')).toBe(false);
			harness.close();
			expect(harness.hasDuplicateDisposal()).toBe(false);
			expect(harness.getOverlayCount()).toBe(0);
		} finally { harness.close(); }
	});

	test('selects the nearest canonical face and breaks equal-distance ties by code-unit face ID', () => {
		const harness = createHarness([
			{ first: [0, 0, 0], opposite: [2, 0, 3] },
			{ first: [0, 0, 0], opposite: [2, 0, 3] }
		]);
		try {
			click(harness.controller, 1, 1);
			expect(harness.controller.selectedEntityId).toBe(`${DOCUMENT_ID}:rectangle:1`);
			expect(harness.selections).toEqual([`${DOCUMENT_ID}:rectangle:1`]);
			expect(harness.overlays.has('editor-authoring-selection')).toBe(true);
		} finally { harness.close(); }
	});

	test('previews and commits signed extrusion from two clicks without changing canonical state optimistically', async () => {
		const entityId = `${DOCUMENT_ID}:rectangle:1`;
		const harness = createHarness([{ first: [0, 0, 0], opposite: [2, 0, 3] }]);
		try {
			click(harness.controller, 1, 1);
			harness.controller.setTool('extrude');
			click(harness.controller, 1, 100);
			harness.controller.handlePointerMove(pointer(1, -35), false);
			const preview = harness.overlays.get('editor-authoring-preview') as { children: unknown[] };
			expect(preview.children.filter((child) => child instanceof Mesh)).toHaveLength(6);
			expect(validateEditableSubset(harness.getCheckpoint().snapshot.graph)).toMatchObject({ editable: true });
			click(harness.controller, 1, -35);
			await flush();
			expect(harness.submitted.at(-1)).toEqual({ kind: 'EXTRUDE_RECTANGLE', entityId, distance: 2.7 });
			const subset = validateEditableSubset(harness.getCheckpoint().snapshot.graph);
			expect(subset.editable).toBe(true);
			if (subset.editable) expect(subset.entities[0]).toMatchObject({ kind: 'extrusion', distance: 2.7 });
			expect(harness.overlays.has('editor-authoring-preview')).toBe(false);
		} finally { harness.close(); }
	});

	test('commits the exact finite numeric distance and sends no command for invalid input', async () => {
		const harness = createHarness([{ first: [0, 0, 0], opposite: [2, 0, 3] }]);
		try {
			click(harness.controller, 1, 1);
			harness.controller.setTool('extrude');
			harness.controller.setExtrusionDistance('-2.700000000000001');
			await harness.controller.commitExtrusionDistance();
			expect(harness.submitted.at(-1)).toMatchObject({ kind: 'EXTRUDE_RECTANGLE', distance: -2.700000000000001 });
			harness.controller.setExtrusionDistance('1 metre');
			expect(await harness.controller.commitExtrusionDistance()).toBeNull();
			expect(harness.submitted).toHaveLength(1);
			expect(harness.errors.at(-1)).toContain('complete finite');
		} finally { harness.close(); }
	});

	test('camera drags never commit drawing and undo-removal clears selected entity', () => {
		const harness = createHarness([{ first: [0, 0, 0], opposite: [2, 0, 3] }]);
		try {
			click(harness.controller, 1, 1);
			harness.controller.setTool('rectangle');
			click(harness.controller, 0, 0);
			harness.controller.handlePointerDown(pointer(3, 4), false);
			harness.controller.handlePointerMove(pointer(20, 25), true);
			harness.controller.handlePointerUp(pointer(20, 25), true);
			expect(harness.submitted).toHaveLength(0);
			harness.history.undo(harness.document);
			const checkpoint: AuthoringCheckpoint = {
				snapshot: harness.document.snapshot(), sequence: 2, history: harness.history.checkpoint()
			};
			harness.controller.setCheckpoint(checkpoint);
			expect(harness.controller.selectedEntityId).toBeNull();
			expect(harness.selections.at(-1)).toBeNull();
		} finally { harness.close(); }
	});

	test('rejects parallel, behind-camera and missing screen rays; honors the 4px click boundary and cancellation', async () => {
		const harness = createHarness();
		try {
			harness.controller.setTool('rectangle');
			harness.setRayFactory(() => new Ray(new Vector3(0, 2, 0), new Vector3(1, 0, 0)));
			click(harness.controller, 0, 0);
			harness.setRayFactory(() => new Ray(new Vector3(0, 2, 0), new Vector3(0, 1, 0)));
			click(harness.controller, 2, 2);
			harness.setRayFactory(() => null);
			click(harness.controller, 3, 3);
			expect(harness.submitted).toHaveLength(0);

			harness.setRayFactory((clientX, clientY) => new Ray(new Vector3(clientX, 10, clientY), new Vector3(0, -1, 0)));
			harness.controller.handlePointerDown(pointer(1, 1), false);
			harness.controller.handlePointerMove(pointer(5, 1), false);
			harness.controller.handlePointerUp(pointer(5, 1), false);
			harness.controller.handlePointerDown(pointer(7, 4), false);
			harness.controller.handlePointerUp(pointer(7, 4), false);
			await flush();
			expect(harness.submitted).toEqual([{
				kind: 'CREATE_RECTANGLE', first: [5, 0, 1], opposite: [7, 0, 4]
			}]);

			harness.controller.setTool('rectangle');
			harness.controller.handlePointerDown(pointer(0, 0), false);
			harness.controller.handlePointerMove(pointer(5, 0), false);
			harness.controller.handlePointerUp(pointer(5, 0), false);
			expect(harness.submitted).toHaveLength(1);
			click(harness.controller, 2, 2);
			harness.controller.handlePointerMove(pointer(3, 4), false);
			expect(harness.overlays.has('editor-authoring-preview')).toBe(true);
			harness.controller.cancelPreview();
			expect(harness.overlays.has('editor-authoring-preview')).toBe(false);
			harness.controller.handlePointerDown(pointer(3, 3), false);
			harness.controller.handlePointerUp(pointer(3, 3), false);
			expect(harness.submitted).toHaveLength(1);
		} finally { harness.close(); }
	});
});
