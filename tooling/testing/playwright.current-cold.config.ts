import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import { readAcceleratedContext, type AcceleratedProofTicket } from './accelerated-proof';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ticketContext = readAcceleratedContext('current-cold');
const ticket = ticketContext && !('discoveryOnly' in ticketContext) ? ticketContext as AcceleratedProofTicket : null;
const discovery = process.env.SIBAMBO_ACCELERATED_DISCOVERY === '1';

const config: PlaywrightTestConfig = {
	testDir: path.join(repoRoot, 'tooling', 'testing'),
	testMatch: ['editor-current-cold-start.spec.ts'],
	// Playwright clears its outputDir before the webServer starts. Keep that cleanup
	// inside the ticketed evidence root so the current-cold Vite config can validate
	// the retained root while it starts.
	outputDir: ticket ? path.join(ticket.outputDir, 'playwright-test-output') : path.join(repoRoot, 'test-results', 'current-cold'),
	projects: [{ name: 'editor-current-cold-chromium', use: { ...devices['Desktop Chrome'] } }],
	reporter: ticket ? [['list'], ['json', { outputFile: ticket.reportFile }]] : 'list',
	timeout: 240_000,
	globalTimeout: 1_200_000,
	expect: { timeout: 30_000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	maxFailures: 1,
	use: {
		baseURL: 'http://127.0.0.1:5198', browserName: 'chromium', headless: true,
		viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block', trace: 'retain-on-failure'
	},
	...(discovery ? {} : { webServer: {
		command: `bunx vite --config "${path.join(repoRoot, 'tooling', 'testing', 'editor-current-cold-vite.config.ts')}" --host 127.0.0.1 --port 5198 --strictPort`,
		cwd: path.join(repoRoot, 'apps', 'editor'),
		url: 'http://127.0.0.1:5198',
		reuseExistingServer: false,
		timeout: 60_000,
		env: ticket ? { SIBAMBO_ACCELERATED_RUN_ROOT: ticket.executionRoot } : {}
	} })
};

export default defineConfig(config);
