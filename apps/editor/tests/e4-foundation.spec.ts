import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { E4_PROVENANCE_POLICY_V1 } from '@sibambo/provenance/policies/e4-v1';
import { makeTinyBomc12 } from '../../../tooling/test-fixtures/tiny-bomc';

type EditorInitializationTestWindow = Window & {
	__editorWebGpuProbe?: { pending: boolean; release?: () => void };
	__editorViewportProbe?: { host: HTMLElement; mountCount: number; disposeCount: number };
	__editorPreMountProbe?: { cancelRequested: boolean; adapterRequests: number; adapterRequestsAtCancel: number };
	__editorRetryCanvas?: HTMLCanvasElement;
	__editorOriginalCanvas?: HTMLCanvasElement;
	__editorReplacementProbe?: { pending: boolean; release?: () => void; candidateCanvases: number };
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
	await page.getByLabel('Provenance JSON for next model').setInputFiles({ name: 'tiny-browser-test.provenance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(provenance)) });
	await page.getByRole('button', { name: 'Open model file' }).click();
	await expect(page.getByLabel('Imported source status').getByText('tiny-browser-test', { exact: true })).toBeVisible({ timeout: 30000 });
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
	await page.getByLabel('Provenance JSON for next model').setInputFiles({ name: 'tiny-replacement.provenance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replacement)) });
	await page.getByRole('button', { name: 'Open model file' }).click();
	await expect(page.getByLabel('Imported source status').getByText('tiny-browser-replacement', { exact: true })).toBeVisible({ timeout: 30000 });
	await expect(page.getByText('Textures settled and first frame observed')).toBeVisible({ timeout: 30000 });
	await page.getByRole('button', { name: 'Unload' }).click();
	await expect(page.getByRole('heading', { name: 'Open a model file' })).toBeVisible();
});

test('file-only import saves a view and optional provenance upgrades the open session in place', async ({ page }, testInfo) => {
	test.setTimeout(90000);
	const bytes = Buffer.from(makeTinyBomc12());
	const artifactHash = createHash('sha256').update(bytes).digest('hex');
	const makeProvenance = (profile = 'exact', sha256 = artifactHash) => ({
		schema: 'sibambo-research-provenance-v1', engine: 'e4',
		artifact: { sha256, bytes: bytes.length, format: 'bomc-1.2', profile },
		producer: { label: 'Synthetic browser worker fixture', sourceTreeSha256: E4_PROVENANCE_POLICY_V1.producer.sourceTreeSha256![0] },
		model: { id: 'file-only-upgrade-model' },
		capture: { id: 'file-only-upgrade-capture', exportedAt: new Date().toISOString(), evidence: 'Generated structural test fixture; not an exporter capture.', method: 'operator-attested' }
	});

	await page.goto('/?renderer=webgl2');
	await page.getByLabel('BOMC 1.2 file').setInputFiles({ name: 'file-only-upgrade.bomc', mimeType: 'application/octet-stream', buffer: bytes });
	await page.getByRole('button', { name: 'Open model file' }).click();
	await expect(page.getByText('Textures settled and first frame observed')).toBeVisible({ timeout: 30000 });
	await expect(page.getByLabel('Evidence level')).toHaveAttribute('data-evidence-level', 'file-only');
	await expect(page.getByLabel('Evidence level')).toHaveText('File-only · source not recorded');
	await expect(page.locator('dd').nth(4)).toHaveText('Unknown (not recorded)');
	await expect(page.locator('dd').nth(6)).toHaveText('Not provided');

	const viewDownload = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Save view' }).click();
	const savedView = await viewDownload;
	const savedPath = testInfo.outputPath('file-only-view.png');
	await savedView.saveAs(savedPath);
	expect(readFileSync(savedPath).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

	await page.getByRole('button', { name: 'Top', exact: true }).click();
	const canvas = page.locator('canvas[aria-label="Interactive 3D model viewport"]');
	const box = await canvas.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + box!.width * 0.46, box!.y + box!.height * 0.51);
	await expect(page.getByRole('heading', { name: 'Picked geometry' })).toBeVisible({ timeout: 5000 });
	const canvasHash = async () => createHash('sha256').update(await canvas.screenshot()).digest('hex');
	const initialCanvasHash = await canvasHash();
	const originalScene = await page.getByLabel('Visible scene').inputValue();
	await page.evaluate(() => Object.defineProperty(window, '__editorOriginalCanvas', { configurable: true, value: document.querySelector<HTMLCanvasElement>('canvas[aria-label="Interactive 3D model viewport"]') }));

	await page.getByRole('button', { name: 'Add provenance JSON to this model' }).click();
	await page.getByLabel('Provenance JSON for current model').setInputFiles({ name: 'malformed.provenance.json', mimeType: 'application/json', buffer: Buffer.from('{') });
	await expect(page.getByRole('alert')).toBeVisible();
	await expect(page.getByLabel('Evidence level')).toHaveAttribute('data-evidence-level', 'file-only');
	await expect(page.getByRole('heading', { name: 'Picked geometry' })).toBeVisible();
	expect(await canvasHash()).toBe(initialCanvasHash);

	await page.getByRole('button', { name: 'Add provenance JSON to this model' }).click();
	await page.getByLabel('Provenance JSON for current model').setInputFiles({ name: 'wrong-hash.provenance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeProvenance('exact', 'b'.repeat(64)))) });
	await expect(page.getByRole('alert')).toContainText('Artifact SHA-256 mismatch');
	await expect(page.getByLabel('Evidence level')).toHaveAttribute('data-evidence-level', 'file-only');
	await expect(page.getByRole('heading', { name: 'Picked geometry' })).toBeVisible();
	await expect(page.getByLabel('Visible scene')).toHaveValue(originalScene);
	expect(await canvasHash()).toBe(initialCanvasHash);

	await page.getByRole('button', { name: 'Add provenance JSON to this model' }).click();
	await page.getByLabel('Provenance JSON for current model').setInputFiles({ name: 'wrong-profile.provenance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeProvenance('visual'))) });
	await expect(page.getByRole('alert')).toContainText('encoding profile');
	await expect(page.getByLabel('Evidence level')).toHaveAttribute('data-evidence-level', 'file-only');
	expect(await canvasHash()).toBe(initialCanvasHash);

	await page.getByRole('button', { name: 'Add provenance JSON to this model' }).click();
	await page.getByLabel('Provenance JSON for current model').setInputFiles({ name: 'matched.provenance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeProvenance())) });
	await expect(page.getByLabel('Evidence level')).toHaveAttribute('data-evidence-level', 'provenance-matched');
	await expect(page.getByLabel('Evidence level')).toContainText('Provenance-matched · operator-attested source record');
	await expect(page.getByLabel('Imported source status').getByText('file-only-upgrade-model', { exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Picked geometry' })).toBeVisible();
	await expect(page.getByLabel('Visible scene')).toHaveValue(originalScene);
	expect(await canvasHash()).toBe(initialCanvasHash);
	await expect.poll(() => page.evaluate(() => {
		const original = (window as EditorInitializationTestWindow).__editorOriginalCanvas;
		return !!original && original.isConnected && document.querySelector('canvas[aria-label="Interactive 3D model viewport"]') === original;
	})).toBe(true);
});

test('selecting a replacement model clears the previous staged sidecar and opens file-only', async ({ page }) => {
	const originalBytes = Buffer.from(makeTinyBomc12());
	const replacementBytes = Buffer.from(makeTinyBomc12({ faceSurfaceCode: 1, faceRoleCode: 1 }));
	const makeProvenance = (bytes: Buffer) => ({
		schema: 'sibambo-research-provenance-v1', engine: 'e4',
		artifact: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, format: 'bomc-1.2', profile: 'exact' },
		producer: { label: 'Synthetic browser worker fixture', sourceTreeSha256: E4_PROVENANCE_POLICY_V1.producer.sourceTreeSha256![0] },
		model: { id: 'editor-replacement-sidecar-model' },
		capture: { id: 'editor-replacement-sidecar-capture', exportedAt: new Date().toISOString(), evidence: 'Generated structural test fixture; not an exporter capture.', method: 'operator-attested' }
	});

	await page.goto('/?renderer=webgl2');
	await page.getByLabel('BOMC 1.2 file').setInputFiles({ name: 'editor-original.bomc', mimeType: 'application/octet-stream', buffer: originalBytes });
	await page.getByLabel('Provenance JSON for next model').setInputFiles({ name: 'editor-original.provenance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeProvenance(originalBytes))) });
	await page.getByRole('button', { name: 'Open model file' }).click();
	await expect(page.getByLabel('Evidence level')).toHaveAttribute('data-evidence-level', 'provenance-matched');
	await expect(page.getByText('Textures settled and first frame observed')).toBeVisible({ timeout: 30000 });

	await page.getByLabel('BOMC 1.2 file').setInputFiles({ name: 'editor-replacement.bomc', mimeType: 'application/octet-stream', buffer: replacementBytes });
	await expect(page.getByLabel('Provenance JSON for next model')).toHaveValue('');
	await page.getByRole('button', { name: 'Open model file' }).click();
	await expect(page.getByText('Textures settled and first frame observed')).toBeVisible({ timeout: 30000 });
	await expect(page.getByLabel('Evidence level')).toHaveAttribute('data-evidence-level', 'file-only');
	await expect(page.getByLabel('Evidence level')).toHaveText('File-only · source not recorded');
	await expect(page.locator('dd').nth(1)).toHaveText('editor-replacement.bomc');
	await expect(page.locator('dd').nth(4)).toHaveText('Unknown (not recorded)');
	await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a rejected replacement sidecar preserves the loaded Editor model and selection', async ({ page }) => {
	const bytes = Buffer.from(makeTinyBomc12());
	const provenance = {
		schema: 'sibambo-research-provenance-v1', engine: 'e4',
		artifact: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, format: 'bomc-1.2', profile: 'exact' },
		producer: { label: 'Synthetic browser worker fixture', sourceTreeSha256: E4_PROVENANCE_POLICY_V1.producer.sourceTreeSha256![0] },
		model: { id: 'editor-transaction-original' },
		capture: { id: 'editor-transaction-original-capture', exportedAt: new Date().toISOString(), evidence: 'Generated structural test fixture; not an exporter capture.', method: 'operator-attested' }
	};

	await page.goto('/?renderer=webgl2');
	await page.getByLabel('BOMC 1.2 file').setInputFiles({ name: 'editor-original.bomc', mimeType: 'application/octet-stream', buffer: bytes });
	await page.getByLabel('Provenance JSON for next model').setInputFiles({ name: 'editor-original.provenance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(provenance)) });
	await page.getByRole('button', { name: 'Open model file' }).click();
	await expect(page.getByLabel('Imported source status').getByText('editor-transaction-original', { exact: true })).toBeVisible({ timeout: 30000 });
	await expect(page.getByText('Textures settled and first frame observed')).toBeVisible({ timeout: 30000 });
	const sceneId = await page.getByLabel('Visible scene').inputValue();
	const canvas = page.locator('canvas[aria-label="Interactive 3D model viewport"]');
	const box = await canvas.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + box!.width * 0.46, box!.y + box!.height * 0.51);
	await expect(page.getByRole('heading', { name: 'Picked geometry' })).toBeVisible({ timeout: 5000 });
	const originalHash = createHash('sha256').update(bytes).digest('hex');
	await page.evaluate(() => Object.defineProperty(window, '__editorOriginalCanvas', { configurable: true, value: document.querySelector<HTMLCanvasElement>('canvas[aria-label="Interactive 3D model viewport"]') }));

	await page.getByLabel('BOMC 1.2 file').setInputFiles({ name: 'rejected-replacement.bomc', mimeType: 'application/octet-stream', buffer: bytes });
	await page.getByLabel('Provenance JSON for next model').setInputFiles({ name: 'oversized-replacement.provenance.json', mimeType: 'application/json', buffer: Buffer.alloc(4 * 1024 * 1024 + 1, 0x20) });
	await page.getByRole('button', { name: 'Open model file' }).click();
	await expect(page.getByRole('alert')).toContainText('4 MiB');
	await expect(page.getByLabel('Imported source status').getByText('editor-transaction-original', { exact: true })).toBeVisible();
	await expect(page.getByText('Textures settled and first frame observed')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Picked geometry' })).toBeVisible();
	await expect(page.locator('dd').nth(0)).toHaveText(originalHash);
	await expect(page.locator('dd').nth(1)).toHaveText('editor-original.bomc');
	await expect(page.getByLabel('Visible scene')).toHaveValue(sceneId);
	await expect.poll(() => page.evaluate(() => {
		const original = (window as EditorInitializationTestWindow).__editorOriginalCanvas;
		return !!original && original.isConnected && document.querySelector('canvas[aria-label="Interactive 3D model viewport"]') === original;
	})).toBe(true);
});

test('cancelling a replacement restores the original Editor after its delayed mount finishes', async ({ page }) => {
	const bytes = Buffer.from(makeTinyBomc12());
	const replacementBytes = Buffer.from(makeTinyBomc12({ faceSurfaceCode: 1, faceRoleCode: 1 }));
	const makeProvenance = (modelId: string, captureId: string, artifactBytes: Buffer) => ({
		schema: 'sibambo-research-provenance-v1', engine: 'e4',
		artifact: { sha256: createHash('sha256').update(artifactBytes).digest('hex'), bytes: artifactBytes.length, format: 'bomc-1.2', profile: 'exact' },
		producer: { label: 'Synthetic browser worker fixture', sourceTreeSha256: E4_PROVENANCE_POLICY_V1.producer.sourceTreeSha256![0] },
		model: { id: modelId },
		capture: { id: captureId, exportedAt: new Date().toISOString(), evidence: 'Generated structural test fixture; not an exporter capture.', method: 'operator-attested' }
	});
	const original = makeProvenance('editor-cancel-original', 'editor-cancel-original-capture', bytes);
	const replacement = makeProvenance('editor-cancel-replacement', 'editor-cancel-replacement-capture', replacementBytes);

	await page.addInitScript(() => {
		const probe: { pending: boolean; release?: () => void; candidateCanvases: number } = { pending: false, candidateCanvases: 0 };
		Object.defineProperty(window, '__editorReplacementProbe', { configurable: true, value: probe });
		Object.defineProperty(navigator, 'gpu', {
			configurable: true,
			value: { requestAdapter: () => new Promise<null>((resolve) => { probe.pending = true; probe.release = () => resolve(null); }) }
		});
	});
	await page.goto('/?renderer=webgl2');
	await page.getByLabel('BOMC 1.2 file').setInputFiles({ name: 'editor-cancel-original.bomc', mimeType: 'application/octet-stream', buffer: bytes });
	await page.getByLabel('Provenance JSON for next model').setInputFiles({ name: 'editor-cancel-original.provenance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(original)) });
	await page.getByRole('button', { name: 'Open model file' }).click();
	await expect(page.getByLabel('Imported source status').getByText('editor-cancel-original', { exact: true })).toBeVisible({ timeout: 30000 });
	await expect(page.getByText('Textures settled and first frame observed')).toBeVisible({ timeout: 30000 });
	const canvas = page.locator('canvas[aria-label="Interactive 3D model viewport"]');
	const box = await canvas.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + box!.width * 0.46, box!.y + box!.height * 0.51);
	await expect(page.getByRole('heading', { name: 'Picked geometry' })).toBeVisible({ timeout: 5000 });
	const originalHash = createHash('sha256').update(bytes).digest('hex');
	const originalScene = await page.getByLabel('Visible scene').inputValue();
	await page.evaluate(() => {
		const host = document.querySelector<HTMLElement>('.viewport');
		if (!host) throw new Error('Editor viewport host was not mounted.');
		const probe = (window as EditorInitializationTestWindow).__editorReplacementProbe;
		if (!probe) throw new Error('Replacement probe is unavailable.');
		new MutationObserver((records) => {
			probe.candidateCanvases += records.flatMap((record) => Array.from(record.addedNodes)).filter((node) => node instanceof HTMLCanvasElement).length;
		}).observe(host, { childList: true });
		Object.defineProperty(window, '__editorOriginalCanvas', { configurable: true, value: host.querySelector('canvas') });
	});
	await page.evaluate(() => history.replaceState(history.state, '', '/?renderer=webgpu'));
	await page.getByLabel('BOMC 1.2 file').setInputFiles({ name: 'editor-cancel-replacement.bomc', mimeType: 'application/octet-stream', buffer: replacementBytes });
	await page.getByLabel('Provenance JSON for next model').setInputFiles({ name: 'editor-cancel-replacement.provenance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replacement)) });
	await page.getByRole('button', { name: 'Open model file' }).click();
	await expect.poll(() => page.evaluate(() => (window as EditorInitializationTestWindow).__editorReplacementProbe?.pending ?? false)).toBe(true);
	await page.getByRole('button', { name: 'Cancel' }).click();
	await expect(page.getByRole('alert')).toHaveText('Model load cancelled.');
	await expect(page.getByLabel('Imported source status').getByText('editor-cancel-original', { exact: true })).toBeVisible();
	await expect(page.getByText('Textures settled and first frame observed')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Picked geometry' })).toBeVisible();
	await expect(page.locator('dd').nth(0)).toHaveText(originalHash);
	await expect(page.locator('dd').nth(1)).toHaveText('editor-cancel-original.bomc');
	await expect(page.getByLabel('Visible scene')).toHaveValue(originalScene);
	await page.evaluate(() => (window as EditorInitializationTestWindow).__editorReplacementProbe?.release?.());
	await expect.poll(() => page.evaluate(() => (window as EditorInitializationTestWindow).__editorReplacementProbe?.candidateCanvases ?? 0)).toBeGreaterThan(0);
	await expect.poll(() => page.evaluate(() => {
		const original = (window as EditorInitializationTestWindow).__editorOriginalCanvas;
		return !!original && original.isConnected && document.querySelectorAll('canvas[aria-label="Interactive 3D model viewport"]').length === 1 && document.querySelector('canvas[aria-label="Interactive 3D model viewport"]') === original;
	})).toBe(true);
	await expect(page.getByLabel('Imported source status').getByText('editor-cancel-replacement', { exact: true })).toHaveCount(0);
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
		await page.getByLabel('Provenance JSON for next model').setInputFiles({ name: `${fileName}.provenance.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(provenance)) });
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
	await page.getByRole('button', { name: 'Open model file' }).click();
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
		await expect(page.getByRole('heading', { name: 'Open a model file' })).toBeVisible();
		await expect(page.getByLabel('Imported source status')).toHaveCount(0);
		await expect(page.getByLabel('Source and selection information')).toHaveCount(0);
		await expect(page.getByLabel('Imported source status').getByText('cancelled-route-model', { exact: true })).toHaveCount(0);
		await expect(page.locator('canvas[aria-label="Interactive 3D model viewport"]')).toHaveCount(0);
		await expect(page.getByRole('alert')).toHaveText('Model load cancelled.');
		await expect.poll(() => page.evaluate(() => (window as EditorInitializationTestWindow).__editorViewportProbe?.host.isConnected ?? true)).toBe(false);

	const pageTimeOrigin = await page.evaluate(() => performance.timeOrigin);
	await page.evaluate(() => history.replaceState(history.state, '', '/?renderer=webgl2'));
	await expect.poll(() => page.evaluate(() => performance.timeOrigin)).toBe(pageTimeOrigin);
	await setModel('after-cancel-model', 'editor-load-after-webgpu-cancel', 'after-cancel-source', retryBytes);
	await page.getByRole('button', { name: 'Open model file' }).click();
	await expect(page.getByLabel('Imported source status').getByText('after-cancel-model', { exact: true })).toBeVisible({ timeout: 30000 });
	await expect(page.getByText('Textures settled and first frame observed')).toBeVisible({ timeout: 30000 });
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(page.getByLabel('Imported source status').getByText('cancelled-route-model', { exact: true })).toHaveCount(0);
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

test('cancelling as imported source state first appears clears it before viewport initialization', async ({ page }) => {
	const bytes = Buffer.from(makeTinyBomc12());
	const provenance = {
		schema: 'sibambo-research-provenance-v1', engine: 'e4',
		artifact: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, format: 'bomc-1.2', profile: 'exact' },
		producer: { label: 'Synthetic browser worker fixture', sourceTreeSha256: E4_PROVENANCE_POLICY_V1.producer.sourceTreeSha256![0] },
		model: { id: 'pre-mount-cancel-model' },
		capture: { id: 'editor-pre-mount-cancel', exportedAt: new Date().toISOString(), evidence: 'Generated structural test fixture; not an exporter capture.', method: 'operator-attested' }
	};

	await page.addInitScript(() => {
		const probe = { cancelRequested: false, adapterRequests: 0, adapterRequestsAtCancel: -1 };
		Object.defineProperty(window, '__editorPreMountProbe', { configurable: true, value: probe });
		Object.defineProperty(navigator, 'gpu', {
			configurable: true,
			value: { requestAdapter: () => { probe.adapterRequests += 1; return Promise.resolve(null); } }
		});
		const observer = new MutationObserver(() => {
			if (probe.cancelRequested || !document.querySelector('[aria-label="Imported source status"]')) return;
			const cancel = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Cancel');
			if (!cancel) return;
			probe.adapterRequestsAtCancel = probe.adapterRequests;
			probe.cancelRequested = true;
			observer.disconnect();
			// Run on the first imported-status DOM mutation, before the route's tick continuation can mount the viewport.
			cancel.click();
		});
		observer.observe(document, { childList: true, subtree: true });
	});
	await page.goto('/?renderer=webgpu');
	await page.getByLabel('BOMC 1.2 file').setInputFiles({ name: 'pre-mount-cancel.bomc', mimeType: 'application/octet-stream', buffer: bytes });
	await page.getByLabel('Provenance JSON for next model').setInputFiles({ name: 'pre-mount-cancel.provenance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(provenance)) });
	await page.getByRole('button', { name: 'Open model file' }).click();

	await expect.poll(() => page.evaluate(() => (window as EditorInitializationTestWindow).__editorPreMountProbe?.cancelRequested ?? false)).toBe(true);
	await expect(page.getByRole('alert')).toHaveText('Model load cancelled.');
	await expect(page.getByLabel('Imported source status')).toHaveCount(0);
	await expect(page.getByLabel('Source and selection information')).toHaveCount(0);
	await expect(page.getByLabel('Imported source status').getByText('pre-mount-cancel-model', { exact: true })).toHaveCount(0);
	await expect(page.locator('canvas[aria-label="Interactive 3D model viewport"]')).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => (window as EditorInitializationTestWindow).__editorPreMountProbe?.adapterRequestsAtCancel ?? -1)).toBe(0);
	await expect(page.getByRole('button', { name: 'Open model file' })).toBeEnabled();
});
