import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const configDir = path.dirname(fileURLToPath(import.meta.url));
const editorRoot = path.resolve(configDir, '../../..');
const workspaceRoot = path.resolve(editorRoot, '..');
const worklogRootValue = process.env.SIBAMBO_M2_WORKLOG;
const attempt = process.env.SIBAMBO_M2_ATTEMPT;
if (!worklogRootValue || !path.isAbsolute(worklogRootValue)) throw new Error('SIBAMBO_M2_WORKLOG must be an absolute path.');
if (attempt !== '01' && attempt !== '02') throw new Error('SIBAMBO_M2_ATTEMPT must be 01 or 02.');
const worklogRoot = path.resolve(worklogRootValue);
assertNested(workspaceRoot, worklogRoot);
assertNested(path.join(workspaceRoot, 'docs', 'worklogs', 'BOMC-MATERIALS-V2-001'), worklogRoot);
const outputDir = path.join(worklogRoot, 'pixel-playwright', `attempt-${attempt}`);
const outputDirPreflight = process.env.SIBAMBO_M2_PREFLIGHT_OUTPUT_DIR;
if (outputDirPreflight !== outputDir) {
	if (existsSync(outputDir)) throw new Error(`Refusing to reuse an existing MATERIALS-v2 Playwright attempt directory: ${outputDir}`);
	// Playwright reloads this config in its worker process after creating outputDir.
	// Propagate the successful one-time preflight to that process through its environment.
	process.env.SIBAMBO_M2_PREFLIGHT_OUTPUT_DIR = outputDir;
}

export default defineConfig({
	testDir: configDir,
	testMatch: 'proof.spec.ts',
	outputDir,
	timeout: 330_000,
	globalTimeout: 1_500_000,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	maxFailures: 1,
	reporter: 'list',
	use: {
		baseURL: 'http://127.0.0.1:5196',
		browserName: 'chromium',
		headless: true,
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1,
		serviceWorkers: 'block'
	},
	webServer: {
		command: 'bunx vite --config tooling/performance/materials-v2/vite.config.ts --host 127.0.0.1 --port 5196 --strictPort',
		cwd: editorRoot,
		url: 'http://127.0.0.1:5196',
		reuseExistingServer: false,
		timeout: 60_000,
		env: { SIBAMBO_M2_WORKLOG: worklogRoot, SIBAMBO_M2_ATTEMPT: attempt }
	}
});

function assertNested(root: string, target: string) {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Playwright worklog must be nested inside ${root}.`);
	}
}
