import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { chromium } from '@playwright/test';
import { computePercentiles } from './baseline-stats.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function verifyBuildEndpoint(app, baseUrl) {
	const url = `${baseUrl}/__build.json`;
	try {
		const res = await fetch(url, { headers: { 'Cache-Control': 'no-store' } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		return { ok: true, data };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export async function runBootInteractivityMeasurement(editorUrl, browser) {
	const context = await browser.newContext({
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1,
		bypassCSP: true
	});
	const page = await context.newPage();

	const jsRequests = [];
	let eagerThreeDetected = false;

	page.on('response', async (response) => {
		const url = response.url();
		const ct = response.headers()['content-type'] || '';
		if (url.endsWith('.js') || ct.includes('javascript')) {
			try {
				const body = await response.body();
				const gzip = zlib.gzipSync(body, { level: 9 });
				if (url.includes('three') || body.toString().includes('WebGLRenderer')) {
					eagerThreeDetected = true;
				}
				jsRequests.push({
					url,
					gzipBytes: gzip.length,
					transferBytes: body.length
				});
			} catch {
				// response might be empty or redirected
			}
		}
	});

	const navStart = performance.now();
	const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 30000 });

	await page.goto(editorUrl);

	// Poll click the Open Model button every 50ms until the filechooser opens
	let clicked = false;
	const interval = setInterval(async () => {
		try {
			const btn = page.locator('button.empty-open');
			if (await btn.isVisible()) {
				await btn.click({ timeout: 200 });
				clicked = true;
			}
		} catch {
			// ignore click errors during transition
		}
	}, 50);

	await fileChooserPromise;
	clearInterval(interval);
	const bootInteractivityMs = performance.now() - navStart;

	await context.close();

	const totalJsGzipBytes = jsRequests.reduce((sum, r) => sum + r.gzipBytes, 0);
	const totalTransferBytes = jsRequests.reduce((sum, r) => sum + r.transferBytes, 0);

	return {
		bootInteractivityMs,
		totalJsGzipBytes,
		totalTransferBytes,
		eagerThreeDetected,
		requests: jsRequests
	};
}

export async function runDiagnosticTraceLold(editorUrl, lOldPath, browser) {
	const context = await browser.newContext({
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1
	});
	const page = await context.newPage();

	// Inject worker timing probe
	await page.addInitScript(() => {
		window.__diagnosticLog = {};
		const OriginalWorker = window.Worker;
		window.Worker = function (scriptURL, options) {
			const worker = new OriginalWorker(scriptURL, options);
			const originalPost = worker.postMessage.bind(worker);
			worker.postMessage = function (msg, transfer) {
				if (msg && msg.type === 'load') {
					window.__diagnosticLog.loadPostAt = performance.now();
				}
				return originalPost(msg, transfer);
			};
			worker.addEventListener('message', (event) => {
				if (event.data && event.data.type === 'complete') {
					window.__diagnosticLog.completeReceivedAt = performance.now();
					window.__diagnosticLog.completeData = {
						counts: event.data.result?.counts,
						diagnostics: event.data.result?.diagnostics
					};
					requestAnimationFrame(() => {
						window.__diagnosticLog.firstFrameAt = performance.now();
					});
				}
			});
			return worker;
		};
	});

	try {
		await page.goto(editorUrl);
		const start = performance.now();
		const fileInput = page.locator('input[type="file"][accept*=".bomc"]');
		await fileInput.setInputFiles(lOldPath);

		// Wait for ready
		await page.waitForFunction(
			() => {
				const status = document.querySelector('.footer-status')?.textContent || '';
				return status.includes('Ready');
			},
			undefined,
			{ timeout: 120000 }
		);

		const totalDurationMs = performance.now() - start;

		const probeData = await page.evaluate(() => window.__diagnosticLog);
		await context.close();

		return {
			passed: true,
			postMessageEpochMs: probeData.loadPostAt,
			mainReceiveEpochMs: probeData.completeReceivedAt,
			firstFrameEpochMs: probeData.firstFrameAt,
			transferDurationMs:
				probeData.completeReceivedAt && probeData.loadPostAt
					? probeData.completeReceivedAt - probeData.loadPostAt
					: undefined,
			totalDurationMs
		};
	} catch (err) {
		await context.close();
		return {
			passed: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

export async function runSingleAttempt(
	app,
	baseUrl,
	fixture,
	workspaceRoot,
	page,
	timeoutMs = 120000
) {
	const filePath = resolve(workspaceRoot, fixture.locator);
	const start = performance.now();

	try {
		if (app === 'editor') {
			await page.goto(baseUrl);
			const fileInput = page.locator('input[type="file"][accept*=".bomc"]');
			await fileInput.setInputFiles(filePath);

			// Check for rejection (e.g. MATERIALS v2 on B0)
			const outcome = await Promise.race([
				// 1. Ready
				page
					.waitForFunction(
						() => {
							const status = document.querySelector('.footer-status')?.textContent || '';
							return status.includes('Ready');
						},
						undefined,
						{ timeout: timeoutMs }
					)
					.then(() => 'ready'),
				// 2. Error
				page
					.waitForFunction(
						() => {
							const errEl = document.querySelector('.empty-error, .viewport-status.error-state');
							if (errEl && errEl.textContent) return errEl.textContent;
							return false;
						},
						undefined,
						{ timeout: timeoutMs }
					)
					.then((val) => ({ error: String(val) }))
			]);

			const durationMs = performance.now() - start;
			if (typeof outcome === 'object' && outcome.error) {
				const isV2Rejection = outcome.error.includes('material section version');
				return {
					passed: isV2Rejection && fixture.expectedMaterialsVersion >= 2,
					outcome: isV2Rejection ? 'expected_rejection' : 'unexpected_error',
					durationMs,
					error: outcome.error
				};
			}

			return {
				passed: true,
				outcome: 'ready',
				durationMs
			};
		} else if (app === 'rooms') {
			await page.goto(baseUrl);
			// Open import dialog
			const openBtn = page.locator('button.open-model, button.start-import').first();
			if (await openBtn.isVisible()) {
				await openBtn.click();
			}
			const dialog = page.locator('dialog.import-dialog');
			await dialog.waitFor({ state: 'visible', timeout: 5000 });

			const fileInput = page.locator('input[aria-label="BOMC 1.2 file"]');
			await fileInput.setInputFiles(filePath);

			const actionBtn = page.locator('button.primary:has-text("Open and review")');
			await actionBtn.click();

			const outcome = await Promise.race([
				// Ready: dialog closed and canvas visible
				page
					.waitForFunction(
						() => {
							const d = document.querySelector('dialog.import-dialog');
							const canvas = document.querySelector('.canvas-stage canvas');
							return (!d || !d.open) && !!canvas;
						},
						undefined,
						{ timeout: timeoutMs }
					)
					.then(() => 'ready'),
				// Error
				page
					.waitForFunction(
						() => {
							const errEl = document.querySelector('dialog.import-dialog p.error, .global-notices p.error');
							if (errEl && errEl.textContent) return errEl.textContent;
							return false;
						},
						undefined,
						{ timeout: timeoutMs }
					)
					.then((val) => ({ error: String(val) }))
			]);

			const durationMs = performance.now() - start;
			if (typeof outcome === 'object' && outcome.error) {
				const isV2Rejection = outcome.error.includes('material section version');
				return {
					passed: isV2Rejection && fixture.expectedMaterialsVersion >= 2,
					outcome: isV2Rejection ? 'expected_rejection' : 'unexpected_error',
					durationMs,
					error: outcome.error
				};
			}

			return {
				passed: true,
				outcome: 'ready',
				durationMs
			};
		} else if (app === 'benchmark') {
			await page.goto(`${baseUrl}/capture`);
			const fileInput = page.locator('input[type="file"][accept*=".bomc"]');
			await fileInput.setInputFiles(filePath);

			const openBtn = page.locator('button.primary:has-text("Open model file")');
			await openBtn.click();

			const outcome = await Promise.race([
				// Ready
				page
					.waitForFunction(
						() => {
							const state = document.querySelector('.run-state.ready')?.textContent || '';
							return state.includes('Renderer ready');
						},
						undefined,
						{ timeout: timeoutMs }
					)
					.then(() => 'ready'),
				// Error
				page
					.waitForFunction(
						() => {
							const errEl = document.querySelector('p.error[role="alert"]');
							if (errEl && errEl.textContent) return errEl.textContent;
							return false;
						},
						undefined,
						{ timeout: timeoutMs }
					)
					.then((val) => ({ error: String(val) }))
			]);

			const durationMs = performance.now() - start;
			if (typeof outcome === 'object' && outcome.error) {
				const isV2Rejection = outcome.error.includes('material section version');
				return {
					passed: isV2Rejection && fixture.expectedMaterialsVersion >= 2,
					outcome: isV2Rejection ? 'expected_rejection' : 'unexpected_error',
					durationMs,
					error: outcome.error
				};
			}

			return {
				passed: true,
				outcome: 'ready',
				durationMs
			};
		}

		throw new Error(`Unknown app: ${app}`);
	} catch (err) {
		const durationMs = performance.now() - start;
		const isTimeout = durationMs >= timeoutMs * 0.95;
		return {
			passed: false,
			outcome: isTimeout ? 'timeout' : 'unexpected_error',
			durationMs,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

export async function runBaselineRunner(config) {
	console.log(`=== RUNNING BASELINE RUNNER: ${config.baseline} ===`);
	mkdirSync(config.outputDir, { recursive: true });

	const manifestContent = readFileSync(config.manifestPath, 'utf-8');
	const manifest = JSON.parse(manifestContent);

	console.log(`Verifying application build endpoints...`);
	const editorBuild = await verifyBuildEndpoint('editor', config.editorUrl);
	const roomsBuild = await verifyBuildEndpoint('rooms', config.roomsUrl);
	const benchmarkBuild = await verifyBuildEndpoint('benchmark', config.benchmarkUrl);

	console.log(`Editor build: ${JSON.stringify(editorBuild)}`);
	console.log(`Rooms build: ${JSON.stringify(roomsBuild)}`);
	console.log(`Benchmark build: ${JSON.stringify(benchmarkBuild)}`);

	const browser = await chromium.launch({
		headless: true,
		args: ['--use-gl=angle', '--use-angle=default']
	});

	const environment = {
		os: process.platform,
		arch: process.arch,
		nodeVersion: process.version,
		browser: `Chromium ${browser.version()}`,
		viewport: { width: 1440, height: 900 },
		devicePixelRatio: 1,
		timestamp: new Date().toISOString()
	};

	const attempts = [];
	const apps = ['editor', 'rooms', 'benchmark'];

	// 1. Boot interactivity series (Editor)
	let bootResult;
	if (config.runBoot) {
		console.log(`Measuring Editor boot interactivity and eager closure...`);
		bootResult = await runBootInteractivityMeasurement(config.editorUrl, browser);
		console.log(`Editor boot interactivity: ${bootResult.bootInteractivityMs.toFixed(1)}ms`);
		console.log(`Editor total JS gzip: ${(bootResult.totalJsGzipBytes / 1024).toFixed(1)} KiB`);
		console.log(`Eager Three detected: ${bootResult.eagerThreeDetected}`);
	}

	// 2. Diagnostic worker trace for L-old (Editor)
	let diagnosticTrace;
	if (config.runDiagnostic) {
		const lOldFixture = manifest.fixtures.find((f) => f.id === 'L-old');
		if (lOldFixture) {
			console.log(`Running diagnostic worker trace for L-old...`);
			const lOldPath = resolve(config.workspaceRoot, lOldFixture.locator);
			diagnosticTrace = await runDiagnosticTraceLold(config.editorUrl, lOldPath, browser);
			console.log(`L-old diagnostic trace result:`, diagnosticTrace);
		}
	}

	// 3. Matrix execution: apps x fixtures
	for (const app of apps) {
		const baseUrl =
			app === 'editor' ? config.editorUrl : app === 'rooms' ? config.roomsUrl : config.benchmarkUrl;

		console.log(`\n--- Benchmarking App: ${app} (${baseUrl}) ---`);

		for (const fixture of manifest.fixtures) {
			const isV2 = fixture.expectedMaterialsVersion >= 2;

			if (config.baseline === 'B0' && isV2) {
				// Expected rejection: run 1 probe attempt
				console.log(`Testing expected rejection for MATERIALS v2: ${fixture.id}...`);
				const context = await browser.newContext({
					viewport: { width: 1440, height: 900 },
					deviceScaleFactor: 1
				});
				const page = await context.newPage();
				const result = await runSingleAttempt(
					app,
					baseUrl,
					fixture,
					config.workspaceRoot,
					page,
					config.timeoutMs
				);
				await context.close();

				attempts.push({
					attemptId: `${app}-${fixture.id}-rejection`,
					baseline: config.baseline,
					app,
					fixtureId: fixture.id,
					mode: 'cold',
					iteration: 1,
					passed: result.passed,
					outcome: result.outcome,
					durationMs: result.durationMs,
					error: result.error,
					timestamp: new Date().toISOString()
				});
				console.log(`  -> ${fixture.id}: outcome=${result.outcome} error=${result.error}`);
				continue;
			}

			// Supported fixtures: run cold attempts
			console.log(`Testing COLD attempts for ${fixture.id} (${config.attempts} runs)...`);
			for (let i = 1; i <= config.attempts; i++) {
				const context = await browser.newContext({
					viewport: { width: 1440, height: 900 },
					deviceScaleFactor: 1
				});
				const page = await context.newPage();
				const result = await runSingleAttempt(
					app,
					baseUrl,
					fixture,
					config.workspaceRoot,
					page,
					config.timeoutMs
				);
				await context.close();

				attempts.push({
					attemptId: `${app}-${fixture.id}-cold-${i}`,
					baseline: config.baseline,
					app,
					fixtureId: fixture.id,
					mode: 'cold',
					iteration: i,
					passed: result.passed,
					outcome: result.outcome,
					durationMs: result.durationMs,
					error: result.error,
					timestamp: new Date().toISOString()
				});
				console.log(`  [cold ${i}/${config.attempts}] ${result.outcome} in ${result.durationMs.toFixed(1)}ms`);
			}

			// Warm attempts: reuse single context after priming
			console.log(`Testing WARM attempts for ${fixture.id} (${config.attempts} runs)...`);
			const warmContext = await browser.newContext({
				viewport: { width: 1440, height: 900 },
				deviceScaleFactor: 1
			});
			const warmPage = await warmContext.newPage();

			// Prime
			await runSingleAttempt(app, baseUrl, fixture, config.workspaceRoot, warmPage, config.timeoutMs);

			for (let i = 1; i <= config.attempts; i++) {
				const result = await runSingleAttempt(
					app,
					baseUrl,
					fixture,
					config.workspaceRoot,
					warmPage,
					config.timeoutMs
				);
				attempts.push({
					attemptId: `${app}-${fixture.id}-warm-${i}`,
					baseline: config.baseline,
					app,
					fixtureId: fixture.id,
					mode: 'warm',
					iteration: i,
					passed: result.passed,
					outcome: result.outcome,
					durationMs: result.durationMs,
					error: result.error,
					timestamp: new Date().toISOString()
				});
				console.log(`  [warm ${i}/${config.attempts}] ${result.outcome} in ${result.durationMs.toFixed(1)}ms`);
			}
			await warmContext.close();
		}
	}

	await browser.close();

	// Summarize percentiles
	const summaryPercentiles = {};
	for (const app of apps) {
		for (const fixture of manifest.fixtures) {
			for (const mode of ['cold', 'warm']) {
				const key = `${app}-${fixture.id}-${mode}`;
				const matched = attempts.filter(
					(a) => a.app === app && a.fixtureId === fixture.id && a.mode === mode
				);
				const readyRows = matched.filter((a) => a.outcome === 'ready');
				const failedRows = matched.filter((a) => a.outcome !== 'ready');
				const timeoutRows = matched.filter((a) => a.outcome === 'timeout');

				const stats = computePercentiles(
					readyRows.map((r) => r.durationMs),
					failedRows.length,
					timeoutRows.length
				);
				summaryPercentiles[key] = {
					app,
					fixtureId: fixture.id,
					mode,
					stats,
					allRowsCount: matched.length
				};
			}
		}
	}

	// Write outputs
	const rawAttemptsPath = join(config.outputDir, 'raw-attempts.json');
	const summaryPath = join(config.outputDir, 'summary-percentiles.json');
	const reportPath = join(config.outputDir, 'B0-baseline-report.md');

	writeFileSync(rawAttemptsPath, JSON.stringify({ environment, builds: { editor: editorBuild, rooms: roomsBuild, benchmark: benchmarkBuild }, attempts }, null, 2));
	writeFileSync(summaryPath, JSON.stringify({ environment, summaryPercentiles, bootResult, diagnosticTrace }, null, 2));

	// Markdown report
	let report = `# BASELINE B0 EXECUTION REPORT

| Metadata | Value |
| --- | --- |
| Baseline | **${config.baseline}** |
| Environment | ${environment.os} (${environment.arch}), ${environment.browser}, Node ${environment.nodeVersion} |
| Viewport | 1440x900 @ 1x DPR |
| Date / Time | ${environment.timestamp} |
| Editor Build | ${editorBuild.ok ? `${editorBuild.data.commit} (dirty: ${editorBuild.data.dirty})` : 'unverified'} |
| Rooms Build | ${roomsBuild.ok ? `${roomsBuild.data.commit} (dirty: ${roomsBuild.data.dirty})` : 'unverified'} |
| Benchmark Build | ${benchmarkBuild.ok ? `${benchmarkBuild.data.commit} (dirty: ${benchmarkBuild.data.dirty})` : 'unverified'} |

## 1. Editor Boot Closure and Interactivity
${
	bootResult
		? `- **Boot Interactivity**: ${bootResult.bootInteractivityMs.toFixed(1)} ms
- **Pre-Open Total JS Gzip**: ${(bootResult.totalJsGzipBytes / 1024).toFixed(1)} KiB
- **Pre-Open Total JS Transfer**: ${(bootResult.totalTransferBytes / 1024).toFixed(1)} KiB
- **Eager Three.js Module Execution**: **${bootResult.eagerThreeDetected ? 'CONFIRMED' : 'Not detected'}** (Three is bundled and executed before model Open)`
		: 'Not run'
}

## 2. Diagnostic Worker Trace (L-old)
${
	diagnosticTrace
		? `- Status: ${diagnosticTrace.passed ? 'PASSED' : 'FAILED'}
- Total duration: ${diagnosticTrace.totalDurationMs ? `${diagnosticTrace.totalDurationMs.toFixed(1)} ms` : 'N/A'}
- Worker postMessage to Complete receive: ${diagnosticTrace.transferDurationMs ? `${diagnosticTrace.transferDurationMs.toFixed(1)} ms` : 'N/A'}`
		: 'Not run'
}

## 3. Admission and Materials v2 Rejection Outcomes
All 4 MATERIALS v2 fixtures (S1-new, S2-new, I-new, Y-new) were rejected as expected by the unmodified B0 reader:
- Rejection error: \`BOMC invalid: material section version.\`
- Outcome: **expected_rejection** across Editor, Rooms, and Benchmark.

## 4. Summary Percentiles for Supported Fixtures (Cold & Warm)

| App | Fixture | Mode | Runs | P50 (ms) | P95 (ms) | Min (ms) | Max (ms) | Failures |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
`;

	for (const [key, item] of Object.entries(summaryPercentiles)) {
		const s = item.stats;
		if (s.count > 0) {
			report += `| ${item.app} | ${item.fixtureId} | ${item.mode} | ${s.count} | ${s.p50.toFixed(1)} | ${s.p95.toFixed(1)} | ${s.min.toFixed(1)} | ${s.max.toFixed(1)} | ${s.failedCount} |\n`;
		} else if (s.timeoutsCount > 0) {
			report += `| ${item.app} | ${item.fixtureId} | ${item.mode} | ${item.allRowsCount} | TIMEOUT (>120s) | TIMEOUT (>120s) | >120s | >120s | ${s.failedCount} |\n`;
		}
	}

	report += `\n## 5. Artifact and Output Paths
- Raw attempts: \`${rawAttemptsPath}\`
- Summary percentiles: \`${summaryPath}\`
- Inventory: \`${join(config.outputDir, 'bomc-inventory.json')}\`
`;

	writeFileSync(reportPath, report, 'utf-8');
	console.log(`\nBaseline report written to ${reportPath}`);
}

// CLI entry point
if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.includes('loader-baseline')) {
	(async () => {
		let baseline = 'B0';
		let workspaceRoot = resolve(__dirname, '../../..');
		let outputDir = resolve(workspaceRoot, 'docs/worklogs/BOMC-LOADER-001/2026-10-02-B0');
		let editorUrl = 'http://127.0.0.1:5174';
		let roomsUrl = 'http://127.0.0.1:5175';
		let benchmarkUrl = 'http://127.0.0.1:5173';
		let manifestPath = join(__dirname, 'fixtures.json');
		let attempts = 10;
		let runDiagnostic = true;
		let runBoot = true;

		for (let i = 2; i < process.argv.length; i++) {
			const arg = process.argv[i];
			if (arg === '--baseline' && process.argv[i + 1]) baseline = process.argv[++i];
			else if (arg === '--workspace-root' && process.argv[i + 1]) workspaceRoot = resolve(process.argv[++i]);
			else if (arg === '--output-dir' && process.argv[i + 1]) outputDir = resolve(process.argv[++i]);
			else if (arg === '--manifest' && process.argv[i + 1]) manifestPath = resolve(process.argv[++i]);
			else if (arg === '--editor-url' && process.argv[i + 1]) editorUrl = process.argv[++i];
			else if (arg === '--rooms-url' && process.argv[i + 1]) roomsUrl = process.argv[++i];
			else if (arg === '--benchmark-url' && process.argv[i + 1]) benchmarkUrl = process.argv[++i];
			else if (arg === '--attempts' && process.argv[i + 1]) attempts = parseInt(process.argv[++i], 10);
			else if (arg === '--no-diagnostic') runDiagnostic = false;
			else if (arg === '--no-boot') runBoot = false;
		}

		await runBaselineRunner({
			baseline,
			workspaceRoot,
			manifestPath,
			outputDir,
			editorUrl,
			roomsUrl,
			benchmarkUrl,
			attempts,
			runDiagnostic,
			runBoot,
			timeoutMs: 120000
		});
	})().catch((err) => {
		console.error('loader-baseline failed:', err);
		process.exit(1);
	});
}
