import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
export default defineConfig({
  testDir: './tests', testMatch: 'draft-sync.spec.ts', timeout: 45000, workers: 1, fullyParallel: false,
  outputDir: path.join(process.env.SE05_OUTPUT_ROOT!, 'browser-artifacts'),
  reporter: [['list'], ['json', { outputFile: path.join(process.env.SE05_OUTPUT_ROOT!, 'browser-results.json') }]],
  projects: [{ name: 'se05-chromium', use: { ...devices['Desktop Chrome'] } }],
  use: { baseURL: 'http://localhost:5175', headless: true, ignoreHTTPSErrors: true,
    launchOptions: { args: ['--ignore-certificate-errors'] } },
  webServer: { command: 'bun run build && bun run serve:build', url: 'http://127.0.0.1:5175', timeout: 120000,
    env: { HOST: '127.0.0.1', PORT: '5175', ORIGIN: 'http://localhost:5175' } }
});
