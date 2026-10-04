import { expect, test } from '@playwright/test';
import { captureSourceIdentity, percentile, persistRecoveryReport } from './reporting.js';

test('S2-new Editor worker view keeps its cutter hidden and exposes a visible framed door', async ({ page, browser }, testInfo) => {
	test.setTimeout(120_000);
	const sourceIdentityBefore = captureSourceIdentity();
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	const workerRequests: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
	page.on('request', (request) => { if (request.url().includes('e4-import.worker')) workerRequests.push(request.url()); });
	let report: Record<string, unknown> = {};
	let screenshotPath: string | null = null;
	try {
		await page.goto('/');
		await expect(page.locator('#status')).toContainText('ready');
		await page.evaluate(async () => (window as any).__viewerRecovery.loadFixture('S2-new'));
		await page.evaluate(() => (window as any).__viewerRecovery.setPose([15, 1.2, -3.503520113], [10.48, 1.2, -3.503520113]));
		await page.evaluate(() => (window as any).__viewerRecovery.waitFrames(4));
		const door = await page.evaluate(() => (window as any).__viewerRecovery.verifyDoorOpening());
		screenshotPath = testInfo.outputPath('s2-door-normal-shaded-textures.png');
		await page.locator('#viewer canvas').screenshot({ path: screenshotPath });
		const performance = await page.evaluate(() => (window as any).__viewerRecovery.measureWheelBurst(40, -100));
		const result = await page.evaluate(() => (window as any).__viewerRecovery.snapshot());
		const handlerP95Ms = percentile(performance.measuredEvents as number[], 0.95);
		const queryP95Ms = percentile(performance.queryEvents as number[], 0.95);
		report = {
			case: 'S2-new Editor worker visibility and navigation query', fixture: door.fixture,
			browserVersion: browser.version(), sourceIdentityBefore, workerRequests, door,
			wheelPerformance: { warmedEvents: performance.warmedEvents, measuredEvents: performance.measuredEvents.length, handlerP95Ms, queryP95Ms, eventMs: performance.measuredEvents, queryMs: performance.queryEvents },
			finalSnapshot: result, screenshotPath, pageErrors, consoleErrors, recordedAt: new Date().toISOString()
		};
		expect(door.fixture).toMatchObject({ id: 'S2-new', bytes: 2_319_634, sha256: 'df19a9f07df845661d065b98b221dbcfc53e9ec2c3efe7a11f434b7fcb0ac452' });
		expect(door.workerLifecycle).toMatchObject({ created: 1, terminated: 1 });
		expect(door.workerLifecycle.urls).toHaveLength(1);
		expect(door.workerLifecycle.urls[0]).toContain('e4-import.worker');
		expect(door.effectiveHiddenNodeIndices).toContain(39);
		expect(door.cutterVisible).toBe(false);
		expect(door.frameVisible).toBe(true);
		expect(door.openingHit).not.toBeNull();
		expect(door.openingHit.sourceMeshIndex).not.toBe(25);
		expect(door.observation.appearance.faceStyle).toBe('shaded-textures');
		expect(door.observation.renderer.render.calls).toBeGreaterThan(0);
		expect(workerRequests.some((url) => url.includes('e4-import.worker'))).toBe(true);
		expect(handlerP95Ms).not.toBeNull();
		expect(handlerP95Ms!).toBeLessThanOrEqual(50);
		expect(queryP95Ms).not.toBeNull();
		expect(queryP95Ms!).toBeLessThanOrEqual(50);
		expect(pageErrors).toEqual([]);
		expect(consoleErrors).toEqual([]);
	} finally {
		const sourceIdentityAfter = captureSourceIdentity();
		report = { ...report, sourceIdentityAfter, sourceIdentityMatched: JSON.stringify(sourceIdentityBefore) === JSON.stringify(sourceIdentityAfter), recordedAt: new Date().toISOString() };
		persistRecoveryReport('door-visibility', report);
		await page.evaluate(() => (window as any).__viewerRecovery?.dispose()).catch(() => undefined);
	}
});
