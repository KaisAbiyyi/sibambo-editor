import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import { readProofTicket } from '../../testing/proof-run-contract';

const harnessRoot = path.dirname(fileURLToPath(import.meta.url));
const editorRoot = path.resolve(harnessRoot, '../../..');
const proof = readProofTicket('mirror');
const discovery = 'discoveryOnly' in proof;

const config: PlaywrightTestConfig = {
	testDir: harnessRoot,
	testMatch: ['navigation.spec.ts', 'door-visibility.spec.ts', 'mirrored-surfaces.spec.ts'],
	outputDir: proof.outputDir,
	timeout: 180_000,
	globalTimeout: 360_000,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	maxFailures: 1,
	reporter: discovery ? 'list' : [['list'], ['json', { outputFile: proof.reportFile }]],
	use: {
		baseURL: 'http://127.0.0.1:5197',
		browserName: 'chromium',
		headless: true,
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1,
		serviceWorkers: 'block'
	},
	...(discovery ? {} : { webServer: {
		command: `bunx vite --config "${path.join(harnessRoot, 'vite.config.ts')}" --host 127.0.0.1 --port 5197 --strictPort`,
		cwd: editorRoot,
		url: 'http://127.0.0.1:5197',
		reuseExistingServer: false,
		timeout: 60_000,
		env: { SIBAMBO_RECOVERY_WORKLOG: proof.executionRoot, SIBAMBO_RECOVERY_ATTEMPT: proof.attempt }
	} })
};

export default defineConfig(config);
