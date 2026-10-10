import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appRoot, '../..');
const runId = process.env.EDITOR_AUTHORING_E2E_RUN_ID;
if (!runId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) {
	throw new Error('EDITOR_AUTHORING_E2E_RUN_ID must be a unique lowercase evidence label.');
}

export default defineConfig({
	testDir: './tests',
	testMatch: 'bomc-authoring.spec.ts',
	outputDir: path.join(repoRoot, 'tooling', 'testing', 'results', runId, 'authoring-ui'),
	timeout: 240_000,
	globalTimeout: 1_800_000,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: 'list',
	projects: [{ name: 'editor-authoring-chromium', use: { browserName: 'chromium' } }],
	use: {
		baseURL: 'http://127.0.0.1:5206',
		headless: true,
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1,
		launchOptions: { args: ['--enable-gpu'] },
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	webServer: {
		command: 'bunx vite --host 127.0.0.1 --port 5206 --strictPort',
		cwd: appRoot,
		url: 'http://127.0.0.1:5206',
		reuseExistingServer: false,
		timeout: 180_000,
		env: { HOST: '127.0.0.1', PORT: '5206' }
	}
});
