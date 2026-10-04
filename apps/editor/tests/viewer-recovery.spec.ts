import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const s2FixturePath = fileURLToPath(new URL('../../../../skps/model-eval-exports/PROJECT SBOOST 2__SIBAMBO-BOMC-v1.2.0__EXACT.bomc', import.meta.url));
const s2FixtureBytes = 2_319_634;
const s2FixtureSha256 = 'df19a9f07df845661d065b98b221dbcfc53e9ec2c3efe7a11f434b7fcb0ac452';

async function confirmEditorInteractive(page: Page) {
	const windowMenu = page.locator('nav.editor-menubar details.menu-root').filter({ has: page.locator('summary', { hasText: 'Window' }) });
	await windowMenu.locator('summary').click();
	await windowMenu.getByRole('button', { name: 'Dark Theme' }).click();
	await expect(windowMenu.getByRole('button', { name: 'Light Theme' })).toBeVisible();
	await windowMenu.getByRole('button', { name: 'Light Theme' }).click();
	await expect(windowMenu.getByRole('button', { name: 'Dark Theme' })).toBeVisible();
}

test('Editor S2-new UI loads the pinned worker model and responds to orbit and cursor-wheel navigation', async ({ page }, testInfo) => {
	test.setTimeout(120_000);
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	const workerRequests: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
	page.on('request', (request) => { if (request.url().includes('e4-import.worker')) workerRequests.push(request.url()); });

	const fixture = await readFile(s2FixturePath);
	const fixtureSha256 = createHash('sha256').update(fixture).digest('hex');
	expect(fixture.byteLength).toBe(s2FixtureBytes);
	expect(fixtureSha256).toBe(s2FixtureSha256);

	const buildResponse = await page.request.get('/__build.json');
	expect(buildResponse.ok()).toBeTruthy();
	const buildIdentity = await buildResponse.json();
	expect(buildIdentity).toMatchObject({ schema: 'sibambo-app-build-identity-v2', app: 'editor' });

	await page.goto('/?renderer=webgl2', { waitUntil: 'networkidle' });
	await confirmEditorInteractive(page);
	const chooserPromise = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: 'Open Model…' }).click();
	await (await chooserPromise).setFiles({
		name: 'PROJECT SBOOST 2.skp', mimeType: 'application/octet-stream', buffer: fixture
	});
	await expect.poll(() => page.title(), { timeout: 30_000 }).toBe('PROJECT SBOOST 2');
	const canvas = page.locator('canvas[aria-label="Interactive 3D model viewport"]');
	await expect(canvas).toBeVisible();
	await expect(page.getByRole('button', { name: 'Orbit' })).toBeEnabled();
	await expect(page.locator('[data-app="editor"]')).toBeVisible();

	const beforePath = testInfo.outputPath('s2-editor-before-navigation.png');
	const afterOrbitPath = testInfo.outputPath('s2-editor-after-orbit.png');
	const afterWheelPath = testInfo.outputPath('s2-editor-after-cursor-wheel.png');
	const beforePixels = await canvas.screenshot({ path: beforePath });
	const box = await canvas.boundingBox();
	expect(box).not.toBeNull();
	const centerX = box!.x + box!.width / 2;
	const centerY = box!.y + box!.height / 2;

	await page.getByRole('button', { name: 'Orbit' }).click();
	await page.mouse.move(centerX, centerY);
	await page.mouse.down();
	await page.mouse.move(centerX + 76, centerY + 42, { steps: 6 });
	await page.mouse.up();
	const afterOrbitPixels = await canvas.screenshot({ path: afterOrbitPath });
	expect(createHash('sha256').update(afterOrbitPixels).digest('hex')).not.toBe(createHash('sha256').update(beforePixels).digest('hex'));

	await page.mouse.move(centerX - box!.width * 0.2, centerY);
	await page.mouse.wheel(0, -110);
	const afterWheelPixels = await canvas.screenshot({ path: afterWheelPath });
	expect(createHash('sha256').update(afterWheelPixels).digest('hex')).not.toBe(createHash('sha256').update(afterOrbitPixels).digest('hex'));
	await expect.poll(() => page.title(), { timeout: 30_000 }).toBe('PROJECT SBOOST 2');
	expect(workerRequests.some((url) => url.includes('e4-import.worker'))).toBe(true);
	expect(pageErrors).toEqual([]);
	expect(consoleErrors).toEqual([]);

	await testInfo.attach('editor-build-identity.json', { body: Buffer.from(JSON.stringify(buildIdentity, null, 2)), contentType: 'application/json' });
	await testInfo.attach('s2-source-identity.json', {
		body: Buffer.from(JSON.stringify({ file: 'PROJECT SBOOST 2__SIBAMBO-BOMC-v1.2.0__EXACT.bomc', bytes: fixture.byteLength, sha256: fixtureSha256, workerRequests }, null, 2)),
		contentType: 'application/json'
	});
	await testInfo.attach('s2-editor-before-navigation.png', { path: beforePath, contentType: 'image/png' });
	await testInfo.attach('s2-editor-after-orbit.png', { path: afterOrbitPath, contentType: 'image/png' });
	await testInfo.attach('s2-editor-after-cursor-wheel.png', { path: afterWheelPath, contentType: 'image/png' });
});
