import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import { readProofTicket } from '../../tooling/testing/proof-run-contract';

const editorRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(editorRoot, '../..');
const proof = readProofTicket('cold');
const discovery = 'discoveryOnly' in proof;

const config: PlaywrightTestConfig = {
	testDir: path.join(repoRoot, 'tooling', 'testing'),
	testMatch: ['editor-dev-cold-start.spec.ts'],
	outputDir: proof.outputDir,
	reporter: discovery ? 'list' : [['list'], ['json', { outputFile: proof.reportFile }]],
	timeout: 180_000,
	globalTimeout: 300_000,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	maxFailures: 1,
	use: { baseURL: 'http://127.0.0.1:5198', browserName: 'chromium', headless: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block' },
	...(discovery ? {} : { webServer: {
		command: `bunx vite --config "${path.join(repoRoot, 'tooling', 'testing', 'editor-cold-vite.config.ts')}" --host 127.0.0.1 --port 5198 --strictPort`,
		cwd: editorRoot,
		url: 'http://127.0.0.1:5198',
		reuseExistingServer: false,
		timeout: 60_000,
		env: { SIBAMBO_STABILITY_RUN: proof.executionRoot, SIBAMBO_STABILITY_CYCLE: proof.cycle! }
	} })
};

export default defineConfig(config);
