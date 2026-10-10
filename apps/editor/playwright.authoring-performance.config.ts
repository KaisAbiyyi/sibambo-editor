import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runId = process.env.EDITOR_AUTHORING_RUN_ID ?? 'local';
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw new Error('EDITOR_AUTHORING_RUN_ID must be a lowercase evidence label.');

export default defineConfig({
	testDir: path.join(repoRoot, 'tooling', 'testing'),
	testMatch: 'editor-authoring-performance.spec.ts',
	outputDir: path.join(repoRoot, 'tooling', 'testing', 'results', runId, 'authoring-performance'),
	timeout: 1_200_000,
	globalTimeout: 2_400_000,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: 'list',
	projects: [{ name: 'editor-authoring-performance', use: { browserName: 'chromium' } }],
	use: {
		baseURL: 'http://127.0.0.1:5206',
		headless: true,
		channel: 'chromium',
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1,
		launchOptions: { args: ['--enable-gpu'] },
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	webServer: {
		command: 'bunx vite --config tooling/testing/authoring-performance/authoring-performance-vite.config.ts',
		cwd: repoRoot,
		url: 'http://127.0.0.1:5206',
		reuseExistingServer: false,
		timeout: 180_000
	}
});
