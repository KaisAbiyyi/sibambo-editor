import { describe, expect, test } from 'bun:test';
import { PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { applyNavigationShortcutToControls, middleMouseAction } from './camera-navigation.js';

type Listener = (event: any) => void;

class TestEventTarget {
	private listeners = new Map<string, Array<{ listener: Listener; capture: boolean }>>();

	addEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean }) {
		const rows = this.listeners.get(type) ?? [];
		rows.push({ listener, capture: typeof options === 'boolean' ? options : options?.capture ?? false });
		this.listeners.set(type, rows);
	}

	removeEventListener(type: string, listener: Listener) {
		this.listeners.set(type, (this.listeners.get(type) ?? []).filter((row) => row.listener !== listener));
	}

	dispatchEvent(event: any) {
		event.preventDefault ??= () => {};
		const rows = [...(this.listeners.get(event.type) ?? [])].sort((a, b) => Number(b.capture) - Number(a.capture));
		for (const row of rows) row.listener(event);
		return true;
	}
}

class TestDocument extends TestEventTarget {}

class TestCanvas extends TestEventTarget {
	readonly style: Record<string, string> = {};
	readonly ownerDocument: TestDocument;
	readonly clientWidth = 800;
	readonly clientHeight = 600;

	constructor(ownerDocument: TestDocument) { super(); this.ownerDocument = ownerDocument; }
	getRootNode() { return this.ownerDocument; }
	setPointerCapture(_pointerId: number) {}
	releasePointerCapture(_pointerId: number) {}
	getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; }
}

function middleDragTrace(shiftKey: boolean) {
	const document = new TestDocument();
	const canvas = new TestCanvas(document);
	const camera = new PerspectiveCamera(45, 800 / 600, 0.1, 1000);
	camera.position.set(10, 8, 15);
	camera.lookAt(0, 0, 0);
	const controls = new OrbitControls(camera, canvas as any);
	controls.enableDamping = false;
	controls.mouseButtons.MIDDLE = middleMouseAction();

	// Match PreparedSceneViewport's capture-phase remapping before OrbitControls
	// handles the same pointerdown on the canvas.
	canvas.addEventListener('pointerdown', (event) => {
		if (event.button === 1) controls.mouseButtons.MIDDLE = middleMouseAction();
	}, true);

	const initialPosition = camera.position.clone();
	const initialTarget = controls.target.clone();
	const initialOffset = initialPosition.clone().sub(initialTarget);
	canvas.dispatchEvent({
		type: 'pointerdown', pointerId: 7, pointerType: 'mouse', button: 1,
		clientX: 120, clientY: 140, pageX: 120, pageY: 140, shiftKey, ctrlKey: false, metaKey: false
	});
	document.dispatchEvent({
		type: 'pointermove', pointerId: 7, pointerType: 'mouse', button: 1,
		clientX: 180, clientY: 165, pageX: 180, pageY: 165, shiftKey, ctrlKey: false, metaKey: false
	});
	document.dispatchEvent({ type: 'pointerup', pointerId: 7, pointerType: 'mouse', button: 1 });

	const trace = {
		cameraPosition: camera.position.clone(),
		target: controls.target.clone(),
		cameraOffset: camera.position.clone().sub(controls.target),
		initialPosition,
		initialTarget,
		initialOffset
	};
	controls.dispose();
	return trace;
}

function leftDragAfterShortcut(key: string, code: string) {
	const document = new TestDocument();
	const canvas = new TestCanvas(document);
	const camera = new PerspectiveCamera(45, 800 / 600, 0.1, 1000);
	camera.position.set(10, 8, 15);
	camera.lookAt(0, 0, 0);
	const controls = new OrbitControls(camera, canvas as any);
	controls.enableDamping = false;
	const shortcut = { key, code, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} };
	applyNavigationShortcutToControls(shortcut, controls);
	const initialPosition = camera.position.clone();
	const initialTarget = controls.target.clone();
	const initialOffset = initialPosition.clone().sub(initialTarget);
	canvas.dispatchEvent({
		type: 'pointerdown', pointerId: 8, pointerType: 'mouse', button: 0,
		clientX: 120, clientY: 140, pageX: 120, pageY: 140, shiftKey: false, ctrlKey: false, metaKey: false
	});
	document.dispatchEvent({
		type: 'pointermove', pointerId: 8, pointerType: 'mouse', button: 0,
		clientX: 180, clientY: 165, pageX: 180, pageY: 165, shiftKey: false, ctrlKey: false, metaKey: false
	});
	document.dispatchEvent({ type: 'pointerup', pointerId: 8, pointerType: 'mouse', button: 0 });
	const trace = {
		cameraPosition: camera.position.clone(),
		target: controls.target.clone(),
		cameraOffset: camera.position.clone().sub(controls.target),
		initialPosition,
		initialTarget,
		initialOffset
	};
	controls.dispose();
	return trace;
}

function touchGestureTrace(pointerCount: 1 | 2) {
	const document = new TestDocument();
	const canvas = new TestCanvas(document);
	const camera = new PerspectiveCamera(45, 800 / 600, 0.1, 1000);
	camera.position.set(10, 8, 15);
	camera.lookAt(0, 0, 0);
	const controls = new OrbitControls(camera, canvas as any);
	controls.enableDamping = false;
	const initialPosition = camera.position.clone();
	const initialTarget = controls.target.clone();
	const initialOffset = initialPosition.clone().sub(initialTarget);

	canvas.dispatchEvent({
		type: 'pointerdown', pointerId: 1, pointerType: 'touch', button: 0,
		clientX: 100, clientY: 100, pageX: 100, pageY: 100, shiftKey: false, ctrlKey: false, metaKey: false
	});
	if (pointerCount === 1) {
		document.dispatchEvent({
			type: 'pointermove', pointerId: 1, pointerType: 'touch', button: 0,
			clientX: 155, clientY: 140, pageX: 155, pageY: 140, shiftKey: false, ctrlKey: false, metaKey: false
		});
	} else {
		canvas.dispatchEvent({
			type: 'pointerdown', pointerId: 2, pointerType: 'touch', button: 0,
			clientX: 200, clientY: 100, pageX: 200, pageY: 100, shiftKey: false, ctrlKey: false, metaKey: false
		});
		document.dispatchEvent({
			type: 'pointermove', pointerId: 1, pointerType: 'touch', button: 0,
			clientX: 110, clientY: 110, pageX: 110, pageY: 110, shiftKey: false, ctrlKey: false, metaKey: false
		});
		document.dispatchEvent({
			type: 'pointermove', pointerId: 2, pointerType: 'touch', button: 0,
			clientX: 230, clientY: 90, pageX: 230, pageY: 90, shiftKey: false, ctrlKey: false, metaKey: false
		});
		document.dispatchEvent({ type: 'pointerup', pointerId: 2, pointerType: 'touch', button: 0 });
	}
	document.dispatchEvent({ type: 'pointerup', pointerId: 1, pointerType: 'touch', button: 0 });
	const trace = {
		touchAction: canvas.style.touchAction,
		cameraPosition: camera.position.clone(),
		target: controls.target.clone(),
		cameraOffset: camera.position.clone().sub(controls.target),
		initialPosition,
		initialTarget,
		initialOffset
	};
	controls.dispose();
	return trace;
}

describe('OrbitControls pointer input trace', () => {
	test('middle orbits and Shift+middle pans using the installed OrbitControls modifier mapping', () => {
		const orbit = middleDragTrace(false);
		expect(orbit.target.distanceTo(orbit.initialTarget)).toBeCloseTo(0);
		expect(orbit.cameraPosition.distanceTo(orbit.initialPosition)).toBeGreaterThan(0.1);

		const pan = middleDragTrace(true);
		expect(pan.target.distanceTo(pan.initialTarget)).toBeGreaterThan(0.1);
		expect(pan.cameraOffset.distanceTo(pan.initialOffset)).toBeCloseTo(0);
	});

	test('H/P switch left drag to pan and orbit shortcuts restore left orbit', () => {
		const pan = leftDragAfterShortcut('h', 'KeyH');
		expect(pan.target.distanceTo(pan.initialTarget)).toBeGreaterThan(0.1);
		expect(pan.cameraOffset.distanceTo(pan.initialOffset)).toBeCloseTo(0);

		const panP = leftDragAfterShortcut('p', 'KeyP');
		expect(panP.target.distanceTo(panP.initialTarget)).toBeGreaterThan(0.1);
		expect(panP.cameraOffset.distanceTo(panP.initialOffset)).toBeCloseTo(0);

		const orbitShortcut = leftDragAfterShortcut('r', 'KeyR');
		expect(orbitShortcut.target.distanceTo(orbitShortcut.initialTarget)).toBeCloseTo(0);
		expect(orbitShortcut.cameraPosition.distanceTo(orbitShortcut.initialPosition)).toBeGreaterThan(0.1);
	});

	test('one touch orbits and two touches pan and pinch without changing the page touch policy', () => {
		const orbit = touchGestureTrace(1);
		expect(orbit.touchAction).toBe('none');
		expect(orbit.target.distanceTo(orbit.initialTarget)).toBeCloseTo(0);
		expect(orbit.cameraPosition.distanceTo(orbit.initialPosition)).toBeGreaterThan(0.1);

		const panAndPinch = touchGestureTrace(2);
		expect(panAndPinch.touchAction).toBe('none');
		expect(panAndPinch.target.distanceTo(panAndPinch.initialTarget)).toBeGreaterThan(0.1);
		expect(panAndPinch.cameraOffset.length()).not.toBeCloseTo(panAndPinch.initialOffset.length());
	});
});
