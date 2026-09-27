import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { E4_PROVENANCE_POLICY_V1 } from '@sibambo/provenance/policies/e4-v1';
import { makeTinyBomc12 } from '../../../tooling/test-fixtures/tiny-bomc';

type EditorInitializationTestWindow = Window & {
	__editorWebGpuProbe?: { pending: boolean; release?: () => void };
	__editorViewportProbe?: { host: HTMLElement; mountCount: number; disposeCount: number };
	__editorRetryCanvas?: HTMLCanvasElement;
};

test('Editor verifies and imports an E4 artifact in its own worker', async ({ page }, testInfo) => {
	const bytes = Buffer.from(makeTinyBomc12());
	const provenance = {
		schema: 'sibambo-research-provenance-v1', engine: 'e4',
		artifact: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, format: 'bomc-1.2', profile: 'exact' },
		producer: { label: 'Synthetic browser worker fixture', sourceTreeSha256: E4_PROVENANCE_POLICY_V1.producer.sourceTreeSha256![0] },
		model: { id: 'tiny-browser-test' },
		capture: { id: 'tiny-editor-worker-flow', exportedAt: new Date().toISOString(), evidence: 'Generated structural test fixture; not an exporter capture.', method: 'operator-attested' }
	};

	await page.goto('/');
	await page.getByLabel('BOMC 1.2 file').setInputFiles({ name: 'tiny-browser-test.bomc', mimeType: 'application/octet-stream', buffer: bytes });
	await page.getByLabel('Provenance sidecar').setInputFiles({ name: 'tiny-browser-test.provenance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(provenance)) });
	await page.getByRole('button', { name: 'Open verified model' }).click();
	await expect(page.getByText('tiny-browser-test', { exact: true })).toBeVisible({ timeout: 30000 });
	await expect(page.getByText('Textures settled and first frame observed')).toBeVisible({ timeout: 30000 });
	await expect(page.getByRole('alert')).toHaveCount(0);
	const artifactHash = await page.locator('dd').nth(0).textContent();
	await expect(page.getByLabel('Visible scene')).toBeVisible();

	const captureHash = async (name: string) => {
		const promise = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Save view' }).click();
		const download = await promise;
		const path = testInfo.outputPath(name);
		await download.saveAs(path);
		return createHash('sha256').update(readFileSync(path)).digest('hex');
	};
	await page.getByRole('button', { name: 'Top', exact: true }).click();
	const topViewHash = await captureHash('top.png');
	await page.getByRole('button', { name: 'Front', exact: true }).click();
	const frontViewHash = await captureHash('front.png');
	expect(topViewHash).not.toBe(frontViewHash);

	for (const view of ['Iso', 'Fit']) {
		await page.getByRole('button', { name: view, exact: true }).click();
	}
	const canvas = page.locator('canvas[aria-label="Interactive 3D model viewport"]');
	const box = await canvas.boundingBox();
	expect(box).not.toBeNull();
	// Click inside the fixture triangle, slightly left of the viewport target.
	await page.mouse.click(box!.x + box!.width * 0.46, box!.y + box!.height * 0.51);
	await expect(page.getByRole('heading', { name: 'Picked geometry' })).toBeVisible({ timeout: 5000 });
	await expect(page.locator('dd').nth(0)).toHaveText(artifactHash ?? '');
	const pickedDetails = page.locator('section.pick dl');
	await expect(pickedDetails.locator('dt')).toHaveText(['Source mesh', 'Definition', 'Occurrence', 'Source face']);
	await expect(pickedDetails.locator('dd')).toHaveText(['0', '0', 'bomc:runtime:instance:0:0', '0']);

	await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
	await page.mouse.down();
	await page.mouse.move(box!.x + box!.width * 0.58, box!.y + box!.height * 0.54, { steps: 4 });
	await page.mouse.up();
	await page.mouse.wheel(0, -120);

	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Save view' }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('tiny-browser-test-editor-view.png');

	const replacement = { ...provenance, model: { id: 'tiny-browser-replacement' }, capture: { ...provenance.capture, id: 'tiny-editor-replacement-flow' } };
	await page.getByLabel('BOMC 1.2 file').setInputFiles({ name: 'tiny-replacement.bomc', mimeType: 'application/octet-stream', buffer: bytes });
	await page.getByLabel('Provenance sidecar').setInputFiles({ name: 'tiny-replacement.provenance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replacement)) });
	await page.getByRole('button', { name: 'Open verified model' }).click();
	await expect(page.getByText('tiny-browser-replacement', { exact: true })).toBeVisible({ timeout: 30000 });
	await expect(page.getByText('Textures settled and first frame observed')).toBeVisible({ timeout: 30000 });
	await page.getByRole('button', { name: 'Unload' }).click();
	await expect(page.getByRole('heading', { name: 'Open a verified model' })).toBeVisible();
});

test('cancelling delayed WebGPU initialization clears the source and allows a later load', async ({ page }) => {
	const bytes = Buffer.from(makeTinyBomc12());
	const retryBytes = Buffer.from(makeTinyBomc12({ faceSurfaceCode: 1, faceRoleCode: 1 }));
	const makeProvenance = (modelId: string, captureId: string, artifactBytes = bytes) => ({
		schema: 'sibambo-research-provenance-v1', engine: 'e4',
		artifact: { sha256: createHash('sha256').update(artifactBytes).digest('hex'), bytes: artifactBytes.length, format: 'bomc-1.2', profile: 'exact' },
		producer: { label: 'Synthetic browser worker fixture', sourceTreeSha256: E4_PROVENANCE_POLICY_V1.producer.sourceTreeSha256![0] },
		model: { id: modelId },
		capture: { id: captureId, exportedAt: new Date().toISOString(), evidence: 'Generated structural test fixture; not an exporter capture.', method: 'operator-attested' }
	});
	const setModel = async (modelId: string, captureId: string, fileName: string, artifactBytes = bytes) => {
		const provenance = makeProvenance(modelId, captureId, artifactBytes);
		await page.getByLabel('BOMC 1.2 file').setInputFiles({ name: `${fileName}.bomc`, mimeType: 'application/octet-stream', buffer: artifactBytes });
		await page.getByLabel('Provenance sidecar').setInputFiles({ name: `${fileName}.provenance.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(provenance)) });
	};

	await page.addInitScript(() => {
		const probe: { pending: boolean; release?: () => void } = { pending: false };
		Object.defineProperty(window, '__editorWebGpuProbe', { configurable: true, value: probe });
		Object.defineProperty(navigator, 'gpu', {
			configurable: true,
			value: {
				requestAdapter: () => new Promise<null>((resolve) => {
					probe.pending = true;
					probe.release = () => resolve(null);
				})
			}
		});
	});
	await page.goto('/?renderer=webgpu');
	await setModel('cancelled-route-model', 'editor-delayed-webgpu-cancel', 'cancelled-route-model');
	await page.getByRole('button', { name: 'Open verified model' }).click();
	await expect(page.getByLabel('Imported source status')).toBeVisible({ timeout: 30000 });
	await expect(page.getByText('Preparing viewport')).toBeVisible();
	await expect.poll(() => page.evaluate(() => (window as EditorInitializationTestWindow).__editorWebGpuProbe?.pending ?? false)).toBe(true);
	await page.evaluate(() => {
		const host = document.querySelector<HTMLElement>('.viewport');
		if (!host) throw new Error('Editor viewport host was not mounted.');
		const probe = { host, mountCount: 0, disposeCount: 0 };
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				probe.mountCount += Array.from(record.addedNodes).filter((node) => node instanceof HTMLCanvasElement).length;
				probe.disposeCount += Array.from(record.removedNodes).filter((node) => node instanceof HTMLCanvasElement).length;
			}
		});
		observer.observe(host, { childList: true });
		Object.defineProperty(window, '__editorViewportProbe', { configurable: true, value: probe });
	});

	try {
		await page.getByRole('button', { name: 'Cancel' }).click();
		await expect(page.getByRole('heading', { name: 'Open a verified model' })).toBeVisible();
		await expect(page.getByLabel('Imported source status')).toHaveCount(0);
		await expect(page.getByLabel('Source and selection information')).toHaveCount(0);
		await expect(page.getByText('cancelled-route-model', { exact: true })).toHaveCount(0);
		await expect(page.locator('canvas[aria-label="Interactive 3D model viewport"]')).toHaveCount(0);
		await expect(page.getByRole('alert')).toHaveText('Model load cancelled.');
		await expect.poll(() => page.evaluate(() => (window as EditorInitializationTestWindow).__editorViewportProbe?.host.isConnected ?? true)).toBe(false);

	const pageTimeOrigin = await page.evaluate(() => performance.timeOrigin);
	await page.evaluate(() => history.replaceState(history.state, '', '/?renderer=webgl2'));
	await expect.poll(() => page.evaluate(() => performance.timeOrigin)).toBe(pageTimeOrigin);
	await setModel('after-cancel-model', 'editor-load-after-webgpu-cancel', 'after-cancel-source', retryBytes);
	await page.getByRole('button', { name: 'Open verified model' }).click();
	await expect(page.getByText('after-cancel-model', { exact: true })).toBeVisible({ timeout: 30000 });
	await expect(page.getByText('Textures settled and first frame observed')).toBeVisible({ timeout: 30000 });
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(page.getByText('cancelled-route-model', { exact: true })).toHaveCount(0);
	await expect(page.locator('dd').nth(0)).toHaveText(createHash('sha256').update(retryBytes).digest('hex'));
	await expect(page.locator('dd').nth(1)).toHaveText('after-cancel-source.bomc');
	await expect(page.locator('canvas[aria-label="Interactive 3D model viewport"]')).toHaveCount(1);
	await page.evaluate(() => Object.defineProperty(window, '__editorRetryCanvas', { configurable: true, value: document.querySelector<HTMLCanvasElement>('canvas[aria-label="Interactive 3D model viewport"]') }));
	const retryCapture = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Save view' }).click();
	expect((await retryCapture).suggestedFilename()).toBe('after-cancel-model-editor-view.png');
	} finally {
		await page.evaluate(() => (window as EditorInitializationTestWindow).__editorWebGpuProbe?.release?.());
	}

	await expect.poll(() => page.evaluate(() => (window as EditorInitializationTestWindow).__editorViewportProbe?.mountCount ?? 0)).toBe(1);
	await expect.poll(() => page.evaluate(() => (window as EditorInitializationTestWindow).__editorViewportProbe?.disposeCount ?? 0)).toBe(1);
	await expect.poll(() => page.evaluate(() => (window as EditorInitializationTestWindow).__editorViewportProbe?.host.childElementCount ?? -1)).toBe(0);
	await expect(page.locator('canvas[aria-label="Interactive 3D model viewport"]')).toHaveCount(1);
	await expect.poll(() => page.evaluate(() => (window as EditorInitializationTestWindow).__editorRetryCanvas?.isConnected ?? false)).toBe(true);
});
