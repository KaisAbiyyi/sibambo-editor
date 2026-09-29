import { expect, test } from '@playwright/test';

test('serves an app-specific build identity', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('[data-app="editor"]')).toBeVisible();
	await expect(page.getByRole('heading', { level: 1, name: 'Open a verified model' })).toBeVisible();
	await expect(page.getByTestId('build-fingerprint')).toHaveText(/^[a-f0-9]{64}$/);
	const response = await page.request.get('/__build.json');
	expect(response.ok()).toBeTruthy();
	expect(await response.json()).toMatchObject({ app: 'editor', fingerprintScheme: 'sibambo-app-closure-sha256-v1' });
});
