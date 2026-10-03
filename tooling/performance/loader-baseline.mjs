import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';

const PLAN = 'BOMC-LOADER-001/v1.0';
const DEADLINE_MS = 120_000;
const POLL_MS = 50;
export const APPS = [
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
const SUPPORTED_IDS = ['L-old', 'Y-old', 'I-old', 'S2-jcm'];
const SUPPORTED_ID_SET = new Set(SUPPORTED_IDS);
const V2_IDS = ['S1-new', 'S2-new', 'I-new', 'Y-new'];
const V2_ID_SET = new Set(V2_IDS);
export const BROWSER_LAUNCH_ARGS = ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader'];

function monotonicEpochNow() { return performance.timeOrigin + performance.now(); }

export function captureChooserEventEpoch(event, readEpoch = monotonicEpochNow) {
	return { event, chooserEpochMs: readEpoch() };
}

export function bootPollDelay(tickStartMs, nowMs, cadenceMs = POLL_MS) {
	return Math.max(0, tickStartMs + cadenceMs - nowMs);
}

export function isBootRequestEvidenceComplete(audit) {
	return audit.chooserObserved === true && audit.jsRequestCount > 0 && audit.jsGzipUnknownBodyCount === 0 && audit.jsHttpFailureCount === 0 && audit.jsTimingFailureCount === 0 && audit.jsPendingAtCutoffCount === 0 && audit.jsResourceTimingFailureCount === 0 && audit.missingResourceMatchCount === 0 && audit.resourceMissingCaptureCount === 0;
}

function argValue(args, name, fallback) {
	const index = args.indexOf(name);
	if (index < 0) return fallback;
	const value = args[index + 1];
	if (!value || value.startsWith('--')) throw new Error(`Missing value after ${name}.`);
	return value;
}

export function parseArgs(args) {
	const parsed = {
		baseline: argValue(args, '--baseline', null),
		workspaceRoot: argValue(args, '--workspace-root', null),
		fixtures: argValue(args, '--fixtures', path.resolve('tooling/performance/fixtures.json')),
		output: argValue(args, '--output', null),
		suite: argValue(args, '--suite', 'all'),
		appSelection: argValue(args, '--apps', null),
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
	const selectedIds = parsed.appSelection === null ? APPS.map((app) => app.id) : parsed.appSelection.split(',').map((id) => id.trim());
	if (selectedIds.length === 0 || selectedIds.some((id) => id.length === 0)) throw new Error('--apps must contain one or more comma-separated app IDs.');
	if (new Set(selectedIds).size !== selectedIds.length) throw new Error('--apps contains duplicate app IDs.');
	const unknownIds = selectedIds.filter((id) => !APPS.some((app) => app.id === id));
	if (unknownIds.length) throw new Error(`--apps contains unknown app IDs: ${unknownIds.join(', ')}.`);
	parsed.apps = APPS.filter((app) => selectedIds.includes(app.id));
	return parsed;
}

export function assertWithinRoot(root, locator) {
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

export function assertBuildIdentityUnchanged(expectedIdentity, actualIdentity, appId, fixtureId, stage) {
	if (JSON.stringify(actualIdentity) !== JSON.stringify(expectedIdentity)) {
		throw new Error(`${appId}/${fixtureId}: build identity changed ${stage} series.`);
	}
	return true;
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

export async function withNodeWatchdog(operation, timeoutMs, label) {
	const pending = typeof operation === 'function' ? Promise.resolve().then(operation) : Promise.resolve(operation);
	const result = await raceWithDeadline(pending, timeoutMs);
	if (result.kind === 'timeout') throw new Error(`${label} exceeded the ${timeoutMs}ms Node watchdog.`);
	if (result.kind === 'error') throw result.error;
	return result.value;
}

export function nearestRankPercentile(values, percentile) {
	if (values.length === 0) return null;
	if (!(percentile > 0 && percentile <= 1)) throw new Error('percentile must be within (0, 1].');
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(percentile * sorted.length) - 1];
}

export function summarizeTimingRows(rows, expectedAttempts = 10) {
	const durationRows = rows.map((row) => row.elapsedMs);
	const validDurations = durationRows.filter((value) => Number.isFinite(value) && value >= 0);
	const invalidDurationCount = durationRows.filter((value) => !Number.isFinite(value) || value < 0).length;
	const failedCount = rows.filter((row) => row.status !== 'ready').length;
	const timeoutCount = rows.filter((row) => row.status === 'timeout').length;
	const clocksValid = rows.every((row) => row.openOccurred === true && Number.isFinite(row.startedAtEpochMs));
	const completeTimings = rows.length === expectedAttempts && invalidDurationCount === 0 && clocksValid;
	return {
		expectedAttemptCount: expectedAttempts,
		completedRowCount: rows.length,
		validTimingRowCount: validDurations.length,
		invalidOrMissingDurationCount: invalidDurationCount,
		missingOpenClockCount: rows.filter((row) => row.openOccurred !== true || !Number.isFinite(row.startedAtEpochMs)).length,
		p50Ms: completeTimings ? median(validDurations) : null,
		p95Ms: completeTimings ? nearestRankPercentile(validDurations, 0.95) : null,
		finiteRowsP50Ms: validDurations.length ? median(validDurations) : null,
		finiteRowsP95Ms: validDurations.length ? nearestRankPercentile(validDurations, 0.95) : null,
		minMs: completeTimings ? Math.min(...validDurations) : null,
		maxMs: completeTimings ? Math.max(...validDurations) : null,
		failedCount,
		timeoutCount,
		seriesPass: completeTimings && failedCount === 0
	};
}

export function summarizeBootTimingRows(rows, expectedAttempts = 10) {
	const timedRows = rows.map((row) => {
		const navigation = row.navigationStartedEpochMs;
		const chooser = row.chooserEpochMs;
		const valid = Number.isFinite(navigation) && Number.isFinite(chooser) && chooser >= navigation;
		return { ...row, openOccurred: valid, startedAtEpochMs: navigation, elapsedMs: valid ? chooser - navigation : null, status: row.status === 'ready' ? 'ready' : 'failed' };
	});
	return { ...summarizeTimingRows(timedRows, expectedAttempts), missingNavigationOrChooserClockCount: timedRows.filter((row) => !row.openOccurred).length };
}

function modelRowId(appId, fixtureId, mode, attempt, prime = false) {
	return `${appId}-${fixtureId}-${mode}-${prime ? 'prime' : String(attempt).padStart(2, '0')}`;
}

export function buildModelScenarioMatrix(baseline, appIds, fixtureIds) {
	if (!['B0', 'B1', 'P1'].includes(baseline)) throw new Error(`Unsupported baseline ${baseline}.`);
	if (!Array.isArray(appIds) || appIds.length === 0 || new Set(appIds).size !== appIds.length || appIds.some((id) => !APPS.some((app) => app.id === id))) {
		throw new Error('Scenario matrix requires unique known app IDs in non-empty selection.');
	}
	if (!Array.isArray(fixtureIds) || fixtureIds.length !== 8 || new Set(fixtureIds).size !== fixtureIds.length || [...SUPPORTED_IDS, ...V2_IDS].some((id) => !fixtureIds.includes(id))) {
		throw new Error('Scenario matrix requires the exact eight frozen fixture IDs.');
	}
	const scenarios = [];
	const expectedRowIds = [];
	for (const app of APPS.filter((item) => appIds.includes(item.id))) {
		const timedFixtures = baseline === 'B0' ? fixtureIds.filter((id) => SUPPORTED_ID_SET.has(id)) : fixtureIds;
		for (const fixtureId of timedFixtures) {
			for (const mode of ['cold', 'warm']) {
				const scenario = {
					id: `${app.id}-${fixtureId}-${mode}`,
					kind: 'timing-series', appId: app.id, fixtureId, mode, expectedOutcome: 'ready', expectedAttempts: 10,
					primeRowId: mode === 'warm' ? modelRowId(app.id, fixtureId, mode, 0, true) : null,
					attemptRowIds: Array.from({ length: 10 }, (_, index) => modelRowId(app.id, fixtureId, mode, index + 1))
				};
				scenarios.push(scenario);
				if (scenario.primeRowId) expectedRowIds.push(scenario.primeRowId);
				expectedRowIds.push(...scenario.attemptRowIds);
			}
		}
		if (baseline === 'B0') {
			for (const fixtureId of fixtureIds.filter((id) => V2_ID_SET.has(id))) {
				const id = `${app.id}-${fixtureId}-rejection`;
				scenarios.push({ id, kind: 'expected-rejection', appId: app.id, fixtureId, mode: 'cold', expectedOutcome: 'material-v2-rejection', expectedAttempts: 1, attemptRowIds: [id] });
				expectedRowIds.push(id);
			}
		}
	}
	return { baseline, appIds: APPS.filter((app) => appIds.includes(app.id)).map((app) => app.id), fixtureIds: [...fixtureIds], scenarios, expectedRowIds, expectedRowCount: expectedRowIds.length };
}

export function verifyScenarioRows(rows, expectedRowIds) {
	const seen = new Set();
	const duplicateRowIds = [];
	const unknownRowIds = [];
	for (const row of rows) {
		const rowId = row.scenarioRowId ?? row.id;
		if (!expectedRowIds.includes(rowId)) unknownRowIds.push(rowId ?? null);
		if (seen.has(rowId)) duplicateRowIds.push(rowId);
		seen.add(rowId);
	}
	const missingRowIds = expectedRowIds.filter((id) => !seen.has(id));
	return { expectedRowCount: expectedRowIds.length, actualRowCount: rows.length, duplicateRowIds, unknownRowIds, missingRowIds, matrixComplete: expectedRowIds.length > 0 && rows.length === expectedRowIds.length && duplicateRowIds.length === 0 && unknownRowIds.length === 0 && missingRowIds.length === 0 };
}

export function evaluateModelAcceptance(matrix, rows, summaries) {
	const matrixAudit = verifyScenarioRows(rows, matrix.expectedRowIds);
	const timingScenarios = matrix.scenarios.filter((scenario) => scenario.kind === 'timing-series');
	const allTimingSeriesPass = timingScenarios.length > 0 && timingScenarios.every((scenario) => summaries[scenario.id]?.seriesPass === true);
	const expectedRejections = matrix.scenarios.filter((scenario) => scenario.kind === 'expected-rejection');
	const rowsById = new Map(rows.map((row) => [row.scenarioRowId ?? row.id, row]));
	const allRejectionsPass = expectedRejections.length === 0
		? matrix.baseline !== 'B0'
		: expectedRejections.every((scenario) => {
			const row = rowsById.get(scenario.attemptRowIds[0]);
			return row?.status === 'expected-rejection' && row.rejectionMessageMatchesB0 === true && row.firstValidFrame === null;
		});
	const primeScenarios = matrix.scenarios.filter((scenario) => scenario.primeRowId);
	const allPrimeRowsPass = primeScenarios.length > 0 && primeScenarios.every((scenario) => {
		const row = rowsById.get(scenario.primeRowId);
		return row?.status === 'prime-excluded' && row.openOccurred === true && Number.isFinite(row.startedAtEpochMs) && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && row.firstValidFrame !== null;
	});
	return { matrixAudit, allTimingSeriesPass, allPrimeRowsPass, allRejectionsPass, pass: matrixAudit.matrixComplete && allTimingSeriesPass && allPrimeRowsPass && allRejectionsPass };
}

export function buildBootScenarioMatrix(appIds) {
	if (!Array.isArray(appIds) || appIds.length === 0 || new Set(appIds).size !== appIds.length || appIds.some((id) => !APPS.some((app) => app.id === id))) {
		throw new Error('Boot matrix requires unique known app IDs in non-empty selection.');
	}
	const appOrder = APPS.filter((app) => appIds.includes(app.id)).map((app) => app.id);
	const scenarios = [];
	for (const appId of appOrder) for (const viewport of ['desktop', 'mobile']) for (const mode of ['cold', 'warm']) {
		const prefix = `${appId}-boot-${viewport}-${mode}`;
		const scenario = { id: prefix, appId, viewport, mode, expectedAttempts: 10, primeRowId: mode === 'warm' ? `${prefix}-prime` : null, attemptRowIds: Array.from({ length: 10 }, (_, index) => `${prefix}-${String(index + 1).padStart(2, '0')}`) };
		scenarios.push(scenario);
	}
	const expectedRowIds = scenarios.flatMap((scenario) => [...(scenario.primeRowId ? [scenario.primeRowId] : []), ...scenario.attemptRowIds]);
	return { appIds: appOrder, scenarios, expectedRowIds, expectedRowCount: expectedRowIds.length };
}

export function evaluateBootAcceptance(matrix, rows, summaries) {
	const matrixAudit = verifyScenarioRows(rows, matrix.expectedRowIds);
	const allTimingSeriesPass = matrix.scenarios.length > 0 && matrix.scenarios.every((scenario) => summaries[scenario.id]?.seriesPass === true);
	const rowsById = new Map(rows.map((row) => [row.scenarioRowId ?? row.id, row]));
	const primeScenarios = matrix.scenarios.filter((scenario) => scenario.primeRowId);
	const allPrimeRowsPass = primeScenarios.length > 0 && primeScenarios.every((scenario) => {
		const row = rowsById.get(scenario.primeRowId);
		return row?.status === 'prime-excluded' && row.clockValid === true && Number.isFinite(row.bootInteractivityMs) && row.bootInteractivityMs >= 0 && Number.isFinite(row.jsGzipLevel9Bytes) && row.jsGzipLevel9Bytes >= 0 && row.jsRequestCount > 0;
	});
	return { matrixAudit, allTimingSeriesPass, allPrimeRowsPass, pass: matrixAudit.matrixComplete && allTimingSeriesPass && allPrimeRowsPass };
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

export function appUrl(baseUrl, app) {
	const url = new URL(baseUrl);
	if (app.path !== '/') url.pathname = `${url.pathname.replace(/\/$/, '')}${app.path}`;
	url.searchParams.set('renderer', 'webgl2');
	url.searchParams.set('renderProfile', 'cpu-safe');
	return url.href;
}

export async function readBuild(url, app, baseline) {
	const endpoint = new URL('/__build.json', url);
	const response = await withNodeWatchdog(() => fetch(endpoint, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(5_000) }), 5_000, `${app.id} build identity request`);
	if (!response.ok) throw new Error(`${app.id}: GET ${endpoint} returned HTTP ${response.status}.`);
	const data = await withNodeWatchdog(() => response.json(), 5_000, `${app.id} build identity body`);
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

export function makeFrameProbe() {
	return () => {
		const state = { drawCanvases: new Map(), firstFrame: null, unavailableHooks: [], extensionHooks: {} };
		const wrapped = new WeakSet();
		const wrappedMethods = new WeakMap();
		const extensionContexts = new WeakMap();
		function drawable(context) {
			const canvas = context?.canvas;
			if (!canvas || context.isContextLost?.() || !canvas.isConnected || !canvas.closest('.viewport')) return null;
			const rect = canvas.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0) return null;
			return { canvas, rect };
		}
		function positiveCount(value) { return Number.isFinite(value) && value > 0; }
		function addressedPositive(list, offset, count) {
			if (!list || !Number.isInteger(offset) || !Number.isInteger(count) || count <= 0 || offset < 0 || offset + count > list.length) return false;
			for (let index = offset; index < offset + count; index += 1) if (positiveCount(list[index])) return true;
			return false;
		}
		function pairedPositive(counts, countsOffset, instances, instancesOffset, drawCount) {
			if (!counts || !instances || !Number.isInteger(countsOffset) || !Number.isInteger(instancesOffset) || !Number.isInteger(drawCount) || drawCount <= 0 || countsOffset < 0 || instancesOffset < 0 || countsOffset + drawCount > counts.length || instancesOffset + drawCount > instances.length) return false;
			for (let index = 0; index < drawCount; index += 1) if (positiveCount(counts[countsOffset + index]) && positiveCount(instances[instancesOffset + index])) return true;
			return false;
		}
		function validCount(name, args) {
			switch (name) {
				case 'drawArrays': return positiveCount(args[2]);
				case 'drawElements': return positiveCount(args[1]);
				case 'drawRangeElements': return positiveCount(args[3]);
				case 'drawArraysInstanced':
				case 'drawArraysInstancedANGLE': return positiveCount(args[2]) && positiveCount(args[3]);
				case 'drawElementsInstanced':
				case 'drawElementsInstancedANGLE': return positiveCount(args[1]) && positiveCount(args[4]);
				case 'multiDrawArraysWEBGL': return addressedPositive(args[3], args[4], args[5]);
				case 'multiDrawElementsWEBGL': return addressedPositive(args[1], args[2], args[6]);
				case 'multiDrawArraysInstancedWEBGL': {
					return pairedPositive(args[3], args[4], args[5], args[6], args[7]);
				}
				case 'multiDrawElementsInstancedWEBGL': {
					return pairedPositive(args[1], args[2], args[6], args[7], args[8]);
				}
				default: return false;
			}
		}
		function noteSuccessfulDraw(context, name, args) {
			if (!validCount(name, args)) return;
			const current = drawable(context);
			if (!current) return;
			const rows = state.drawCanvases.get(current.canvas) ?? [];
			rows.push({ context, method: name });
			state.drawCanvases.set(current.canvas, rows);
		}
		function hookMethods(target, names, label, contextOverride = null) {
			if (!target) return;
			const hookedNames = wrappedMethods.get(target) ?? new Set();
			wrappedMethods.set(target, hookedNames);
			for (const name of names) {
				if (hookedNames.has(name)) continue;
				hookedNames.add(name);
				const original = target[name];
				if (typeof original === 'function' && !Object.prototype.hasOwnProperty.call(target, name)) continue;
				if (typeof original !== 'function') {
					state.unavailableHooks.push(`${label}.${name}: unavailable`);
					continue;
				}
				try {
					const replacement = function (...args) {
						const result = original.apply(this, args);
						noteSuccessfulDraw(typeof contextOverride === 'function' ? contextOverride(this) : contextOverride ?? this, name, args);
						return result;
					};
					target[name] = replacement;
					if (target[name] !== replacement) throw new Error('protected method');
				} catch {
					state.unavailableHooks.push(`${label}.${name}: protected`);
				}
			}
		}
		function observePrototype(prototype, label) {
			if (!prototype || wrapped.has(prototype)) return;
			wrapped.add(prototype);
			hookMethods(prototype, ['drawArrays', 'drawElements', 'drawRangeElements'], label);
			hookMethods(prototype, ['drawArraysInstanced', 'drawElementsInstanced'], label);
			const getExtension = prototype.getExtension;
			if (typeof getExtension !== 'function') {
				state.extensionHooks[label] = 'getExtension-unavailable';
				return;
			}
			try {
				const replacement = function (name, ...args) {
					const extension = getExtension.call(this, name, ...args);
					if (extension && name === 'ANGLE_instanced_arrays') {
						extensionContexts.set(extension, this);
						hookMethods(Object.getPrototypeOf(extension), ['drawArraysInstancedANGLE', 'drawElementsInstancedANGLE'], `${label}.ANGLE_instanced_arrays`, (receiver) => extensionContexts.get(receiver) ?? null);
						state.extensionHooks[`${label}.ANGLE_instanced_arrays`] = 'observed';
					} else if (!extension && name === 'ANGLE_instanced_arrays') {
						state.extensionHooks[`${label}.ANGLE_instanced_arrays`] = 'unavailable';
						state.unavailableHooks.push(`${label}.ANGLE_instanced_arrays: unsupported`);
					}
					if (extension && name === 'WEBGL_multi_draw') {
						extensionContexts.set(extension, this);
						hookMethods(Object.getPrototypeOf(extension), ['multiDrawArraysWEBGL', 'multiDrawElementsWEBGL', 'multiDrawArraysInstancedWEBGL', 'multiDrawElementsInstancedWEBGL'], `${label}.WEBGL_multi_draw`, (receiver) => extensionContexts.get(receiver) ?? null);
						state.extensionHooks[`${label}.WEBGL_multi_draw`] = 'observed';
					} else if (!extension && name === 'WEBGL_multi_draw') {
						state.extensionHooks[`${label}.WEBGL_multi_draw`] = 'unavailable';
						state.unavailableHooks.push(`${label}.WEBGL_multi_draw: unsupported`);
					}
					return extension;
				};
				prototype.getExtension = replacement;
				if (prototype.getExtension !== replacement) throw new Error('protected getExtension');
			} catch { state.unavailableHooks.push(`${label}.getExtension: protected`); }
		}
		observePrototype(window.WebGLRenderingContext?.prototype, 'WebGLRenderingContext');
		observePrototype(window.WebGL2RenderingContext?.prototype, 'WebGL2RenderingContext');
		const originalRaf = window.requestAnimationFrame.bind(window);
		window.requestAnimationFrame = (callback) => originalRaf((timestamp) => {
			callback(timestamp);
			if (state.firstFrame) return;
			for (const [canvas, draws] of state.drawCanvases) {
				const current = canvas.isConnected ? draws.find((draw) => drawable(draw.context)) : null;
				const geometry = current && drawable(current.context);
				if (!current || !geometry) continue;
				state.firstFrame = {
					perfMs: performance.now(), epochMs: performance.timeOrigin + performance.now(), method: current.method,
					cssWidth: geometry.rect.width, cssHeight: geometry.rect.height,
					bufferWidth: canvas.width, bufferHeight: canvas.height,
					tagName: canvas.tagName, viewportCanvas: true
				};
				break;
			}
		});
		try { performance.setResourceTimingBufferSize(10_000); } catch { /* optional */ }
		window.__loaderBaselineProbe = state;
	};
}

export function makeWorkerDiagnosticProbe(channelName) {
	return (configuration) => {
		const settings = typeof configuration === 'string' ? { channel: configuration, streamToken: null } : configuration || {};
		const channel = settings.channel || channelName;
		const streamToken = typeof settings.streamToken === 'string' ? settings.streamToken : null;
		const NativeWorker = window.Worker;
		const bus = new BroadcastChannel(channel);
		const objectUrls = new Set();
		const workers = new Set();
		const events = [];
		let mainSequence = 0;
		let nextWorkerId = 1;
		const emit = (event) => {
			const tagged = streamToken ? { ...event, streamToken, workerId: event.workerId ?? 'page', realm: 'main', seq: ++mainSequence } : event;
			events.push(tagged);
			bus.postMessage(tagged);
			if (streamToken) console.debug('__BOMC_DIAG_V3__' + JSON.stringify(tagged));
		};
		bus.onmessage = (event) => events.push(event.data);
		window.Worker = function Worker(url, options) {
			if (!new.target) throw new TypeError("Failed to construct 'Worker': Please use the 'new' operator.");
			const absolute = new URL(url, document.baseURI).href;
			const matched = /\/e4-import\.worker[^/]*\.js(?:\?.*)?$/.test(new URL(absolute).pathname + new URL(absolute).search);
			if (!matched) {
				const workerUrl = new URL(absolute);
				const knownSecondary = settings.appId === 'rooms' && workerUrl.origin === location.origin && /\/\_app\/immutable\/workers\/rooms-analysis\.worker[^/]*\.js$/.test(workerUrl.pathname);
				if (knownSecondary) {
					emit({ phase: 'known-secondary-worker', workerKind: 'rooms-analysis', workerId: 'secondary-' + nextWorkerId++, url: absolute, epochMs: performance.timeOrigin + performance.now() });
					return options === undefined ? new NativeWorker(url) : new NativeWorker(url, options);
				}
				emit({ phase: 'unmatched-worker', url: absolute, epochMs: performance.timeOrigin + performance.now() });
				return options === undefined ? new NativeWorker(url) : new NativeWorker(url, options);
			}
			const workerId = String(nextWorkerId++);
			const sourceUrl = absolute;
			const moduleSource = `
				const __channel = new BroadcastChannel(${JSON.stringify(channel)});
				const __streamToken = ${JSON.stringify(streamToken)};
				const __workerId = ${JSON.stringify(workerId)};
				const __prefix = '__BOMC_DIAG_V3__';
				const __epoch = () => performance.timeOrigin + performance.now();
				let __seq = 0;
				const __emit = (event) => {
					const tagged = __streamToken ? { ...event, streamToken: __streamToken, workerId: __workerId, realm: 'worker', seq: ++__seq } : event;
					__channel.postMessage(tagged);
					if (__streamToken) console.debug(__prefix + JSON.stringify(tagged));
				};
				let __sourceBuffer = null;
				let __inputObserved = false;
				let __moduleReady = false;
				const __ingressQueue = [];
				self.addEventListener('message', (event) => {
					const data = event.data;
					if (data?.type === 'load' && !__inputObserved) {
						__inputObserved = true;
						if (data.buffer instanceof ArrayBuffer) __sourceBuffer = data.buffer;
						__emit({ phase: 'worker-input', id: Number.isInteger(data.id) ? data.id : null, type: data.type, sourceName: typeof data.sourceName === 'string' ? data.sourceName : null, byteLength: data.buffer instanceof ArrayBuffer ? data.buffer.byteLength : null, epochMs: __epoch() });
					}
				}, true);
				const __ingressGate = (event) => {
					if (__moduleReady) return;
					__ingressQueue.push({ data: event.data, origin: event.origin, lastEventId: event.lastEventId, source: event.source, ports: [...event.ports] });
					__emit({ phase: 'worker-ingress-queued', queueLength: __ingressQueue.length, epochMs: __epoch() });
					event.stopImmediatePropagation();
				};
				self.addEventListener('message', __ingressGate, true);
				try {
					const __originalDigest = crypto.subtle.digest.bind(crypto.subtle);
					crypto.subtle.digest = function(algorithm, data) {
						__emit({ phase: 'worker-digest', algorithm: String(algorithm), byteLength: data?.byteLength ?? null, epochMs: __epoch() });
						return __originalDigest(algorithm, data);
					};
				} catch { __emit({ phase: 'worker-digest-probe-unavailable', epochMs: __epoch() }); }
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
							graph = { objects, arrays, views, viewBytes, uniqueBuffers: buffers.size, graphBufferBytes: bufferBytes, transferBufferCount: transfers.size, transferBytes: [...transfers].reduce((total, buffer) => total + buffer.byteLength, 0), viewBuffersMissingFromTransferList: [...buffers.keys()].filter((buffer) => !transfers.has(buffer)).length, sourceBufferRetainedBytes: __sourceBuffer?.byteLength ?? null, sourceBufferInTransferList: Boolean(__sourceBuffer && transfers.has(__sourceBuffer)), graphIncludesSourceBuffer: Boolean(__sourceBuffer && buffers.has(__sourceBuffer)), nakedArrayBufferProperties: nakedBuffers, sharedArrayBufferCount: sharedBuffers, nonPlainClasses: classes, runtimeCounts: { resultFacesLength: Number.isInteger(message.result?.faces?.length) ? message.result.faces.length : null, preparedRuntimeSceneGroupsLength: Number.isInteger(message.result?.preparedRuntimeScene?.groups?.length) ? message.result.preparedRuntimeScene.groups.length : null, sourceCounts: message.result?.counts ?? null } };
						} catch (error) { graph = { error: String(error) }; }
					}
					const kind = message?.type ?? 'unknown';
					const replyId = Number.isInteger(message?.id) ? message.id : null;
					const common = { type: kind, id: replyId, epochMs: __epoch(), transferCount: Array.isArray(transferList) ? transferList.length : 0, transferBytes: Array.isArray(transferList) ? transferList.filter((item) => item instanceof ArrayBuffer).reduce((total, item) => total + item.byteLength, 0) : 0 };
					if (__streamToken && kind === 'progress') {
						const progress = message?.progress && typeof message.progress === 'object' ? message.progress : {};
						__emit({ phase: 'worker-progress', id: replyId, stage: typeof progress.stage === 'string' ? progress.stage : null, completed: Number.isFinite(progress.completed) ? progress.completed : null, total: Number.isFinite(progress.total) ? progress.total : null, unit: typeof progress.unit === 'string' ? progress.unit : null, epochMs: __epoch() });
					}
					__emit({ phase: 'worker-pre-post', ...common, graph });
					const returned = __originalPostMessage(message, transferList);
					__emit({ phase: 'worker-post-return', type: kind, id: replyId, epochMs: __epoch() });
					return returned;
				};
				(async () => {
					try {
						await import(${JSON.stringify(sourceUrl)});
						__moduleReady = true;
						__emit({ phase: 'worker-module-ready', url: ${JSON.stringify(sourceUrl)}, epochMs: __epoch() });
						self.removeEventListener('message', __ingressGate, true);
						for (const queued of __ingressQueue) {
							self.dispatchEvent(new MessageEvent('message', { data: queued.data, origin: queued.origin, lastEventId: queued.lastEventId, source: queued.source, ports: queued.ports }));
							__emit({ phase: 'worker-ingress-replayed', queueLength: __ingressQueue.length, type: queued.data?.type ?? null, epochMs: __epoch() });
						}
						__ingressQueue.length = 0;
					} catch (error) {
						__emit({ phase: 'worker-import-error', error: String(error), epochMs: __epoch() });
					}
				})();
			`;
			const objectUrl = URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' }));
			objectUrls.add(objectUrl);
			const worker = options === undefined ? new NativeWorker(objectUrl, { type: 'module' }) : new NativeWorker(objectUrl, options);
			workers.add(worker);
			worker.addEventListener('message', (event) => {
				if (event.data?.type === 'complete' || event.data?.type === 'error' || event.data?.type === 'cancelled') emit({ phase: 'main-receive', type: event.data.type, id: Number.isInteger(event.data?.id) ? event.data.id : null, workerId, epochMs: performance.timeOrigin + performance.now() });
			}, true);
			const terminate = worker.terminate.bind(worker);
			worker.terminate = () => { terminate(); URL.revokeObjectURL(objectUrl); objectUrls.delete(objectUrl); workers.delete(worker); };
			emit({ phase: 'wrapped-worker', url: sourceUrl, workerId, epochMs: performance.timeOrigin + performance.now() });
			return worker;
		};
		window.Worker.prototype = NativeWorker.prototype;
		Object.setPrototypeOf(window.Worker, NativeWorker);
		window.__loaderWorkerProbe = {
			channel, streamToken, events, workers, objectUrls,
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

export function makeWorkerNativeControlProbe(channelName) {
	return (configuration) => {
		const settings = typeof configuration === 'string' ? { channel: configuration, streamToken: null } : configuration || {};
		const channel = settings.channel || channelName;
		const streamToken = typeof settings.streamToken === 'string' ? settings.streamToken : null;
		const NativeWorker = window.Worker;
		const bus = new BroadcastChannel(channel);
		const events = [];
		let sequence = 0;
		let nextWorkerId = 1;
		const emit = (event) => {
			const tagged = streamToken ? { ...event, streamToken, workerId: event.workerId ?? 'page', realm: 'main', seq: ++sequence } : event;
			events.push(tagged);
			bus.postMessage(tagged);
			if (streamToken) console.debug('__BOMC_DIAG_V3__' + JSON.stringify(tagged));
		};
		bus.onmessage = (event) => events.push(event.data);
		window.Worker = function Worker(url, options) {
			if (!new.target) throw new TypeError("Failed to construct 'Worker': Please use the 'new' operator.");
			const absolute = new URL(url, document.baseURI).href;
			const matched = /\/e4-import\.worker[^/]*\.js(?:\?.*)?$/.test(new URL(absolute).pathname + new URL(absolute).search);
			if (!matched) {
				const workerUrl = new URL(absolute);
				const knownSecondary = settings.appId === 'rooms' && workerUrl.origin === location.origin && /\/\_app\/immutable\/workers\/rooms-analysis\.worker[^/]*\.js$/.test(workerUrl.pathname);
				emit({ phase: knownSecondary ? 'known-secondary-worker' : 'native-unmatched-worker', ...(knownSecondary ? { workerKind: 'rooms-analysis', workerId: 'secondary-' + nextWorkerId++ } : {}), url: absolute, epochMs: performance.timeOrigin + performance.now() });
				return options === undefined ? new NativeWorker(url) : new NativeWorker(url, options);
			}
			const worker = options === undefined ? new NativeWorker(url) : new NativeWorker(url, options);
			const workerId = String(nextWorkerId++);
			emit({ phase: 'native-worker', url: absolute, workerId, epochMs: performance.timeOrigin + performance.now() });
			worker.addEventListener('message', (event) => emit({ phase: 'native-main-receive', type: event.data?.type ?? null, id: Number.isInteger(event.data?.id) ? event.data.id : null, workerId, epochMs: performance.timeOrigin + performance.now() }), true);
			worker.addEventListener('error', (event) => emit({ phase: 'native-worker-error', message: event.message, workerId, epochMs: performance.timeOrigin + performance.now() }), true);
			return worker;
		};
		window.Worker.prototype = NativeWorker.prototype;
		Object.setPrototypeOf(window.Worker, NativeWorker);
		window.__loaderWorkerControlProbe = { channel, streamToken, events, cleanup() { bus.close(); } };
	};
}

function isJavaScriptResponse(request) {
	return request.resourceType() === 'script' || /\.m?js(?:[?#]|$)/i.test(request.url());
}

function installRequestCapture(page) {
	const rows = [];
	const rowByRequest = new WeakMap();
	const bodyPromises = new WeakMap();
	page.on('request', (request) => {
		const row = { url: request.url(), method: request.method(), resourceType: request.resourceType(), requestEpochMs: monotonicEpochNow() };
		rows.push(row);
		rowByRequest.set(request, row);
	});
	page.on('response', (response) => {
		const request = response.request();
		const row = rowByRequest.get(request);
		if (row) {
			row.status = response.status();
			row.responseEpochMs = monotonicEpochNow();
			row.responseTiming = request.timing();
			row.contentType = response.headers()['content-type'] ?? null;
			row.fromServiceWorker = response.fromServiceWorker();
			bodyPromises.set(row, response.body().then((body) => body).catch(() => null));
		}
	});
	page.on('requestfailed', (request) => {
		const row = rowByRequest.get(request);
		if (row) row.failure = request.failure()?.errorText ?? 'request failed';
	});
	return { rows, bodyFor: (row) => bodyPromises.get(row) ?? Promise.resolve(null) };
}

function installPageErrorCapture(page) {
	const errors = { console: [], page: [] };
	page.on('console', (message) => { if (message.type() === 'error') errors.console.push({ text: message.text(), location: message.location() }); });
	page.on('pageerror', (error) => errors.page.push({ name: error.name, message: error.message, stack: error.stack ?? null }));
	return errors;
}

const DIAGNOSTIC_CONSOLE_PREFIX = '__BOMC_DIAG_V3__';
const DIAGNOSTIC_MAX_EVENT_BYTES = 64 * 1024;
const DIAGNOSTIC_MAX_EVENTS = 10_000;
const DIAGNOSTIC_MAX_BYTES = 5 * 1024 * 1024;

export function installDiagnosticConsoleStream(page, streamToken, onDiagnosticEvent) {
	let eventCount = 0;
	let byteCount = 0;
	let invalid = false;
	const eventIdentities = new Map();
	const observedWorkers = new Map();
	const markInvalid = (reason) => {
		if (invalid) return;
		invalid = true;
		try { onDiagnosticEvent?.({ invalidDiagnostic: true, streamToken, reason, epochMs: monotonicEpochNow() }); } catch {}
	};
	const onConsole = (message) => {
		const text = message.text();
		if (!text.startsWith(DIAGNOSTIC_CONSOLE_PREFIX)) return;
		const size = Buffer.byteLength(text, 'utf8');
		if (size > DIAGNOSTIC_MAX_EVENT_BYTES) { markInvalid('event-size-limit'); return; }
		if (eventCount + 1 > DIAGNOSTIC_MAX_EVENTS) { markInvalid('event-count-limit'); return; }
		if (byteCount + size > DIAGNOSTIC_MAX_BYTES) { markInvalid('case-byte-limit'); return; }
		let event;
		try { event = JSON.parse(text.slice(DIAGNOSTIC_CONSOLE_PREFIX.length)); }
		catch { markInvalid('malformed-json'); return; }
		if (!event || typeof event !== 'object' || event.streamToken !== streamToken || typeof event.workerId !== 'string' || !event.workerId || !['main', 'worker'].includes(event.realm) || !Number.isInteger(event.seq) || event.seq < 1 || typeof event.phase !== 'string' || !Number.isFinite(event.epochMs)) {
			markInvalid('invalid-token-or-event-shape');
			return;
		}
		const identity = [event.streamToken, event.workerId, event.realm, event.seq].join('|');
		const serialized = JSON.stringify(event);
		if (eventIdentities.has(identity)) {
			if (eventIdentities.get(identity) !== serialized) markInvalid('duplicate-identity-conflict');
			return;
		}
		eventCount += 1;
		byteCount += size;
		eventIdentities.set(identity, serialized);
		try { onDiagnosticEvent?.(event); }
		catch (error) { markInvalid('forward-error:' + (error instanceof Error ? error.message : String(error))); }
	};
	const onWorker = (worker) => {
		if (!worker || observedWorkers.has(worker)) return;
		const detach = () => {
			worker.removeListener('console', onConsole);
			worker.removeListener('close', detach);
			observedWorkers.delete(worker);
		};
		observedWorkers.set(worker, detach);
		worker.on('console', onConsole);
		worker.once('close', detach);
	};
	const remove = () => {
		page.removeListener('console', onConsole);
		page.removeListener('worker', onWorker);
		for (const detach of [...observedWorkers.values()]) detach();
	};
	page.on('console', onConsole);
	page.on('worker', onWorker);
	page.once('close', remove);
	return { get eventCount() { return eventCount; }, get byteCount() { return byteCount; }, get invalid() { return invalid; }, dispose: remove };
}

async function newPage(context, { appId = null, diagnostic = false, workerControl = false, channelName = null, diagnosticStreamToken = null, onDiagnosticEvent = null } = {}) {
	const page = await context.newPage();
	const streamState = diagnostic || workerControl
		? installDiagnosticConsoleStream(page, diagnosticStreamToken, onDiagnosticEvent)
		: null;
	if (streamState) page.__loaderDiagnosticStreamState = streamState;
	await page.addInitScript(makeFrameProbe());
	const probeOptions = { channel: channelName, streamToken: diagnosticStreamToken, appId };
	if (diagnostic) await page.addInitScript(makeWorkerDiagnosticProbe(channelName), probeOptions);
	else if (workerControl) await page.addInitScript(makeWorkerNativeControlProbe(channelName), probeOptions);
	return page;
}

async function gotoApplication(page, app, baseUrl) {
	const response = await page.goto(appUrl(baseUrl, app), { waitUntil: 'domcontentloaded', timeout: 30_000 });
	if (!response || !response.ok()) throw new Error(`${app.id}: page navigation failed with HTTP ${response?.status() ?? 'no response'}.`);
	await page.locator(app.selector).waitFor({ state: 'attached', timeout: 15_000 });
	return response;
}

async function selectFixture(page, app, fixture, onOpenClock = () => {}) {
	const captureOpenClock = async (openAction) => {
		const start = await page.evaluate(() => ({ perfMs: performance.now(), epochMs: performance.timeOrigin + performance.now() }));
		onOpenClock({ ...start, openAction });
		return start;
	};
	const payload = { name: path.basename(fixture.locator), mimeType: 'application/octet-stream', buffer: fixture.payloadBytes };
	if (app.id === 'editor') {
		const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 });
		await page.locator('button.empty-open').click();
		const chooser = await chooserPromise;
		const start = await captureOpenClock('native file selection accepted; Editor auto-opens on selection');
		await chooser.setFiles(payload);
		return { startPerfMs: start.perfMs, startEpochMs: start.epochMs, openAction: 'native file selection accepted; Editor auto-opens on selection' };
	}
	if (app.id === 'rooms') {
		await page.locator('button.start-import').click();
		await page.locator('dialog.import-dialog').waitFor({ state: 'visible', timeout: 10_000 });
		await page.getByLabel('BOMC 1.2 file').setInputFiles(payload);
		await page.getByRole('button', { name: 'Open and review' }).waitFor({ state: 'visible', timeout: 15_000 });
		const start = await captureOpenClock('Open and review submit');
		await page.getByRole('button', { name: 'Open and review' }).click();
		return { startPerfMs: start.perfMs, startEpochMs: start.epochMs, openAction: 'Open and review submit' };
	}
	await page.getByLabel('BOMC 1.2 file').setInputFiles(payload);
	await page.getByRole('button', { name: 'Open model file' }).last().waitFor({ state: 'visible', timeout: 15_000 });
	const start = await captureOpenClock('Open model file submit');
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
		await withNodeWatchdog(() => page.waitForFunction(() => Boolean(window.__loaderBaselineProbe?.firstFrame), null, { timeout: 2_000, polling: POLL_MS }), 2_000, 'Frame observer wait');
		const frame = await withNodeWatchdog(() => page.evaluate(() => window.__loaderBaselineProbe.firstFrame), 2_000, 'Frame observer read');
		return { ...frame, elapsedFromOpenMs: frame.perfMs - startPerfMs, afterReadyMs: frame.perfMs - (startPerfMs + readyPerfElapsedMs) };
	} catch {
		return null;
	}
}

export async function makeContext(browser, { viewport = { width: 1440, height: 900 }, cacheDisabled = false, throttled = false } = {}) {
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
	try { mkdirSync(path.dirname(file), { recursive: true }); await withNodeWatchdog(() => page.screenshot({ path: file, fullPage: true, timeout: Math.min(timeoutMs, 4_500) }), 5_000, 'Failure screenshot'); return path.relative(outputDir, file).replaceAll('\\', '/'); }
	catch { return null; }
}

export async function performModelAttempt({ browser, app, fixture, baseUrl, mode, outputDir, index, diagnostic = false, workerControl = false, expectedOutcome = 'ready', scenarioRowId = null, prime = false, onAttemptEvent = null, diagnosticStreamToken = null, onDiagnosticEvent = null }) {
	const id = `${app.id}-${fixture.id}-${mode}-${String(index).padStart(2, '0')}${diagnostic ? '-diagnostic' : ''}`;
	const setupStart = performance.now();
	const attemptId = scenarioRowId ?? id;
	let observerError = null;
	let appOutcomeEmitted = false;
	const emitAttemptEvent = (type, payload) => {
		if (typeof onAttemptEvent !== 'function') return true;
		if (observerError) return false;
		try {
			const result = onAttemptEvent({ type, attemptId, payload, emittedAtEpochMs: monotonicEpochNow() });
			if (result && typeof result.then === 'function') throw new Error('onAttemptEvent must synchronously enqueue IPC observations.');
			return true;
		} catch (error) {
			observerError = error instanceof Error ? error.message : String(error);
			return false;
		}
	};
	const emitOutcome = (value) => {
		if (appOutcomeEmitted || typeof onAttemptEvent !== 'function') return;
		appOutcomeEmitted = true;
		emitAttemptEvent('app-outcome', { ...value, observedAtEpochMs: monotonicEpochNow() });
	};
	let context = null;
	let page = null;
	let configure = null;
	const channelName = diagnostic || workerControl ? `bomc-loader-diagnostic-${Date.now()}-${Math.random()}` : null;
	const errorCapture = { console: [], page: [] };
	const requestCapture = { rows: [], responses: new Map() };
	let startPerfMs = null;
	let startEpochMs = null;
	let openAction = 'app-specific open action';
	let tracePath = null;
	let traceStarted = false;
	let diagnosticData = null;
	let outcome = { kind: 'setup-error', text: null, elapsedMs: null };
	let frame = null;
	try {
		const made = await withNodeWatchdog(() => makeContext(browser, { cacheDisabled: mode === 'cold' }), 5_000, 'Browser context creation');
		context = made.context;
		configure = made.configure;
		page = await withNodeWatchdog(() => newPage(context, { appId: app.id, diagnostic, workerControl, channelName, diagnosticStreamToken, onDiagnosticEvent }), 5_000, 'Browser page creation');
		Object.assign(errorCapture, installPageErrorCapture(page));
		Object.assign(requestCapture, installRequestCapture(page));
		if (diagnostic || workerControl) { await withNodeWatchdog(() => context.tracing.start({ screenshots: true, snapshots: true, sources: false }), 5_000, 'Trace start'); traceStarted = true; }
		await withNodeWatchdog(() => configure(page), 5_000, 'Browser context configuration');
		await gotoApplication(page, app, baseUrl);
		const selected = await selectFixture(page, app, fixture, (clock) => {
			startPerfMs = clock.perfMs;
			startEpochMs = clock.epochMs;
			openAction = clock.openAction;
			if (!emitAttemptEvent('open', { perfMs: clock.perfMs, epochMs: clock.epochMs, openAction })) throw new Error('Open observation could not be enqueued.');
		});
		startPerfMs ??= selected.startPerfMs;
		startEpochMs ??= selected.startEpochMs;
		openAction = selected.openAction;
		outcome = await waitForOutcome(page, app, startPerfMs, startEpochMs);
		emitOutcome(outcome);
		const readySignal = outcome.kind === 'ready' ? outcome : outcome.lateOutcome?.kind === 'ready' ? outcome.lateOutcome : outcome.postDeadlineObservation?.outcome?.kind === 'ready' ? outcome.postDeadlineObservation : null;
		if (readySignal) frame = await readFrame(page, startPerfMs, readySignal.observedElapsedMs ?? readySignal.elapsedMs ?? DEADLINE_MS);
		if (outcome.kind === 'ready' && !frame) outcome = { ...outcome, kind: 'failed-no-valid-frame', text: 'App reported ready without observable connected positive-size WebGL draw frame.' };
	} catch (error) {
		const errorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		outcome = startEpochMs === null
			? { kind: 'setup-error', text: errorText, elapsedMs: null }
			: { kind: 'failed-after-open', text: errorText, elapsedMs: Math.max(0, Date.now() - startEpochMs) };
		if (!appOutcomeEmitted && !observerError) emitOutcome({ ...outcome, observationError: true });
	}
	const diagnosticErrors = [];
	if ((diagnostic || workerControl) && page) {
		try {
			diagnosticData = await withNodeWatchdog(() => page.evaluate(async ({ probeName }) => {
				await new Promise((resolve) => setTimeout(resolve, 300));
				const probe = probeName === 'wrapped' ? window.__loaderWorkerProbe : window.__loaderWorkerControlProbe;
				const matchedPhases = probeName === 'wrapped' ? ['wrapped-worker'] : ['native-worker'];
				const unmatchedPhases = probeName === 'wrapped' ? ['unmatched-worker'] : ['native-unmatched-worker'];
				const value = probe ? { matchedWorkerCount: probe.events.filter((event) => matchedPhases.includes(event.phase)).length, unmatchedWorkers: probe.events.filter((event) => unmatchedPhases.includes(event.phase)).map((event) => event.url), events: probe.events } : { matchedWorkerCount: 0, unmatchedWorkers: [], events: [] };
				probe?.cleanup();
				return value;
			}, { probeName: diagnostic ? 'wrapped' : 'native' }), 5_000, 'Diagnostic collection');
		} catch (error) { diagnosticErrors.push(error instanceof Error ? error.message : String(error)); }
	}
	if (diagnostic && traceStarted && context) {
		tracePath = path.join(outputDir, 'traces', `${id}.zip`);
		mkdirSync(path.dirname(tracePath), { recursive: true });
		try { await withNodeWatchdog(() => context.tracing.stop({ path: tracePath }), 5_000, 'Trace stop'); tracePath = path.relative(outputDir, tracePath).replaceAll('\\', '/'); }
		catch (error) { diagnosticErrors.push(error instanceof Error ? error.message : String(error)); tracePath = null; }
	}
	let screenshotPath = null;
	if (page && !['ready', 'expected-rejection'].includes(outcome.kind)) screenshotPath = await addFailureCapture(page, outputDir, id, outcome.kind === 'timeout' ? 1_000 : 4_500);
	if (typeof onAttemptEvent === 'function') {
		emitAttemptEvent('evidence', {
			status: outcome.kind,
			startedAtEpochMs: startEpochMs,
			elapsedMs: outcome.elapsedMs,
			firstValidFrame: frame,
			outcomeText: outcome.text,
			lateOutcome: outcome.lateOutcome ?? null,
			postDeadlineObservation: outcome.postDeadlineObservation ?? null,
			consoleErrors: errorCapture.console,
			pageErrors: errorCapture.page,
			requestGraph: requestCapture.rows,
			screenshotPath,
			tracePath,
			diagnostic: diagnosticData,
			diagnosticErrors
		});
		emitAttemptEvent('cleanup-start', {});
	}
	const cleanupErrors = [];
	if (page) try { await withNodeWatchdog(() => page.close(), 5_000, 'Page cleanup'); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
	if (context) try { await withNodeWatchdog(() => context.close(), 5_000, 'Context cleanup'); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
	const row = {
		id: attemptId, scenarioRowId: attemptId, kind: prime ? 'prime' : diagnostic ? 'diagnostic' : 'model', baseline: null,
		app: app.id, fixtureId: fixture.id, fixtureSha256: fixture.sha256, fixtureBytes: fixture.bytes,
		mode, attempt: index, prime, openAction,
		status: cleanupErrors.length ? 'harness-error-cleanup' : prime && outcome.kind === 'ready' ? 'prime-excluded' : outcome.kind,
		expectedOutcome, openOccurred: startEpochMs !== null,
		setupDurationMs: performance.now() - setupStart,
		startedAtEpochMs: startEpochMs, elapsedMs: outcome.elapsedMs, firstValidFrame: frame,
		outcomeText: outcome.text, lateOutcome: outcome.lateOutcome ?? null, postDeadlineObservation: outcome.postDeadlineObservation ?? null,
		consoleErrors: errorCapture.console, pageErrors: errorCapture.page,
		requestGraph: requestCapture.rows, screenshotPath, tracePath, diagnostic: diagnosticData,
		diagnosticErrors, cleanupStatus: cleanupErrors.length ? 'failed' : 'complete', cleanupErrors
	};
	if (observerError) {
		row.observerError = observerError;
		row.status = 'harness-error-observer';
	}
	if (startEpochMs !== null) row.startedAt = new Date(startEpochMs).toISOString();
	if (typeof onAttemptEvent === 'function') emitAttemptEvent('attempt-result', { row });
	return row;
}

export async function performExpectedRejection({ browser, app, fixture, baseUrl, outputDir, scenarioRowId, onAttemptEvent = null }) {
	let pendingResultEvent = null;
	const relayEvent = onAttemptEvent ? (event) => {
		if (event.type === 'attempt-result') { pendingResultEvent = event; return; }
		return onAttemptEvent(event);
	} : null;
	const row = await performModelAttempt({ browser, app, fixture, baseUrl, mode: 'cold', outputDir, index: 1, expectedOutcome: 'BOMC 1.2 MATERIALS v2 rejected before geometry/preview', scenarioRowId, onAttemptEvent: relayEvent });
	const expected = /^BOMC invalid: material section version\.$/i.test((row.outcomeText ?? '').trim());
	row.status = row.status === 'error' && expected && row.firstValidFrame === null && row.openOccurred ? 'expected-rejection' : row.status === 'timeout' ? 'timeout' : 'failed';
	row.expectedOutcome = 'BOMC 1.2 MATERIALS v2 rejected before geometry/preview';
	row.rejectionMessageMatchesB0 = expected && row.firstValidFrame === null;
	if (pendingResultEvent) onAttemptEvent(pendingResultEvent);
	return row;
}

async function currentBootOpenPoint(page, app) {
	const target = await withNodeWatchdog(() => page.evaluate((appId) => {
		let element = null;
		if (appId === 'editor') element = document.querySelector('button.empty-open');
		else if (appId === 'rooms') {
			const dialog = document.querySelector('dialog.import-dialog');
			element = dialog?.open ? dialog.querySelector('input[aria-label="BOMC 1.2 file"]') : document.querySelector('button.start-import');
		} else {
			element = [...document.querySelectorAll('button')].find((button) => (button.innerText ?? button.textContent ?? '').trim() === 'Choose model file');
		}
		if (!(element instanceof HTMLElement) || element.matches(':disabled') || element.hidden) return null;
		const style = getComputedStyle(element);
		if (style.display === 'none' || style.visibility === 'hidden') return null;
		const rect = element.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return null;
		return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, tagName: element.tagName, className: typeof element.className === 'string' ? element.className : '' };
	}, app.id), 1_000, 'Current Open target lookup');
	if (!target) return null;
	await withNodeWatchdog(() => page.mouse.click(target.x, target.y), 5_000, 'Current Open action');
	return target;
}

function validBootRequestTiming(timing) {
	return timing && Number.isFinite(timing.startTime) && timing.startTime > 0 && Number.isFinite(timing.responseStart) && timing.responseStart >= 0 && Number.isFinite(timing.responseEnd) && timing.responseEnd >= timing.responseStart;
}

async function performBootAttempt({ browser, context: reusedContext = null, app, baseUrl, viewportName, mode, outputDir, index, prime = false, baseline = null }) {
	const id = `${app.id}-boot-${viewportName}-${mode}-${prime ? 'prime' : String(index).padStart(2, '0')}`;
	const viewport = viewportName === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 };
	let context = reusedContext;
	let page = null;
	let errors = { console: [], page: [] };
	let capture = { rows: [], bodyFor: () => Promise.resolve(null) };
	let navigationStartedEpochMs = null;
	let chooserEpochMs = null;
	let navigationResponse = null;
	let chooser = null;
	let row = null;
	let actualTickEpochs = [];
	let openTargetTrace = [];
	let chooserResolve;
	const chooserObserved = new Promise((resolve) => { chooserResolve = resolve; });
	try {
		if (!context) {
			const made = await withNodeWatchdog(() => makeContext(browser, { viewport, cacheDisabled: mode === 'cold', throttled: true }), 5_000, 'Boot context creation');
			context = made.context;
		}
		page = await withNodeWatchdog(() => newPage(context), 5_000, 'Boot page creation');
		errors = installPageErrorCapture(page);
		capture = installRequestCapture(page);
		const cdp = await withNodeWatchdog(() => context.newCDPSession(page), 5_000, 'Boot CDP session');
		await withNodeWatchdog(async () => {
			await cdp.send('Network.enable');
			await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
			await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 4_000_000 / 8, uploadThroughput: 1_000_000 / 8, connectionType: 'cellular3g' });
		}, 5_000, 'Boot throttle setup');
		page.on('filechooser', (event) => {
			if (chooser) return;
			const observation = captureChooserEventEpoch(event);
			chooser = observation.event;
			chooserEpochMs = observation.chooserEpochMs;
			chooserResolve({ chooser, chooserEpochMs });
		});
		navigationStartedEpochMs = monotonicEpochNow();
		const navigationDeadline = performance.now() + 30_000;
		navigationResponse = await withNodeWatchdog(() => page.goto(appUrl(baseUrl, app), { waitUntil: 'domcontentloaded', timeout: 30_000 }), 30_000, 'Boot navigation');
		if (!navigationResponse || !navigationResponse.ok()) throw new Error(`Navigation failed with HTTP ${navigationResponse?.status() ?? 'no response'}.`);
		let tickStart = performance.now();
		while (!chooser && performance.now() < navigationDeadline) {
			const actualStart = performance.now();
			actualTickEpochs.push(monotonicEpochNow());
			const target = await currentBootOpenPoint(page, app).catch((error) => {
				if (/Node watchdog/i.test(error instanceof Error ? error.message : String(error))) throw error;
				return null;
			});
			openTargetTrace.push({ tick: actualTickEpochs.length, target });
			if (chooser) break;
			const nextTick = tickStart + POLL_MS;
			const waitMs = bootPollDelay(tickStart, performance.now());
			if (waitMs > 0) await Promise.race([new Promise((resolve) => setTimeout(resolve, waitMs)), chooserObserved]);
			tickStart = Math.max(nextTick, actualStart);
		}
		if (chooser) {
			await withNodeWatchdog(() => chooser.setFiles([]), 5_000, 'Boot chooser cancellation');
		}
		const cutoffEpochMs = chooserEpochMs;
		let preOpenJsRequests = [];
		let jsUnknownBodyCount = 0;
		let jsHttpFailureCount = 0;
		let jsTimingFailureCount = 0;
		let jsPendingAtCutoffCount = 0;
		let jsResourceTimingFailureCount = 0;
		let missingResourceMatchCount = 0;
		let resourceMissingCaptureCount = 0;
		let firstFrame = null;
		if (cutoffEpochMs !== null) {
			const browserResourceSnapshot = await withNodeWatchdog(() => page.evaluate(() => ({ timeOriginEpochMs: performance.timeOrigin, resources: performance.getEntriesByType('resource').map((entry) => ({ name: entry.name, startTime: entry.startTime, responseEnd: entry.responseEnd, transferSize: entry.transferSize, initiatorType: entry.initiatorType })) })), 5_000, 'Boot resource timing read');
			const browserResources = browserResourceSnapshot.resources;
			const browserJsResources = browserResources.map((entry, index2) => ({ entry, index: index2 })).filter(({ entry }) => browserResourceSnapshot.timeOriginEpochMs + entry.startTime <= cutoffEpochMs && (entry.initiatorType === 'script' || /\.m?js(?:[?#]|$)/i.test(entry.name)));
			const jsRows = capture.rows.filter((request) => (request.resourceType === 'script' || /\.m?js(?:[?#]|$)/i.test(request.url)) && request.requestEpochMs <= cutoffEpochMs);
			const resourceUsed = new Set();
			for (const request of jsRows) {
				const resourceIndex = browserResources.findIndex((entry, index2) => !resourceUsed.has(index2) && entry.name === request.url && (entry.initiatorType === 'script' || /\.m?js(?:[?#]|$)/i.test(entry.name)));
				const resource = resourceIndex < 0 ? null : browserResources[resourceIndex];
				if (resourceIndex >= 0) resourceUsed.add(resourceIndex); else missingResourceMatchCount += 1;
				const responseBeforeCutoff = Number.isFinite(request.responseEpochMs) && request.responseEpochMs <= cutoffEpochMs;
				const body = responseBeforeCutoff ? await withNodeWatchdog(() => capture.bodyFor(request), 5_000, `JavaScript body ${request.url}`).catch(() => null) : null;
				const status = request.status ?? null;
				const requestTimingValid = validBootRequestTiming(request.responseTiming);
				const resourceResponseEpochMs = resource ? browserResourceSnapshot.timeOriginEpochMs + resource.responseEnd : null;
				const resourceTimingValid = resource && Number.isFinite(resourceResponseEpochMs) && resourceResponseEpochMs <= cutoffEpochMs && Number.isFinite(resource.transferSize) && resource.transferSize >= 0;
				if (!responseBeforeCutoff) jsPendingAtCutoffCount += 1;
				if (!body) jsUnknownBodyCount += 1;
				if (status === null || status >= 400 || request.failure) jsHttpFailureCount += 1;
				if (!requestTimingValid) jsTimingFailureCount += 1;
				if (!resourceTimingValid) jsResourceTimingFailureCount += 1;
				const gzipBytes = body ? gzipSync(body, { level: 9 }).byteLength : null;
				preOpenJsRequests.push({ url: request.url, requestEpochMs: request.requestEpochMs, responseEpochMs: request.responseEpochMs ?? null, status, responseTiming: request.responseTiming ?? null, gzipLevel9Bytes: gzipBytes, responseBodyBytes: body?.byteLength ?? null, transferBytes: resourceTimingValid ? resource.transferSize : null, contentType: request.contentType ?? null, fromServiceWorker: request.fromServiceWorker ?? false, failure: request.failure ?? null, webglTokens: body ? ['WebGLRenderer', 'BufferGeometry', 'WebGL2RenderingContext'].filter((token) => body.includes(Buffer.from(token))) : [] });
			}
			resourceMissingCaptureCount = browserJsResources.filter(({ index: resourceIndex }) => !resourceUsed.has(resourceIndex)).length;
			firstFrame = await withNodeWatchdog(() => page.evaluate(() => window.__loaderBaselineProbe?.firstFrame ?? null), 5_000, 'Pre-open frame read');
		}
		const intervals = actualTickEpochs.slice(1).map((epoch, index2) => epoch - actualTickEpochs[index2]);
		const bodyComplete = isBootRequestEvidenceComplete({ chooserObserved: Boolean(chooser), jsRequestCount: preOpenJsRequests.length, jsGzipUnknownBodyCount: jsUnknownBodyCount, jsHttpFailureCount, jsTimingFailureCount, jsPendingAtCutoffCount, jsResourceTimingFailureCount, missingResourceMatchCount, resourceMissingCaptureCount });
		const clockValid = Number.isFinite(navigationStartedEpochMs) && Number.isFinite(chooserEpochMs) && chooserEpochMs >= navigationStartedEpochMs;
		const pass = Boolean(chooser) && clockValid && bodyComplete;
		row = {
			id, scenarioRowId: id, kind: 'boot', app: app.id, baseline, viewport: viewportName, mode, attempt: index, prime,
			status: pass ? prime ? 'prime-excluded' : 'ready' : !chooser ? 'timeout' : 'failed',
			navigationStartedEpochMs, chooserEpochMs,
			bootInteractivityMs: clockValid ? chooserEpochMs - navigationStartedEpochMs : null,
			clockBasis: 'Node performance.timeOrigin + performance.now captured in filechooser event callback', clockValid,
			nominalPollingResolutionMs: POLL_MS, observedTickEpochs: actualTickEpochs, actualTickIntervalsMs: intervals,
			maxObservedTickIntervalMs: intervals.length ? Math.max(...intervals) : null, chooserPollAttempts: actualTickEpochs.length,
			openTargetTrace, chooserObserved: Boolean(chooser), chooserCancellation: chooser ? 'empty-file-selection-sent' : 'not-applicable',
			jsGzipLevel9Bytes: bodyComplete ? preOpenJsRequests.reduce((sum, item) => sum + item.gzipLevel9Bytes, 0) : null,
			jsRequestCount: preOpenJsRequests.length, jsGzipUnknownBodyCount: jsUnknownBodyCount, jsHttpFailureCount, jsTimingFailureCount, jsPendingAtCutoffCount, jsResourceTimingFailureCount, missingResourceMatchCount, resourceMissingCaptureCount,
			jsNetworkTransferBytes: bodyComplete ? preOpenJsRequests.reduce((sum, item) => sum + item.transferBytes, 0) : null,
			preOpenJsRequests, requestGraph: capture.rows, firstFrameBeforeOpen: firstFrame,
			preOpenRendererEvidence: { observedFrame: firstFrame !== null, webglTokenRequestCount: preOpenJsRequests.filter((item) => item.webglTokens.length > 0).length, informationalOnlyForB0Baseline: baseline === 'B0' },
			preOpenJsContainsWebglTokens: preOpenJsRequests.some((item) => item.webglTokens.length > 0),
			consoleErrors: errors.console, pageErrors: errors.page,
			cdpThrottle: { cpuRate: 4, downloadBitsPerSecond: 4_000_000, uploadBitsPerSecond: 1_000_000, rttMs: 150 }
		};
	} catch (error) {
		const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		const intervals = actualTickEpochs.slice(1).map((epoch, index2) => epoch - actualTickEpochs[index2]);
		row = { id, scenarioRowId: id, kind: 'boot', app: app.id, baseline, viewport: viewportName, mode, attempt: index, prime, status: 'failed', navigationStartedEpochMs, chooserEpochMs, bootInteractivityMs: null, clockValid: false, nominalPollingResolutionMs: POLL_MS, observedTickEpochs: actualTickEpochs, actualTickIntervalsMs: intervals, maxObservedTickIntervalMs: intervals.length ? Math.max(...intervals) : null, chooserPollAttempts: actualTickEpochs.length, openTargetTrace, chooserObserved: Boolean(chooser), outcomeText: text, requestGraph: capture.rows, consoleErrors: errors.console, pageErrors: errors.page, cdpThrottle: { cpuRate: 4, downloadBitsPerSecond: 4_000_000, uploadBitsPerSecond: 1_000_000, rttMs: 150 } };
	}
	const cleanupErrors = [];
	if (page) try { await withNodeWatchdog(() => page.close(), 5_000, 'Boot page cleanup'); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
	if (!reusedContext && context) try { await withNodeWatchdog(() => context.close(), 5_000, 'Boot context cleanup'); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
	row.cleanupStatus = cleanupErrors.length ? 'failed' : 'complete';
	row.cleanupErrors = cleanupErrors;
	if (cleanupErrors.length) row.status = 'harness-error-cleanup';
	return row;
}

export async function discoverBrowserEnvironment(browser) {
	let context = null;
	let page = null;
	let webgl = null;
	try {
		context = await withNodeWatchdog(() => browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }), 5_000, 'Environment context creation');
		page = await withNodeWatchdog(() => context.newPage(), 5_000, 'Environment page creation');
		webgl = await withNodeWatchdog(() => page.evaluate(() => {
			const canvas = document.createElement('canvas');
			const gl = canvas.getContext('webgl2');
			if (!gl || gl.isContextLost()) return { available: false, backend: 'webgl2', contextLost: Boolean(gl?.isContextLost()) };
			const extension = gl.getExtension('WEBGL_debug_renderer_info');
			return {
				available: true, backend: 'webgl2', contextLost: false, version: gl.getParameter(gl.VERSION), shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
				vendor: gl.getParameter(extension?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR),
				renderer: gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER), maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE)
			};
		}), 5_000, 'WebGL2 environment read');
	} catch (error) { webgl = { available: false, error: String(error) }; }
	const cleanupErrors = await closeEnvironmentResources([
		{ resource: page, label: 'Environment page cleanup' },
		{ resource: context, label: 'Environment context cleanup' }
	]);
	if (cleanupErrors.length) throw new Error(`Browser environment cleanup failed: ${cleanupErrors.join('; ')}.`);
	if (webgl?.available !== true || webgl.backend !== 'webgl2' || webgl.contextLost) throw new Error(`Required fixed WebGL2/SwiftShader environment unavailable: ${JSON.stringify(webgl)}.`);
	return {
		os: `${os.platform()} (${os.arch()})`, osRelease: os.release(), nodeVersion: process.version,
		browser: browser.version(), browserLaunchArgs: [...BROWSER_LAUNCH_ARGS], viewport: { width: 1440, height: 900 }, devicePixelRatio: 1,
		webglAdapter: webgl, capturedAt: new Date().toISOString()
	};
}

export function stableEnvironment(environment) {
	const { capturedAt, ...stable } = environment;
	return stable;
}

async function verifySeriesIdentity({ browser, app, baseUrl, baseline, fixture = null, workspaceRoot, expectedBuild, expectedEnvironment, stage }) {
	const build = await readBuild(baseUrl, app, baseline);
	const fixtureLabel = fixture?.id ?? 'boot';
	assertBuildIdentityUnchanged(expectedBuild.identity, build.identity, app.id, fixtureLabel, stage);
	const url = new URL(appUrl(baseUrl, app));
	if (url.searchParams.get('renderer') !== 'webgl2' || url.searchParams.get('renderProfile') !== 'cpu-safe') throw new Error(`${app.id}/${fixtureLabel}: benchmark renderer/profile changed ${stage} series.`);
	const actualFixtureHash = fixture ? verifyFixtureBytes(fixture, readFileSync(fixture.filePath)) : null;
	const environment = await discoverBrowserEnvironment(browser);
	if (JSON.stringify(stableEnvironment(environment)) !== JSON.stringify(stableEnvironment(expectedEnvironment))) throw new Error(`${app.id}/${fixtureLabel}: machine/browser/WebGL environment changed ${stage} series.`);
	return { stage, appId: app.id, fixtureId: fixture?.id ?? null, commit: build.identity.commit, sourceSha256: build.identity.sourceSha256, dirty: build.identity.dirty, renderer: url.searchParams.get('renderer'), renderProfile: url.searchParams.get('renderProfile'), fixtureSha256: actualFixtureHash, environment: stableEnvironment(environment) };
}

async function captureSeriesIdentity(args) {
	try {
		return { valid: true, identity: await verifySeriesIdentity(args), error: null };
	} catch (error) {
		return {
			valid: false,
			identity: { stage: args.stage, appId: args.app.id, fixtureId: args.fixture?.id ?? null },
			error: error instanceof Error ? error.message : String(error)
		};
	}
}

export async function closeEnvironmentResources(resources) {
	const errors = [];
	for (const { resource, label } of resources) {
		if (!resource) continue;
		try { await withNodeWatchdog(() => resource.close(), 5_000, label); }
		catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
	}
	return errors;
}

let activeRunState = null;
let activeRunStatePath = null;

function writeAtomicJson(file, value) {
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
	renameSync(temporary, file);
}

async function writeMetadata(file, metadata) {
	writeAtomicJson(file, metadata);
}

export function assertFreshOutputDirectory(outputDir) {
	if (!existsSync(outputDir)) return;
	const existing = readdirSync(outputDir);
	if (existing.length > 0) throw new Error(`Refusing to mix benchmark evidence in non-empty output directory: ${outputDir} (${existing.join(', ')}).`);
}

export async function launchBenchmarkBrowser() {
	return chromium.launch({ headless: true, args: BROWSER_LAUNCH_ARGS });
}

function writeRunState(update) {
	if (!activeRunState || !activeRunStatePath) return;
	activeRunState = { ...activeRunState, ...update, updatedAt: new Date().toISOString() };
	writeAtomicJson(activeRunStatePath, activeRunState);
}

async function appendRow(file, row) {
	appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
	writeRunState({ rowCount: (activeRunState?.rowCount ?? 0) + 1, lastCompletedCell: row.scenarioId ?? row.scenarioRowId ?? `${row.kind}:${row.app ?? 'unknown'}:${row.fixtureId ?? row.viewport ?? 'unknown'}:${row.mode ?? 'unknown'}`, lastCompletedRowId: row.scenarioRowId ?? row.id ?? null });
}

function assertRunActive() {
	if (activeRunState?.state === 'interrupted') throw new Error(`Benchmark interrupted by ${activeRunState.interruptReason ?? 'external signal'}; no further attempt may start.`);
}

async function runModelSuite({ browser, apps, fixtures, urls, outputDir, baseline, builds, environment, workspaceRoot }) {
	const file = path.join(outputDir, 'model-attempts.jsonl');
	const summaries = {};
	const matrix = buildModelScenarioMatrix(baseline, apps.map((app) => app.id), fixtures.map((fixture) => fixture.id));
	const rows = [];
	const seriesAudits = [];
	let allPrimeRowsPass = true;
	for (const scenario of matrix.scenarios) {
		assertRunActive();
		const app = apps.find((item) => item.id === scenario.appId);
		const fixture = fixtures.find((item) => item.id === scenario.fixtureId);
		if (!app || !fixture) throw new Error(`Scenario ${scenario.id} refers to an unselected app or missing fixture.`);
		const expectedBuild = builds[app.id];
		const beforeCheck = await captureSeriesIdentity({ browser, app, baseUrl: urls[app.id], baseline, fixture, workspaceRoot, expectedBuild, expectedEnvironment: environment, stage: 'before' });
		if (!beforeCheck.valid) {
			seriesAudits.push({ scenarioId: scenario.id, before: beforeCheck.identity, after: null, valid: false, identityError: beforeCheck.error, status: 'not-started' });
			await writeMetadata(path.join(outputDir, 'series-identity-audit-progress.json'), seriesAudits);
			throw new Error(`${scenario.id}: identity check failed before cell start: ${beforeCheck.error}`);
		}
		const before = beforeCheck.identity;
		if (scenario.kind === 'expected-rejection') {
			const row = await performExpectedRejection({ browser, app, fixture, baseUrl: urls[app.id], outputDir, scenarioRowId: scenario.attemptRowIds[0] });
			row.scenarioId = scenario.id;
			row.baseline = baseline;
			rows.push(row);
			await appendRow(file, row);
			console.log(JSON.stringify({ progress: 'v2-admission', app: app.id, fixture: fixture.id, status: row.status, outcomeText: row.outcomeText }));
			if (row.cleanupStatus !== 'complete') {
				seriesAudits.push({ scenarioId: scenario.id, before, after: null, valid: false, cleanupFailure: row.cleanupErrors, expectedOutcome: scenario.expectedOutcome, status: row.status });
				await writeMetadata(path.join(outputDir, 'series-identity-audit-progress.json'), seriesAudits);
				throw new Error(`${scenario.id}: owned attempt cleanup failed; stopping before next cell.`);
			}
			const afterCheck = await captureSeriesIdentity({ browser, app, baseUrl: urls[app.id], baseline, fixture, workspaceRoot, expectedBuild, expectedEnvironment: environment, stage: 'after' });
			seriesAudits.push({ scenarioId: scenario.id, before, after: afterCheck.identity, valid: afterCheck.valid, identityError: afterCheck.error, expectedOutcome: scenario.expectedOutcome, status: row.status });
			await writeMetadata(path.join(outputDir, 'series-identity-audit-progress.json'), seriesAudits);
			if (!afterCheck.valid) throw new Error(`${scenario.id}: identity check failed after cell: ${afterCheck.error}`);
			continue;
		}
		let warmContext = null;
		let primeRow = null;
		let primePassed = true;
		if (scenario.mode === 'warm') {
			const made = await withNodeWatchdog(() => makeContext(browser, { cacheDisabled: false }), 5_000, 'Warm context creation');
			warmContext = made.context;
			primeRow = await performModelAttemptInContext({ context: warmContext, browser, app, fixture, baseUrl: urls[app.id], outputDir, mode: scenario.mode, index: 0, prime: true, scenarioRowId: scenario.primeRowId, expectedOutcome: scenario.expectedOutcome });
			primeRow.baseline = baseline;
			primeRow.scenarioId = scenario.id;
			rows.push(primeRow);
			await appendRow(file, primeRow);
			primePassed = primeRow.status === 'prime-excluded' && primeRow.openOccurred && Number.isFinite(primeRow.elapsedMs) && primeRow.firstValidFrame !== null;
			allPrimeRowsPass &&= primePassed;
			if (!primePassed) summaries[`${scenario.id}-prime`] = { passed: false, status: primeRow.status, elapsedMs: primeRow.elapsedMs, outcomeText: primeRow.outcomeText };
		}
		const measuredRows = [];
		let beforeMeasured = null;
		let after = null;
		let cleanupFailure = null;
		let seriesFailure = null;
		let identityFailure = null;
		try {
			if (primeRow?.cleanupStatus !== undefined && primeRow.cleanupStatus !== 'complete') throw new Error(`${scenario.id}: prime cleanup failed; stopping before measured attempts.`);
			const beforeMeasuredCheck = await captureSeriesIdentity({ browser, app, baseUrl: urls[app.id], baseline, fixture, workspaceRoot, expectedBuild, expectedEnvironment: environment, stage: 'before-measured' });
			beforeMeasured = beforeMeasuredCheck.identity;
			if (!beforeMeasuredCheck.valid) {
				identityFailure = `${scenario.id}: identity check failed before measured series: ${beforeMeasuredCheck.error}`;
				throw new Error(identityFailure);
			}
			for (let attempt = 1; attempt <= scenario.expectedAttempts; attempt += 1) {
				assertRunActive();
				const scenarioRowId = scenario.attemptRowIds[attempt - 1];
				const row = scenario.mode === 'cold'
					? await performModelAttempt({ browser, app, fixture, baseUrl: urls[app.id], mode: scenario.mode, outputDir, index: attempt, expectedOutcome: scenario.expectedOutcome, scenarioRowId })
					: await performModelAttemptInContext({ context: warmContext, browser, app, fixture, baseUrl: urls[app.id], outputDir, mode: scenario.mode, index: attempt, expectedOutcome: scenario.expectedOutcome, scenarioRowId });
				row.baseline = baseline;
				row.scenarioId = scenario.id;
				measuredRows.push(row);
				rows.push(row);
				await appendRow(file, row);
				console.log(JSON.stringify({ progress: 'model', app: app.id, fixture: fixture.id, mode: scenario.mode, attempt, status: row.status, elapsedMs: row.elapsedMs }));
				if (row.cleanupStatus !== 'complete') throw new Error(`${scenario.id}: attempt cleanup failed; stopping before next attempt.`);
			}
			const afterCheck = await captureSeriesIdentity({ browser, app, baseUrl: urls[app.id], baseline, fixture, workspaceRoot, expectedBuild, expectedEnvironment: environment, stage: 'after' });
			after = afterCheck.identity;
			if (!afterCheck.valid) {
				identityFailure = `${scenario.id}: identity check failed after measured series: ${afterCheck.error}`;
				throw new Error(identityFailure);
			}
		} catch (error) {
			seriesFailure = error instanceof Error ? error.message : String(error);
		} finally {
			if (warmContext) {
				try { await withNodeWatchdog(() => warmContext.close(), 5_000, 'Warm context cleanup'); }
				catch (error) { cleanupFailure = error instanceof Error ? error.message : String(error); }
			}
		}
		const summary = summarizeTimingRows(measuredRows, scenario.expectedAttempts);
		if (scenario.mode === 'warm') {
			summary.warmPrimeStatus = primeRow?.status ?? 'missing';
			summary.warmPrimePassed = primePassed;
			if (!primePassed) summary.seriesPass = false;
		}
		const identityValid = beforeMeasured !== null && after !== null && identityFailure === null;
		if (!identityValid || identityFailure !== null || seriesFailure !== null || cleanupFailure !== null) summary.seriesPass = false;
		summaries[scenario.id] = summary;
		seriesAudits.push({ scenarioId: scenario.id, before, beforeMeasured, after, identityValid, valid: identityValid && cleanupFailure === null, identityError: identityFailure, seriesFailure, cleanupFailure, summary });
		await writeMetadata(path.join(outputDir, 'model-summary-progress.json'), summaries);
		await writeMetadata(path.join(outputDir, 'series-identity-audit-progress.json'), seriesAudits);
		if (cleanupFailure) throw new Error(`${scenario.id}: warm context cleanup did not finish; stopping dependent work.`);
		if (seriesFailure) throw new Error(`${scenario.id}: stopping dependent work after series failure: ${seriesFailure}`);
	}
	const acceptance = evaluateModelAcceptance(matrix, rows, summaries);
	const expectedPrimeCount = matrix.scenarios.filter((scenario) => scenario.primeRowId).length;
	const actualPrimeCount = rows.filter((row) => row.kind === 'prime').length;
	acceptance.allPrimeRowsPass &&= actualPrimeCount === expectedPrimeCount;
	const rejectionRows = rows.filter((row) => row.expectedOutcome === 'BOMC 1.2 MATERIALS v2 rejected before geometry/preview');
	return { summaries, rowCount: rows.length, outputFile: file, matrix, ...acceptance, allPrimeRowsPass: acceptance.allPrimeRowsPass, rejectionRows: rejectionRows.map(({ id, app, fixtureId, status, outcomeText, firstValidFrame, rejectionMessageMatchesB0 }) => ({ id, app, fixtureId, status, outcomeText, firstValidFrame, rejectionMessageMatchesB0 })), seriesAudits };
}

export async function performModelAttemptInContext({ context, browser, app, fixture, baseUrl, mode, outputDir, index, prime = false, expectedOutcome = 'ready', scenarioRowId = null, onAttemptEvent = null }) {
	const id = scenarioRowId ?? modelRowId(app.id, fixture.id, mode, index, prime);
	const setupStart = performance.now();
	const attemptId = id;
	let observerError = null;
	let appOutcomeEmitted = false;
	const emitAttemptEvent = (type, payload) => {
		if (typeof onAttemptEvent !== 'function') return true;
		if (observerError) return false;
		try {
			const result = onAttemptEvent({ type, attemptId, payload, emittedAtEpochMs: monotonicEpochNow() });
			if (result && typeof result.then === 'function') throw new Error('onAttemptEvent must synchronously enqueue IPC observations.');
			return true;
		} catch (error) {
			observerError = error instanceof Error ? error.message : String(error);
			return false;
		}
	};
	const emitOutcome = (value) => {
		if (appOutcomeEmitted || typeof onAttemptEvent !== 'function') return;
		appOutcomeEmitted = true;
		emitAttemptEvent('app-outcome', { ...value, observedAtEpochMs: monotonicEpochNow() });
	};
	let page = null;
	const errorCapture = { console: [], page: [] };
	const requestCapture = { rows: [], responses: new Map() };
	let startPerfMs = null;
	let startEpochMs = null;
	let openAction = 'app-specific open action';
	let outcome = { kind: 'setup-error', text: null, elapsedMs: null };
	let frame = null;
	try {
		page = await withNodeWatchdog(() => newPage(context), 5_000, 'Warm browser page creation');
		Object.assign(errorCapture, installPageErrorCapture(page));
		Object.assign(requestCapture, installRequestCapture(page));
		await gotoApplication(page, app, baseUrl);
		const selected = await selectFixture(page, app, fixture, (clock) => {
			startPerfMs = clock.perfMs;
			startEpochMs = clock.epochMs;
			openAction = clock.openAction;
			if (!emitAttemptEvent('open', { perfMs: clock.perfMs, epochMs: clock.epochMs, openAction })) throw new Error('Open observation could not be enqueued.');
		});
		startPerfMs ??= selected.startPerfMs;
		startEpochMs ??= selected.startEpochMs;
		openAction = selected.openAction;
		outcome = await waitForOutcome(page, app, startPerfMs, startEpochMs);
		emitOutcome(outcome);
		const readySignal = outcome.kind === 'ready' ? outcome : outcome.lateOutcome?.kind === 'ready' ? outcome.lateOutcome : outcome.postDeadlineObservation?.outcome?.kind === 'ready' ? outcome.postDeadlineObservation : null;
		if (readySignal) frame = await readFrame(page, startPerfMs, readySignal.observedElapsedMs ?? readySignal.elapsedMs ?? DEADLINE_MS);
		if (outcome.kind === 'ready' && !frame) outcome = { ...outcome, kind: 'failed-no-valid-frame', text: 'App reported ready without observable connected positive-size WebGL draw frame.' };
	} catch (error) {
		const errorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		outcome = startEpochMs === null
			? { kind: 'setup-error', text: errorText, elapsedMs: null }
			: { kind: 'failed-after-open', text: errorText, elapsedMs: Math.max(0, Date.now() - startEpochMs) };
		if (!appOutcomeEmitted && !observerError) emitOutcome({ ...outcome, observationError: true });
	}
	const screenshotPath = page && !['ready', 'expected-rejection', 'error'].includes(outcome.kind) ? await addFailureCapture(page, outputDir, id) : null;
	if (typeof onAttemptEvent === 'function') {
		emitAttemptEvent('evidence', {
			status: outcome.kind,
			startedAtEpochMs: startEpochMs,
			elapsedMs: outcome.elapsedMs,
			firstValidFrame: frame,
			outcomeText: outcome.text,
			lateOutcome: outcome.lateOutcome ?? null,
			postDeadlineObservation: outcome.postDeadlineObservation ?? null,
			consoleErrors: errorCapture.console,
			pageErrors: errorCapture.page,
			requestGraph: requestCapture.rows,
			diagnostic: null,
			diagnosticErrors: []
		});
		emitAttemptEvent('cleanup-start', {});
	}
	const cleanupErrors = [];
	if (page) try { await withNodeWatchdog(() => page.close(), 5_000, 'Warm page cleanup'); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
	const row = {
		id: attemptId, scenarioRowId: attemptId, kind: prime ? 'prime' : 'model', app: app.id, fixtureId: fixture.id, fixtureSha256: fixture.sha256, fixtureBytes: fixture.bytes,
		mode, attempt: index, prime, openAction, status: cleanupErrors.length ? 'harness-error-cleanup' : prime && outcome.kind === 'ready' ? 'prime-excluded' : outcome.kind,
		expectedOutcome, openOccurred: startEpochMs !== null, setupDurationMs: performance.now() - setupStart, startedAtEpochMs: startEpochMs, elapsedMs: outcome.elapsedMs, firstValidFrame: frame,
		outcomeText: outcome.text, lateOutcome: outcome.lateOutcome ?? null, postDeadlineObservation: outcome.postDeadlineObservation ?? null,
		consoleErrors: errorCapture.console, pageErrors: errorCapture.page,
		requestGraph: requestCapture.rows, screenshotPath, cleanupStatus: cleanupErrors.length ? 'failed' : 'complete', cleanupErrors
	};
	if (observerError) {
		row.observerError = observerError;
		row.status = 'harness-error-observer';
	}
	if (startEpochMs !== null) row.startedAt = new Date(startEpochMs).toISOString();
	if (typeof onAttemptEvent === 'function') emitAttemptEvent('attempt-result', { row });
	return row;
}

async function runBootSuite({ browser, apps, urls, outputDir, baseline, builds, environment }) {
	const file = path.join(outputDir, 'boot-attempts.jsonl');
	const summaries = {};
	const matrix = buildBootScenarioMatrix(apps.map((app) => app.id));
	const rows = [];
	const seriesAudits = [];
	let allPrimeRowsPass = true;
	for (const scenario of matrix.scenarios) {
		const app = apps.find((item) => item.id === scenario.appId);
		if (!app) throw new Error(`Boot scenario ${scenario.id} refers to an unselected app.`);
		const beforeCheck = await captureSeriesIdentity({ browser, app, baseUrl: urls[app.id], baseline, expectedBuild: builds[app.id], expectedEnvironment: environment, stage: 'before' });
		if (!beforeCheck.valid) {
			seriesAudits.push({ scenarioId: scenario.id, before: beforeCheck.identity, after: null, identityValid: false, valid: false, identityError: beforeCheck.error, status: 'not-started' });
			await writeMetadata(path.join(outputDir, 'series-identity-audit-progress.json'), seriesAudits);
			throw new Error(`${scenario.id}: identity check failed before boot cell start: ${beforeCheck.error}`);
		}
		const before = beforeCheck.identity;
		const viewportName = scenario.viewport;
		let warmContext = null;
		let primeRow = null;
		let primePassed = true;
		if (scenario.mode === 'warm') {
			warmContext = await withNodeWatchdog(() => browser.newContext({ viewport: viewportName === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }), 5_000, 'Warm boot context creation');
			primeRow = await performBootAttempt({ browser, context: warmContext, app, baseUrl: urls[app.id], viewportName, mode: scenario.mode, outputDir, index: 0, prime: true, baseline });
			primeRow.scenarioRowId = scenario.primeRowId;
			primeRow.scenarioId = scenario.id;
			rows.push(primeRow);
			await appendRow(file, primeRow);
			primePassed = primeRow.status === 'prime-excluded' && primeRow.clockValid === true && Number.isFinite(primeRow.bootInteractivityMs) && primeRow.bootInteractivityMs >= 0 && Number.isFinite(primeRow.jsGzipLevel9Bytes) && primeRow.jsGzipLevel9Bytes >= 0 && primeRow.jsRequestCount > 0;
			allPrimeRowsPass &&= primePassed;
			if (primeRow.cleanupStatus !== 'complete') throw new Error(`${scenario.id}: prime cleanup failed; stopping boot series.`);
		}
		const measuredRows = [];
		let beforeMeasured = null;
		let after = null;
		let cleanupFailure = null;
		let seriesFailure = null;
		let identityFailure = null;
		try {
			if (primeRow?.cleanupStatus !== undefined && primeRow.cleanupStatus !== 'complete') throw new Error(`${scenario.id}: prime cleanup failed; stopping boot series.`);
			const beforeMeasuredCheck = await captureSeriesIdentity({ browser, app, baseUrl: urls[app.id], baseline, expectedBuild: builds[app.id], expectedEnvironment: environment, stage: 'before-measured' });
			beforeMeasured = beforeMeasuredCheck.identity;
			if (!beforeMeasuredCheck.valid) {
				identityFailure = `${scenario.id}: identity check failed before measured boot series: ${beforeMeasuredCheck.error}`;
				throw new Error(identityFailure);
			}
			for (let attempt = 1; attempt <= scenario.expectedAttempts; attempt += 1) {
				assertRunActive();
				const row = await performBootAttempt({ browser, context: warmContext, app, baseUrl: urls[app.id], viewportName, mode: scenario.mode, outputDir, index: attempt, baseline });
				row.scenarioRowId = scenario.attemptRowIds[attempt - 1];
				row.scenarioId = scenario.id;
				rows.push(row);
				measuredRows.push(row);
				await appendRow(file, row);
				console.log(JSON.stringify({ progress: 'boot', app: app.id, viewport: viewportName, mode: scenario.mode, attempt, status: row.status, bootInteractivityMs: row.bootInteractivityMs, chooserResolutionMs: row.maxObservedTickIntervalMs }));
				if (row.cleanupStatus !== 'complete') throw new Error(`${scenario.id}: attempt cleanup failed; stopping before next boot attempt.`);
			}
			const afterCheck = await captureSeriesIdentity({ browser, app, baseUrl: urls[app.id], baseline, expectedBuild: builds[app.id], expectedEnvironment: environment, stage: 'after' });
			after = afterCheck.identity;
			if (!afterCheck.valid) {
				identityFailure = `${scenario.id}: identity check failed after measured boot series: ${afterCheck.error}`;
				throw new Error(identityFailure);
			}
		} catch (error) {
			seriesFailure = error instanceof Error ? error.message : String(error);
		} finally {
			if (warmContext) try { await withNodeWatchdog(() => warmContext.close(), 5_000, 'Warm boot context cleanup'); }
			catch (error) { cleanupFailure = error instanceof Error ? error.message : String(error); }
		}
		const summary = summarizeBootTimingRows(measuredRows, scenario.expectedAttempts);
		if (scenario.mode === 'warm') {
			summary.warmPrimeStatus = primeRow?.status ?? 'missing';
			summary.warmPrimePassed = primePassed;
			if (!primePassed) summary.seriesPass = false;
		}
		const identityValid = beforeMeasured !== null && after !== null && identityFailure === null;
		if (!identityValid || identityFailure !== null || seriesFailure !== null || cleanupFailure !== null) summary.seriesPass = false;
		summaries[scenario.id] = summary;
		seriesAudits.push({ scenarioId: scenario.id, before, beforeMeasured, after, identityValid, valid: identityValid && cleanupFailure === null, identityError: identityFailure, seriesFailure, cleanupFailure, summary });
		await writeMetadata(path.join(outputDir, 'boot-summary-progress.json'), summaries);
		await writeMetadata(path.join(outputDir, 'series-identity-audit-progress.json'), seriesAudits);
		if (cleanupFailure) throw new Error(`${scenario.id}: boot warm context cleanup did not finish; stopping dependent work.`);
		if (seriesFailure) throw new Error(`${scenario.id}: stopping dependent boot work after series failure: ${seriesFailure}`);
	}
	const acceptance = evaluateBootAcceptance(matrix, rows, summaries);
	const expectedPrimeCount = matrix.scenarios.filter((scenario) => scenario.primeRowId).length;
	const actualPrimeCount = rows.filter((row) => row.prime).length;
	acceptance.allPrimeRowsPass &&= actualPrimeCount === expectedPrimeCount;
	return { summaries, rowCount: rows.length, outputFile: file, matrix, ...acceptance, allPrimeRowsPass: acceptance.allPrimeRowsPass, seriesAudits };
}

export function workerTraceAudit(row, mode) {
	const events = row.diagnostic?.events ?? [];
	const wrapped = mode === 'wrapped';
	const expectedWorkerPhase = wrapped ? 'wrapped-worker' : 'native-worker';
	const unmatchedPhase = wrapped ? 'unmatched-worker' : 'native-unmatched-worker';
	const matchedWorkerCount = events.filter((event) => event.phase === expectedWorkerPhase).length;
	const unmatchedWorkers = events.filter((event) => event.phase === unmatchedPhase).map((event) => event.url);
	const secondaryWorkers = events.filter((event) => event.phase === 'known-secondary-worker').map(({ url, workerKind, workerId }) => ({ url, workerKind, workerId }));
	const importErrors = events.filter((event) => event.phase === 'worker-import-error');
	const phases = wrapped ? ['worker-pre-post', 'worker-post-return', 'main-receive'] : ['native-main-receive'];
	const completePositions = phases.map((phase) => events.findIndex((event) => event.phase === phase && event.type === 'complete'));
	const completeEvents = phases.map((phase) => events.find((event) => event.phase === phase && event.type === 'complete') ?? null);
	const completePhaseEpochs = completeEvents.map((event) => event?.epochMs ?? null);
	const hasAllCompletePhases = completeEvents.every((event) => event !== null);
	const completeEpochsFinite = completeEvents.every((event) => event !== null && Number.isFinite(event.epochMs));
	const workerPostReturnedAfterPrePost = !wrapped || (
		completeEvents[0] !== null && completeEvents[1] !== null &&
		Number.isFinite(completeEvents[0].epochMs) && Number.isFinite(completeEvents[1].epochMs) &&
		completeEvents[1].epochMs >= completeEvents[0].epochMs
	);
	const completeLifecycle = hasAllCompletePhases && completeEpochsFinite && workerPostReturnedAfterPrePost;
	const phaseCounts = Object.fromEntries([...new Set(events.map((event) => event.phase))].map((phase) => [phase, events.filter((event) => event.phase === phase).length]));
	return {
		mode, matchedWorkerCount, unmatchedWorkers, secondaryWorkers, importErrorCount: importErrors.length,
		completePhaseNames: phases, completePhasePositions: completePositions, completePhaseEpochs,
		workerPostReturnedAfterPrePost,
		completeLifecycle, missingCompletePhases: phases.filter((phase) => !events.some((event) => event.phase === phase && event.type === 'complete')),
		phaseCounts, runtimeCounts: events.findLast((event) => event.phase === 'worker-pre-post' && event.type === 'complete')?.graph?.runtimeCounts ?? null
	};
}

export function summarizeDiagnosticCases(cases) {
	const lOld = cases.find((item) => item.appId === 'editor' && item.fixtureId === 'L-old');
	const s2Native = cases.find((item) => item.appId === 'editor' && item.fixtureId === 'S2-jcm' && item.mode === 'native');
	const s2Wrapped = cases.find((item) => item.appId === 'editor' && item.fixtureId === 'S2-jcm' && item.mode === 'wrapped');
	const roomsYOld = cases.find((item) => item.appId === 'rooms' && item.fixtureId === 'Y-old');
	const runtimeCountAudit = cases.filter((item) => item.mode === 'wrapped' && SUPPORTED_ID_SET.has(item.fixtureId)).map((item) => ({ appId: item.appId, fixtureId: item.fixtureId, status: item.status, runtimeCounts: item.runtimeCounts, captured: item.acceptance.runtimeCountsCaptured, reason: item.acceptance.runtimeCountsCaptured ? null : item.status === 'ready' ? 'worker result did not expose all requested runtime fields' : `successful output unavailable: ${item.status}` }));
	const lOldBoundedAndMatched = Boolean(
		lOld && lOld.acceptance.pass === true && lOld.acceptance.boundedLoldDiagnostic === true
	);
	const acceptance = {
		s2NativeComplete: s2Native?.acceptance.pass === true,
		s2WrappedComplete: s2Wrapped?.acceptance.pass === true,
		lOldBoundedAndMatched,
		roomsYOldFrameTrace: roomsYOld?.acceptance.appReadyAndValidFrame === true && roomsYOld.tracePath !== null,
		runtimeCountAuditComplete: runtimeCountAudit.every((item) => item.captured || item.status !== 'ready'),
		allDiagnosticResourcesClean: cases.every((item) => item.acceptance.cleanupComplete),
		pass: Boolean(s2Native?.acceptance.pass && s2Wrapped?.acceptance.pass && lOldBoundedAndMatched && roomsYOld?.acceptance.appReadyAndValidFrame && runtimeCountAudit.every((item) => item.captured || item.status !== 'ready') && cases.every((item) => item.acceptance.cleanupComplete))
	};
	return { caseCount: cases.length, cases, runtimeCountAudit, acceptance };
}

async function runDiagnostic({ browser, apps, fixtures, urls, outputDir, baseline, builds, environment, workspaceRoot }) {
	const specs = [];
	const supportedFixtures = fixtures.filter((fixture) => SUPPORTED_ID_SET.has(fixture.id));
	for (const app of apps) for (const fixture of supportedFixtures) {
		specs.push({ id: `diagnostic-${app.id}-${fixture.id}-wrapped`, app, fixture, mode: 'wrapped' });
	}
	const editor = apps.find((app) => app.id === 'editor');
	if (editor) {
		const jcm = fixtures.find((fixture) => fixture.id === 'S2-jcm');
		const legacy = fixtures.find((fixture) => fixture.id === 'L-old');
		if (jcm) specs.push({ id: 'diagnostic-editor-S2-jcm-native', app: editor, fixture: jcm, mode: 'native' });
		if (legacy) specs.push({ id: 'diagnostic-editor-L-old-wrapped', app: editor, fixture: legacy, mode: 'wrapped' });
	}
	const attemptsFile = path.join(outputDir, 'diagnostic-attempts.jsonl');
	const cases = [];
	for (const spec of specs) {
		assertRunActive();
		const before = await verifySeriesIdentity({ browser, app: spec.app, baseUrl: urls[spec.app.id], baseline, fixture: spec.fixture, workspaceRoot, expectedBuild: builds[spec.app.id], expectedEnvironment: environment, stage: 'before-diagnostic' });
		const row = await performModelAttempt({
			browser, app: spec.app, fixture: spec.fixture, baseUrl: urls[spec.app.id], mode: 'diagnostic-excluded', outputDir,
			index: 1, diagnostic: spec.mode === 'wrapped', workerControl: spec.mode === 'native', expectedOutcome: 'ready', scenarioRowId: spec.id
		});
		row.baseline = baseline;
		row.diagnosticMode = spec.mode;
		row.scenarioId = spec.id;
		row.workerTraceAudit = workerTraceAudit(row, spec.mode);
		row.runtimeCounts = row.workerTraceAudit.runtimeCounts;
		row.identityAudit = { before, after: null, valid: false, error: null };
		try {
			row.identityAudit.after = await verifySeriesIdentity({ browser, app: spec.app, baseUrl: urls[spec.app.id], baseline, fixture: spec.fixture, workspaceRoot, expectedBuild: builds[spec.app.id], expectedEnvironment: environment, stage: 'after-diagnostic' });
			row.identityAudit.valid = true;
		} catch (error) {
			row.identityAudit.error = error instanceof Error ? error.message : String(error);
		}
		const complete = row.status === 'ready' && row.openOccurred === true && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && row.firstValidFrame !== null && row.workerTraceAudit.matchedWorkerCount === 1 && row.workerTraceAudit.unmatchedWorkers.length === 0;
		const boundedLold = spec.app.id === 'editor' && spec.fixture.id === 'L-old'
			? row.openOccurred === true && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && row.elapsedMs <= DEADLINE_MS && row.tracePath !== null && row.diagnosticErrors.length === 0
			: null;
		row.acceptance = {
			appReadyAndValidFrame: row.status === 'ready' && row.firstValidFrame !== null,
			workerMatchedExactlyOnce: row.workerTraceAudit.matchedWorkerCount === 1,
			noUnmatchedWorker: row.workerTraceAudit.unmatchedWorkers.length === 0,
			noWorkerImportError: row.workerTraceAudit.importErrorCount === 0,
			completeWorkerLifecycle: row.workerTraceAudit.completeLifecycle,
			boundedLoldDiagnostic: boundedLold,
			runtimeCountsCaptured: Boolean(row.runtimeCounts && Number.isInteger(row.runtimeCounts.resultFacesLength) && Number.isInteger(row.runtimeCounts.preparedRuntimeSceneGroupsLength) && row.runtimeCounts.sourceCounts && typeof row.runtimeCounts.sourceCounts === 'object'),
			identityStable: row.identityAudit.valid,
			cleanupComplete: row.cleanupStatus === 'complete',
			pass: spec.mode === 'native'
				? complete && row.workerTraceAudit.completeLifecycle && row.identityAudit.valid && row.cleanupStatus === 'complete'
				: complete && row.workerTraceAudit.completeLifecycle && row.workerTraceAudit.importErrorCount === 0 && row.identityAudit.valid && row.cleanupStatus === 'complete'
		};
		if (boundedLold !== null) row.acceptance.pass = boundedLold && row.workerTraceAudit.matchedWorkerCount === 1 && row.workerTraceAudit.unmatchedWorkers.length === 0 && row.workerTraceAudit.importErrorCount === 0 && row.identityAudit.valid && row.cleanupStatus === 'complete';
		writeAtomicJson(path.join(outputDir, 'diagnostics', `${spec.id}.json`), row);
		await appendRow(attemptsFile, row);
		cases.push({ id: spec.id, appId: spec.app.id, fixtureId: spec.fixture.id, mode: spec.mode, status: row.status, elapsedMs: row.elapsedMs, tracePath: row.tracePath, firstValidFrame: row.firstValidFrame, workerTraceAudit: row.workerTraceAudit, runtimeCounts: row.runtimeCounts, identityAudit: row.identityAudit, acceptance: row.acceptance });
		await writeMetadata(path.join(outputDir, 'diagnostic-summary-progress.json'), cases);
		if (row.cleanupStatus !== 'complete') throw new Error(`${spec.id}: diagnostic resource cleanup failed; stopping.`);
		if (!row.identityAudit.valid) throw new Error(`${spec.id}: diagnostic build/environment/fixture identity drifted; stopping.`);
	}
	return summarizeDiagnosticCases(cases);
}

export async function runBaseline(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	const outputDir = path.resolve(options.output);
	const workspaceRoot = path.resolve(options.workspaceRoot);
	const fixturePath = path.resolve(options.fixtures);
	const fixtureManifestPath = path.relative(workspaceRoot, fixturePath);
	if (fixtureManifestPath === '..' || fixtureManifestPath.startsWith(`..${path.sep}`) || path.isAbsolute(fixtureManifestPath)) {
		throw new Error('Fixture manifest must be inside --workspace-root so run metadata uses a workspace-relative identity.');
	}
	const { manifest, fixtures } = readManifest(workspaceRoot, fixturePath);
	assertFreshOutputDirectory(outputDir);
	mkdirSync(outputDir, { recursive: true });
	activeRunStatePath = path.join(outputDir, 'run-state.json');
	activeRunState = { schemaVersion: 'bomc-loader-run-state-v1', state: 'running', baseline: options.baseline, suite: options.suite, selectedAppIds: options.apps.map((app) => app.id), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), rowCount: 0, lastCompletedCell: null, lastCompletedRowId: null };
	writeAtomicJson(activeRunStatePath, activeRunState);
	let browser = null;
	let interruptedBy = null;
	const onInterrupt = (signal) => {
		if (interruptedBy) return;
		interruptedBy = signal;
		writeRunState({ state: 'interrupted', interruptReason: signal, interruptedAt: new Date().toISOString() });
		process.exitCode = signal === 'SIGINT' ? 130 : 143;
		if (browser) void browser.close().catch(() => {});
	};
	const onSigint = () => onInterrupt('SIGINT');
	const onSigterm = () => onInterrupt('SIGTERM');
	process.on('SIGINT', onSigint);
	process.on('SIGTERM', onSigterm);
	try {
		const builds = {};
		for (const app of APPS) builds[app.id] = await readBuild(options.urls[app.id], app, options.baseline);
		browser = await withNodeWatchdog(() => launchBenchmarkBrowser(), 10_000, 'Chromium launch');
		const environment = await withNodeWatchdog(() => discoverBrowserEnvironment(browser), 10_000, 'Browser environment discovery');
		const modelMatrix = ['all', 'model'].includes(options.suite) ? buildModelScenarioMatrix(options.baseline, options.apps.map((app) => app.id), fixtures.map((fixture) => fixture.id)) : null;
		const bootMatrix = ['all', 'boot'].includes(options.suite) ? buildBootScenarioMatrix(options.apps.map((app) => app.id)) : null;
		const runnerSha256 = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
		const metadata = {
			schemaVersion: 'bomc-loader-baseline-v2', plan: PLAN, review: 'BOMC-LOADER-001/CP0/IMPLEMENTATION_REVIEW_2026-10-03_v1.1', baseline: options.baseline,
			capturedAt: new Date().toISOString(), runnerSha256, selectedAppIds: options.apps.map((app) => app.id), suite: options.suite,
			environment, builds,
			urls: Object.fromEntries(APPS.map((app) => [app.id, appUrl(options.urls[app.id], app)])),
			fixtureManifest: { path: fixtureManifestPath.replaceAll('\\', '/'), schemaVersion: manifest.schemaVersion, fixtureCount: fixtures.length, fixtures: fixtures.map(({ id, locator, bytes, sha256, expected }) => ({ id, locator, bytes, sha256, expected })) },
			scenarioManifest: { model: modelMatrix, boot: bootMatrix, diagnostic: options.suite === 'diagnostic' || options.suite === 'all' ? { appIds: options.apps.map((app) => app.id), supportedRuntimeCapturesPerApp: SUPPORTED_IDS, controls: ['S2-jcm-native', 'S2-jcm-wrapped'], workerDiagnostic: 'Editor/L-old-wrapped', roomsFrameTrace: 'Rooms/Y-old-wrapped', excludedFromTiming: true } : null },
			measurement: {
				deadlineMs: DEADLINE_MS, modelViewport: { width: 1440, height: 900, devicePixelRatio: 1 },
				modelConditions: ['cold: new context + cache disabled', 'warm: one excluded full-load prime + same cache-enabled context'],
				bootConditions: ['cold: new context + cache disabled', 'warm: one excluded chooser prime + same cache-enabled context'],
				bootViewport: { desktop: { width: 1440, height: 900, devicePixelRatio: 1 }, mobile: { width: 390, height: 844, devicePixelRatio: 1 } },
				bootThrottle: { cpuRate: 4, downloadBitsPerSecond: 4_000_000, uploadBitsPerSecond: 1_000_000, latencyMs: 150 },
				expectedModelRows: modelMatrix?.expectedRowCount ?? null, expectedBootRows: bootMatrix?.expectedRowCount ?? null,
				excludedDiagnostic: 'All selected-app supported runtime-count captures, S2-jcm native/wrapped controls, Editor L-old worker diagnostic, and Rooms Y-old frame trace; excluded from timing percentiles.'
			}
		};
		await writeMetadata(path.join(outputDir, 'metadata.json'), metadata);
		let modelResult = null;
		let bootResult = null;
		let diagnosticResult = null;
		if (modelMatrix) {
			modelResult = await runModelSuite({ browser, apps: options.apps, fixtures, urls: options.urls, outputDir, baseline: options.baseline, builds, environment, workspaceRoot });
			if (!modelResult.matrixAudit.matrixComplete) throw new Error('Model scenario matrix is incomplete; no complete summary will be written.');
		}
		if (bootMatrix) {
			bootResult = await runBootSuite({ browser, apps: options.apps, urls: options.urls, outputDir, baseline: options.baseline, builds, environment });
			if (!bootResult.matrixAudit.matrixComplete) throw new Error('Boot scenario matrix is incomplete; no complete summary will be written.');
		}
		if (options.suite === 'diagnostic' || options.suite === 'all') {
			diagnosticResult = await runDiagnostic({ browser, apps: options.apps, fixtures, urls: options.urls, outputDir, baseline: options.baseline, builds, environment, workspaceRoot });
		}
		await withNodeWatchdog(() => browser.close(), 5_000, 'Browser shutdown');
		browser = null;
		const modelAcceptance = modelResult ? Boolean(modelResult.matrixAudit.matrixComplete && modelResult.allTimingSeriesPass && modelResult.allPrimeRowsPass && modelResult.allRejectionsPass) : null;
		const bootAcceptance = bootResult ? Boolean(bootResult.matrixAudit.matrixComplete && bootResult.allTimingSeriesPass && bootResult.allPrimeRowsPass) : null;
		const summary = {
			schemaVersion: 'bomc-loader-baseline-summary-v2', plan: PLAN, review: metadata.review, baseline: options.baseline, suite: options.suite,
			selectedAppIds: options.apps.map((app) => app.id), completedAt: new Date().toISOString(), model: modelResult, boot: bootResult, diagnostic: diagnosticResult,
			acceptance: {
				allModelRowsPass: modelAcceptance,
					allBootRowsPass: bootAcceptance,
					diagnosticWorkerMatched: diagnosticResult ? diagnosticResult.acceptance.lOldBoundedAndMatched : null,
					diagnosticAllControlsAndRuntimeCountsPass: diagnosticResult ? diagnosticResult.acceptance.pass : null,
				allPinnedFixturesReverifiedBeforeRun: true,
				selectedModelMatrixComplete: modelResult?.matrixAudit.matrixComplete ?? null,
				selectedBootMatrixComplete: bootResult?.matrixAudit.matrixComplete ?? null
			}
		};
		writeAtomicJson(path.join(outputDir, 'summary.json'), summary);
		writeRunState({ state: 'completed', completedAt: new Date().toISOString(), acceptance: summary.acceptance, expectedModelRows: modelMatrix?.expectedRowCount ?? null, actualModelRows: modelResult?.rowCount ?? null, expectedBootRows: bootMatrix?.expectedRowCount ?? null, actualBootRows: bootResult?.rowCount ?? null });
		return summary;
	} catch (error) {
		if (interruptedBy) writeRunState({ state: 'interrupted', interruptReason: interruptedBy, failure: error instanceof Error ? error.message : String(error) });
		else writeRunState({ state: 'failed', failedAt: new Date().toISOString(), failure: error instanceof Error ? error.stack ?? error.message : String(error) });
		throw error;
	} finally {
		if (browser) await withNodeWatchdog(() => browser.close(), 5_000, 'Browser shutdown after failure').catch((error) => {
			if (!interruptedBy) writeRunState({ state: 'failed', cleanupFailure: error instanceof Error ? error.message : String(error) });
		});
		process.off('SIGINT', onSigint);
		process.off('SIGTERM', onSigterm);
		activeRunState = null;
		activeRunStatePath = null;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runBaseline().then((summary) => {
		console.log(JSON.stringify({ summary: path.join(path.resolve(argValue(process.argv.slice(2), '--output', '.')), 'summary.json'), acceptance: summary.acceptance }, null, 2));
	}).catch((error) => {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error));
		process.exitCode ??= 1;
	});
}
