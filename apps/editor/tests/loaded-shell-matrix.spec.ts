import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const exactBomcPath = process.env.SIBAMBO_EXACT_BOMC_PATH
	?? path.resolve(process.cwd(), '../../../skps/model-eval-exports/PROJECT SBOOST 2__SIBAMBO-BOMC-v1.2.0__EXACT.bomc');

test('loaded exact BOMC stays within the shell and keeps the model visible across the viewport matrix', async ({ browser }, testInfo) => {
	test.setTimeout(180000);
	test.skip(!existsSync(exactBomcPath), `Exact BOMC fixture is not available at ${exactBomcPath}.`);
	const context = await browser.newContext({
		baseURL: 'http://127.0.0.1:5175',
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 1,
		isMobile: true,
		hasTouch: true
	});
	const page = await context.newPage();
	const bytes = readFileSync(exactBomcPath);
	try {
		await page.goto('/?renderer=webgl2');
		await page.getByLabel('BOMC 1.2 file').setInputFiles({
			name: path.basename(exactBomcPath),
			mimeType: 'application/octet-stream',
			buffer: bytes
		});
		await page.getByRole('button', { name: 'Open model file' }).click();
		await expect(page.getByLabel('Imported source status')).toContainText('BOMC 1.2', { timeout: 60000 });
		await expect(page.getByLabel('Imported source status')).toContainText('7,078 faces', { timeout: 60000 });
		await expect(page.locator('.source-bar .ready')).toHaveClass(/ready/, { timeout: 120000 });

		const canvas = page.locator('canvas[aria-label="Interactive 3D model viewport"]');
		await expect(canvas).toBeVisible();
		const measurements: Array<Record<string, number>> = [];
		for (const viewport of [
			{ width: 320, height: 568 },
			{ width: 390, height: 844 },
			{ width: 430, height: 932 },
			{ width: 768, height: 1024 },
			{ width: 1440, height: 900 }
		]) {
			await page.setViewportSize(viewport);
			const dimensions = await page.evaluate(async () => {
				await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
				const shell = document.querySelector<HTMLElement>('main[data-app="editor"].is-loaded');
				const workspace = document.querySelector<HTMLElement>('.workspace');
				const frame = document.querySelector<HTMLElement>('.viewport-frame');
				const viewportCanvas = document.querySelector<HTMLCanvasElement>('canvas[aria-label="Interactive 3D model viewport"]');
				if (!shell || !workspace || !frame || !viewportCanvas) throw new Error('Loaded model shell or viewport is missing.');
				return {
					innerWidth,
					innerHeight,
					shellHeight: shell.getBoundingClientRect().height,
					documentWidth: document.documentElement.scrollWidth,
					bodyWidth: document.body.scrollWidth,
					documentHeight: document.documentElement.scrollHeight,
					bodyHeight: document.body.scrollHeight,
					workspaceHeight: workspace.getBoundingClientRect().height,
					modelFrameHeight: frame.getBoundingClientRect().height,
					canvasWidth: viewportCanvas.getBoundingClientRect().width,
					canvasHeight: viewportCanvas.getBoundingClientRect().height,
					canvasPixelWidth: viewportCanvas.width,
					canvasPixelHeight: viewportCanvas.height
				};
			});
			measurements.push(dimensions);
			expect(dimensions.innerWidth).toBe(viewport.width);
			expect(dimensions.innerHeight).toBe(viewport.height);
			expect(dimensions.documentWidth).toBeLessThanOrEqual(viewport.width);
			expect(dimensions.bodyWidth).toBeLessThanOrEqual(viewport.width);
			expect(dimensions.documentHeight).toBeLessThanOrEqual(dimensions.shellHeight + 2);
			expect(dimensions.bodyHeight).toBeLessThanOrEqual(dimensions.shellHeight + 2);
			expect(dimensions.modelFrameHeight).toBeGreaterThan(0);
			expect(dimensions.canvasWidth).toBeGreaterThan(0);
			expect(dimensions.canvasHeight).toBeGreaterThan(0);
			expect(dimensions.canvasPixelWidth).toBeGreaterThan(0);
			expect(dimensions.canvasPixelHeight).toBeGreaterThan(0);
			if (viewport.width <= 430) {
				expect(dimensions.modelFrameHeight).toBeGreaterThanOrEqual(dimensions.workspaceHeight * 0.55);
			}
			await page.screenshot({ path: testInfo.outputPath(`exact-loaded-${viewport.width}x${viewport.height}.png`), fullPage: false });
		}
		console.info(`Exact BOMC loaded-shell matrix: ${JSON.stringify(measurements)}`);
	} finally {
		await context.close();
	}
});
