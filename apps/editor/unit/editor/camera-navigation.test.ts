import { describe, expect, test } from 'bun:test';
import { PerspectiveCamera, Vector3 } from 'three';
import { groundPlaneAnchor, groundedCameraPose, orbitCameraDrag, panCameraDrag, pinchZoomDelta, temporaryCameraTool, uprightCameraUp } from '../../src/lib/editor/camera-navigation';

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

	test('orbit supports yaw and pitch around the grounded anchor with distance-independent sensitivity', () => {
		const near = { position: new Vector3(8, 5, 7), target: new Vector3(2, 1, -3) };
		const nearGrounded = groundedCameraPose(near);
		const farDirection = nearGrounded.position.clone().sub(nearGrounded.target).normalize();
		const far = { position: nearGrounded.target.clone().add(farDirection.multiplyScalar(100)), target: nearGrounded.target.clone() };
		const nearMoved = orbitCameraDrag(near, 80, -40);
		const horizontalOnly = orbitCameraDrag(near, 80, 0);
		const farMoved = orbitCameraDrag(far, 80, -40);
		expect(nearMoved.target.y).toBeCloseTo(0, 10);
		expect(farMoved.target.y).toBeCloseTo(0, 10);
		expect(Math.abs(nearMoved.position.y - horizontalOnly.position.y)).toBeGreaterThan(1e-3);
		const nearStart = nearGrounded.position.clone().sub(nearGrounded.target).normalize();
		const nearEnd = nearMoved.position.clone().sub(nearMoved.target).normalize();
		const farStart = far.position.clone().sub(far.target).normalize();
		const farEnd = farMoved.position.clone().sub(farMoved.target).normalize();
		expect(nearStart.angleTo(nearEnd)).toBeCloseTo(farStart.angleTo(farEnd), 10);
		expect(Math.abs(nearMoved.position.distanceTo(nearMoved.target) - nearGrounded.position.distanceTo(nearGrounded.target))).toBeLessThan(1e-9);
	});

	test('camera leveling removes roll by choosing a canonical world-up axis', () => {
		const perspective = { position: new Vector3(8, 5, 7), target: new Vector3(0, 0, 0) };
		expect(uprightCameraUp(perspective)).toEqual(new Vector3(0, 1, 0));
		const top = { position: new Vector3(0, 10, 0), target: new Vector3(0, 0, 0) };
		expect(uprightCameraUp(top)).toEqual(new Vector3(0, 0, -1));
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
