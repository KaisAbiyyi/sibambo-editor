import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const harnessRoot = path.dirname(fileURLToPath(import.meta.url));
const editorRoot = path.resolve(harnessRoot, '../../..');
const workspaceRoot = path.resolve(editorRoot, '..');
const worklogValue = process.env.SIBAMBO_RECOVERY_WORKLOG;
const attempt = process.env.SIBAMBO_RECOVERY_ATTEMPT;
if (!worklogValue || !path.isAbsolute(worklogValue)) throw new Error('SIBAMBO_RECOVERY_WORKLOG must be an absolute path.');
if (attempt !== '01' && attempt !== '02') throw new Error('SIBAMBO_RECOVERY_ATTEMPT must be 01 or 02.');
const worklogRoot = path.resolve(worklogValue);
assertNested(workspaceRoot, worklogRoot);
assertNested(path.join(workspaceRoot, 'docs', 'worklogs', 'BOMC-VIEWER-RECOVERY-001'), worklogRoot);
const outputDir = path.join(worklogRoot, 'browser', `attempt-${attempt}`, 'playwright-output');

export default defineConfig({
	testDir: harnessRoot,
	testMatch: ['navigation.spec.ts', 'door-visibility.spec.ts'],
	outputDir,
	timeout: 120_000,
	globalTimeout: 900_000,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: 'list',
	use: {
		baseURL: 'http://127.0.0.1:5197',
		browserName: 'chromium',
		headless: true,
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1,
		serviceWorkers: 'block'
	},
	webServer: {
		command: `bunx vite --config "${path.join(harnessRoot, 'vite.config.ts')}" --host 127.0.0.1 --port 5197 --strictPort`,
		cwd: editorRoot,
		url: 'http://127.0.0.1:5197',
		reuseExistingServer: false,
		timeout: 60_000,
		env: { SIBAMBO_RECOVERY_WORKLOG: worklogRoot, SIBAMBO_RECOVERY_ATTEMPT: attempt }
	}
});

function assertNested(root: string, target: string) {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Recovery worklog must be nested inside ${root}.`);
	}
}
