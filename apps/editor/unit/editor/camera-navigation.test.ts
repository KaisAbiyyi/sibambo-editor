import { describe, expect, test } from 'bun:test';
import { PerspectiveCamera, Vector3 } from 'three';
import { groundPlaneAnchor, groundedCameraPose, orbitCameraDrag, panCameraDrag, pinchZoomDelta, temporaryCameraTool } from '../../src/lib/editor/camera-navigation';

describe('editor camera navigation', () => {
	test('anchor is the centre-camera ray intersection with the Y=0 ground plane', () => {
		const start = { position: new Vector3(8, 5, 7), target: new Vector3(2, 1, -3) };
		const anchor = groundPlaneAnchor(start);
		expect(anchor).not.toBeNull();
		expect(anchor!.y).toBeCloseTo(0, 10);
		const cameraDirection = start.target.clone().sub(start.position).normalize();
		const anchorDirection = anchor!.clone().sub(start.position).normalize();
		expect(anchorDirection.distanceTo(cameraDirection)).toBeLessThan(1e-9);
	});

	test('orbit uses the grounded anchor and keeps angular sensitivity independent of radius', () => {
		const near = { position: new Vector3(8, 5, 7), target: new Vector3(2, 1, -3) };
		const nearGrounded = groundedCameraPose(near);
		const farDirection = nearGrounded.position.clone().sub(nearGrounded.target).normalize();
		const far = { position: nearGrounded.target.clone().add(farDirection.multiplyScalar(100)), target: nearGrounded.target.clone() };
		const nearMoved = orbitCameraDrag(near, 80, -20);
		const farMoved = orbitCameraDrag(far, 80, -20);
		expect(nearMoved.target.y).toBeCloseTo(0, 10);
		expect(farMoved.target.y).toBeCloseTo(0, 10);
		const nearStartDirection = nearGrounded.position.clone().sub(nearGrounded.target).normalize();
		const nearEndDirection = nearMoved.position.clone().sub(nearMoved.target).normalize();
		const farStartDirection = far.position.clone().sub(far.target).normalize();
		const farEndDirection = farMoved.position.clone().sub(farMoved.target).normalize();
		expect(nearStartDirection.angleTo(nearEndDirection)).toBeCloseTo(farStartDirection.angleTo(farEndDirection), 10);
		expect(Math.abs(nearMoved.position.distanceTo(nearMoved.target) - nearGrounded.position.distanceTo(nearGrounded.target))).toBeLessThan(1e-9);
	});

	test('pan tracks pointer pixels at grounded-anchor depth and leaves the next anchor on Y=0', () => {
		const width = 1200, height = 800;
		const camera = new PerspectiveCamera(42, width / height, 0.1, 1000);
		const start = { position: new Vector3(8, 5, 7), target: new Vector3(2, 1, -3) };
		const grounded = groundedCameraPose(start);
		camera.position.copy(grounded.position);
		camera.lookAt(grounded.target);
		camera.updateProjectionMatrix();
		camera.updateMatrixWorld(true);
		const moved = panCameraDrag(camera, start, 80, -35, height);
		expect(moved.target.y).toBeCloseTo(0, 10);
		const beforeDirection = grounded.target.clone().sub(grounded.position).normalize();
		const afterDirection = moved.target.clone().sub(moved.position).normalize();
		expect(afterDirection.distanceTo(beforeDirection)).toBeLessThan(1e-9);
		camera.position.copy(moved.position);
		camera.lookAt(moved.target);
		camera.updateMatrixWorld(true);
		const projected = grounded.target.clone().project(camera);
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
