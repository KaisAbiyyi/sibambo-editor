import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appRoot, '../..');
const runId = process.env.EDITOR_BROWSER_MATRIX_RUN_ID;
const engine = process.env.EDITOR_BROWSER_MATRIX_ENGINE;
if (!runId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw new Error('EDITOR_BROWSER_MATRIX_RUN_ID must be a unique lowercase evidence label.');
if (!['chrome', 'edge', 'firefox', 'webkit'].includes(engine ?? '')) throw new Error('EDITOR_BROWSER_MATRIX_ENGINE must be chrome, edge, firefox, or webkit.');

const chromiumChannel = engine === 'chrome' ? 'chrome' : engine === 'edge' ? 'msedge' : undefined;
const browserName = chromiumChannel ? 'chromium' : engine as 'firefox' | 'webkit';
const outputDir = path.join(repoRoot, 'tooling', 'testing', 'results', runId, 'browser-matrix', engine!);

export default defineConfig({
	testDir: './tests',
	testMatch: 'bomc-authoring.spec.ts',
	outputDir,
	timeout: 240_000,
	globalTimeout: 1_800_000,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: 'list',
	grep: /New downloads canonical bytes|keeps the dirty checkpoint on Cancel/,
	use: {
		browserName,
		...(chromiumChannel ? { channel: chromiumChannel } : {}),
		baseURL: 'http://127.0.0.1:5206',
		headless: true,
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1,
		...(chromiumChannel ? { launchOptions: { args: ['--enable-gpu'] } } : {}),
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
