import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import { readProofTicket } from '../../testing/proof-run-contract';

const harnessRoot = path.dirname(fileURLToPath(import.meta.url));
const editorRoot = path.resolve(harnessRoot, '../../..');
const proof = readProofTicket('writer');
const discovery = 'discoveryOnly' in proof;

const config: PlaywrightTestConfig = {
	testDir: harnessRoot,
	testMatch: ['proof.spec.ts'],
	outputDir: proof.outputDir,
	reporter: discovery ? 'list' : [['list'], ['json', { outputFile: proof.reportFile }]],
	timeout: 120_000,
	globalTimeout: 300_000,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	maxFailures: 1,
	use: { baseURL: 'http://127.0.0.1:5201', browserName: 'chromium', headless: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
	...(discovery ? {} : { webServer: {
		command: `bunx vite --config "${path.join(harnessRoot, 'vite.config.ts')}" --host 127.0.0.1 --port 5201 --strictPort`,
		cwd: editorRoot,
		url: 'http://127.0.0.1:5201',
		reuseExistingServer: false,
		timeout: 30_000,
		env: { SIBAMBO_WRITER_WORKLOG: proof.executionRoot, SIBAMBO_WRITER_ATTEMPT: proof.attempt }
	} })
};

export default defineConfig(config);
