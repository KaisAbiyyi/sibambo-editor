import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { makeTinyBomc12 } from '../../../tooling/test-fixtures/tiny-bomc';

async function openMenu(page: Page, label: string) {
	const menu = page.locator('.editor-menubar details.menu-root').filter({
		has: page.locator('summary', { hasText: label })
	});
	if (!(await menu.evaluate((element) => (element as HTMLDetailsElement).open))) {
		await menu.locator('summary').click();
	}
	return menu;
}

async function previewBuilderFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
	const menu = await openMenu(page, 'Extensions');
	const chooserPromise = page.waitForEvent('filechooser');
	await menu.getByRole('button', { name: 'Preview Builder Artifact…' }).click();
	await (await chooserPromise).setFiles(file);
}

async function saveCurrentBomc(page: Page, outputPath: string) {
	const fileMenu = await openMenu(page, 'File');
	const downloadPromise = page.waitForEvent('download');
	await fileMenu.getByRole('button', { name: /Save BOMC/ }).click();
	const download = await downloadPromise;
	await download.saveAs(outputPath);
	return readFile(outputPath);
}

async function drawRectangle(page: Page) {
	const cameraMenu = await openMenu(page, 'Camera');
	await cameraMenu.getByRole('button', { name: 'Top', exact: true }).click();
	const canvas = page.locator('.viewport canvas');
	const box = await canvas.boundingBox();
	if (!box) throw new Error('The authoring viewport canvas is unavailable.');
	await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
	await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.3);
	await page.mouse.click(box.x + box.width * 0.52, box.y + box.height * 0.62);
}

test('Builder preview is forced read-only for an otherwise writable BOMC subset', async ({ page }, testInfo) => {
	test.setTimeout(120000);
	await page.goto('/?renderer=webgl2');
	await page.getByRole('button', { name: 'New BOMC' }).click();
	await expect(page.locator('.tool-context .mode-badge')).toHaveText('Writable BOMC', { timeout: 30000 });
	await drawRectangle(page);

	const bytes = await saveCurrentBomc(page, testInfo.outputPath('builder-preview-writable-subset.bomc'));
	await expect(page.locator('.footer-status')).toContainText('Saved BOMC');
	const closeMenu = await openMenu(page, 'File');
	await closeMenu.getByRole('button', { name: 'Close Model' }).click();
	await page.getByLabel('BOMC 1.2 file').setInputFiles({
		name: 'writable-subset.bomc', mimeType: 'application/octet-stream', buffer: bytes
	});
	await expect(page.locator('.tool-context .mode-badge')).toHaveText('Writable BOMC', { timeout: 30000 });

	const closeAgain = await openMenu(page, 'File');
	await closeAgain.getByRole('button', { name: 'Close Model' }).click();
	await previewBuilderFile(page, {
		name: 'builder-output.bomc', mimeType: 'application/octet-stream', buffer: bytes
	});
	await expect(page.locator('.tool-context .mode-badge')).toHaveText('Builder Preview · Read-only', { timeout: 30000 });
	await expect(page.locator('main[data-app="editor"]')).toHaveAttribute('data-builder-preview-only', 'true');
	await expect(page.getByRole('button', { name: /Save BOMC/ })).toHaveCount(0);

	const editMenu = await openMenu(page, 'Edit');
	await expect(editMenu.getByRole('button', { name: /Undo/ })).toBeDisabled();
	await expect(editMenu.getByRole('button', { name: /Redo/ })).toBeDisabled();
	const toolsMenu = await openMenu(page, 'Tools');
	await expect(toolsMenu.getByRole('button', { name: /Move Selected/ })).toBeDisabled();
	const previewFileMenu = await openMenu(page, 'File');
	await expect(previewFileMenu.getByRole('button', { name: /Save View/ })).toBeEnabled();
});

test('Builder preview reuses E4 scene import and retains source-face inspection', async ({ page }) => {
	test.setTimeout(90000);
	await page.goto('/?renderer=webgl2');
	await previewBuilderFile(page, {
		name: 'builder-generated-inspection-fixture.bomc',
		mimeType: 'application/octet-stream',
		buffer: Buffer.from(makeTinyBomc12())
	});
	await expect(page.locator('.tool-context .mode-badge')).toHaveText('Builder Preview · Read-only', { timeout: 30000 });
	const canvas = page.locator('.viewport canvas');
	await expect(canvas).toBeVisible({ timeout: 30000 });
	const cameraMenu = await openMenu(page, 'Camera');
	await cameraMenu.getByRole('button', { name: 'Top', exact: true }).click();
	const box = await canvas.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + box!.width * 0.46, box!.y + box!.height * 0.51);
	await expect(page.locator('.footer-status')).toContainText('Face 0', { timeout: 10000 });
	const toolsMenu = await openMenu(page, 'Tools');
	await expect(toolsMenu.getByRole('button', { name: /Move Selected/ })).toBeDisabled();
	await page.locator('.viewport-frame').focus();
	await page.keyboard.press('m');
	await expect(page.locator('.move-hud')).toHaveCount(0);
	const fileMenu = await openMenu(page, 'File');
	await expect(fileMenu.getByRole('button', { name: /Save View/ })).toBeEnabled();
});
