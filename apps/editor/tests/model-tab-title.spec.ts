import { expect, test, type Page } from '@playwright/test';
import { makeTinyBomc12 } from '../../../tooling/test-fixtures/tiny-bomc';

async function holdFileRead(page: Page, fileName: string) {
	await page.addInitScript((heldName) => {
		const original = File.prototype.arrayBuffer;
		let released = false;
		File.prototype.arrayBuffer = function () {
			const file = this;
			if (file.name !== heldName || released) return original.call(file);
			return new Promise<ArrayBuffer>((resolve, reject) => {
				Object.defineProperty(window, '__releaseModelTitleFile', {
					configurable: true,
					value: () => { released = true; return original.call(file).then(resolve, reject); }
				});
			});
		};
	}, fileName);
}

async function releaseFileRead(page: Page) {
	await page.evaluate(() => (window as Window & { __releaseModelTitleFile?: () => void }).__releaseModelTitleFile?.());
}

async function chooseSourceFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
	const chooserPromise = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: 'Open Model…' }).click();
	await (await chooserPromise).setFiles(file);
}

async function replaceSourceInput(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const sourceInput = page.getByLabel('BOMC 1.2 file', { exact: true });
	await sourceInput.setInputFiles(file);
  // stageSource deliberately clears FileList so selecting the same file again still emits change.
  // Callers assert the delayed read/committed title or rejection, which prove the file was consumed.
}

async function confirmEditorInteractive(page: Page) {
	const windowMenu = page.locator('nav.editor-menubar details.menu-root').filter({ has: page.locator('summary', { hasText: 'Window' }) });
	await windowMenu.locator('summary').click();
	await windowMenu.getByRole('button', { name: 'Dark Theme' }).click();
	await expect(windowMenu.getByRole('button', { name: 'Light Theme' })).toBeVisible();
	await windowMenu.getByRole('button', { name: 'Light Theme' }).click();
	await expect(windowMenu.getByRole('button', { name: 'Dark Theme' })).toBeVisible();
}

async function expectModelTitle(page: Page, title: string) {
	await expect.poll(() => page.title(), { timeout: 30_000 }).toBe(title);
}

test('Editor browser tab follows successful model commits and restores the default on close', async ({ page }) => {
	test.setTimeout(120000);
	await holdFileRead(page, 'staged-editor-two.bomc');
	await page.goto('/?renderer=webgl2', { waitUntil: 'networkidle' });
	await expectModelTitle(page, 'Sibambo Editor');
	await confirmEditorInteractive(page);
	const first = Buffer.from(makeTinyBomc12({ modelName: '', sourceFileName: 'Source Model One.skp' }));
	await chooseSourceFile(page, { name: 'selected-one.bomc', mimeType: 'application/octet-stream', buffer: first });
	await expectModelTitle(page, 'Source Model One');
	await expect(page.locator('canvas[aria-label="Interactive 3D model viewport"]')).toBeVisible();

	const second = Buffer.from(makeTinyBomc12({ modelName: 'Model Two', sourceFileName: 'other-source.skp' }));
	await replaceSourceInput(page, { name: 'staged-editor-two.bomc', mimeType: 'application/octet-stream', buffer: second });
	await expect.poll(() => page.evaluate(() => typeof (window as Window & { __releaseModelTitleFile?: () => void }).__releaseModelTitleFile)).toBe('function');
	await expectModelTitle(page, 'Source Model One');
	await releaseFileRead(page);
	await expectModelTitle(page, 'Model Two');
	await expect(page.locator('canvas[aria-label="Interactive 3D model viewport"]')).toBeVisible();

	await replaceSourceInput(page, { name: 'broken-editor-replacement.bomc', mimeType: 'application/octet-stream', buffer: Buffer.from('broken BOMC') });
	await expect(page.locator('.viewport-status')).toContainText('Editor accepts BOMC 1.2 only');
	await expectModelTitle(page, 'Model Two');

	const fileMenu = page.locator('nav.editor-menubar details.menu-root').filter({ has: page.locator('summary', { hasText: 'File' }) });
	await fileMenu.locator('summary').click();
	await fileMenu.getByRole('button', { name: 'Close Model' }).click();
	await expect(page.locator('canvas[aria-label="Interactive 3D model viewport"]')).toHaveCount(0);
	await expectModelTitle(page, 'Sibambo Editor');
});
