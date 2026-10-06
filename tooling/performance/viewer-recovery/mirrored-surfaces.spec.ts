import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { markProofOutcome, readProofTicket } from '../../testing/proof-run-contract';
import { captureSourceIdentity, persistRecoveryReport } from './reporting.js';

type Capture = { screenshotBase64: string; observation: any; camera: { near: number; far: number } };
type RecoveryApi = {
	loadFixture(id: 'S1-new' | 'S2-new'): Promise<any>;
	prepareDoorComparison(): Promise<any>;
	probeOrdinaryOracleVisibility(): any;
	waitDoorReady(timeoutMs?: number): Promise<any>;
	doorSnapshot(): Promise<any>;
	captureDoorPose(position: [number, number, number], target: [number, number, number]): Promise<{ candidate: Capture; oracle: Capture }>;
	setDoorSourceLinesVisible(visible: boolean): unknown;
	captureRepeatedDoorPose(position: [number, number, number], target: [number, number, number]): Promise<{ candidate: string[]; oracle: string[] }>;
	comparePixelCaptures(candidate: string, oracle: string): Promise<any>;
	runMirrorFixture(): Promise<any>;
	captureMirrorFace(face: 'front' | 'back'): Promise<any>;
	mirrorPick(handle: string, point: [number, number, number]): any;
	mirrorFilter(handle: string | null): any;
	mirrorEdgeSnapshot(handle: string): number[][];
	mirrorMove(handle: string, offset: [number, number, number] | null): any;
	mirrorState(): any;
	loadS1SourceComparison(): Promise<any>;
	waitFrames(count?: number): Promise<void>;
	observation(): any;
	snapshot(): any;
	verifyDoorOpening(): any;
	disposeAndVerifyPostInput(): any;
	dispose(): any;
};
type RecoveryWindow = Window & { __viewerRecovery: RecoveryApi };

function evaluateRecovery(page: Page, expression: (...args: any[]) => any, argument?: any): Promise<any> {
	return page.evaluate<any, any>(expression, argument);
}

const runRoot = path.resolve(process.env.SIBAMBO_RECOVERY_WORKLOG || '');
const attempt = process.env.SIBAMBO_RECOVERY_ATTEMPT!;

function markOutcome(testInfo: TestInfo) {
	if (process.env.SIBAMBO_PROOF_TICKET) markProofOutcome(readProofTicket('mirror'), testInfo.title);
}

test('mirror front/back rendering preserves source identity through filter and movement', async ({ page }, testInfo) => {
	test.setTimeout(180_000);
	const sourceIdentityBefore = captureSourceIdentity();
	const pageErrors: string[] = []; const consoleErrors: string[] = [];
	let report: Record<string, any> = { planId: 'BOMC-EDITOR-STABILITY-001', planVersion: '1.1', test: testInfo.title, reachedStage: 'startup', sourceIdentityBefore };
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
	try {
		await page.goto('/');
		markOutcome(testInfo);
		await expect(page.locator('#status')).toContainText('ready');
		const initial = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.runMirrorFixture());
		report.initial = initial;
		expect(initial.sourcePositionsNormalsUvsUnchanged).toBe(true);
		expect(initial.sourceEdgesUnchanged).toBe(true);
		expect(initial.visibleDeterminants.every((value: number) => value > 0)).toBe(true);
		expect(initial.groups).toHaveLength(4);
		expect(initial.groups.map((group: any) => group.side)).toEqual(['front', 'front', 'back', 'back']);
		expect(initial.groups.every((group: any) => group.ordinals.length === group.handles.length)).toBe(true);
		expect(initial.groups.some((group: any) => group.handles.includes('mirror') && group.ordinals.includes(1))).toBe(true);
		expect(initial.groups.some((group: any) => group.handles.includes('shear-mirror') && group.ordinals.includes(3))).toBe(true);
		expect(initial.groups.every((group: any) => group.sourceFaces.every((face: number) => face === 100))).toBe(true);
		expect(initial.groups.every((group: any) => JSON.stringify(group.uvs) === JSON.stringify([0, 0, 1, 0, 1, 1, 0, 1]))).toBe(true);

		const faceEvidence: Record<string, any> = {};
		for (const face of ['front', 'back'] as const) {
			const pair = await evaluateRecovery(page, (value) => (window as RecoveryWindow).__viewerRecovery.captureMirrorFace(value), face);
			const candidatePath = writePng(testInfo, `mirror-${face}-candidate.png`, pair.candidate.screenshotBase64);
			const oraclePath = writePng(testInfo, `mirror-${face}-ordinary.png`, pair.oracle.screenshotBase64);
			const comparison = await evaluateRecovery(page, ([candidate, oracle]) => (window as RecoveryWindow).__viewerRecovery.comparePixelCaptures(candidate, oracle), [pair.candidate.screenshotBase64, pair.oracle.screenshotBase64]);
			expect(comparison.normalizedMeanAbsoluteRgb).toBeLessThanOrEqual(0.03);
			expect(comparison.fractionPixelsAnyChannelOverTwo).toBeLessThanOrEqual(0.002);
			const samples = pair.samples.candidate as Array<{ handle: string; rgba: number[] }>;
			if (face === 'front') for (const sample of samples) expect(sample.rgba[0]).toBeGreaterThan(sample.rgba[2] * 1.2);
			else for (const sample of samples) expect(sample.rgba[2]).toBeGreaterThan(sample.rgba[0] * 1.2);
			faceEvidence[face] = { comparison, samples: pair.samples, candidatePath, oraclePath };
		}
		report.faceEvidence = faceEvidence;

		const originalPick = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.mirrorPick('mirror', [0.5, 0.5, 0]));
		expect(originalPick).toMatchObject({ occurrenceIndex: 1, occurrenceHandle: 'mirror', sourceFaceIndex: 100 });
		const edgesBefore = await evaluateRecovery(page, () => ({ mirror: (window as RecoveryWindow).__viewerRecovery.mirrorEdgeSnapshot('mirror'), positive: (window as RecoveryWindow).__viewerRecovery.mirrorEdgeSnapshot('positive') }));
		expect(edgesBefore.mirror.length).toBeGreaterThan(0);
		expect(edgesBefore.positive.length).toBeGreaterThan(0);
		const filteredPick = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.mirrorFilter('mirror'));
		const edgesWhileFiltered = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.mirrorEdgeSnapshot('mirror'));
		expect(filteredPick).toMatchObject({ occurrenceIndex: 1, occurrenceHandle: 'mirror', sourceFaceIndex: 100 });
		expect(edgesWhileFiltered).toEqual([]);
		await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.mirrorFilter(null));
		const restoredEdges = await evaluateRecovery(page, () => ({ mirror: (window as RecoveryWindow).__viewerRecovery.mirrorEdgeSnapshot('mirror'), positive: (window as RecoveryWindow).__viewerRecovery.mirrorEdgeSnapshot('positive') }));
		expect(restoredEdges.mirror).toEqual(edgesBefore.mirror);
		expect(restoredEdges.positive).toEqual(edgesBefore.positive);
		const movedState = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.mirrorMove('mirror', [0.25, 0, 0]));
		const edgesAfterMove = await evaluateRecovery(page, () => ({ mirror: (window as RecoveryWindow).__viewerRecovery.mirrorEdgeSnapshot('mirror'), positive: (window as RecoveryWindow).__viewerRecovery.mirrorEdgeSnapshot('positive') }));
		expect(edgesAfterMove.mirror).toHaveLength(edgesBefore.mirror.length);
		expect(edgesAfterMove.mirror.every((point: number[], index: number) => Math.abs(point[0]! - edgesBefore.mirror[index]![0]! - 0.25) < 1e-6 && Math.abs(point[1]! - edgesBefore.mirror[index]![1]!) < 1e-6 && Math.abs(point[2]! - edgesBefore.mirror[index]![2]!) < 1e-6)).toBe(true);
		expect(edgesAfterMove.positive).toEqual(edgesBefore.positive);
		const movedPick = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.mirrorPick('mirror', [0.5, 0.5, 0]));
		expect(movedPick).toMatchObject({ occurrenceIndex: 1, occurrenceHandle: 'mirror', sourceFaceIndex: 100 });
		const resetState = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.mirrorMove('mirror', null));
		const resetPick = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.mirrorPick('mirror', [0.5, 0.5, 0]));
		expect(resetPick).toMatchObject({ occurrenceIndex: 1, occurrenceHandle: 'mirror', sourceFaceIndex: 100 });
		expect(resetState.anchors).toEqual(initial.anchors);
		report.interaction = { originalPick, filteredPick, edgesBefore, edgesWhileFiltered, restoredEdges, movedState, edgesAfterMove, movedPick, resetPick, resetState };

		const box = await page.locator('#viewer canvas').boundingBox();
		if (!box) throw new Error('Candidate mirror viewport canvas has no browser bounds.');
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		const activePointer = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.snapshot());
		expect(activePointer.gestureCounts.activeCaptures).toBeGreaterThan(0);
		const disposal = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.disposeAndVerifyPostInput());
		await page.mouse.up();
		expect(disposal.disposed).toBe(true);
		expect(disposal.capturesBefore).toBeGreaterThan(0);
		expect(disposal.capturesAfter).toBe(0);
		expect(disposal.canvasConnectedAfter).toBe(false);
		expect(disposal.postDisposeWheelPrevented).toBe(false);
		expect(disposal.postDisposePointerPrevented).toBe(false);
		report.disposal = { activePointer, disposal };
		expect(pageErrors).toEqual([]);
		expect(consoleErrors).toEqual([]);
	} finally {
		report = { ...report, pageErrors, consoleErrors, observedStatus: testInfo.status, expectedStatus: testInfo.expectedStatus, errors: [...testInfo.errors.map((error) => error.message), ...pageErrors, ...consoleErrors], sourceIdentityAfter: captureSourceIdentity() };
		persistRecoveryReport('mirrored-surfaces-synthetic', report);
		await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery?.dispose()).catch(() => undefined);
	}
});

test('S2 mirrored door follows the raw ordinary renderer through orbit and zoom', async ({ page }, testInfo) => {
	test.setTimeout(180_000);
	const sourceIdentityBefore = captureSourceIdentity();
	const pageErrors: string[] = []; const consoleErrors: string[] = [];
	let report: Record<string, any> = { planId: 'BOMC-EDITOR-STABILITY-001', planVersion: '1.1', test: testInfo.title, reachedStage: 'startup', sourceIdentityBefore, expectedThresholds: { normalizedMeanAbsoluteRgb: 0.03, fractionPixelsAnyChannelOverTwo: 0.002 } };
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
	const measurements: any[] = [];
	try {
		await page.goto('/');
		markOutcome(testInfo);
		await expect(page.locator('#status')).toContainText('ready');
		const workerResult = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.loadFixture('S2-new'));
		report.reachedStage = 'candidate-worker-mounted';
		const oracleSetup = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.prepareDoorComparison());
		report.oracleSetup = oracleSetup;
		const visibilityProbe = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.probeOrdinaryOracleVisibility());
		report.visibilityProbe = visibilityProbe;
		expect(visibilityProbe).toMatchObject({ originalVisible: true, hiddenVisible: false, detachedVisible: false, restoredVisible: true, parentRestored: true, matrixRestored: true, visibilityRestored: true });
		const ready = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.waitDoorReady(30_000));
		report.ready = ready;
		const door = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.verifyDoorOpening());
		const initial = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.doorSnapshot());
		report.door = door;
		report.initialInventory = initial;
		expect(door.fixture).toMatchObject({ id: 'S2-new', bytes: 2_319_634, sha256: 'df19a9f07df845661d065b98b221dbcfc53e9ec2c3efe7a11f434b7fcb0ac452' });
		expect(door.workerLifecycle).toMatchObject({ created: 1, terminated: 1 });
		expect(door.effectiveHiddenNodeIndices).toContain(39);
		expect(door.cutterVisible).toBe(false);
		expect(door.frameVisible).toBe(true);
		expect(door.observation.appearance.faceStyle).toBe('shaded-textures');
		expect(door.observation.renderer.render.calls).toBeGreaterThan(0);
		expect(door.observation.renderer.render.triangles).toBeGreaterThan(0);
		for (const observation of [ready.candidate, ready.oracle]) {
			expect(observation.firstFrameAtMs).not.toBeNull();
			expect(observation.readyAtMs).not.toBeNull();
			expect(observation.renderer.render.calls).toBeGreaterThan(0);
			expect(observation.renderer.render.triangles).toBeGreaterThan(0);
			expect(observation.appearance.failedDecodePaths).toEqual([]);
			expect(observation.appearance.missingAssetPaths).toEqual([]);
			expect(observation.appearance.unsupportedTexturePaths).toEqual([]);
		}
		for (const inventory of [initial.candidateInventory, initial.oracleInventory]) {
			expect(inventory.requiredPathPresence).toEqual({ '0/49/48/47': true, '0/49/48/47/46/44': true, '0/49/48/47/46/45': true });
			expect(inventory.draws.some((row: any) => row.sourcePath === '0/49/48/47/46/44' && row.visible)).toBe(true);
			expect(inventory.draws.some((row: any) => row.sourcePath === '0/49/48/47/46/45' && row.visible)).toBe(true);
		}
		expect(Math.abs(ready.candidate.camera.near - ready.oracle.camera.near)).toBeLessThanOrEqual(1e-6);
		expect(Math.abs(ready.candidate.camera.far - ready.oracle.camera.far)).toBeLessThanOrEqual(1e-6);
		report.workerResult = workerResult;
		report.reachedStage = 'appearance-ready-and-inventory-accepted';

		const target: [number, number, number] = [10.48, 1.2, -3.503520113];
		const poses: Array<{ radius: number; angleDegrees: number; pass: 'forward' | 'reverse'; index: number }> = [];
		for (const radius of [1.2, 1.8, 2.6]) {
			const forward = Array.from({ length: 11 }, (_, index) => -7.5 + 1.5 * index);
			const reverse = Array.from({ length: 10 }, (_, index) => -7.5 + 1.5 * (9 - index));
			forward.forEach((angleDegrees, index) => poses.push({ radius, angleDegrees, pass: 'forward', index }));
			reverse.forEach((angleDegrees, index) => poses.push({ radius, angleDegrees, pass: 'reverse', index }));
		}
		expect(poses).toHaveLength(63);
		for (const pose of poses) {
			const radians = pose.angleDegrees * Math.PI / 180;
			const position: [number, number, number] = [target[0] + pose.radius * Math.cos(radians), target[1], target[2] + pose.radius * Math.sin(radians)];
			const pair = await evaluateRecovery(page, ([camera, lookAt]) => (window as RecoveryWindow).__viewerRecovery.captureDoorPose(camera, lookAt), [position, target]);
			const prefix = `pose-r${pose.radius.toFixed(1)}-${pose.pass}-${String(pose.index).padStart(2, '0')}-a${pose.angleDegrees.toFixed(1).replace('.', '_')}`;
			const candidatePath = writePng(testInfo, `${prefix}-candidate.png`, pair.candidate.screenshotBase64);
			const oraclePath = writePng(testInfo, `${prefix}-ordinary.png`, pair.oracle.screenshotBase64);
			const comparison = await evaluateRecovery(page, ([candidate, oracle]) => (window as RecoveryWindow).__viewerRecovery.comparePixelCaptures(candidate, oracle), [pair.candidate.screenshotBase64, pair.oracle.screenshotBase64]);
			const cameraNearDelta = Math.abs(pair.candidate.camera.near - pair.oracle.camera.near);
			const cameraFarDelta = Math.abs(pair.candidate.camera.far - pair.oracle.camera.far);
			measurements.push({ ...pose, cameraNearDelta, cameraFarDelta, comparison, candidatePath, oraclePath });
			expect(cameraNearDelta).toBeLessThanOrEqual(1e-6);
			expect(cameraFarDelta).toBeLessThanOrEqual(1e-6);
			expect(comparison.normalizedMeanAbsoluteRgb).toBeLessThanOrEqual(0.03);
			expect(comparison.fractionPixelsAnyChannelOverTwo).toBeLessThanOrEqual(0.002);
		}
		report.trajectoryMeasurements = measurements;
		report.reachedStage = '63-normal-source-line-poses-compared';

		await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.setDoorSourceLinesVisible(false));
		const noLineControls: any[] = [];
		try {
			for (const angleDegrees of [-7.5, 0, 7.5]) {
				const radians = angleDegrees * Math.PI / 180;
				const position: [number, number, number] = [target[0] + 1.2 * Math.cos(radians), target[1], target[2] + 1.2 * Math.sin(radians)];
				const pair = await evaluateRecovery(page, ([camera, lookAt]) => (window as RecoveryWindow).__viewerRecovery.captureDoorPose(camera, lookAt), [position, target]);
				const prefix = `control-lines-hidden-${angleDegrees.toFixed(1).replace('.', '_')}`;
				const candidatePath = writePng(testInfo, `${prefix}-candidate.png`, pair.candidate.screenshotBase64);
				const oraclePath = writePng(testInfo, `${prefix}-ordinary.png`, pair.oracle.screenshotBase64);
				const comparison = await evaluateRecovery(page, ([candidate, oracle]) => (window as RecoveryWindow).__viewerRecovery.comparePixelCaptures(candidate, oracle), [pair.candidate.screenshotBase64, pair.oracle.screenshotBase64]);
				expect(comparison.normalizedMeanAbsoluteRgb).toBeLessThanOrEqual(0.03);
				expect(comparison.fractionPixelsAnyChannelOverTwo).toBeLessThanOrEqual(0.002);
				noLineControls.push({ angleDegrees, comparison, candidatePath, oraclePath });
			}
		} finally {
			await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.setDoorSourceLinesVisible(true));
		}
		report.noLineControls = noLineControls;
		const repeated = await evaluateRecovery(page, ([camera, lookAt]) => (window as RecoveryWindow).__viewerRecovery.captureRepeatedDoorPose(camera, lookAt), [[target[0] + 1.2, target[1], target[2]], target]);
		for (let index = 0; index < 3; index += 1) {
			writePng(testInfo, `repeat-${index}-candidate.png`, repeated.candidate[index]!);
			writePng(testInfo, `repeat-${index}-ordinary.png`, repeated.oracle[index]!);
		}
		expect(repeated.candidate[1]).toBe(repeated.candidate[0]);
		expect(repeated.candidate[2]).toBe(repeated.candidate[0]);
		expect(repeated.oracle[1]).toBe(repeated.oracle[0]);
		expect(repeated.oracle[2]).toBe(repeated.oracle[0]);
		const repeatedComparison = await evaluateRecovery(page, ([candidate, oracle]) => (window as RecoveryWindow).__viewerRecovery.comparePixelCaptures(candidate, oracle), [repeated.candidate[0]!, repeated.oracle[0]!]);
		expect(repeatedComparison.normalizedMeanAbsoluteRgb).toBeLessThanOrEqual(0.03);
		expect(repeatedComparison.fractionPixelsAnyChannelOverTwo).toBeLessThanOrEqual(0.002);
		report.repeatedCentralPose = { repeated, comparison: repeatedComparison };
		report.reachedStage = 'all-render-comparisons-complete';
		expect(pageErrors).toEqual([]);
		expect(consoleErrors).toEqual([]);
	} finally {
		report = { ...report, trajectoryMeasurements: measurements, pageErrors, consoleErrors, observedStatus: testInfo.status, expectedStatus: testInfo.expectedStatus, errors: [...testInfo.errors.map((error) => error.message), ...pageErrors, ...consoleErrors], sourceIdentityAfter: captureSourceIdentity() };
		persistRecoveryReport('mirrored-surfaces-s2-door', report);
		await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery?.dispose()).catch(() => undefined);
	}
});

test('S1 mirrored preparation retains source data and disposes cleanly', async ({ page }, testInfo) => {
	test.setTimeout(180_000);
	const sourceIdentityBefore = captureSourceIdentity();
	const pageErrors: string[] = []; const consoleErrors: string[] = [];
	let report: Record<string, any> = { planId: 'BOMC-EDITOR-STABILITY-001', planVersion: '1.1', test: testInfo.title, reachedStage: 'startup', sourceIdentityBefore };
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
	try {
		await page.goto('/');
		markOutcome(testInfo);
		await expect(page.locator('#status')).toContainText('ready');
		const workerResult = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.loadFixture('S1-new'));
		await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.waitFrames(4));
		const observation = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.observation());
		const sourceComparison = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.loadS1SourceComparison());
		const snapshot = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.snapshot());
		report.workerResult = workerResult;
		report.observation = observation;
		report.sourceComparison = sourceComparison;
		report.snapshot = snapshot;
		report.reachedStage = 'raw-source-and-worker-result-compared';
		expect(workerResult.fixture).toMatchObject({ id: 'S1-new', bytes: 2_428_754, sha256: 'd306fb89c0a59edf5ecdbcaf26d27e795e521cceb1c689e59958e1038932918c' });
		expect(workerResult.workerLifecycle).toMatchObject({ created: 1, terminated: 1 });
		expect(sourceComparison.counts.candidate).toEqual(sourceComparison.counts.raw);
		expect(sourceComparison.modelName.candidate).toBe(sourceComparison.modelName.raw);
		expect(sourceComparison.materialAppearanceHashes.candidate).toBe(sourceComparison.materialAppearanceHashes.raw);
		expect(sourceComparison.preservation).toMatchObject({ countsMatch: true, materialsMatch: true, sourceFaceWeightsMatch: true, sourceOccurrenceWeightsMatch: true, sourceEdgesMatch: true, sceneVisibilityMatch: true });
		expect(sourceComparison.sourceSummaries.candidate.sourceMeshCount).toBe(sourceComparison.sourceSummaries.raw.sourceMeshCount);
		expect(sourceComparison.sourceSummaries.candidate.worldTriangleCount).toBe(sourceComparison.sourceSummaries.raw.worldTriangleCount);
		expect(sourceComparison.sourceSummaries.candidate.geometryStorage.positionValues).toBeGreaterThan(0);
		expect(observation.firstFrameAtMs).not.toBeNull();
		expect(observation.readyAtMs).not.toBeNull();
		expect(observation.renderer.render.calls).toBeGreaterThan(0);
		expect(observation.renderer.render.triangles).toBeGreaterThan(0);
		expect(observation.appearance.failedDecodePaths).toEqual([]);
		expect(observation.appearance.missingAssetPaths).toEqual([]);
		expect(observation.appearance.unsupportedTexturePaths).toEqual([]);
		expect(sourceComparison.visibleDeterminants.every((value: number) => Number.isFinite(value) && value >= 0)).toBe(true);
		expect(sourceComparison.sourceSummaries.candidate.faceWeights.length).toBeGreaterThan(0);
		const screenshotPath = testInfo.outputPath('s1-worker-viewport.png');
		mkdirSync(path.dirname(screenshotPath), { recursive: true });
		await page.locator('#viewer canvas').screenshot({ path: screenshotPath });
		const canvas = await page.locator('#viewer canvas').elementHandle();
		const disposal = await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery.disposeAndVerifyPostInput());
		const canvasConnectedAfter = canvas ? await canvas.evaluate((element) => element.isConnected) : null;
		expect(disposal.disposed).toBe(true);
		expect(disposal.canvasConnectedAfter).toBe(false);
		expect(canvasConnectedAfter).toBe(false);
		report.disposal = disposal;
		await canvas?.dispose();
		report.reachedStage = 'disposed';
		expect(pageErrors).toEqual([]);
		expect(consoleErrors).toEqual([]);
	} finally {
		report = { ...report, pageErrors, consoleErrors, observedStatus: testInfo.status, expectedStatus: testInfo.expectedStatus, errors: [...testInfo.errors.map((error) => error.message), ...pageErrors, ...consoleErrors], sourceIdentityAfter: captureSourceIdentity() };
		persistRecoveryReport('mirrored-surfaces-s1-source-and-disposal', report);
		await evaluateRecovery(page, () => (window as RecoveryWindow).__viewerRecovery?.dispose()).catch(() => undefined);
	}
});

function writePng(testInfo: TestInfo, name: string, base64: string) {
	const filePath = testInfo.outputPath(name);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, Buffer.from(base64, 'base64'), { flag: 'wx' });
	return filePath;
}
