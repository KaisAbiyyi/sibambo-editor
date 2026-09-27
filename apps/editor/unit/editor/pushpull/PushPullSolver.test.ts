import { describe, expect, test } from 'bun:test';
import { PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';
import { createPlane, createRectangle, extrudeFace, triangulateExtrusion } from '../../../src/lib/editor/geometry/editable-geometry';
import { EXTRUSION_EPSILON, projectToScreen, PushPullSolver } from '../../../src/lib/editor/pushpull/PushPullSolver';

describe('PushPullSolver', () => {
	const solver = new PushPullSolver();
	const canvasWidth = 1000;
	const canvasHeight = 1000;

	function setupCamera(pos: Vector3, lookAtTarget: Vector3 = new Vector3(0, 0, 0)): PerspectiveCamera {
		const camera = new PerspectiveCamera(45, canvasWidth / canvasHeight, 0.1, 1000);
		camera.position.copy(pos);
		camera.lookAt(lookAtTarget);
		camera.updateMatrixWorld(true);
		camera.updateProjectionMatrix();
		return camera;
	}

	function makeRaycaster(camera: PerspectiveCamera, pointerPx: Vector2): Raycaster {
		const normPointer = new Vector2(
			(pointerPx.x / canvasWidth) * 2 - 1,
			-(pointerPx.y / canvasHeight) * 2 + 1
		);
		const raycaster = new Raycaster();
		raycaster.setFromCamera(normPointer, camera);
		return raycaster;
	}

	test('CASE A: normal projected upward -> pointer upward is positive, downward is negative', () => {
		// Camera at (0, 0, 10) looking at (0, 0, 0)
		const camera = setupCamera(new Vector3(0, 0, 10));
		const anchor = new Vector3(0, 0, 0);
		const normal = new Vector3(0, 1, 0); // Normal points UP (+Y)
		const startPointer = new Vector2(500, 500); // Center

		// Pointer moves UP on screen (Y decreases from 500 to 400)
		const pointerUp = new Vector2(500, 400);
		const resultUp = solver.solve({
			anchorPoint: anchor,
			faceNormal: normal,
			raycaster: makeRaycaster(camera, pointerUp),
			camera,
			canvasWidth,
			canvasHeight,
			pointerPx: pointerUp,
			startPointerPx: startPointer
		});

		expect(resultUp).not.toBeNull();
		expect(resultUp!.distance).toBeGreaterThan(0);
		expect(resultUp!.label).toContain('+');

		// Pointer moves DOWN on screen (Y increases from 500 to 600)
		const pointerDown = new Vector2(500, 600);
		const resultDown = solver.solve({
			anchorPoint: anchor,
			faceNormal: normal,
			raycaster: makeRaycaster(camera, pointerDown),
			camera,
			canvasWidth,
			canvasHeight,
			pointerPx: pointerDown,
			startPointerPx: startPointer
		});

		expect(resultDown).not.toBeNull();
		expect(resultDown!.distance).toBeLessThan(0);
		expect(resultDown!.label.startsWith('-')).toBe(true);
	});

	test('CASE B: normal projected right -> pointer right is positive, left is negative', () => {
		const camera = setupCamera(new Vector3(0, 0, 10));
		const anchor = new Vector3(0, 0, 0);
		const normal = new Vector3(1, 0, 0); // Normal points RIGHT (+X)
		const startPointer = new Vector2(500, 500);

		// Pointer moves RIGHT (X increases from 500 to 600)
		const pointerRight = new Vector2(600, 500);
		const resultRight = solver.solve({
			anchorPoint: anchor,
			faceNormal: normal,
			raycaster: makeRaycaster(camera, pointerRight),
			camera,
			canvasWidth,
			canvasHeight,
			pointerPx: pointerRight,
			startPointerPx: startPointer
		});

		expect(resultRight).not.toBeNull();
		expect(resultRight!.distance).toBeGreaterThan(0);

		// Pointer moves LEFT (X decreases from 500 to 400)
		const pointerLeft = new Vector2(400, 500);
		const resultLeft = solver.solve({
			anchorPoint: anchor,
			faceNormal: normal,
			raycaster: makeRaycaster(camera, pointerLeft),
			camera,
			canvasWidth,
			canvasHeight,
			pointerPx: pointerLeft,
			startPointerPx: startPointer
		});

		expect(resultLeft).not.toBeNull();
		expect(resultLeft!.distance).toBeLessThan(0);
	});

	test('CASE C: camera rotated 180 degrees -> positive stays world face normal', () => {
		const anchor = new Vector3(0, 0, 0);
		const normal = new Vector3(1, 0, 0); // World normal points +X
		const startPointer = new Vector2(500, 500);

		// Front camera (0, 0, 10)
		const cameraFront = setupCamera(new Vector3(0, 0, 10));
		// In front view, +X is to the right
		const pointerRightFront = new Vector2(600, 500);
		const resFront = solver.solve({
			anchorPoint: anchor,
			faceNormal: normal,
			raycaster: makeRaycaster(cameraFront, pointerRightFront),
			camera: cameraFront,
			canvasWidth,
			canvasHeight,
			pointerPx: pointerRightFront,
			startPointerPx: startPointer
		});
		expect(resFront!.distance).toBeGreaterThan(0);

		// Rear camera (0, 0, -10) looking at (0, 0, 0)
		const cameraRear = setupCamera(new Vector3(0, 0, -10));
		// In rear view, world +X is to the LEFT on screen!
		const pointerLeftRear = new Vector2(400, 500);
		const resRear = solver.solve({
			anchorPoint: anchor,
			faceNormal: normal,
			raycaster: makeRaycaster(cameraRear, pointerLeftRear),
			camera: cameraRear,
			canvasWidth,
			canvasHeight,
			pointerPx: pointerLeftRear,
			startPointerPx: startPointer
		});
		expect(resRear!.distance).toBeGreaterThan(0); // Moving towards world +X is still positive!
	});

	test('CASE D: vertical wall orientation', () => {
		const camera = setupCamera(new Vector3(5, 5, 10));
		const anchor = new Vector3(2, 0, 0);
		const normal = new Vector3(0, 0, 1); // Wall normal facing +Z
		const startPointer = new Vector2(500, 500);

		const pointer = new Vector2(550, 450);
		const result = solver.solve({
			anchorPoint: anchor,
			faceNormal: normal,
			raycaster: makeRaycaster(camera, pointer),
			camera,
			canvasWidth,
			canvasHeight,
			pointerPx: pointer,
			startPointerPx: startPointer
		});

		expect(result).not.toBeNull();
		expect(Number.isFinite(result!.distance)).toBe(true);
	});

	test('CASE E: horizontal floor orientation', () => {
		const camera = setupCamera(new Vector3(0, 10, 5));
		const anchor = new Vector3(0, 0, 0);
		const normal = new Vector3(0, 1, 0); // Upward floor normal +Y
		const startPointer = new Vector2(500, 500);

		const pointerUp = new Vector2(500, 300);
		const result = solver.solve({
			anchorPoint: anchor,
			faceNormal: normal,
			raycaster: makeRaycaster(camera, pointerUp),
			camera,
			canvasWidth,
			canvasHeight,
			pointerPx: pointerUp,
			startPointerPx: startPointer
		});

		expect(result).not.toBeNull();
		expect(result!.distance).toBeGreaterThan(0);
	});

	test('CASE F: sloped roof orientation', () => {
		const camera = setupCamera(new Vector3(5, 10, 10));
		const anchor = new Vector3(0, 3, 0);
		const normal = new Vector3(0, 0.707, 0.707).normalize(); // 45-degree sloped roof
		const startPointer = new Vector2(500, 500);

		const pA = projectToScreen(anchor, camera, canvasWidth, canvasHeight);
		const pAN = projectToScreen(anchor.clone().add(normal), camera, canvasWidth, canvasHeight);
		const normDirPx = pAN.clone().sub(pA).normalize();
		const pointerInNormalDir = startPointer.clone().add(normDirPx.clone().multiplyScalar(100));

		const result = solver.solve({
			anchorPoint: anchor,
			faceNormal: normal,
			raycaster: makeRaycaster(camera, pointerInNormalDir),
			camera,
			canvasWidth,
			canvasHeight,
			pointerPx: pointerInNormalDir,
			startPointerPx: startPointer
		});

		expect(result).not.toBeNull();
		expect(result!.distance).toBeGreaterThan(0);
	});

	test('CASE G: near-degenerate ray/axis relation triggers fallback smoothly', () => {
		// Camera looking almost directly along normal: camera at (0, 10, 0.01) looking at (0, 0, 0), normal = (0, 1, 0)
		const camera = setupCamera(new Vector3(0, 10, 0.01));
		const anchor = new Vector3(0, 0, 0);
		const normal = new Vector3(0, 1, 0);
		const startPointer = new Vector2(500, 500);

		const pointer = new Vector2(500, 400);
		const result = solver.solve({
			anchorPoint: anchor,
			faceNormal: normal,
			raycaster: makeRaycaster(camera, pointer),
			camera,
			canvasWidth,
			canvasHeight,
			pointerPx: pointer,
			startPointerPx: startPointer
		});

		expect(result).not.toBeNull();
		expect(result!.isDegenerate).toBe(true);
		expect(Number.isFinite(result!.distance)).toBe(true);
	});

	test('CASE H: crossing origin smoothly changes sign and handles epsilon', () => {
		const camera = setupCamera(new Vector3(0, 0, 10));
		const anchor = new Vector3(0, 0, 0);
		const normal = new Vector3(0, 1, 0);
		const startPointer = new Vector2(500, 500);

		// Exactly at start pointer -> distance = 0
		const resZero = solver.solve({
			anchorPoint: anchor,
			faceNormal: normal,
			raycaster: makeRaycaster(camera, startPointer),
			camera,
			canvasWidth,
			canvasHeight,
			pointerPx: startPointer,
			startPointerPx: startPointer
		});
		expect(resZero!.distance).toBe(0);
		expect(resZero!.label).toBe('0.000 m');

		// Very tiny displacement (< 1mm) -> clamped to 0
		const tinyPointer = new Vector2(500, 499.99);
		const resTiny = solver.solve({
			anchorPoint: anchor,
			faceNormal: normal,
			raycaster: makeRaycaster(camera, tinyPointer),
			camera,
			canvasWidth,
			canvasHeight,
			pointerPx: tinyPointer,
			startPointerPx: startPointer
		});
		expect(resTiny!.distance).toBe(0);

		// Positive movement -> + distance
		const posPointer = new Vector2(500, 400);
		const resPos = solver.solve({
			anchorPoint: anchor,
			faceNormal: normal,
			raycaster: makeRaycaster(camera, posPointer),
			camera,
			canvasWidth,
			canvasHeight,
			pointerPx: posPointer,
			startPointerPx: startPointer
		});
		expect(resPos!.distance).toBeGreaterThan(0);
		expect(resPos!.label).toContain('+');

		// Negative movement -> - distance
		const negPointer = new Vector2(500, 600);
		const resNeg = solver.solve({
			anchorPoint: anchor,
			faceNormal: normal,
			raycaster: makeRaycaster(camera, negPointer),
			camera,
			canvasWidth,
			canvasHeight,
			pointerPx: negPointer,
			startPointerPx: startPointer
		});
		expect(resNeg!.distance).toBeLessThan(0);
		expect(resNeg!.label.startsWith('-')).toBe(true);
	});

	test('Performance microbenchmark: 10,000 solves and 500 preview updates', () => {
		const camera = setupCamera(new Vector3(5, 5, 10));
		const anchor = new Vector3(0, 0, 0);
		const normal = new Vector3(0, 1, 0);
		const startPointer = new Vector2(500, 500);

		// 1. Solve 10,000 times
		const solveTimes: number[] = [];
		for (let i = 0; i < 10000; i++) {
			const px = new Vector2(500 + (i % 100) - 50, 500 - (i % 50));
			const raycaster = makeRaycaster(camera, px);
			const t0 = performance.now();
			solver.solve({
				anchorPoint: anchor,
				faceNormal: normal,
				raycaster,
				camera,
				canvasWidth,
				canvasHeight,
				pointerPx: px,
				startPointerPx: startPointer
			});
			solveTimes.push(performance.now() - t0);
		}
		solveTimes.sort((a, b) => a - b);
		const solverP50 = solveTimes[Math.floor(solveTimes.length * 0.50)];
		const solverP95 = solveTimes[Math.floor(solveTimes.length * 0.95)];

		// 2. Preview update 500 times
		const plane = createPlane([0, 0, 0], [0, 1, 0], [1, 0, 0]);
		const rect = createRectangle('test-rect', plane, [0, 0, 0], [2, 0, 2]);
		const previewTimes: number[] = [];

		for (let i = 0; i < 500; i++) {
			const dist = 0.1 + (i % 50) * 0.1;
			const t0 = performance.now();
			const extrusion = extrudeFace(rect, dist);
			if (extrusion) {
				triangulateExtrusion(extrusion);
			}
			previewTimes.push(performance.now() - t0);
		}
		previewTimes.sort((a, b) => a - b);
		const previewP50 = previewTimes[Math.floor(previewTimes.length * 0.50)];
		const previewP95 = previewTimes[Math.floor(previewTimes.length * 0.95)];

		console.log(`[Push/Pull Benchmark] Solver p50: ${solverP50.toFixed(4)} ms | p95: ${solverP95.toFixed(4)} ms`);
		console.log(`[Push/Pull Benchmark] Preview p50: ${previewP50.toFixed(4)} ms | p95: ${previewP95.toFixed(4)} ms`);

		expect(solverP95).toBeLessThan(1.0); // Should be well under 1ms
		expect(previewP95).toBeLessThan(1.0);
	});
});
