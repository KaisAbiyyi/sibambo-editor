import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './tests', timeout: 30000, fullyParallel: false, workers: 1, reporter: 'list',
	projects: [{ name: 'editor-chromium', use: { ...devices['Desktop Chrome'] } }],
	use: { baseURL: 'http://localhost:5175', headless: true },
	webServer: {
		command: 'bun run build && bun run serve:build',
		url: 'http://127.0.0.1:5175',
		reuseExistingServer: false,
		timeout: 120000,
		env: { HOST: '127.0.0.1', PORT: '5175' }
	}
});
