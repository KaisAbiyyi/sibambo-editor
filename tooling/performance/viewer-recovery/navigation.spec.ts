import { expect, test } from '@playwright/test';
import { captureSourceIdentity, percentile, persistRecoveryReport } from './reporting.js';

test('prepared viewport follows cursor rays, acquires the near orbit boundary and enters a hollow scene', async ({ page, browser }, testInfo) => {
	test.setTimeout(120_000);
	const sourceIdentityBefore = captureSourceIdentity();
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
	let report: Record<string, unknown> = {};
	try {
		await page.goto('/');
		await expect(page.locator('#status')).toContainText('ready');
		await page.evaluate(async () => (window as any).__viewerRecovery.initializeHollow(false));
		const origin = await page.evaluate(() => (window as any).__viewerRecovery.setPose([-5, 1.6, 5], [10, 1.6, 5]));
		const orbitAcquisition = await page.evaluate(() => (window as any).__viewerRecovery.beginOrbit());
		expect(orbitAcquisition.snapshot.orbitAnchor).toEqual([0, 0, 5]);
		expect(orbitAcquisition.after.position).toEqual(orbitAcquisition.before.position);
		expect(orbitAcquisition.after.target).toEqual(orbitAcquisition.before.target);

		const canvasBox = await page.locator('#viewer canvas').boundingBox();
		if (!canvasBox) throw new Error('Prepared viewport canvas has no browser bounds.');
		const centerY = canvasBox.y + canvasBox.height / 2;
		const start = [-5, 1.6, 5] as [number, number, number];
		const target = [10, 1.6, 5] as [number, number, number];
		await page.evaluate(([position, lookAt]) => (window as any).__viewerRecovery.setPose(position, lookAt), [start, target]);
		const perspectiveBefore = await page.evaluate(() => (window as any).__viewerRecovery.observation());
		const leftBefore = await page.evaluate(() => (window as any).__viewerRecovery.pose());
		const leftResult = await page.evaluate(([x, y]) => (window as any).__viewerRecovery.dispatchWheel(-100, x, y), [canvasBox.x + canvasBox.width * 0.25, centerY]);
		const leftAfter = leftResult.pose;
		const leftForwardDot = forwardDot(leftBefore, leftAfter);
		const leftLateral = leftAfter.position[2] - leftBefore.position[2];
		const perspectiveAfterLeft = await page.evaluate(() => (window as any).__viewerRecovery.observation());
		await page.evaluate(([position, lookAt]) => (window as any).__viewerRecovery.setPose(position, lookAt), [start, target]);
		const rightBefore = await page.evaluate(() => (window as any).__viewerRecovery.pose());
		const rightResult = await page.evaluate(([x, y]) => (window as any).__viewerRecovery.dispatchWheel(-100, x, y), [canvasBox.x + canvasBox.width * 0.75, centerY]);
		const rightAfter = rightResult.pose;
		const rightForwardDot = forwardDot(rightBefore, rightAfter);
		const rightLateral = rightAfter.position[2] - rightBefore.position[2];
		const perspectiveAfterRight = await page.evaluate(() => (window as any).__viewerRecovery.observation());
		expect(leftResult.prevented).toBe(true);
		expect(leftForwardDot).toBeGreaterThanOrEqual(1 - 1e-7);
		expect(rightForwardDot).toBeGreaterThanOrEqual(1 - 1e-7);
		expect(leftLateral).toBeLessThan(0);
		expect(rightLateral).toBeGreaterThan(0);
		expect(perspectiveAfterLeft.camera.fov).toBe(perspectiveBefore.camera.fov);
		expect(perspectiveAfterRight.camera.fov).toBe(perspectiveBefore.camera.fov);
		expect(distance(leftAfter.position, leftAfter.target)).toBeCloseTo(distance(leftBefore.position, leftBefore.target), 9);

		await page.evaluate(() => (window as any).__viewerRecovery.setOrthographic());
		const orthographicBefore = await page.evaluate(() => (window as any).__viewerRecovery.observation());
		const orthographicPoseBefore = await page.evaluate(() => (window as any).__viewerRecovery.pose());
		await page.evaluate(() => (window as any).__viewerRecovery.dispatchWheel(-100));
		const orthographicAfter = await page.evaluate(() => (window as any).__viewerRecovery.observation());
		const orthographicPoseAfter = await page.evaluate(() => (window as any).__viewerRecovery.pose());
		expect(orthographicBefore.camera.projection).toBe('orthographic');
		expect(orthographicAfter.camera.projection).toBe('orthographic');
		expect(orthographicAfter.camera.zoom).toBeGreaterThan(orthographicBefore.camera.zoom);
		expect(orthographicPoseAfter.position).not.toEqual(orthographicPoseBefore.position);

		await page.evaluate(async () => (window as any).__viewerRecovery.initializeHollow(false));
		const doorwayWalk = await page.evaluate(() => (window as any).__viewerRecovery.walkThroughDoorway(80));
		expect(sourceLabel(doorwayWalk.initialHit, doorwayWalk.state.sourceLabels)).toBe('interior-wall-x5');
		expect(doorwayWalk.steps.length).toBeLessThanOrEqual(80);
		expect(doorwayWalk.transition).not.toBeNull();
		expect(doorwayWalk.transition.cameraX).toBeGreaterThan(0);
		expect(sourceLabel(doorwayWalk.transition.hit, doorwayWalk.state.sourceLabels)).toBe('interior-wall-x5');

		await page.evaluate(async () => (window as any).__viewerRecovery.initializeHollow(true));
		const smallScenePerformance = await page.evaluate(() => (window as any).__viewerRecovery.measureWheelBurst(40, -100));
		const smallHandlerP95Ms = percentile(smallScenePerformance.measuredEvents, 0.95);
		const smallQueryP95Ms = percentile(smallScenePerformance.queryEvents.slice(-20), 0.95);
		const closedWallWalk = await page.evaluate(() => (window as any).__viewerRecovery.walkThroughExterior(80));
		const wallSteps = closedWallWalk.steps.filter((step: any) => /^outer-/.test(sourceLabel(step.hitBefore, closedWallWalk.state.sourceLabels) ?? ''));
		const transitionStep = closedWallWalk.transition ? closedWallWalk.steps[closedWallWalk.transition.index - 1] : null;
		const precedingStep = transitionStep ? closedWallWalk.steps[closedWallWalk.transition.index - 2] : null;
		expect(sourceLabel(closedWallWalk.initialHit, closedWallWalk.state.sourceLabels)).toBe('outer-front-0');
		expect(closedWallWalk.steps.length).toBeLessThanOrEqual(80);
		expect(closedWallWalk.transition).not.toBeNull();
		expect(closedWallWalk.transition.cameraX).toBeGreaterThan(0);
		expect(sourceLabel(closedWallWalk.transition.hit, closedWallWalk.state.sourceLabels)).toBe('interior-wall-x5');
		expect(wallSteps.length).toBeGreaterThan(2);
		expect(wallSteps.at(-1).appliedStep).toBeLessThan(wallSteps[0].appliedStep);
		if (transitionStep && precedingStep) expect(transitionStep.appliedStep).toBeLessThanOrEqual(Math.max(precedingStep.appliedStep * 1.5, 0.005) + 1e-9);
		expect(smallHandlerP95Ms).not.toBeNull();
		expect(smallHandlerP95Ms!).toBeLessThanOrEqual(50);
		expect(smallQueryP95Ms).not.toBeNull();
		expect(smallQueryP95Ms!).toBeLessThanOrEqual(50);
		expect(pageErrors).toEqual([]);
		expect(consoleErrors).toEqual([]);
		report = {
			case: 'generated hollow navigation geometry', browserVersion: browser.version(), sourceIdentityBefore,
			generatedGeometry: { footprintXZ: [0, 10], groundY: 0, exteriorDoorwayZ: [4, 6], interiorWallX: 5, closedExteriorX: [0, 0.05] },
			orbitAcquisition, cursorDolly: { leftResult, leftForwardDot, leftLateral, rightResult, rightForwardDot, rightLateral, perspectiveBefore, perspectiveAfterLeft, perspectiveAfterRight },
			orthographic: { before: orthographicBefore, after: orthographicAfter, poseBefore: orthographicPoseBefore, poseAfter: orthographicPoseAfter },
			doorwayWalk, closedWallWalk,
			smallScenePerformance: { warmedEvents: smallScenePerformance.warmedEvents, measuredEvents: smallScenePerformance.measuredEvents.length, handlerP95Ms: smallHandlerP95Ms, queryP95Ms: smallQueryP95Ms, eventMs: smallScenePerformance.measuredEvents, queryMs: smallScenePerformance.queryEvents },
			pageErrors, consoleErrors, recordedAt: new Date().toISOString()
		};
	} finally {
		const sourceIdentityAfter = captureSourceIdentity();
		report = { ...report, sourceIdentityAfter, sourceIdentityMatched: JSON.stringify(sourceIdentityBefore) === JSON.stringify(sourceIdentityAfter), recordedAt: new Date().toISOString() };
		persistRecoveryReport('navigation', report);
		await page.evaluate(() => (window as any).__viewerRecovery?.dispose()).catch(() => undefined);
	}
});

test('real prepared input has no acquisition jump and disposal removes active pointer ownership', async ({ page }, testInfo) => {
	test.setTimeout(120_000);
	const sourceIdentityBefore = captureSourceIdentity();
	let report: Record<string, unknown> = {};
	try {
		await page.goto('/');
		await expect(page.locator('#status')).toContainText('ready');
		await page.evaluate(async () => (window as any).__viewerRecovery.initializeHollow(false));
		await page.evaluate(() => (window as any).__viewerRecovery.setPose([-5, 1.6, 5], [10, 1.6, 5]));
		const canvasBox = await page.locator('#viewer canvas').boundingBox();
		if (!canvasBox) throw new Error('Prepared viewport canvas has no browser bounds.');
		const x = canvasBox.x + canvasBox.width / 2;
		const y = canvasBox.y + canvasBox.height / 2;
		const poseBeforeDown = await page.evaluate(() => (window as any).__viewerRecovery.pose());
		await page.mouse.move(x, y);
		await page.mouse.down({ button: 'middle' });
		const stateAfterDown = await page.evaluate(() => (window as any).__viewerRecovery.snapshot());
		expect(distance(poseBeforeDown.position, stateAfterDown.pose.position)).toBeLessThanOrEqual(1e-7);
		expect(stateAfterDown.currentDragSnapshot).toMatchObject({ tool: 'orbit', orbitAnchor: [0, 0, 5] });
		await page.mouse.move(x + 36, y + 14, { steps: 3 });
		const moved = await page.evaluate(() => (window as any).__viewerRecovery.pose());
		await page.mouse.up({ button: 'middle' });
		const stateAfterUp = await page.evaluate(() => (window as any).__viewerRecovery.snapshot());
		expect(distance(poseBeforeDown.position, moved.position)).toBeGreaterThan(0);
		expect(stateAfterUp.gestureCounts.begins).toBe(1);
		expect(stateAfterUp.gestureCounts.drags).toBeGreaterThan(0);
		expect(stateAfterUp.gestureCounts.ends).toBe(1);
		expect(stateAfterUp.gestureCounts.activeCaptures).toBe(0);

		await page.mouse.down({ button: 'middle' });
		const disposed = await page.evaluate(() => (window as any).__viewerRecovery.disposeAndVerifyPostInput());
		await page.mouse.up({ button: 'middle' });
		expect(disposed.disposed).toBe(true);
		expect(disposed.capturesBefore).toBeGreaterThan(0);
		expect(disposed.capturesAfter).toBe(0);
		expect(distance(disposed.before.position, disposed.after.position)).toBeLessThanOrEqual(1e-7);
		expect(distance(disposed.before.target, disposed.after.target)).toBeLessThanOrEqual(1e-7);
		expect(disposed.postDisposeWheelPrevented).toBe(false);
		expect(disposed.postDisposePointerPrevented).toBe(false);
		expect(disposed.postDisposeCanvasCaptured).toBe(false);
		expect(disposed.countsAfterDispose).toEqual(disposed.countsAfterInput);
		report = { case: 'real prepared camera pointer and disposal', sourceIdentityBefore, stateAfterDown, moved, stateAfterUp, disposed, recordedAt: new Date().toISOString() };
	} finally {
		const sourceIdentityAfter = captureSourceIdentity();
		report = { ...report, sourceIdentityAfter, sourceIdentityMatched: JSON.stringify(sourceIdentityBefore) === JSON.stringify(sourceIdentityAfter), recordedAt: new Date().toISOString() };
		persistRecoveryReport('prepared-input', report);
		await page.evaluate(() => (window as any).__viewerRecovery?.dispose()).catch(() => undefined);
	}
});

function distance(first: number[], second: number[]) {
	return Math.hypot(first[0]! - second[0]!, first[1]! - second[1]!, first[2]! - second[2]!);
}

function forwardDot(before: { position: number[]; target: number[] }, after: { position: number[]; target: number[] }) {
	const first = normalize(before.target.map((value, index) => value - before.position[index]!));
	const second = normalize(after.target.map((value, index) => value - after.position[index]!));
	return first.reduce((sum, value, index) => sum + value * second[index]!, 0);
}

function normalize(vector: number[]) {
	const length = Math.hypot(...vector);
	return vector.map((value) => value / length);
}

function sourceLabel(hit: { sourceMeshIndex: number | null } | null, labels: Record<number, string> | null) {
	return hit && labels ? labels[hit.sourceMeshIndex!] : null;
}
