import { describe, expect, test } from 'bun:test';
import { PerspectiveCamera, Vector3 } from 'three';
import { orbitCameraDrag, panCameraDrag, temporaryCameraTool } from '../../src/lib/editor/camera-navigation';

describe('editor camera navigation', () => {
	test('orbit starts from current pose without changing target or radius', () => {
		const start = { position: new Vector3(8, 5, 7), target: new Vector3(2, 1, -3) };
		const unchanged = orbitCameraDrag(start, 0, 0);
		expect(unchanged.position.distanceTo(start.position)).toBeLessThan(1e-9);
		const moved = orbitCameraDrag(start, 30, -12);
		expect(moved.target.equals(start.target)).toBe(true);
		expect(Math.abs(moved.position.distanceTo(moved.target) - start.position.distanceTo(start.target))).toBeLessThan(1e-9);
	});

	test('pan translates camera and target equally while preserving distance', () => {
		const camera = new PerspectiveCamera(42, 1.5, 0.1, 1000);
		const start = { position: new Vector3(8, 5, 7), target: new Vector3(2, 1, -3) };
		const moved = panCameraDrag(camera, start, 80, -35, 800);
		expect(moved.position.clone().sub(start.position).distanceTo(moved.target.clone().sub(start.target))).toBeLessThan(1e-9);
		expect(Math.abs(moved.position.distanceTo(moved.target) - start.position.distanceTo(start.target))).toBeLessThan(1e-9);
	});

	test('temporary middle mouse navigation preserves persistent tool', () => {
		expect(temporaryCameraTool('tape', 1, false)).toBe('orbit');
		expect(temporaryCameraTool('tape', 1, true)).toBe('pan');
		expect(temporaryCameraTool('tape', 0, false)).toBe('tape');
	});
});
