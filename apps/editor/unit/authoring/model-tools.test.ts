import { describe, expect, test } from 'bun:test';
import { OrthographicCamera, Raycaster, Vector2, Vector3 } from 'three';
import { BomcDocument } from '@sibambo/bomc-document/document';
import type { PreparedSceneViewport } from '@sibambo/viewport';
import { buildPlanarRectangleEdit, journalEntry } from '../../src/lib/authoring/geometry.js';
import { AuthoringHistory } from '../../src/lib/authoring/history.js';
import { buildModelEdit, nextModelSequence } from '../../src/lib/authoring/model.js';
import { ModelingController } from '../../src/lib/authoring/model-tools.js';
import type { AuthoringCheckpoint, ModelAction } from '../../src/lib/authoring/protocol.js';
const ID = '57364f27-3268-4ef6-a68e-aa0a6b766048';
function setup() {
	const doc = BomcDocument.create({ documentId: ID, name: 'Picking' }),
		history = new AuthoringHistory(null);
	history.execute(
		doc,
		journalEntry(
			buildPlanarRectangleEdit(
				doc.snapshot().graph,
				ID + ':rectangle:1',
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
	let checkpoint: AuthoringCheckpoint = { snapshot: doc.snapshot(), sequence: 2, history: history.checkpoint() };
	const camera = new OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
	camera.position.set(0, 10, 0);
	camera.up.set(0, 0, -1);
	camera.lookAt(0, 0, 0);
	camera.updateMatrixWorld(true);
	const caster = new Raycaster(),
		overlays = new Map<string, any>(),
		errors: string[] = [],
		actions: ModelAction[] = [];
	const viewport = {
		rayFromScreen(x: number, y: number) {
			caster.setFromCamera(new Vector2((x / 1000) * 2 - 1, 1 - (y / 1000) * 2), camera);
			return caster.ray.clone();
		},
		projectWorldToScreen(p: readonly [number, number, number]) {
			const v = new Vector3(...p).project(camera);
			return { x: (v.x + 1) * 500, y: (1 - v.y) * 500, inFront: true, visible: true };
		},
		setDomainOverlay(key: string, value: any) {
			overlays.get(key)?.traverse((o: any) => {
				o.geometry?.dispose();
				o.material?.dispose();
			});
			overlays.delete(key);
			if (value) overlays.set(key, value);
		},
	};
	const commit = (action: ModelAction, path: readonly string[] = []) => {
		actions.push(action);
		history.execute(
			doc,
			journalEntry(buildModelEdit(doc.snapshot().graph, path, action, nextModelSequence(doc.snapshot().graph))),
		);
		checkpoint = {
			snapshot: doc.snapshot(),
			sequence: nextModelSequence(doc.snapshot().graph),
			history: history.checkpoint(),
		};
	};
	const controller = new ModelingController({
		checkpoint: () => checkpoint,
		viewport: () => viewport as unknown as PreparedSceneViewport,
		enabled: () => true,
		submit: async (path, action) => commit(action, path),
		change: () => {},
		contextChanged: () => {},
		error: (m) => errors.push(m),
	});
	controller.refresh();
	const pointer = (x: number, z: number, ctrl = false) => {
		const p = viewport.projectWorldToScreen([x, 0, z]);
		return { clientX: p.x, clientY: p.y, button: 0, shiftKey: false, ctrlKey: ctrl, metaKey: false } as PointerEvent;
	};
	const click = (x: number, z: number, ctrl = false) => {
		const event = pointer(x, z, ctrl);
		controller.down(event);
		controller.up(event);
	};
	return {
		doc,
		history,
		controller,
		commit,
		pointer,
		click,
		actions,
		errors,
		close() {
			controller.dispose();
			doc.dispose();
			expect(overlays.size).toBe(0);
		},
	};
}
describe('canonical modeling pointer controller', () => {
	test('Inset and free-ground Circle preview without mutation; replacing a checkpoint cancels their captured gesture', async()=>{
		const s=setup();try{
			const initial=s.doc.snapshot().graph;
			s.controller.setMode('inset');s.click(2,.2);s.controller.move(s.pointer(2,.5));
			expect(s.doc.snapshot().graph).toEqual(initial);s.click(2,.5);await Promise.resolve();await Promise.resolve();
			expect(s.doc.snapshot().graph.meshes[0]!.faces).toHaveLength(2);expect(s.actions.at(-1)).toMatchObject({type:'offset',distance:expect.closeTo(.3)});
			expect(s.controller.state.selection[0]?.type).toBe('face');
			s.controller.setMode('circle');s.controller.setCurveOptions(12,90);s.click(-3,-3);s.controller.move(s.pointer(-2,-3));
			const before=s.doc.snapshot().graph;expect(s.controller.state.anchor).toEqual([-3,0,-3]);s.click(-2,-3);await Promise.resolve();await Promise.resolve();
			expect(s.doc.snapshot().graph.meshes[0]!.faces).toHaveLength(3);expect(s.doc.snapshot().graph).not.toEqual(before);
			s.click(-6,-6);s.commit({type:'guide',start:[20,0,0],end:[21,0,0],guideKind:'line'});s.controller.refresh();
			expect(s.controller.state.anchor).toBeNull();const count=s.actions.length;s.controller.up(s.pointer(-5,-6));expect(s.actions).toHaveLength(count);expect(s.errors).toEqual([]);
		}finally{s.close();}
	});
	test('point selection distinguishes edge/face; window requires containment and crossing accepts intersection', () => {
		const s = setup();
		try {
			s.click(2, 1.5);
			expect(s.controller.state.selection).toEqual([{ type: 'face', id: ID + ':rectangle:1' }]);
			s.click(0, 1.5);
			expect(s.controller.state.selection[0]?.type).toBe('edge');
			s.controller.down(s.pointer(-0.5, -0.5));
			s.controller.up(s.pointer(4.5, 3.5));
			expect(s.controller.state.selection[0]?.type).toBe('face');
			s.controller.down(s.pointer(1, 1));
			s.controller.up(s.pointer(3, 2));
			expect(s.controller.state.selection).toHaveLength(0);
			s.controller.down(s.pointer(3, 1));
			s.controller.up(s.pointer(1, 2));
			expect(s.controller.state.selection.some((e) => e.type === 'face')).toBe(true);
			expect(s.actions).toHaveLength(0);
		} finally {
			s.close();
		}
	});
	test('container picking respects context and Move copies from exact two-click anchors; cancellation cannot commit', async () => {
		const s = setup();
		try {
			s.commit({
				type: 'group',
				selection: [{ type: 'face', id: ID + ':rectangle:1' }],
				containerKind: 'component',
				name: 'Desk',
			});
			s.controller.refresh();
			s.click(2, 1.5);
			expect(s.controller.state.selection[0]?.type).toBe('instance');
			s.controller.enter();
			s.click(2, 1.5);
			expect(s.controller.state.selection[0]?.type).toBe('face');
			s.controller.exit();
			s.click(2, 1.5);
			s.controller.setMode('move');
			s.click(2, 1.5);
			s.controller.setAxis('x');
			s.click(8, 1.5, true);
			await new Promise((r) => setTimeout(r, 0));
			expect(s.doc.snapshot().graph.instances.filter((i) => i.kind === 'component')).toHaveLength(2);
			expect(s.doc.snapshot().graph.instances.some((i) => Math.abs(i.matrix[12]! - 6) < 1e-9)).toBe(true);
			const count = s.actions.length;
			s.controller.down(s.pointer(5, 5));
			s.controller.cancel();
			s.controller.up(s.pointer(8, 5));
			expect(s.actions).toHaveLength(count);
			expect(s.errors).toEqual([]);
		} finally {
			s.close();
		}
	});
});
