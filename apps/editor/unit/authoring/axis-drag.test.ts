import { describe, expect, test } from 'bun:test';
import { OrthographicCamera, PerspectiveCamera, Raycaster, Vector2, Vector3, type Camera } from 'three';
import { captureAxisDrag, solveAxisDrag } from '../../src/lib/authoring/axis-drag.js';

const WIDTH = 1200;
const HEIGHT = 800;

function viewportFor(camera: Camera) {
	const raycaster = new Raycaster();
	camera.updateMatrixWorld(true);
	return {
		rayFromScreen(clientX: number, clientY: number) {
			const ndc = new Vector2(clientX / WIDTH * 2 - 1, -(clientY / HEIGHT) * 2 + 1);
			raycaster.setFromCamera(ndc, camera);
			return raycaster.ray.clone();
		},
		projectWorldToScreen(point: readonly [number, number, number]) {
			const cameraSpace = new Vector3(...point).applyMatrix4(camera.matrixWorldInverse);
			const projected = new Vector3(...point).project(camera);
			const x = (projected.x + 1) * 0.5 * WIDTH;
			const y = (1 - projected.y) * 0.5 * HEIGHT;
			return { x, y, inFront: cameraSpace.z < 0, visible: cameraSpace.z < 0 && projected.z >= -1 && projected.z <= 1 };
		},
		worldUnitsPerPixelAt(point: readonly [number, number, number]) {
			if (camera instanceof PerspectiveCamera) {
				const cameraSpace = new Vector3(...point).applyMatrix4(camera.matrixWorldInverse);
				return 2 * Math.tan(camera.fov * Math.PI / 360) * Math.abs(cameraSpace.z) / HEIGHT;
			}
			if (camera instanceof OrthographicCamera) return Math.abs(camera.top - camera.bottom) / camera.zoom / HEIGHT;
			return null;
		}
	};
}

function perspective(position: [number, number, number]) {
	const camera = new PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 200);
	camera.position.set(...position);
	camera.lookAt(0, 0, 0);
	camera.updateProjectionMatrix();
	return camera;
}

function orthographic(position: [number, number, number], halfHeight = 8) {
	const halfWidth = halfHeight * WIDTH / HEIGHT;
	const camera = new OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, 0.1, 200);
	camera.position.set(...position);
	camera.lookAt(0, 0, 0);
	camera.updateProjectionMatrix();
	return camera;
}

function signedSolve(camera: Camera, axis: readonly [number, number, number], pixels: number) {
	const viewport = viewportFor(camera);
	const anchor = [0, 0, 0] as const;
	const projectedAnchor = viewport.projectWorldToScreen(anchor);
	const projectedUnit = viewport.projectWorldToScreen(axis);
	const dx = projectedUnit.x - projectedAnchor.x;
	const dy = projectedUnit.y - projectedAnchor.y;
	const screenLength = Math.hypot(dx, dy);
	if (screenLength < 1e-6) throw new Error('Test axis is projection-degenerate for this camera.');
	const capture = captureAxisDrag(viewport, anchor, axis, projectedAnchor.x, projectedAnchor.y);
	if (!capture) throw new Error('Axis drag capture failed.');
	const endX = projectedAnchor.x + dx / screenLength * pixels;
	const endY = projectedAnchor.y + dy / screenLength * pixels;
	const distance = solveAxisDrag(viewport, capture, endX, endY);
	if (distance === null) throw new Error('Axis drag solve failed.');
	const displaced: [number, number, number] = [axis[0] * distance, axis[1] * distance, axis[2] * distance];
	const projectedDisplaced = viewport.projectWorldToScreen(displaced);
	return { distance, screenPixels: Math.hypot(projectedDisplaced.x - projectedAnchor.x, projectedDisplaced.y - projectedAnchor.y) };
}

describe('camera-scaled authoring axis drag', () => {
	test('perspective near, medium and far views keep apparent displacement close to the pointer drag', () => {
		for (const distance of [6, 12, 24]) {
			const result = signedSolve(perspective([distance, distance * 0.6, distance]), [1, 0, 0], 100);
			expect(result.distance).toBeGreaterThan(0);
			expect(result.screenPixels).toBeGreaterThanOrEqual(85);
			expect(result.screenPixels).toBeLessThanOrEqual(115);
		}
	});

	test('orthographic distance follows zoom-derived world-per-pixel without a fixed metres-per-pixel constant', () => {
		const near = signedSolve(orthographic([8, 7, 10], 4), [1, 0, 0], 100);
		const far = signedSolve(orthographic([8, 7, 10], 12), [1, 0, 0], 100);
		expect(near.screenPixels).toBeCloseTo(100, 6);
		expect(far.screenPixels).toBeCloseTo(100, 6);
		expect(far.distance).toBeGreaterThan(near.distance * 2.5);
	});

	test('top, side and iso visible normals solve along their canonical axes', () => {
		const cases: Array<[Camera, readonly [number, number, number]]> = [
			[perspective([0, 10, 0.001]), [1, 0, 0]],
			[perspective([0.001, 2, 10]), [0, 1, 0]],
			[perspective([10, 8, 12]), [0, 0, 1]]
		];
		for (const [camera, axis] of cases) {
			const result = signedSolve(camera, axis, 80);
			expect(result.distance).toBeGreaterThan(0);
			expect(result.screenPixels).toBeGreaterThanOrEqual(68);
			expect(result.screenPixels).toBeLessThanOrEqual(92);
		}
	});

	test('reversing pointer motion reverses the signed distance', () => {
		const camera = perspective([10, 8, 12]);
		const positive = signedSolve(camera, [1, 0, 0], 90);
		const negative = signedSolve(camera, [1, 0, 0], -90);
		expect(positive.distance).toBeGreaterThan(0);
		expect(negative.distance).toBeLessThan(0);
		expect(positive.screenPixels).toBeGreaterThanOrEqual(76.5);
		expect(positive.screenPixels).toBeLessThanOrEqual(103.5);
		expect(negative.screenPixels).toBeGreaterThanOrEqual(76.5);
		expect(negative.screenPixels).toBeLessThanOrEqual(103.5);
	});
});
