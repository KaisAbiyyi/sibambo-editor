import { describe, expect, test } from 'bun:test';
import { PreparedNavigationInput, type PreparedNavigationInputCallbacks } from './prepared-navigation-input.js';
import type { CameraDragSnapshot, NavigationTool } from './camera-navigation.js';

type Listener = (event: Event) => void;

class FakeTarget {
	private listeners = new Map<string, Set<Listener>>();
	addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
		const callback = typeof listener === 'function' ? listener as Listener : (event: Event) => listener.handleEvent(event);
		const entries = this.listeners.get(type) ?? new Set<Listener>();
		entries.add(callback);
		this.listeners.set(type, entries);
	}
	removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
		const callback = typeof listener === 'function' ? listener as Listener : (event: Event) => listener.handleEvent(event);
		this.listeners.get(type)?.delete(callback);
	}
	dispatch(type: string, event: Record<string, unknown>) {
		for (const listener of this.listeners.get(type) ?? []) listener(event as unknown as Event);
	}
}

class FakeDocument extends FakeTarget {
	defaultView = new FakeTarget();
}

class FakeCanvas extends FakeTarget {
	ownerDocument = new FakeDocument();
	captured = new Set<number>();
	setPointerCapture(id: number) { this.captured.add(id); }
	releasePointerCapture(id: number) { this.captured.delete(id); }
	getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
}

function makeSnapshot(epoch = 1): CameraDragSnapshot {
	return { pose: { position: { x: 0, y: 1, z: 5 } as never, target: { x: 0, y: 1, z: 0 } as never }, orbitAnchor: { x: 0, y: 0, z: 0 } as never, sceneEpoch: epoch };
}

function harness() {
	const canvas = new FakeCanvas();
	const calls: Array<{ type: string; tool?: NavigationTool; dx?: number; dy?: number; delta?: number; id?: number }> = [];
	let primaryTool: NavigationTool = 'orbit';
	let snapshotId = 0;
	const callbacks: PreparedNavigationInputCallbacks = {
		beginCameraDrag: (tool) => { calls.push({ type: 'begin', tool, id: ++snapshotId }); return makeSnapshot(); },
		dragCamera: (tool, _start, dx, dy) => calls.push({ type: 'drag', tool, dx, dy }),
		endCameraDrag: () => calls.push({ type: 'end' }),
		zoomAt: (_x, _y, delta) => calls.push({ type: 'zoom', delta }),
		getPrimaryTool: () => primaryTool,
		getViewportHeight: () => 600
	};
	const input = new PreparedNavigationInput(canvas as unknown as HTMLCanvasElement, callbacks);
	input.setEnabled(true);
	const fire = (target: FakeTarget, type: string, values: Record<string, unknown> = {}) => {
		const event = {
			pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0, button: 0, buttons: 0,
			shiftKey: false, ctrlKey: false, metaKey: false, target: canvas,
			defaultPrevented: false,
			preventDefault() { this.defaultPrevented = true; },
			stopImmediatePropagation() {},
			...values
		};
		target.dispatch(type, event);
		return event;
	};
	return { canvas, calls, input, primaryTool: (tool: NavigationTool) => primaryTool = tool, fire };
}

describe('PreparedNavigationInput pointer ownership', () => {
	test('routes middle, Shift+middle and combined buttons; modifier transitions end and resnapshot at the pointer', () => {
		const h = harness();
		h.fire(h.canvas, 'pointerdown', { buttons: 4, button: 1, clientX: 10, clientY: 10 });
		h.fire(h.canvas.ownerDocument, 'pointermove', { buttons: 4, clientX: 20, clientY: 15 });
		h.fire(h.canvas.ownerDocument, 'pointermove', { buttons: 4, shiftKey: true, clientX: 24, clientY: 18 });
		h.fire(h.canvas.ownerDocument, 'pointermove', { buttons: 4, shiftKey: true, clientX: 30, clientY: 22 });
		h.fire(h.canvas.ownerDocument, 'pointerup', { buttons: 0, button: 1, clientX: 30, clientY: 22 });
		expect(h.calls.filter((call) => call.type === 'begin').map((call) => call.tool)).toEqual(['orbit', 'pan']);
		expect(h.calls.filter((call) => call.type === 'drag')).toEqual([
			{ type: 'drag', tool: 'orbit', dx: 10, dy: 5 },
			{ type: 'drag', tool: 'pan', dx: 6, dy: 4 }
		]);
		expect(h.calls.filter((call) => call.type === 'end')).toHaveLength(2);
		expect(h.canvas.captured.size).toBe(0);

		h.fire(h.canvas, 'pointerdown', { pointerId: 2, buttons: 5, button: 1 });
		expect(h.calls.at(-1)).toMatchObject({ type: 'begin', tool: 'pan' });
		h.fire(h.canvas.ownerDocument, 'pointerup', { pointerId: 2, buttons: 0, button: 1 });
		h.primaryTool('pan');
		h.fire(h.canvas, 'pointerdown', { pointerId: 3, buttons: 1, button: 0 });
		expect(h.calls.at(-1)).toMatchObject({ type: 'begin', tool: 'pan' });
		h.fire(h.canvas.ownerDocument, 'pointerup', { pointerId: 3, buttons: 0, button: 0 });
		h.input.dispose();
	});

	test('right button has no camera action and a primary shortcut can select pan', () => {
		const h = harness();
		const rightDown = h.fire(h.canvas, 'pointerdown', { button: 2, buttons: 2 });
		expect(rightDown.defaultPrevented).toBe(false);
		expect(h.calls).toEqual([]);
		h.primaryTool('pan');
		const leftDown = h.fire(h.canvas, 'pointerdown', { pointerId: 2, button: 0, buttons: 1 });
		expect(leftDown.defaultPrevented).toBe(true);
		expect(h.calls.at(-1)).toMatchObject({ type: 'begin', tool: 'pan' });
		h.fire(h.canvas.ownerDocument, 'pointerup', { pointerId: 2, button: 0, buttons: 0 });
		h.input.dispose();
	});

	test('one touch orbits, a pair incrementally pans and pinches, then remaining touch reacquires an orbit snapshot', () => {
		const h = harness();
		h.fire(h.canvas, 'pointerdown', { pointerId: 10, pointerType: 'touch', clientX: 10, clientY: 10, buttons: 1 });
		h.fire(h.canvas.ownerDocument, 'pointermove', { pointerId: 10, pointerType: 'touch', clientX: 20, clientY: 14, buttons: 1 });
		h.fire(h.canvas, 'pointerdown', { pointerId: 11, pointerType: 'touch', clientX: 40, clientY: 10, buttons: 1 });
		h.fire(h.canvas, 'pointerdown', { pointerId: 12, pointerType: 'touch', clientX: 100, clientY: 100, buttons: 1 });
		h.fire(h.canvas.ownerDocument, 'pointermove', { pointerId: 11, pointerType: 'touch', clientX: 50, clientY: 12, buttons: 1 });
		const pointerIds = h.calls;
		expect(pointerIds.filter((call) => call.type === 'begin').map((call) => call.tool)).toEqual(['orbit', 'pan']);
		expect(pointerIds.filter((call) => call.type === 'drag')).toContainEqual({ type: 'drag', tool: 'orbit', dx: 10, dy: 4 });
		expect(pointerIds.filter((call) => call.type === 'drag')).toContainEqual({ type: 'drag', tool: 'pan', dx: 5, dy: 1 });
		expect(pointerIds.some((call) => call.type === 'zoom' && Number.isFinite(call.delta) && call.delta! < 0)).toBe(true);
		expect(pointerIds.filter((call) => call.type === 'begin')).toHaveLength(2); // the ignored third touch adds no gesture
		h.fire(h.canvas.ownerDocument, 'pointerup', { pointerId: 11, pointerType: 'touch', clientX: 50, clientY: 12, buttons: 0 });
		expect(h.calls.at(-1)).toMatchObject({ type: 'begin', tool: 'orbit' });
		h.fire(h.canvas.ownerDocument, 'pointermove', { pointerId: 10, pointerType: 'touch', clientX: 23, clientY: 17, buttons: 1 });
		expect(h.calls.at(-1)).toMatchObject({ type: 'drag', tool: 'orbit', dx: 3, dy: 3 });
		h.fire(h.canvas.ownerDocument, 'pointerup', { pointerId: 10, pointerType: 'touch', clientX: 23, clientY: 17, buttons: 0 });
		expect(h.canvas.captured.size).toBe(0); // ignored third touch was never captured
		h.input.cancel();
		expect(h.canvas.captured.size).toBe(0);
		h.input.dispose();
	});

	test('cancel, lost capture, blur, Editor disable and disposal release ownership without later callbacks', () => {
		const h = harness();
		h.fire(h.canvas, 'pointerdown', { buttons: 4, button: 1 });
		h.fire(h.canvas.ownerDocument, 'pointercancel', { buttons: 0 });
		expect(h.canvas.captured.size).toBe(0);
		h.fire(h.canvas, 'pointerdown', { pointerId: 2, buttons: 4, button: 1 });
		h.fire(h.canvas.ownerDocument, 'lostpointercapture', { pointerId: 2, buttons: 0 });
		expect(h.canvas.captured.size).toBe(0);
		h.fire(h.canvas, 'pointerdown', { pointerId: 3, pointerType: 'touch', buttons: 1 });
		h.fire(h.canvas.ownerDocument.defaultView, 'blur');
		expect(h.canvas.captured.size).toBe(0);
		h.input.setEnabled(false);
		const beforeDisabled = h.calls.length;
		h.fire(h.canvas, 'pointerdown', { pointerId: 4, buttons: 4, button: 1 });
		expect(h.calls).toHaveLength(beforeDisabled);
		h.input.setEnabled(true);
		h.input.dispose();
		const afterDispose = h.calls.length;
		h.fire(h.canvas, 'pointerdown', { pointerId: 5, buttons: 4, button: 1 });
		expect(h.calls).toHaveLength(afterDispose);
	});
});
