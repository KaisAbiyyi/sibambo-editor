import { createHash } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
	resolveAllBomcProfileFixtures,
	type ResolvedBomcProfileFixture
} from '../../../tooling/testing/bomc-profile-fixtures';

type CanvasBox = { x: number; y: number; width: number; height: number };
type PickEvidence = { xFraction: number; yFraction: number; footerStatus: string };

const fixtures = resolveAllBomcProfileFixtures();
const fixtureIds = fixtures.map((fixture) => fixture.id);
if (fixtures.length !== 12 || new Set(fixtureIds).size !== 12) {
	throw new Error(`BOMC profile gate requires exactly 12 distinct pinned fixtures; received ${fixtures.length}.`);
}

function sha256(bytes: Buffer) {
	return createHash('sha256').update(bytes).digest('hex');
}

async function settleFrames(page: Page) {
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function waitForEditorReady(page: Page, fixture: ResolvedBomcProfileFixture) {
	const ready = page.locator('.footer-status').getByText('Ready', { exact: true });
	const alert = page.getByRole('alert');
	await expect(ready.or(alert).first()).toBeVisible({ timeout: 180_000 });
	if (await alert.isVisible()) {
		throw new Error(`${fixture.id} import failed before viewport readiness: ${(await alert.innerText()).trim()}`);
	}
	await expect(ready).toBeVisible();
}

function isPickEvidenceStatus(status: string) {
	return /\bselected\b/i.test(status)
		|| /\bFace\s+\d+\b/i.test(status)
		|| status.includes('This hit has no stable imported occurrence identity');
}

async function pickVisibleGeometry(page: Page, canvasBox: CanvasBox): Promise<PickEvidence | null> {
	const points: ReadonlyArray<readonly [number, number]> = [
		[0.50, 0.50], [0.38, 0.50], [0.62, 0.50], [0.50, 0.38], [0.50, 0.62],
		[0.35, 0.35], [0.65, 0.35], [0.35, 0.65], [0.65, 0.65],
		[0.25, 0.50], [0.75, 0.50], [0.50, 0.25], [0.50, 0.75]
	];
	const footerStatus = page.locator('.footer-status');
	for (const [xFraction, yFraction] of points) {
		await page.mouse.click(
			canvasBox.x + canvasBox.width * xFraction,
			canvasBox.y + canvasBox.height * yFraction
		);
		await settleFrames(page);
		const status = (await footerStatus.innerText()).trim();
		if (isPickEvidenceStatus(status)) return { xFraction, yFraction, footerStatus: status };
	}
	return null;
}

async function runProfileCase(page: Page, testInfo: TestInfo, fixture: ResolvedBomcProfileFixture) {
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	const workerRequests: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
	page.on('request', (request) => { if (request.url().includes('e4-import.worker')) workerRequests.push(request.url()); });

	const buildResponse = await page.request.get('/__build.json');
	expect(buildResponse.ok()).toBeTruthy();
	const buildIdentity = await buildResponse.json();
	expect(buildIdentity).toMatchObject({ schema: 'sibambo-app-build-identity-v2', app: 'editor' });

	await page.goto('/?renderer=webgl2', { waitUntil: 'networkidle' });
	await page.getByLabel('BOMC 1.2 file').setInputFiles(fixture.realPath);
	await waitForEditorReady(page, fixture);
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(page.locator('.tool-context span').nth(1)).toHaveText(fixture.profile, { timeout: 30_000 });

	const canvas = page.locator('canvas[aria-label="Interactive 3D model viewport"]');
	await expect(canvas).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole('button', { name: 'Orbit' })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Zoom Extents' })).toBeEnabled();
	await settleFrames(page);

	const beforePath = testInfo.outputPath('before-orbit.png');
	const afterPath = testInfo.outputPath('after-orbit.png');
	const beforePixels = await canvas.screenshot({ path: beforePath });
	let box = await canvas.boundingBox();
	expect(box).not.toBeNull();
	const centerX = box!.x + box!.width / 2;
	const centerY = box!.y + box!.height / 2;
	await page.getByRole('button', { name: 'Orbit' }).click();
	await page.mouse.move(centerX, centerY);
	await page.mouse.down();
	await page.mouse.move(centerX + 76, centerY + 42, { steps: 6 });
	await page.mouse.up();
	await settleFrames(page);
	const afterPixels = await canvas.screenshot({ path: afterPath });
	const beforeSha256 = sha256(beforePixels);
	const afterSha256 = sha256(afterPixels);
	expect(afterSha256).not.toBe(beforeSha256);

	await page.getByRole('button', { name: 'Zoom Extents' }).click();
	await settleFrames(page);
	await page.getByRole('button', { name: 'Select' }).click();
	box = await canvas.boundingBox();
	expect(box).not.toBeNull();
	const pickedAt = await pickVisibleGeometry(page, box!);
	expect(pickedAt).not.toBeNull();
	expect(isPickEvidenceStatus(pickedAt!.footerStatus)).toBe(true);
	expect(workerRequests.some((url) => url.includes('e4-import.worker'))).toBe(true);
	expect(pageErrors).toEqual([]);
	expect(consoleErrors).toEqual([]);

	await testInfo.attach('profile-case.json', {
		body: Buffer.from(JSON.stringify({
			fixture: {
				id: fixture.id,
				model: fixture.model,
				profile: fixture.profile,
				bytes: fixture.bytes,
				sha256: fixture.sha256,
				fileName: fixture.fileName,
				expectedPath: fixture.path,
				realPath: fixture.realPath
			},
			buildIdentity,
			workerRequests,
			orbit: { beforeSha256, afterSha256 },
			pick: pickedAt
		}, null, 2)),
		contentType: 'application/json'
	});
	await testInfo.attach('before-orbit.png', { path: beforePath, contentType: 'image/png' });
	await testInfo.attach('after-orbit.png', { path: afterPath, contentType: 'image/png' });
}

for (const fixture of fixtures) {
	test(`${fixture.id} imports, draws, orbits, and picks in the Editor`, async ({ page }, testInfo) => {
		await runProfileCase(page, testInfo, fixture);
	});
}
