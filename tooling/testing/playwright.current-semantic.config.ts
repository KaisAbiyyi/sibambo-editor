import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import { readAcceleratedContext, type AcceleratedProofTicket } from './accelerated-proof';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ticketContext = readAcceleratedContext('current-semantic');
const ticket = ticketContext && !('discoveryOnly' in ticketContext) ? ticketContext as AcceleratedProofTicket : null;
const discovery = process.env.SIBAMBO_ACCELERATED_DISCOVERY === '1';

const config: PlaywrightTestConfig = {
	testDir: path.join(repoRoot, 'tooling', 'testing'),
	testMatch: ['editor-current-semantic.spec.ts'],
	outputDir: ticket?.outputDir ?? path.join(repoRoot, 'test-results', 'current-semantic'),
	projects: [{ name: 'editor-current-semantic-chromium', use: { ...devices['Desktop Chrome'] } }],
	reporter: ticket ? [['list'], ['json', { outputFile: ticket.reportFile }]] : 'list',
	timeout: 240_000,
	globalTimeout: 360_000,
	expect: { timeout: 30_000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	maxFailures: 1,
	use: {
		baseURL: 'http://127.0.0.1:5202', browserName: 'chromium', headless: true,
		viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block', trace: 'retain-on-failure'
	},
	...(discovery ? {} : { webServer: {
		command: 'bun run build && bun run serve:build',
		cwd: path.join(repoRoot, 'apps', 'editor'),
		url: 'http://127.0.0.1:5202',
		reuseExistingServer: false,
		timeout: 180_000,
		env: { HOST: '127.0.0.1', PORT: '5202' }
	} })
};

export default defineConfig(config);
