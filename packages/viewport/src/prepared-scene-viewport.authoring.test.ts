import { describe, expect, test } from 'bun:test';
import { PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';
import { PreparedSceneViewport, type ViewportBounds } from './prepared-scene-viewport.js';

type ViewportInternals = {
	disposed: boolean;
	input: { editorMode?: boolean; scene: { meshes: unknown[]; groups: unknown[] } };
	canvas: { getBoundingClientRect: () => DOMRect };
	pointer: Vector2;
	raycaster: Raycaster;
	initialFitHandle: number;
	initialFitComplete: boolean;
	fittedBounds: ViewportBounds;
	rendererHost: {
		camera: PerspectiveCamera;
		layoutSize: { width: number; height: number };
		updateClipRange: (bounds: ViewportBounds) => void;
		view: (bounds: ViewportBounds, name: 'top' | 'front' | 'iso') => void;
	};
	invalidateNavigationState: () => void;
	refreshNavigationAxes: () => void;
	renderOnce: () => void;
	checkReady: () => void;
};

const bounds: ViewportBounds = { min: { x: -20, y: 0, z: -10 }, max: { x: 20, y: 4, z: 30 } };

function makeViewport(options: { editorMode?: boolean; meshes?: unknown[]; groups?: unknown[]; width?: number; height?: number } = {}) {
	const viewport = Object.create(PreparedSceneViewport.prototype) as PreparedSceneViewport;
	const calls: string[] = [];
	const camera = new PerspectiveCamera(55, 2, 0.1, 500);
	camera.position.set(2, 3, 8);
	camera.lookAt(1, 1, 2);
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld(true);
	const host: ViewportInternals['rendererHost'] = {
		camera,
		layoutSize: { width: options.width ?? 400, height: options.height ?? 200 },
		updateClipRange: () => calls.push('clip'),
		view: () => calls.push('view')
	};
	const internals = viewport as unknown as ViewportInternals;
	Object.assign(internals, {
		disposed: false,
		input: { editorMode: options.editorMode ?? true, scene: { meshes: options.meshes ?? [], groups: options.groups ?? [] } },
		canvas: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100, right: 210, bottom: 120 } as DOMRect) },
		pointer: new Vector2(),
		raycaster: new Raycaster(),
		initialFitHandle: 0,
		initialFitComplete: false,
		fittedBounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
		rendererHost: host,
		invalidateNavigationState: () => calls.push('invalidate'),
		refreshNavigationAxes: () => calls.push('axes'),
		renderOnce: () => calls.push('render'),
		checkReady: () => calls.push('ready')
	});
	return { viewport, internals, calls, camera };
}

describe('PreparedSceneViewport authoring bridges', () => {
	test('rayFromScreen returns a fresh real-camera ray only for finite coordinates inside the canvas', () => {
		const { viewport, camera } = makeViewport();
		const first = viewport.rayFromScreen(110, 70);
		const second = viewport.rayFromScreen(110, 70);
		expect(first).not.toBeNull();
		expect(first!.origin.distanceTo(camera.position)).toBeLessThan(1e-12);
		expect(first!.direction.distanceTo(camera.getWorldDirection(new Vector3()))).toBeLessThan(1e-12);
		expect(first).not.toBe(second);
		expect(viewport.rayFromScreen(9, 70)).toBeNull();
		expect(viewport.rayFromScreen(110, Number.NaN)).toBeNull();
	});

	test('rayFromScreen rejects zero-size and disposed viewports', () => {
		const { viewport, internals } = makeViewport();
		internals.canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 30, right: 0, bottom: 30 } as DOMRect) };
		expect(viewport.rayFromScreen(0, 10)).toBeNull();
		internals.disposed = true;
		expect(viewport.rayFromScreen(0, 10)).toBeNull();
	});

	test('viewBounds validates caller bounds and uses them without replacing imported fitted bounds', () => {
		const { viewport, internals, calls } = makeViewport();
		const prior = internals.fittedBounds;
		viewport.viewBounds('front', bounds);
		expect(calls).toEqual(['invalidate', 'view', 'render']);
		expect(internals.fittedBounds).toBe(prior);
		const callCount = calls.length;
		expect(() => viewport.viewBounds('top', { ...bounds, max: { ...bounds.max, x: Number.POSITIVE_INFINITY } })).toThrow('finite and ordered');
		expect(calls).toHaveLength(callCount);
	});

	test('setAuthoringBounds copies bounds, cancels deferred fit and updates navigation state without moving the camera', () => {
		const { viewport, internals, calls, camera } = makeViewport();
		internals.initialFitHandle = 17;
		const beforePosition = camera.position.clone();
		const beforeDirection = camera.getWorldDirection(new Vector3());
		const cancelled: number[] = [];
		const previousCancel = globalThis.cancelAnimationFrame;
		globalThis.cancelAnimationFrame = ((handle: number) => { cancelled.push(handle); }) as typeof cancelAnimationFrame;
		try {
			viewport.setAuthoringBounds(bounds);
		} finally {
			globalThis.cancelAnimationFrame = previousCancel;
		}
		expect(cancelled).toEqual([17]);
		expect(internals.initialFitHandle).toBe(0);
		expect(internals.initialFitComplete).toBe(true);
		expect(internals.fittedBounds).toEqual(bounds);
		expect(internals.fittedBounds).not.toBe(bounds);
		expect(internals.fittedBounds.min).not.toBe(bounds.min);
		expect(camera.position.distanceTo(beforePosition)).toBe(0);
		expect(camera.getWorldDirection(new Vector3()).distanceTo(beforeDirection)).toBe(0);
		expect(calls).toEqual(['invalidate', 'clip', 'axes', 'render', 'ready']);
	});

	test('setAuthoringBounds rejects disposed, imported, nonempty and unlaid-out scenes before mutation', () => {
		const cases = [
			makeViewport(),
			makeViewport({ editorMode: false }),
			makeViewport({ groups: [{}] }),
			makeViewport({ width: 0 })
		];
		cases[0]!.internals.disposed = true;
		for (const item of cases) {
			expect(() => item.viewport.setAuthoringBounds(bounds)).toThrow();
			expect(item.calls).toEqual([]);
		}
	});
});
