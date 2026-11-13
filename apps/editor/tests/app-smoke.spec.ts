import { expect, test } from '@playwright/test';

test('serves an app-specific build identity', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('[data-app="editor"]')).toBeVisible();
	await expect(page.getByRole('button', { name: 'New BOMC', exact: true })).toBeVisible();
	const response = await page.request.get('/__build.json');
	expect(response.ok()).toBeTruthy();
	const identity = await response.json();
	expect(identity).toMatchObject({
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
	// The current shell keeps its visible build identity in the footer; detailed hashes/paths
	// remain in the metadata endpoint asserted above.
	await expect(page.locator('.footer-build')).toContainText(`Build ${identity.commit.slice(0, 8)} · ${identity.dirty ? 'dirty' : 'clean'}`);
});
