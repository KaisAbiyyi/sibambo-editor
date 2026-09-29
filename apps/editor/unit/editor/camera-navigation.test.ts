import { describe, expect, test } from 'bun:test';
import { PerspectiveCamera, Vector3 } from 'three';
import { orbitCameraDrag, panCameraDrag, pinchZoomDelta, temporaryCameraTool } from '../../src/lib/editor/camera-navigation';

describe('editor camera navigation', () => {
	test('orbit starts from current pose without changing target or radius', () => {
		const start = { position: new Vector3(8, 5, 7), target: new Vector3(2, 1, -3) };
		const unchanged = orbitCameraDrag(start, 0, 0);
		expect(unchanged.position.distanceTo(start.position)).toBeLessThan(1e-9);
		const moved = orbitCameraDrag(start, 30, -12);
		expect(moved.target.equals(start.target)).toBe(true);
		expect(Math.abs(moved.position.distanceTo(moved.target) - start.position.distanceTo(start.target))).toBeLessThan(1e-9);
	});

	test('pan translates camera and anchor equally and tracks pointer pixels at anchor depth', () => {
		const width = 1200, height = 800;
		const camera = new PerspectiveCamera(42, width / height, 0.1, 1000);
		const start = { position: new Vector3(8, 5, 7), target: new Vector3(2, 1, -3) };
		camera.position.copy(start.position);
		camera.lookAt(start.target);
		camera.updateProjectionMatrix();
		camera.updateMatrixWorld(true);
		const moved = panCameraDrag(camera, start, 80, -35, height);
		expect(moved.position.clone().sub(start.position).distanceTo(moved.target.clone().sub(start.target))).toBeLessThan(1e-9);
		expect(Math.abs(moved.position.distanceTo(moved.target) - start.position.distanceTo(start.target))).toBeLessThan(1e-9);
		camera.position.copy(moved.position);
		camera.lookAt(moved.target);
		camera.updateMatrixWorld(true);
		const projected = start.target.clone().project(camera);
		const x = (projected.x + 1) * width / 2;
		const y = (1 - projected.y) * height / 2;
		expect(x - width / 2).toBeCloseTo(80, 4);
		expect(y - height / 2).toBeCloseTo(-35, 4);
	});

	test('temporary middle mouse navigation preserves persistent tool', () => {
		expect(temporaryCameraTool('tape', 1, false)).toBe('orbit');
		expect(temporaryCameraTool('tape', 1, true)).toBe('pan');
		expect(temporaryCameraTool('tape', 0, false)).toBe('tape');
	});

	test('pinch zoom deltas accumulate to the single start-to-current scale', () => {
		const first = pinchZoomDelta(100, 110);
		const second = pinchZoomDelta(110, 121);
		expect(first + second).toBeCloseTo(pinchZoomDelta(100, 121));
		expect(pinchZoomDelta(100, 110)).toBeLessThan(0);
		expect(pinchZoomDelta(110, 100)).toBeGreaterThan(0);
	});
});
