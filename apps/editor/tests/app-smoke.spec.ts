import { expect, test } from '@playwright/test';

test('serves an app-specific build identity', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('[data-app="editor"]')).toBeVisible();
	await expect(page.getByRole('heading', { level: 1, name: 'Open a model file' })).toBeVisible();
	await expect(page.getByTestId('source-fingerprint')).toHaveText(/^[a-f0-9]{64}$/);
	const response = await page.request.get('/__build.json');
	expect(response.ok()).toBeTruthy();
	expect(await response.json()).toMatchObject({
		schema: 'sibambo-app-build-identity-v2',
		app: 'editor',
		commit: expect.stringMatching(/^[a-f0-9]{40}$/i),
		dirty: expect.any(Boolean),
		fingerprintScheme: 'sibambo-app-closure-sha256-v1',
		sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/i),
		workingTree: {
			buildInputModifiedPaths: expect.any(Array),
			buildInputUntrackedPaths: expect.any(Array),
			otherModifiedPaths: expect.any(Array),
			otherUntrackedPaths: expect.any(Array),
			generatedOutputPaths: expect.any(Array)
		}
	});
	await page.locator('.build-details > summary').click();
	const workingTree = page.getByTestId('build-working-tree');
	await expect(workingTree).toBeVisible();
	for (const label of [
		'Build-input modified paths', 'Build-input untracked paths', 'Other modified paths',
		'Other untracked paths', 'Generated output paths'
	]) await expect(workingTree.getByText(label, { exact: true })).toBeVisible();
});
