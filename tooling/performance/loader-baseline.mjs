import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';

const PLAN = 'BOMC-LOADER-001/v1.0';
const DEADLINE_MS = 120_000;
const POLL_MS = 50;
const APPS = [
	{ id: 'editor', selector: '[data-app="editor"]', basePort: 5175, path: '/', readySelector: '.editor-footer .footer-status', readyText: /^Ready$/i, errorSelectors: '[role="alert"], .empty-error' },
	{ id: 'rooms', selector: '[data-app="rooms"]', basePort: 5174, path: '/', readySelector: '.footer-status', readyText: /^Viewport ready\b/i, errorSelectors: '[role="alert"], .import-dialog .error' },
	{ id: 'benchmark', selector: '[data-app="benchmark-capture"]', basePort: 5173, path: '/capture', readySelector: '.run-bar .run-state', readyText: /^Renderer ready\b/i, errorSelectors: '[role="alert"], .error' }
];
const B0_COMMITS = {
	editor: '4edcc72b415ab16c9b3ad8d1edd3a433d64a452c',
	rooms: 'eeb3816fca4d455305414a48a44764169a1d90cb',
	benchmark: '9d2322409b307473ae88ce39fda825bbf05211c0'
};
const B0_EDITOR_FINGERPRINT = '8e33a8bfa2739aa09c4e5721cfb7e5101bcd6dd7963b82e1dab645f924a185ed';
const SUPPORTED_IDS = new Set(['L-old', 'Y-old', 'I-old', 'S2-jcm']);
const V2_IDS = new Set(['S1-new', 'S2-new', 'I-new', 'Y-new']);

function argValue(args, name, fallback) {
	const index = args.indexOf(name);
	if (index < 0) return fallback;
	const value = args[index + 1];
	if (!value || value.startsWith('--')) throw new Error(`Missing value after ${name}.`);
	return value;
}

function parseArgs(args) {
	const parsed = {
		baseline: argValue(args, '--baseline', null),
		workspaceRoot: argValue(args, '--workspace-root', null),
		fixtures: argValue(args, '--fixtures', path.resolve('tooling/performance/fixtures.json')),
		output: argValue(args, '--output', null),
		suite: argValue(args, '--suite', 'all'),
		urls: {
			editor: argValue(args, '--editor-url', null),
			rooms: argValue(args, '--rooms-url', null),
			benchmark: argValue(args, '--benchmark-url', null)
		}
	};
	if (!['B0', 'B1', 'P1'].includes(parsed.baseline)) throw new Error('--baseline must be B0, B1, or P1.');
	if (!parsed.workspaceRoot || !parsed.output || Object.values(parsed.urls).some((value) => !value)) {
		throw new Error('Required: --workspace-root, --editor-url, --rooms-url, --benchmark-url, and --output.');
	}
	if (!['all', 'model', 'boot', 'diagnostic'].includes(parsed.suite)) throw new Error('--suite must be all, model, boot, or diagnostic.');
	return parsed;
}

function assertWithinRoot(root, locator) {
	if (path.isAbsolute(locator)) throw new Error(`Fixture locator must be relative to --workspace-root: ${locator}`);
	const target = path.resolve(root, locator);
	const relative = path.relative(path.resolve(root), target);
	if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Fixture locator escapes workspace root: ${locator}`);
	return target;
}

export function verifyFixtureBytes(fixture, bytes) {
	if (bytes.byteLength !== fixture.bytes) throw new Error(`${fixture.id}: byte length ${bytes.byteLength} does not match pinned ${fixture.bytes}.`);
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	if (sha256 !== fixture.sha256) throw new Error(`${fixture.id}: SHA-256 ${sha256} does not match pinned ${fixture.sha256}.`);
	return sha256;
}

export function median(values) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function matchesReadyText(text, pattern) {
	return new RegExp(pattern, 'i').test(text.trim());
}

export function enforceDeadline(outcome, observedElapsedMs, deadlineMs = DEADLINE_MS) {
	if (observedElapsedMs <= deadlineMs) return { ...outcome, elapsedMs: observedElapsedMs };
	return {
		kind: 'timeout',
		text: `${outcome.kind} signal was observed after the ${deadlineMs}ms Open-to-ready deadline.`,
		elapsedMs: deadlineMs,
		lateOutcome: { kind: outcome.kind, text: outcome.text, observedElapsedMs }
	};
}

export async function raceWithDeadline(promise, timeoutMs) {
	let timer;
	const observed = Promise.resolve(promise).then(
		(value) => ({ kind: 'result', value }),
		(error) => ({ kind: 'error', error })
	);
	const deadline = new Promise((resolve) => {
		timer = setTimeout(() => resolve({ kind: 'timeout' }), Math.max(0, timeoutMs));
	});
	try { return await Promise.race([observed, deadline]); }
	finally { clearTimeout(timer); }
}

export function nearestRankPercentile(values, percentile) {
	if (values.length === 0) return null;
	if (!(percentile > 0 && percentile <= 1)) throw new Error('percentile must be within (0, 1].');
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(percentile * sorted.length) - 1];
}

export function summarizeTimingRows(rows, expectedAttempts = 10) {
	const durations = rows.map((row) => row.elapsedMs).filter((value) => Number.isFinite(value));
	const failedCount = rows.filter((row) => row.status !== 'ready').length;
	const timeoutCount = rows.filter((row) => row.status === 'timeout').length;
	return {
		attemptCount: rows.length,
		p50Ms: median(durations),
		p95Ms: nearestRankPercentile(durations, 0.95),
		minMs: durations.length ? Math.min(...durations) : null,
		maxMs: durations.length ? Math.max(...durations) : null,
		failedCount,
		timeoutCount,
		seriesPass: rows.length === expectedAttempts && failedCount === 0
	};
}

function readManifest(workspaceRoot, fixturePath) {
	const manifest = JSON.parse(readFileSync(fixturePath, 'utf8'));
	if (manifest.schemaVersion !== 'bomc-loader-fixture-manifest-v1' || manifest.plan !== PLAN || manifest.fixtures?.length !== 8) {
		throw new Error('Fixture manifest schema, plan ID, or eight-row count does not match the frozen contract.');
	}
	const ids = new Set();
	const fixtures = manifest.fixtures.map((fixture) => {
		if (ids.has(fixture.id)) throw new Error(`Duplicate fixture ID ${fixture.id}.`);
		ids.add(fixture.id);
		const filePath = assertWithinRoot(workspaceRoot, fixture.locator);
		const bytes = readFileSync(filePath);
		verifyFixtureBytes(fixture, bytes);
		return { ...fixture, filePath, payloadBytes: bytes };
	});
	if ([...SUPPORTED_IDS, ...V2_IDS].some((id) => !ids.has(id))) throw new Error('Fixture manifest does not contain all frozen support/rejection IDs.');
	return { manifest, fixtures };
}

function appUrl(baseUrl, app) {
	const url = new URL(baseUrl);
	if (app.path !== '/') url.pathname = `${url.pathname.replace(/\/$/, '')}${app.path}`;
	url.searchParams.set('renderer', 'webgl2');
	url.searchParams.set('renderProfile', 'cpu-safe');
	return url.href;
}

async function readBuild(url, app, baseline) {
	const endpoint = new URL('/__build.json', url);
	const response = await fetch(endpoint, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
	if (!response.ok) throw new Error(`${app.id}: GET ${endpoint} returned HTTP ${response.status}.`);
	const data = await response.json();
	if (data.schema !== 'sibambo-app-build-identity-v2' || data.app !== app.id || !/^[0-9a-f]{40}$/.test(data.commit) || !/^[0-9a-f]{64}$/.test(data.sourceSha256)) {
		throw new Error(`${app.id}: invalid production build identity response.`);
	}
	if (baseline === 'B0' && (data.commit !== B0_COMMITS[app.id] || data.dirty !== false)) {
		throw new Error(`${app.id}: B0 identity mismatch; expected clean ${B0_COMMITS[app.id]}, got ${data.commit}, dirty=${data.dirty}.`);
	}
	if (baseline === 'B0' && app.id === 'editor' && data.sourceSha256 !== B0_EDITOR_FINGERPRINT) {
		throw new Error(`Editor B0 source fingerprint mismatch; expected ${B0_EDITOR_FINGERPRINT}, got ${data.sourceSha256}.`);
	}
	return { endpoint: endpoint.href, status: response.status, identity: data };
}

function makeFrameProbe() {
	return () => {
		const state = { drawCanvases: new Set(), firstFrame: null };
		const wrapped = new WeakSet();
		function observePrototype(prototype) {
			if (!prototype || wrapped.has(prototype)) return;
			wrapped.add(prototype);
			for (const name of ['drawArrays', 'drawElements', 'drawRangeElements']) {
				const original = prototype[name];
				if (typeof original !== 'function') continue;
				try {
					prototype[name] = function (...args) {
						const result = original.apply(this, args);
						if (this.canvas) state.drawCanvases.add(this.canvas);
						return result;
					};
				} catch { /* Protected browser prototype; the frame will remain unverified. */ }
			}
		}
		observePrototype(window.WebGLRenderingContext?.prototype);
		observePrototype(window.WebGL2RenderingContext?.prototype);
		const originalRaf = window.requestAnimationFrame.bind(window);
		window.requestAnimationFrame = (callback) => originalRaf((timestamp) => {
			callback(timestamp);
			if (state.firstFrame) return;
			for (const canvas of state.drawCanvases) {
				const rect = canvas.getBoundingClientRect();
				if (!canvas.closest('.viewport') || !canvas.isConnected || rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0) continue;
				state.firstFrame = {
					perfMs: performance.now(), epochMs: performance.timeOrigin + performance.now(),
					cssWidth: rect.width, cssHeight: rect.height,
					bufferWidth: canvas.width, bufferHeight: canvas.height,
					tagName: canvas.tagName, viewportCanvas: Boolean(canvas.closest('.viewport'))
				};
				break;
			}
		});
		try { performance.setResourceTimingBufferSize(10_000); } catch { /* optional */ }
		window.__loaderBaselineProbe = state;
	};
}

function makeWorkerDiagnosticProbe(channelName) {
	return (channel) => {
		const NativeWorker = window.Worker;
		const bus = new BroadcastChannel(channel);
		const objectUrls = new Set();
		const workers = new Set();
		const events = [];
		const emit = (event) => { events.push(event); bus.postMessage(event); };
		bus.onmessage = (event) => events.push(event.data);
		window.Worker = function Worker(url, options) {
			if (!new.target) throw new TypeError("Failed to construct 'Worker': Please use the 'new' operator.");
			const absolute = new URL(url, document.baseURI).href;
			if (!/\/e4-import\.worker[^/]*\.js(?:\?.*)?$/.test(new URL(absolute).pathname + new URL(absolute).search)) {
				emit({ phase: 'unmatched-worker', url: absolute, epochMs: performance.timeOrigin + performance.now() });
				return options === undefined ? new NativeWorker(url) : new NativeWorker(url, options);
			}
			const sourceUrl = absolute;
			const moduleSource = `
				const __channel = new BroadcastChannel(${JSON.stringify(channel)});
				const __epoch = () => performance.timeOrigin + performance.now();
				let __sourceBuffer = null;
				self.addEventListener('message', (event) => {
					if (!__sourceBuffer && event.data && event.data.buffer instanceof ArrayBuffer) {
						__sourceBuffer = event.data.buffer;
						__channel.postMessage({ phase: 'worker-input-buffer', byteLength: __sourceBuffer.byteLength, epochMs: __epoch() });
					}
				}, true);
				try {
					const __originalDigest = crypto.subtle.digest.bind(crypto.subtle);
					crypto.subtle.digest = function(algorithm, data) {
						__channel.postMessage({ phase: 'worker-digest', algorithm: String(algorithm), byteLength: data?.byteLength ?? null, epochMs: __epoch() });
						return __originalDigest(algorithm, data);
					};
				} catch { __channel.postMessage({ phase: 'worker-digest-probe-unavailable', epochMs: __epoch() }); }
				const __originalPostMessage = self.postMessage.bind(self);
				self.postMessage = function(message, transferList) {
					let graph = null;
					if (message?.type === 'complete' && message.result) {
						try {
							const seen = new WeakSet(); const buffers = new Map(); const transfers = new Set(Array.isArray(transferList) ? transferList.filter((item) => item instanceof ArrayBuffer) : []);
							let objects = 0, arrays = 0, views = 0, viewBytes = 0, bufferBytes = 0, nakedBuffers = 0, sharedBuffers = 0, classes = [];
							const visit = (value, property) => {
								if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
								if (value instanceof ArrayBuffer) { if (!buffers.has(value)) { buffers.set(value, true); bufferBytes += value.byteLength; } if (property) nakedBuffers += 1; return; }
								if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) { sharedBuffers += 1; return; }
								if (ArrayBuffer.isView(value)) { views += 1; viewBytes += value.byteLength; if (!buffers.has(value.buffer)) { buffers.set(value.buffer, true); bufferBytes += value.buffer.byteLength; } return; }
								if (seen.has(value)) return; seen.add(value); objects += 1; if (Array.isArray(value)) arrays += 1; else { const proto = Object.getPrototypeOf(value); if (proto !== Object.prototype && proto !== null) classes.push(value.constructor?.name || 'unknown'); } for (const key of Object.keys(value)) visit(value[key], !Array.isArray(value));
								};
							visit(message.result, false);
							graph = { objects, arrays, views, viewBytes, uniqueBuffers: buffers.size, graphBufferBytes: bufferBytes, transferBufferCount: transfers.size, transferBytes: [...transfers].reduce((total, buffer) => total + buffer.byteLength, 0), viewBuffersMissingFromTransferList: [...buffers.keys()].filter((buffer) => !transfers.has(buffer)).length, sourceBufferRetainedBytes: __sourceBuffer?.byteLength ?? null, sourceBufferInTransferList: Boolean(__sourceBuffer && transfers.has(__sourceBuffer)), graphIncludesSourceBuffer: Boolean(__sourceBuffer && buffers.has(__sourceBuffer)), nakedArrayBufferProperties: nakedBuffers, sharedArrayBufferCount: sharedBuffers, nonPlainClasses: classes };
						} catch (error) { graph = { error: String(error) }; }
					}
					const kind = message?.type ?? 'unknown';
					const common = { type: kind, epochMs: __epoch(), transferCount: Array.isArray(transferList) ? transferList.length : 0, transferBytes: Array.isArray(transferList) ? transferList.filter((item) => item instanceof ArrayBuffer).reduce((total, item) => total + item.byteLength, 0) : 0 };
					__channel.postMessage({ phase: 'worker-pre-post', ...common, graph });
					const returned = __originalPostMessage(message, transferList);
					__channel.postMessage({ phase: 'worker-post-return', type: kind, epochMs: __epoch() });
					return returned;
				};
				import(${JSON.stringify(sourceUrl)}).catch((error) => __channel.postMessage({ phase: 'worker-import-error', error: String(error), epochMs: __epoch() }));
			`;
			const objectUrl = URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' }));
			objectUrls.add(objectUrl);
			const worker = options === undefined ? new NativeWorker(objectUrl, { type: 'module' }) : new NativeWorker(objectUrl, options);
			workers.add(worker);
			worker.addEventListener('message', (event) => {
				if (event.data?.type === 'complete' || event.data?.type === 'error' || event.data?.type === 'cancelled') emit({ phase: 'main-receive', type: event.data.type, epochMs: performance.timeOrigin + performance.now() });
			}, true);
			const terminate = worker.terminate.bind(worker);
			worker.terminate = () => { terminate(); URL.revokeObjectURL(objectUrl); objectUrls.delete(objectUrl); workers.delete(worker); };
			emit({ phase: 'wrapped-worker', url: sourceUrl, epochMs: performance.timeOrigin + performance.now() });
			return worker;
		};
	window.Worker.prototype = NativeWorker.prototype;
		Object.setPrototypeOf(window.Worker, NativeWorker);
		window.__loaderWorkerProbe = {
			channel, events, workers, objectUrls,
			cleanup() { for (const worker of [...workers]) worker.terminate(); for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl); objectUrls.clear(); bus.close(); }
		};
		try {
			const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
			crypto.subtle.digest = function(algorithm, data) {
				emit({ phase: 'page-digest', algorithm: String(algorithm), byteLength: data?.byteLength ?? null, epochMs: performance.timeOrigin + performance.now() });
				return originalDigest(algorithm, data);
			};
		} catch { emit({ phase: 'page-digest-probe-unavailable', epochMs: performance.timeOrigin + performance.now() }); }
	};
}

function isJavaScriptResponse(request) {
	return request.resourceType() === 'script' || /\.m?js(?:[?#]|$)/i.test(request.url());
}

function installRequestCapture(page) {
	const rows = [];
	const responses = new Map();
	page.on('request', (request) => {
		rows.push({ url: request.url(), method: request.method(), resourceType: request.resourceType(), requestEpochMs: Date.now() });
	});
	page.on('response', (response) => {
		const request = response.request();
		const row = [...rows].reverse().find((item) => item.url === request.url() && item.method === request.method() && item.status === undefined);
		if (row) {
			row.status = response.status();
			row.contentType = response.headers()['content-type'] ?? null;
			row.fromServiceWorker = response.fromServiceWorker();
		}
		if (isJavaScriptResponse(request)) responses.set(request.url(), response.body().then((body) => body).catch(() => null));
	});
	page.on('requestfailed', (request) => {
		const row = [...rows].reverse().find((item) => item.url === request.url() && item.method === request.method() && item.failure === undefined);
		if (row) row.failure = request.failure()?.errorText ?? 'request failed';
	});
	return { rows, responses };
}

function installPageErrorCapture(page) {
	const errors = { console: [], page: [] };
	page.on('console', (message) => { if (message.type() === 'error') errors.console.push({ text: message.text(), location: message.location() }); });
	page.on('pageerror', (error) => errors.page.push({ name: error.name, message: error.message, stack: error.stack ?? null }));
	return errors;
}

async function newPage(context, { diagnostic = false, channelName = null } = {}) {
	const page = await context.newPage();
	await page.addInitScript(makeFrameProbe());
	if (diagnostic) await page.addInitScript(makeWorkerDiagnosticProbe(channelName), channelName);
	return page;
}

async function gotoApplication(page, app, baseUrl) {
	const response = await page.goto(appUrl(baseUrl, app), { waitUntil: 'domcontentloaded', timeout: 30_000 });
	if (!response || !response.ok()) throw new Error(`${app.id}: page navigation failed with HTTP ${response?.status() ?? 'no response'}.`);
	await page.locator(app.selector).waitFor({ state: 'attached', timeout: 15_000 });
	return response;
}

async function selectFixture(page, app, fixture) {
	const payload = { name: path.basename(fixture.locator), mimeType: 'application/octet-stream', buffer: fixture.payloadBytes };
	if (app.id === 'editor') {
		const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 });
		await page.locator('button.empty-open').click();
		const chooser = await chooserPromise;
		const start = await page.evaluate(() => ({ perfMs: performance.now(), epochMs: performance.timeOrigin + performance.now() }));
		await chooser.setFiles(payload);
		return { startPerfMs: start.perfMs, startEpochMs: start.epochMs, openAction: 'native file selection accepted; Editor auto-opens on selection' };
	}
	if (app.id === 'rooms') {
		await page.locator('button.start-import').click();
		await page.locator('dialog.import-dialog').waitFor({ state: 'visible', timeout: 10_000 });
		await page.getByLabel('BOMC 1.2 file').setInputFiles(payload);
		await page.getByRole('button', { name: 'Open and review' }).waitFor({ state: 'visible', timeout: 15_000 });
		const start = await page.evaluate(() => ({ perfMs: performance.now(), epochMs: performance.timeOrigin + performance.now() }));
		await page.getByRole('button', { name: 'Open and review' }).click();
		return { startPerfMs: start.perfMs, startEpochMs: start.epochMs, openAction: 'Open and review submit' };
	}
	await page.getByLabel('BOMC 1.2 file').setInputFiles(payload);
	await page.getByRole('button', { name: 'Open model file' }).last().waitFor({ state: 'visible', timeout: 15_000 });
	const start = await page.evaluate(() => ({ perfMs: performance.now(), epochMs: performance.timeOrigin + performance.now() }));
	await page.getByRole('button', { name: 'Open model file' }).last().click();
	return { startPerfMs: start.perfMs, startEpochMs: start.epochMs, openAction: 'Open model file submit' };
}

function outcomeInBrowser(app) {
	return ({ readySelector, readyPattern, errorSelectors }) => {
		const ready = document.querySelector(readySelector);
		const readyText = (ready?.innerText ?? ready?.textContent ?? '').trim();
		if (ready && new RegExp(readyPattern, 'i').test(readyText)) return { kind: 'ready', text: readyText.trim() };
		const errors = [...document.querySelectorAll(errorSelectors)].filter((item) => (item.innerText ?? item.textContent ?? '').trim().length > 0);
		if (errors.length) return { kind: 'error', text: errors.map((item) => (item.innerText ?? item.textContent ?? '').trim()).join('\n') };
		return null;
	};
}

async function waitForOutcome(page, app, startPerfMs, startEpochMs) {
	const args = { readySelector: app.readySelector, readyPattern: app.readyText.source, errorSelectors: app.errorSelectors };
	const openEpochMs = startEpochMs ?? Date.now();
	const remainingMs = DEADLINE_MS - Math.max(0, Date.now() - openEpochMs);
	if (remainingMs <= 0) {
		return {
			kind: 'timeout', text: `No app-ready or app-error signal within ${DEADLINE_MS}ms.`, elapsedMs: DEADLINE_MS,
			postDeadlineObservation: { outcome: null, observedElapsedMs: null, firstFrame: null, status: 'not-probed-at-node-deadline' }
		};
	}
	const pendingOutcome = (async () => {
		const handle = await page.waitForFunction(outcomeInBrowser(app), args, { timeout: remainingMs, polling: POLL_MS });
		try {
			const value = await handle.jsonValue();
			return enforceDeadline(value, Math.max(0, Date.now() - openEpochMs));
		} finally { await handle.dispose().catch(() => {}); }
	})();
	const raced = await raceWithDeadline(pendingOutcome, remainingMs);
	if (raced.kind === 'timeout' || (raced.kind === 'error' && /timeout/i.test(raced.error?.message ?? ''))) {
		return {
			kind: 'timeout', text: `No app-ready or app-error signal within ${DEADLINE_MS}ms.`, elapsedMs: DEADLINE_MS,
			postDeadlineObservation: { outcome: null, observedElapsedMs: null, firstFrame: null, status: 'node-watchdog-fired; page-state-unavailable-at-deadline' }
		};
	}
	if (raced.kind === 'error') throw raced.error;
	return raced.value;
}

async function readFrame(page, startPerfMs, readyPerfElapsedMs) {
	try {
		await page.waitForFunction(() => Boolean(window.__loaderBaselineProbe?.firstFrame), null, { timeout: 2_000, polling: POLL_MS });
		const frame = await page.evaluate(() => window.__loaderBaselineProbe.firstFrame);
		return { ...frame, elapsedFromOpenMs: frame.perfMs - startPerfMs, afterReadyMs: frame.perfMs - (startPerfMs + readyPerfElapsedMs) };
	} catch {
		return null;
	}
}

async function makeContext(browser, { viewport = { width: 1440, height: 900 }, cacheDisabled = false, throttled = false } = {}) {
	const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
	return { context, configure: async (page) => {
		const cdp = await context.newCDPSession(page);
		if (cacheDisabled) {
			await cdp.send('Network.enable');
			await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
		}
		if (throttled) {
			await cdp.send('Network.enable');
			await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
			await cdp.send('Network.emulateNetworkConditions', {
				offline: false, latency: 150, downloadThroughput: 4_000_000 / 8, uploadThroughput: 1_000_000 / 8, connectionType: 'cellular3g'
			});
		}
		return cdp;
	} };
}

async function addFailureCapture(page, outputDir, id, timeoutMs = 10_000) {
	const file = path.join(outputDir, 'screenshots', `${id}.png`);
	try { mkdirSync(path.dirname(file), { recursive: true }); await page.screenshot({ path: file, fullPage: true, timeout: timeoutMs }); return path.relative(outputDir, file).replaceAll('\\', '/'); }
	catch { return null; }
}

async function performModelAttempt({ browser, app, fixture, baseUrl, mode, outputDir, index, diagnostic = false }) {
	const id = `${app.id}-${fixture.id}-${mode}-${String(index).padStart(2, '0')}${diagnostic ? '-diagnostic' : ''}`;
	const { context, configure } = await makeContext(browser, { cacheDisabled: mode === 'cold' });
	const channelName = diagnostic ? `bomc-loader-diagnostic-${Date.now()}-${Math.random()}` : null;
	const page = await newPage(context, { diagnostic, channelName });
	const errorCapture = installPageErrorCapture(page);
	const requestCapture = installRequestCapture(page);
	let startPerfMs = null;
	let startEpochMs = null;
	let openAction = 'app-specific open action';
	let tracePath = null;
	if (diagnostic) await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
	let outcome = { kind: 'setup-error', text: null, elapsedMs: 0 };
	let frame = null;
	try {
		await configure(page);
		await gotoApplication(page, app, baseUrl);
		const selected = await selectFixture(page, app, fixture);
		startPerfMs = selected.startPerfMs;
		startEpochMs = selected.startEpochMs;
		openAction = selected.openAction;
		outcome = await waitForOutcome(page, app, startPerfMs, startEpochMs);
		const readySignal = outcome.kind === 'ready' ? outcome : outcome.lateOutcome?.kind === 'ready' ? outcome.lateOutcome : outcome.postDeadlineObservation?.outcome?.kind === 'ready' ? outcome.postDeadlineObservation : null;
		if (readySignal) frame = await readFrame(page, startPerfMs, readySignal.observedElapsedMs ?? readySignal.elapsedMs ?? DEADLINE_MS);
		if (outcome.kind === 'ready' && !frame) outcome = { ...outcome, kind: 'failed-no-valid-frame', text: 'App reported ready without observable connected positive-size WebGL draw frame.' };
	} catch (error) {
		outcome = { kind: 'setup-error', text: error instanceof Error ? `${error.name}: ${error.message}` : String(error), elapsedMs: startPerfMs === null ? 0 : DEADLINE_MS };
	}
	const diagnosticData = diagnostic ? await page.evaluate(async () => {
		await new Promise((resolve) => setTimeout(resolve, 500));
		const probe = window.__loaderWorkerProbe;
		const value = probe ? { matchedWorkerCount: probe.events.filter((event) => event.phase === 'wrapped-worker').length, unmatchedWorkers: probe.events.filter((event) => event.phase === 'unmatched-worker').map((event) => event.url), events: probe.events } : { matchedWorkerCount: 0, unmatchedWorkers: [], events: [] };
		probe?.cleanup();
		return value;
	}) : null;
	if (diagnostic) {
		tracePath = path.join(outputDir, 'traces', `${id}.zip`);
		mkdirSync(path.dirname(tracePath), { recursive: true });
		try { await context.tracing.stop({ path: tracePath }); tracePath = path.relative(outputDir, tracePath).replaceAll('\\', '/'); }
		catch { tracePath = null; }
	}
	const screenshotPath = outcome.kind === 'ready' || outcome.kind === 'expected-rejection' ? null : await addFailureCapture(page, outputDir, id, outcome.kind === 'timeout' ? 1_000 : 10_000);
	const row = {
		kind: diagnostic ? 'diagnostic' : 'model', baseline: null,
		app: app.id, fixtureId: fixture.id, fixtureSha256: fixture.sha256, fixtureBytes: fixture.bytes,
		mode, attempt: index, openAction,
		status: outcome.kind, expectedOutcome: V2_IDS.has(fixture.id) ? 'rejection' : 'ready',
		startedAtEpochMs: startEpochMs, elapsedMs: outcome.elapsedMs, firstValidFrame: frame,
		outcomeText: outcome.text, lateOutcome: outcome.lateOutcome ?? null, postDeadlineObservation: outcome.postDeadlineObservation ?? null,
		consoleErrors: errorCapture.console, pageErrors: errorCapture.page,
		requestGraph: requestCapture.rows, screenshotPath, tracePath, diagnostic: diagnosticData
	};
	if (startEpochMs !== null) row.startedAt = new Date(startEpochMs).toISOString();
	await page.close().catch(() => {});
	await context.close().catch(() => {});
	return row;
}

async function performExpectedRejection({ browser, app, fixture, baseUrl, outputDir }) {
	const row = await performModelAttempt({ browser, app, fixture, baseUrl, mode: 'cold', outputDir, index: 1 });
	const expected = /BOMC invalid: material section version\.?/i.test(row.outcomeText ?? '');
	row.status = row.status === 'error' && expected ? 'expected-rejection' : row.status === 'timeout' ? 'timeout' : 'failed';
	row.expectedOutcome = 'BOMC 1.2 MATERIALS v2 rejected before geometry/preview';
	row.rejectionMessageMatchesB0 = expected;
	return row;
}

async function performBootAttempt({ browser, context: reusedContext = null, app, baseUrl, viewportName, mode, outputDir, index, prime = false, baseline = null }) {
	const id = `${app.id}-boot-${viewportName}-${mode}-${prime ? 'prime' : String(index).padStart(2, '0')}`;
	const viewport = viewportName === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 };
	const { context, configure } = reusedContext
		? { context: reusedContext, configure: async (page) => {
			const cdp = await reusedContext.newCDPSession(page);
			await cdp.send('Network.enable');
			await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
			await cdp.send('Network.emulateNetworkConditions', {
				offline: false, latency: 150, downloadThroughput: 4_000_000 / 8, uploadThroughput: 1_000_000 / 8, connectionType: 'cellular3g'
			});
			return cdp;
		} }
		: await makeContext(browser, { viewport, cacheDisabled: mode === 'cold', throttled: true });
	const page = await newPage(context);
	const errors = installPageErrorCapture(page);
	const capture = installRequestCapture(page);
	let cdp = null;
	let row;
	try {
		cdp = await configure(page);
		const navigationStartedEpochMs = Date.now();
		await gotoApplication(page, app, baseUrl);
		const navigationStartEpochMs = await page.evaluate(() => performance.timeOrigin);
		const deadline = Date.now() + 30_000;
		let chooser = null;
		let attempts = 0;
		const chooserPromise = page.waitForEvent('filechooser', { timeout: 30_000 }).then((value) => { chooser = value; return value; });
		while (!chooser && Date.now() < deadline) {
			attempts += 1;
			try {
				if (app.id === 'editor') await page.locator('button.empty-open').click({ timeout: 100 });
				else if (app.id === 'rooms') {
					const dialog = page.locator('dialog.import-dialog');
					if (!(await dialog.evaluate((node) => node.open).catch(() => false))) await page.locator('button.start-import').click({ timeout: 100 });
					else await page.getByLabel('BOMC 1.2 file').click({ timeout: 100 });
				} else await page.getByRole('button', { name: 'Choose model file' }).click({ timeout: 100 });
			} catch { /* Retry the current Open flow at the frozen 50ms cadence. */ }
			await Promise.race([chooserPromise.then(() => undefined).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, POLL_MS))]);
		}
		if (!chooser) throw new Error('Actual native file chooser was not observed within the 30s boot deadline.');
		const chooserClock = await page.evaluate(() => ({ perfMs: performance.now(), epochMs: performance.timeOrigin + performance.now() }));
		const chooserPerfMs = chooserClock.perfMs;
		await chooser.setFiles([]).catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 150));
		const preOpen = await page.evaluate(() => {
			const resources = performance.getEntriesByType('resource');
			return resources.map((entry) => ({ name: entry.name, initiatorType: entry.initiatorType, startTime: entry.startTime, responseEnd: entry.responseEnd, transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize }));
		});
		const jsResources = preOpen.filter((entry) => entry.responseEnd <= chooserPerfMs && (entry.initiatorType === 'script' || /\.m?js(?:[?#]|$)/i.test(entry.name)));
		const scripts = [];
		for (const resource of jsResources) {
			const bodyPromise = capture.responses.get(resource.name);
			const body = bodyPromise ? await bodyPromise : null;
			const request = capture.rows.find((item) => item.url === resource.name);
			scripts.push({
				url: resource.name, gzipLevel9Bytes: body ? gzipSync(body, { level: 9 }).byteLength : null,
				responseBodyBytes: body?.byteLength ?? null, transferBytes: resource.transferSize,
				status: request?.status ?? null, contentType: request?.contentType ?? null,
				webglTokens: body ? ['WebGLRenderer', 'BufferGeometry', 'WebGL2RenderingContext'].filter((token) => body.includes(Buffer.from(token))) : []
			});
		}
		const probe = await page.evaluate(() => window.__loaderBaselineProbe?.firstFrame ?? null);
		const unknownBodyCount = scripts.filter((item) => item.gzipLevel9Bytes === null).length;
		row = {
			kind: 'boot', app: app.id, baseline, viewport: viewportName, mode, attempt: index, prime,
			status: unknownBodyCount === 0 ? 'ready' : 'failed-js-response-body-missing', navigationStartedEpochMs, navigationStartEpochMs, chooserEpochMs: chooserClock.epochMs,
			bootInteractivityMs: chooserClock.epochMs - navigationStartEpochMs,
			pollIntervalMs: POLL_MS, chooserPollAttempts: attempts,
			jsGzipLevel9Bytes: scripts.reduce((sum, item) => sum + (item.gzipLevel9Bytes ?? 0), 0),
			jsGzipUnknownBodyCount: unknownBodyCount,
			jsNetworkTransferBytes: jsResources.reduce((sum, item) => sum + item.transferSize, 0),
			preOpenJsRequests: scripts,
			requestGraph: capture.rows, firstWebglFrameBeforeOpen: probe !== null,
			preOpenJsContainsWebglTokens: scripts.some((script) => script.webglTokens.length > 0),
			consoleErrors: errors.console, pageErrors: errors.page,
			cdpThrottle: { cpuRate: 4, downloadBitsPerSecond: 4_000_000, uploadBitsPerSecond: 1_000_000, rttMs: 150 }
		};
		if (prime && row.status === 'ready') row.status = 'prime-excluded';
	} catch (error) {
		row = {
			kind: 'boot', app: app.id, baseline, viewport: viewportName, mode, attempt: index, prime,
			status: 'failed', startedAtEpochMs: Date.now(), elapsedMs: 30_000,
			outcomeText: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
			requestGraph: capture.rows, consoleErrors: errors.console, pageErrors: errors.page,
			cdpThrottle: { cpuRate: 4, downloadBitsPerSecond: 4_000_000, uploadBitsPerSecond: 1_000_000, rttMs: 150 }
		};
	}
	await page.close().catch(() => {});
	if (!reusedContext) await context.close().catch(() => {});
	return row;
}

async function discoverBrowserEnvironment(browser) {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
	const page = await context.newPage();
	let webgl = null;
	try {
		webgl = await page.evaluate(() => {
			const canvas = document.createElement('canvas');
			const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
			if (!gl) return { available: false };
			const extension = gl.getExtension('WEBGL_debug_renderer_info');
			return {
				available: true, version: gl.getParameter(gl.VERSION), shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
				vendor: gl.getParameter(extension?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR),
				renderer: gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER), maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE)
			};
		});
	} catch (error) { webgl = { available: false, error: String(error) }; }
	await context.close();
	return {
		os: `${os.platform()} (${os.arch()})`, osRelease: os.release(), nodeVersion: process.version,
		browser: browser.version(), viewport: { width: 1440, height: 900 }, devicePixelRatio: 1,
		webglAdapter: webgl, capturedAt: new Date().toISOString()
	};
}

async function appendRow(file, row) {
	appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

async function writeMetadata(file, metadata) {
	writeFileSync(file, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

async function runModelSuite({ browser, apps, fixtures, urls, outputDir, baseline }) {
	const file = path.join(outputDir, 'model-attempts.jsonl');
	const summaries = {};
	let rowCount = 0;
	for (const app of apps) {
		for (const fixture of fixtures.filter((item) => SUPPORTED_IDS.has(item.id))) {
			for (const mode of ['cold', 'warm']) {
				let warmContext = null;
				let warmPrimePassed = true;
				if (mode === 'warm') {
					// The warm prime is a complete excluded load in the same context used by its ten attempts.
					const { context } = await makeContext(browser, { cacheDisabled: false });
					warmContext = context;
					const prime = await performModelAttemptInContext({ context, browser, app, fixture, baseUrl: urls[app.id], outputDir, mode, index: 0, prime: true });
					prime.baseline = baseline;
					await appendRow(file, prime);
					rowCount += 1;
					warmPrimePassed = prime.status === 'prime-excluded';
					if (!warmPrimePassed) summaries[`${app.id}-${fixture.id}-warm-prime`] = { passed: false, status: prime.status, outcomeText: prime.outcomeText };
				}
				const rows = [];
				for (let attempt = 1; attempt <= 10; attempt += 1) {
					const row = mode === 'cold'
						? await performModelAttempt({ browser, app, fixture, baseUrl: urls[app.id], mode, outputDir, index: attempt })
						: await performModelAttemptInContext({ context: warmContext, browser, app, fixture, baseUrl: urls[app.id], outputDir, mode, index: attempt });
					row.baseline = baseline;
					rows.push(row);
					await appendRow(file, row);
					rowCount += 1;
					console.log(JSON.stringify({ progress: 'model', app: app.id, fixture: fixture.id, mode, attempt, status: row.status, elapsedMs: row.elapsedMs }));
				}
				if (warmContext) await warmContext.close().catch(() => {});
				const summary = summarizeTimingRows(rows, 10);
				if (mode === 'warm' && !warmPrimePassed) summary.seriesPass = false;
				summaries[`${app.id}-${fixture.id}-${mode}`] = summary;
				await writeMetadata(path.join(outputDir, 'model-summary-progress.json'), summaries);
			}
		}
		for (const fixture of fixtures.filter((item) => V2_IDS.has(item.id))) {
			const row = await performExpectedRejection({ browser, app, fixture, baseUrl: urls[app.id], outputDir });
			row.baseline = baseline;
			await appendRow(file, row);
			rowCount += 1;
			console.log(JSON.stringify({ progress: 'v2-rejection', app: app.id, fixture: fixture.id, status: row.status, outcomeText: row.outcomeText }));
		}
	}
	return { summaries, rowCount, outputFile: file };
}

async function performModelAttemptInContext({ context, browser, app, fixture, baseUrl, mode, outputDir, index, prime = false }) {
	const id = `${app.id}-${fixture.id}-${mode}-${prime ? 'prime' : String(index).padStart(2, '0')}`;
	const page = await newPage(context);
	const errorCapture = installPageErrorCapture(page);
	const requestCapture = installRequestCapture(page);
	let startPerfMs = null;
	let startEpochMs = null;
	let openAction = 'app-specific open action';
	let outcome;
	let frame = null;
	try {
		await gotoApplication(page, app, baseUrl);
		const selected = await selectFixture(page, app, fixture);
		startPerfMs = selected.startPerfMs;
		startEpochMs = selected.startEpochMs;
		openAction = selected.openAction;
		outcome = await waitForOutcome(page, app, startPerfMs, startEpochMs);
		const readySignal = outcome.kind === 'ready' ? outcome : outcome.lateOutcome?.kind === 'ready' ? outcome.lateOutcome : outcome.postDeadlineObservation?.outcome?.kind === 'ready' ? outcome.postDeadlineObservation : null;
		if (readySignal) frame = await readFrame(page, startPerfMs, readySignal.observedElapsedMs ?? readySignal.elapsedMs ?? DEADLINE_MS);
		if (outcome.kind === 'ready' && !frame) outcome = { ...outcome, kind: 'failed-no-valid-frame', text: 'App reported ready without observable connected positive-size WebGL draw frame.' };
	} catch (error) {
		outcome = { kind: 'setup-error', text: error instanceof Error ? `${error.name}: ${error.message}` : String(error), elapsedMs: startPerfMs === null ? 0 : DEADLINE_MS };
	}
	const screenshotPath = outcome.kind === 'ready' || outcome.kind === 'expected-rejection' || outcome.kind === 'error' ? null : await addFailureCapture(page, outputDir, id);
	const row = {
		kind: prime ? 'prime' : 'model', app: app.id, fixtureId: fixture.id, fixtureSha256: fixture.sha256, fixtureBytes: fixture.bytes,
		mode, attempt: index, prime, openAction, status: prime && outcome.kind === 'ready' ? 'prime-excluded' : outcome.kind,
		expectedOutcome: 'ready', startedAtEpochMs: startEpochMs, elapsedMs: outcome.elapsedMs, firstValidFrame: frame,
		outcomeText: outcome.text, lateOutcome: outcome.lateOutcome ?? null, postDeadlineObservation: outcome.postDeadlineObservation ?? null,
		consoleErrors: errorCapture.console, pageErrors: errorCapture.page,
		requestGraph: requestCapture.rows, screenshotPath
	};
	await page.close().catch(() => {});
	return row;
}

async function runBootSuite({ browser, apps, urls, outputDir, baseline }) {
	const file = path.join(outputDir, 'boot-attempts.jsonl');
	const summaries = {};
	let rowCount = 0;
	for (const app of apps) {
		for (const viewportName of ['desktop', 'mobile']) {
			for (const mode of ['cold', 'warm']) {
				let warmContext = null;
				let warmPrimePassed = true;
				if (mode === 'warm') {
					warmContext = await browser.newContext({ viewport: viewportName === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
					const prime = await performBootAttempt({ browser, context: warmContext, app, baseUrl: urls[app.id], viewportName, mode, outputDir, index: 0, prime: true, baseline });
					await appendRow(file, prime);
					rowCount += 1;
					warmPrimePassed = prime.status === 'prime-excluded';
				}
				const rows = [];
				for (let attempt = 1; attempt <= 10; attempt += 1) {
					const row = await performBootAttempt({ browser, context: warmContext, app, baseUrl: urls[app.id], viewportName, mode, outputDir, index: attempt, baseline });
					rows.push(row);
					await appendRow(file, row);
					rowCount += 1;
					console.log(JSON.stringify({ progress: 'boot', app: app.id, viewport: viewportName, mode, attempt, status: row.status, bootInteractivityMs: row.bootInteractivityMs }));
				}
				if (warmContext) await warmContext.close().catch(() => {});
				const bootSummary = summarizeTimingRows(rows.map((row) => ({ ...row, elapsedMs: row.bootInteractivityMs ?? row.elapsedMs, status: row.status === 'ready' ? 'ready' : 'failed' })), 10);
				if (mode === 'warm' && !warmPrimePassed) bootSummary.seriesPass = false;
				summaries[`${app.id}-${viewportName}-${mode}`] = bootSummary;
				await writeMetadata(path.join(outputDir, 'boot-summary-progress.json'), summaries);
			}
		}
	}
	return { summaries, rowCount, outputFile: file };
}

async function runDiagnostic({ browser, editor, fixture, baseUrl, outputDir, baseline }) {
	const row = await performModelAttempt({ browser, app: editor, fixture, baseUrl, mode: 'diagnostic-excluded', outputDir, index: 1, diagnostic: true });
	row.baseline = baseline;
	const file = path.join(outputDir, 'diagnostic.json');
	writeFileSync(file, `${JSON.stringify(row, null, 2)}\n`, 'utf8');
	return row;
}

export async function runBaseline(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	const outputDir = path.resolve(options.output);
	mkdirSync(outputDir, { recursive: true });
	const { manifest, fixtures } = readManifest(path.resolve(options.workspaceRoot), path.resolve(options.fixtures));
	const apps = APPS;
	const builds = {};
	for (const app of apps) builds[app.id] = await readBuild(options.urls[app.id], app, options.baseline);
	const browser = await chromium.launch({ headless: true });
	let modelResult = null;
	let bootResult = null;
	let diagnosticResult = null;
	try {
		const environment = await discoverBrowserEnvironment(browser);
		const metadata = {
			schemaVersion: 'bomc-loader-baseline-v1', plan: PLAN, baseline: options.baseline,
			capturedAt: new Date().toISOString(), environment, builds,
			urls: Object.fromEntries(apps.map((app) => [app.id, appUrl(options.urls[app.id], app)])),
			fixtureManifest: { path: path.resolve(options.fixtures), schemaVersion: manifest.schemaVersion, fixtureCount: fixtures.length, fixtures: fixtures.map(({ id, locator, bytes, sha256, expected }) => ({ id, locator, bytes, sha256, expected })) },
			measurement: {
				deadlineMs: DEADLINE_MS, pollIntervalMs: POLL_MS, modelViewport: { width: 1440, height: 900, devicePixelRatio: 1 },
				modelConditions: ['cold: new context + cache disabled', 'warm: one excluded full-load prime + same cache-enabled context'],
				bootConditions: ['cold: new context + cache disabled', 'warm: one excluded boot prime + same cache-enabled context'],
				bootViewport: { desktop: { width: 1440, height: 900, devicePixelRatio: 1 }, mobile: { width: 390, height: 844, devicePixelRatio: 1 } },
				bootThrottle: { cpuRate: 4, downloadBitsPerSecond: 4_000_000, uploadBitsPerSecond: 1_000_000, latencyMs: 150 },
				series: { supportedFixtureCount: SUPPORTED_IDS.size, expectedRejectionFixtureCount: V2_IDS.size, attemptsPerSupportedFixtureAppCondition: 10, apps: apps.map((app) => app.id), bootAttemptsPerAppViewportCondition: 10 },
				excludedDiagnostic: 'One L-old Editor worker diagnostic with a Blob dynamic-import wrapper; excluded from timing percentiles.'
			}
		};
		await writeMetadata(path.join(outputDir, 'metadata.json'), metadata);
		if (['all', 'model'].includes(options.suite)) modelResult = await runModelSuite({ browser, apps, fixtures, urls: options.urls, outputDir, baseline: options.baseline });
		if (['all', 'boot'].includes(options.suite)) bootResult = await runBootSuite({ browser, apps, urls: options.urls, outputDir, baseline: options.baseline });
		if (['all', 'diagnostic'].includes(options.suite)) {
			const diagnosticFixture = fixtures.find((fixture) => fixture.id === 'L-old');
			diagnosticResult = await runDiagnostic({ browser, editor: apps[0], fixture: diagnosticFixture, baseUrl: options.urls.editor, outputDir, baseline: options.baseline });
		}
		const summary = {
			schemaVersion: 'bomc-loader-baseline-summary-v1', plan: PLAN, baseline: options.baseline,
			completedAt: new Date().toISOString(), model: modelResult, boot: bootResult,
			diagnostic: diagnosticResult ? { status: diagnosticResult.status, matchedWorkerCount: diagnosticResult.diagnostic?.matchedWorkerCount ?? null, tracePath: diagnosticResult.tracePath, outcomeText: diagnosticResult.outcomeText } : null,
			acceptance: {
				allModelRowsPass: modelResult ? Object.values(modelResult.summaries).every((value) => value.seriesPass) : null,
				allBootRowsPass: bootResult ? Object.values(bootResult.summaries).every((value) => value.seriesPass) : null,
				diagnosticWorkerMatched: diagnosticResult ? diagnosticResult.diagnostic?.matchedWorkerCount === 1 : null,
				allPinnedFixturesReverifiedBeforeRun: true
			}
		};
		await writeMetadata(path.join(outputDir, 'summary.json'), summary);
		return summary;
	} finally { await browser.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runBaseline().then((summary) => {
		console.log(JSON.stringify({ summary: path.join(path.resolve(argValue(process.argv.slice(2), '--output', '.')), 'summary.json'), acceptance: summary.acceptance }, null, 2));
	}).catch((error) => {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error));
		process.exitCode = 1;
	});
}
