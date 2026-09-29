import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { E4_PROVENANCE_POLICY_V1 } from '@sibambo/provenance/policies/e4-v1';
import { makeTinyBomc12 } from '../../../tooling/test-fixtures/tiny-bomc';

async function openDetails(details: Locator) {
	if (await details.evaluate((element) => (element as HTMLDetailsElement).open)) return;
	const summary = details.locator('summary');
	if (await summary.isVisible()) {
		await summary.click();
	} else {
		await details.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
	}
}

async function expectMobileReady(page: Page, modelId: string) {
	await expect(page.getByLabel('Imported source status').getByText(modelId, { exact: true })).toBeVisible({ timeout: 30000 });
	const ready = page.locator('.source-bar .ready');
	await expect(ready).toHaveText('Textures settled and first frame observed');
	await expect(ready).toBeHidden();
}

test('mobile file pickers are disabled while the first model is importing', async ({ browser }) => {
	test.setTimeout(60000);
	const context = await browser.newContext({
		baseURL: 'http://127.0.0.1:5175',
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true
	});
	const page = await context.newPage();
	const bytes = Buffer.from(makeTinyBomc12());
	const manifest = {
		schema: 'sibambo-research-provenance-v1', engine: 'e4',
		artifact: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, format: 'bomc-1.2', profile: 'exact' },
		producer: { label: 'Synthetic mobile import fixture', sourceTreeSha256: E4_PROVENANCE_POLICY_V1.producer.sourceTreeSha256![0] },
		model: { id: 'mobile-editor-importing' },
		capture: { id: 'mobile-editor-importing-capture', exportedAt: new Date().toISOString(), evidence: 'Generated structural test fixture; not an exporter capture.', method: 'operator-attested' }
	};
	let releaseWorker!: () => void;
	let markWorkerRequested!: () => void;
	const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
	const workerRequested = new Promise<void>((resolve) => { markWorkerRequested = resolve; });
	await page.route('**/*e4-import.worker*', async (route) => {
		markWorkerRequested();
		await workerGate;
		await route.continue();
	});
	try {
		await page.goto('/?renderer=webgl2');
		await page.getByLabel('BOMC 1.2 file').setInputFiles({ name: 'mobile-editor-importing.bomc', mimeType: 'application/octet-stream', buffer: bytes });
		await page.getByLabel('Provenance JSON for next model').setInputFiles({ name: 'mobile-editor-importing.provenance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(manifest)) });
		await page.getByRole('button', { name: 'Open model file' }).click();
		await workerRequested;
		await expect(page.getByRole('button', { name: 'Choose model file' })).toBeDisabled();
		await expect(page.getByLabel('Provenance JSON for next model')).toBeDisabled();
		releaseWorker();
		await expectMobileReady(page, 'mobile-editor-importing');
	} finally {
		releaseWorker();
		await context.close();
	}
});

test('mobile Editor keeps inspection actions, touch gestures, source replacement, and save reachable', async ({ browser }) => {
	test.setTimeout(120000);
	const context = await browser.newContext({
		baseURL: 'http://127.0.0.1:5175',
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true
	});
	const page = await context.newPage();
	const originalBytes = Buffer.from(makeTinyBomc12());
	const replacementBytes = Buffer.from(makeTinyBomc12({ faceSurfaceCode: 1, faceRoleCode: 1 }));
	const makeProvenance = (bytes: Buffer, modelId: string, captureId: string) => ({
		schema: 'sibambo-research-provenance-v1', engine: 'e4',
		artifact: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, format: 'bomc-1.2', profile: 'exact' },
		producer: { label: 'Synthetic browser worker fixture', sourceTreeSha256: E4_PROVENANCE_POLICY_V1.producer.sourceTreeSha256![0] },
		model: { id: modelId },
		capture: { id: captureId, exportedAt: new Date().toISOString(), evidence: 'Generated structural test fixture; not an exporter capture.', method: 'operator-attested' }
	});
	const original = makeProvenance(originalBytes, 'mobile-editor-original', 'mobile-editor-original-capture');
	const replacement = makeProvenance(replacementBytes, 'mobile-editor-replacement', 'mobile-editor-replacement-capture');
	try {
		await page.addInitScript(() => {
			const probe: { hold: boolean; pending: boolean; release?: () => void } = { hold: false, pending: false };
			Object.defineProperty(window, '__mobileEditorAdapterProbe', { configurable: true, value: probe });
			Object.defineProperty(navigator, 'gpu', {
				configurable: true,
				value: {
					requestAdapter: () => {
						if (!probe.hold) return Promise.resolve(null);
						return new Promise<null>((resolve) => {
							probe.pending = true;
							probe.release = () => { probe.pending = false; resolve(null); };
						});
					}
				}
			});
		});
		await page.goto('/?renderer=webgl2');
		await expect(page.getByRole('heading', { name: 'Open a model file' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Open model file' })).toBeVisible();
		await page.getByLabel('BOMC 1.2 file').setInputFiles({ name: 'mobile-editor-original.bomc', mimeType: 'application/octet-stream', buffer: originalBytes });
		await page.getByLabel('Provenance JSON for next model').setInputFiles({ name: 'mobile-editor-original.provenance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(original)) });
		await page.getByRole('button', { name: 'Open model file' }).click();
		await expectMobileReady(page, 'mobile-editor-original');
		await expect(page.getByTestId('touch-hint')).toBeVisible();

		const mobileControls = page.locator('.mobile-loaded-controls[aria-label="Mobile model controls"]');
		await expect(mobileControls).toBeVisible();
		const mobileMore = mobileControls.locator('details.secondary-tools');
		await expect(mobileMore.locator('summary')).toBeVisible();
		const canvas = page.locator('canvas[aria-label="Interactive 3D model viewport"]');
		const initialBounds = await canvas.boundingBox();
		expect(initialBounds).not.toBeNull();
		expect(initialBounds!.width).toBeGreaterThanOrEqual(350);
		expect(initialBounds!.height).toBeGreaterThanOrEqual(320);
		await expect.poll(() => canvas.evaluate((element) => getComputedStyle(element).touchAction)).toBe('none');

		for (const viewport of [
			{ width: 195, height: 844 }, { width: 320, height: 720 }, { width: 390, height: 844 }, { width: 430, height: 932 },
			{ width: 768, height: 1024 }, { width: 844, height: 390 }
		]) {
			await page.setViewportSize(viewport);
			const dimensions = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }));
			expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.width);
			const responsiveCanvas = await canvas.boundingBox();
			expect(responsiveCanvas).not.toBeNull();
			expect(responsiveCanvas!.height).toBeGreaterThanOrEqual(280);
		}
		await page.setViewportSize({ width: 390, height: 844 });
		await openDetails(mobileMore);
		for (const label of ['Top', 'Front', 'Iso', 'Save view', 'Open model file', 'Change artifact', 'Choose sidecar for next model', 'Unload']) {
			await expect(mobileMore.getByRole('button', { name: label, exact: label !== 'Change artifact' })).toBeVisible();
		}
		await expect(mobileMore.getByLabel('Display mode')).toBeVisible();
		await expect(mobileMore.getByLabel('Visible scene')).toBeVisible();
		const mobileTargets = page.locator('.sibambo-header a, .sibambo-header button, .sibambo-header summary, .mobile-loaded-controls button:visible, .mobile-loaded-controls select:visible, .mobile-loaded-controls summary:visible');
		for (const target of await mobileTargets.all()) {
			const rect = await target.boundingBox();
			expect(rect).not.toBeNull();
			expect(rect!.width).toBeGreaterThanOrEqual(44);
			expect(rect!.height).toBeGreaterThanOrEqual(44);
		}
	await mobileMore.locator('summary').focus();
	await page.keyboard.press('Enter');
	await expect(mobileMore).toHaveAttribute('open', '');
	await mobileMore.getByRole('button', { name: 'Top', exact: true }).click();
	await mobileMore.getByLabel('Display mode').selectOption('wireframe');
	await mobileMore.getByLabel('Visible scene').selectOption({ index: 0 });
	await mobileMore.getByLabel('Display mode').selectOption('solid');
	await mobileMore.locator('summary').click();
		const touch = await context.newCDPSession(page);
		let bounds = await canvas.boundingBox();
		expect(bounds).not.toBeNull();
		const tapX = bounds!.x + bounds!.width * 0.46;
		const tapY = bounds!.y + bounds!.height * 0.51;
		await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tapX, y: tapY, id: 0 }] });
		await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await openDetails(page.locator('details.inspection-details'));
		await expect(page.getByRole('heading', { name: 'Picked geometry' })).toBeVisible({ timeout: 5000 });

		await mobileControls.getByRole('button', { name: 'Fit' }).click();

		bounds = await canvas.boundingBox();
		expect(bounds).not.toBeNull();
		const canvasImageHash = async () => createHash('sha256').update(await canvas.screenshot()).digest('hex');
		const selectionBeforeTouch = await canvasImageHash();
		const orbitStart = { x: bounds!.x + bounds!.width * 0.70, y: bounds!.y + bounds!.height * 0.50, id: 0 };
		await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [orbitStart] });
		await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...orbitStart, x: orbitStart.x + 48, y: orbitStart.y - 20 }] });
		await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await expect.poll(canvasImageHash).not.toBe(selectionBeforeTouch);
		const imageAfterOrbit = await canvasImageHash();
		const panCenterX = bounds!.x + bounds!.width * 0.5;
		const panCenterY = bounds!.y + bounds!.height * 0.5;
		await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: panCenterX - 28, y: panCenterY, id: 0 }, { x: panCenterX + 28, y: panCenterY, id: 1 }] });
		await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: panCenterX - 28 + 24, y: panCenterY + 16, id: 0 }, { x: panCenterX + 28 + 24, y: panCenterY + 16, id: 1 }] });
		await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await expect.poll(canvasImageHash).not.toBe(imageAfterOrbit);
		const imageAfterPan = await canvasImageHash();
		await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: panCenterX - 30, y: panCenterY, id: 0 }, { x: panCenterX + 30, y: panCenterY, id: 1 }] });
		await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: panCenterX - 55, y: panCenterY, id: 0 }, { x: panCenterX + 55, y: panCenterY, id: 1 }] });
		await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await expect.poll(canvasImageHash).not.toBe(imageAfterPan);
		await page.evaluate(() => window.scrollTo(0, 0));
		await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 22, y: 150, id: 0 }] });
		await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 22, y: 80, id: 0 }] });
		await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

		await openDetails(mobileMore);
		const actionButtons = mobileMore.getByRole('button');
		for (const button of await actionButtons.all()) {
			const rect = await button.boundingBox();
			expect(rect).not.toBeNull();
			expect(rect!.width).toBeGreaterThanOrEqual(44);
			expect(rect!.height).toBeGreaterThanOrEqual(44);
		}
		await mobileMore.getByRole('button', { name: /^Change artifact/ }).click();
		await page.getByLabel('BOMC 1.2 file').setInputFiles({ name: 'mobile-editor-replacement.bomc', mimeType: 'application/octet-stream', buffer: replacementBytes });
		await mobileMore.getByRole('button', { name: 'Choose sidecar for next model' }).click();
		await page.getByLabel('Provenance JSON for next model').setInputFiles({ name: 'mobile-editor-replacement.provenance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replacement)) });

		await page.evaluate(() => {
			const probe = (window as Window & { __mobileEditorAdapterProbe?: { hold: boolean } }).__mobileEditorAdapterProbe;
			if (!probe) throw new Error('Mobile adapter test probe was not initialized.');
			probe.hold = true;
			history.replaceState(history.state, '', '/?renderer=webgpu');
		});
		await mobileMore.getByRole('button', { name: 'Open model file' }).click();
		await expect.poll(() => page.evaluate(() => (window as Window & { __mobileEditorAdapterProbe?: { pending: boolean } }).__mobileEditorAdapterProbe?.pending ?? false)).toBe(true);
		await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
		await page.getByRole('button', { name: 'Cancel' }).click();
		await expect(page.getByRole('alert')).toHaveText('Model load cancelled.');
		await expectMobileReady(page, 'mobile-editor-original');
		await expect(canvas).toHaveCount(1);
		await page.evaluate(() => (window as Window & { __mobileEditorAdapterProbe?: { release?: () => void } }).__mobileEditorAdapterProbe?.release?.());
		await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).isConnected)).toBe(true);

		await page.evaluate(() => {
			const probe = (window as Window & { __mobileEditorAdapterProbe?: { hold: boolean } }).__mobileEditorAdapterProbe;
			if (!probe) throw new Error('Mobile adapter test probe was not initialized.');
			probe.hold = false;
			history.replaceState(history.state, '', '/?renderer=webgl2');
		});
		await openDetails(mobileMore);
		await mobileMore.getByRole('button', { name: 'Open model file' }).click();
		await expectMobileReady(page, 'mobile-editor-replacement');
		await openDetails(mobileMore);
		const downloadPromise = page.waitForEvent('download');
		await mobileMore.getByRole('button', { name: 'Save view' }).click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toBe('mobile-editor-replacement-editor-view.png');
		const png = readFileSync((await download.path())!);
		expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		const pngWidth = png.readUInt32BE(16);
		const pngHeight = png.readUInt32BE(20);
		const captureSize = await canvas.evaluate((element) => ({ width: (element as HTMLCanvasElement).width, height: (element as HTMLCanvasElement).height }));
		expect({ width: pngWidth, height: pngHeight }).toEqual(captureSize);

		await mobileMore.getByRole('button', { name: 'Unload' }).click();
		await expect(page.getByRole('heading', { name: 'Open a model file' })).toBeVisible();
		await expect(canvas).toHaveCount(0);
	} finally {
		await context.close();
	}
});
