import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const harnessRoot = path.dirname(fileURLToPath(import.meta.url));
const editorRoot = path.resolve(harnessRoot, '../../..');
const worklogValue = process.env.SIBAMBO_RECOVERY_WORKLOG;
const attempt = process.env.SIBAMBO_RECOVERY_UI_ATTEMPT;
if (!worklogValue || !path.isAbsolute(worklogValue)) throw new Error('SIBAMBO_RECOVERY_WORKLOG must be an absolute path.');
if (!['01', '02', '03', '04', '05', '06', '07', '08', '09'].includes(attempt ?? '')) throw new Error('SIBAMBO_RECOVERY_UI_ATTEMPT must be 01 through 09.');
const outputDir = path.join(path.resolve(worklogValue), 'browser', `editor-ui-attempt-${attempt}`, 'playwright-output');

export default defineConfig({
	testDir: path.join(editorRoot, 'apps/editor/tests'),
	testMatch: ['model-tab-title.spec.ts', 'viewer-recovery.spec.ts', 'materials-v2.spec.ts'],
	outputDir,
	timeout: 120_000,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: 'list',
	use: {
		baseURL: 'http://127.0.0.1:5185',
		browserName: 'chromium',
		headless: true,
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1,
		serviceWorkers: 'block'
	},
	webServer: {
		command: 'bunx vite --config vite.config.ts --host 127.0.0.1 --port 5185 --strictPort',
		cwd: path.join(editorRoot, 'apps/editor'),
		url: 'http://127.0.0.1:5185',
		reuseExistingServer: false,
		timeout: 60_000
	}
});
