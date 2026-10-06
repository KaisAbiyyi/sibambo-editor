import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import { readProofTicket } from '../../tooling/testing/proof-run-contract';

const editorRoot = path.dirname(fileURLToPath(import.meta.url));
const proof = readProofTicket('semantic');
const discovery = 'discoveryOnly' in proof;
const config: PlaywrightTestConfig = {
	testDir: path.join(editorRoot, 'tests'),
	testMatch: ['materials-v2.spec.ts'],
	outputDir: proof.outputDir,
	projects: [{ name: 'editor-chromium', use: { ...devices['Desktop Chrome'] } }],
	reporter: discovery ? 'list' : [['list'], ['json', { outputFile: proof.reportFile }]],
	timeout: 180_000,
	globalTimeout: 300_000,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	maxFailures: 1,
	use: { baseURL: 'http://127.0.0.1:5202', browserName: 'chromium', headless: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block' },
	...(discovery ? {} : { webServer: {
		command: 'bun run build && bun run serve:build',
		cwd: editorRoot,
		url: 'http://127.0.0.1:5202',
		reuseExistingServer: false,
		timeout: 120_000,
		env: { HOST: '127.0.0.1', PORT: '5202' }
	} })
};

export default defineConfig(config);
