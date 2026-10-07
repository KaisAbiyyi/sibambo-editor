import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

const editorRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(editorRoot, '../..');

const config: PlaywrightTestConfig = {
	testDir: path.join(editorRoot, 'tests'),
	testMatch: ['bomc-profile-compatibility.spec.ts'],
	outputDir: path.join(repoRoot, 'test-results', 'bomc-profiles'),
	projects: [{ name: 'editor-profile-chromium', use: { ...devices['Desktop Chrome'] } }],
	reporter: 'list',
	timeout: 240_000,
	globalTimeout: 7_200_000,
	expect: { timeout: 30_000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	use: {
		baseURL: 'http://127.0.0.1:5203',
		browserName: 'chromium',
		headless: true,
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1,
		serviceWorkers: 'block',
		trace: 'retain-on-failure'
	},
	webServer: {
		command: 'bun run build && bun run serve:build',
		cwd: editorRoot,
		url: 'http://127.0.0.1:5203',
		reuseExistingServer: false,
		timeout: 180_000,
		env: { HOST: '127.0.0.1', PORT: '5203' }
	}
};

export default defineConfig(config);
