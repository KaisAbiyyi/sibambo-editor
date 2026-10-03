import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertFreshOutputDirectory, buildModelScenarioMatrix, workerTraceAudit } from './loader-baseline.mjs';
import {
	assertManifestSha256,
	buildBlockedWarmDispositions,
	buildIsolationJobs,
	buildIsolatedDiagnosticMatrix,
	classifyAttemptOutcome,
	evaluateCollectionCoverage,
	makeActualRow,
	normalizeChildMessage,
	readIsolationManifest,
	runtimeModuleHashes,
	summarizeIsolatedDiagnostics,
	summarizeIsolatedModel,
	superviseOwnedJob
} from './loader-baseline-isolated.mjs';

const tempDirs: string[] = [];
const harnessDir = mkdtempSync(path.join(os.tmpdir(), 'bomc-isolated-harness-'));
const supervisorUrl = new URL('./loader-baseline-isolated.mjs', import.meta.url).href;
const runnerUrl = new URL('./loader-baseline.mjs', import.meta.url).href;
const APP_IDS = ['editor', 'rooms', 'benchmark'];
const FIXTURE_IDS = ['L-old', 'Y-old', 'I-old', 'S2-jcm', 'S1-new', 'S2-new', 'I-new', 'Y-new'];

function ownedReceipt(jobId: string, resourceDisposition = 'graceful') {
	return {
		jobId,
		verified: true,
		resourceDisposition,
		...(resourceDisposition === 'forced-verified' ? { recoverySandbox: { verified: true } } : {}),
		remainingOwnedProcesses: []
	};
}

function matrixRow(matrix: any, scenario: any, rowId: string, jobId: string, options: Record<string, unknown> = {}) {
	const prime = rowId === scenario.primeRowId;
	const defaultStatus = scenario.kind === 'expected-rejection' ? 'expected-rejection' : prime ? 'prime-excluded' : 'ready';
	const outcomeStatus = (options.outcomeStatus as string | undefined) ?? (scenario.kind === 'expected-rejection' ? 'error' : 'ready');
	return {
		id: rowId,
		scenarioRowId: rowId,
		scenarioId: scenario.id,
		jobId,
		baseline: matrix.baseline,
		kind: scenario.kind === 'expected-rejection' ? 'model' : 'model',
		app: scenario.appId,
		fixtureId: scenario.fixtureId,
		mode: scenario.mode,
		prime,
		openOccurred: true,
		startedAtEpochMs: 1_790_000_000_000 + rowId.length,
		elapsedMs: 100,
		outcomeStatus,
		status: defaultStatus,
		firstValidFrame: scenario.kind === 'expected-rejection' || outcomeStatus !== 'ready' ? null : { method: 'connected-positive-webgl-draw' },
		cleanupStatus: 'complete',
		cleanupErrors: [],
		harnessStatus: 'ok',
		observationIntegrity: 'valid',
		identityAudit: { valid: true },
		ownershipReceipt: ownedReceipt(jobId),
		rejectionMessageMatchesB0: scenario.kind === 'expected-rejection' ? true : undefined,
		...options
	};
}

function makeB0CoverageFixture() {
	const matrix = buildModelScenarioMatrix('B0', APP_IDS, FIXTURE_IDS);
	const jobs = buildIsolationJobs(matrix);
	const jobByAttempt = new Map<string, any>();
	for (const job of jobs) for (const id of job.attemptIds) jobByAttempt.set(id, job);
	const actualRows: any[] = [];
	const dispositions: any[] = [];
	for (const scenario of matrix.scenarios) {
		const job = jobByAttempt.get(scenario.primeRowId || scenario.attemptRowIds[0]);
		if (scenario.kind === 'expected-rejection') {
			actualRows.push(matrixRow(matrix, scenario, scenario.attemptRowIds[0], job.id));
		} else if (scenario.mode === 'cold') {
			for (const id of scenario.attemptRowIds) {
				const attemptJob = jobByAttempt.get(id);
				actualRows.push(matrixRow(matrix, scenario, id, attemptJob.id));
			}
		} else {
			actualRows.push(matrixRow(matrix, scenario, scenario.primeRowId, job.id, { status: 'timeout', outcomeStatus: 'timeout', elapsedMs: 120_000 }));
			dispositions.push(...buildBlockedWarmDispositions(job, 'blocked-prime-failed', scenario.primeRowId, ownedReceipt(job.id)));
		}
	}
	return { matrix, jobs, actualRows, dispositions, receipts: jobs.map((job) => ownedReceipt(job.id)) };
}

function makeStrictCollection(baseline: 'B1' | 'P1') {
	const matrix = buildModelScenarioMatrix(baseline, APP_IDS, FIXTURE_IDS);
	const jobs = buildIsolationJobs(matrix);
	const jobByAttempt = new Map<string, any>();
	for (const job of jobs) for (const id of job.attemptIds) jobByAttempt.set(id, job);
	const scenariosByRow = new Map<string, any>();
	for (const scenario of matrix.scenarios) for (const id of [...(scenario.primeRowId ? [scenario.primeRowId] : []), ...scenario.attemptRowIds]) scenariosByRow.set(id, scenario);
	const actualRows = matrix.expectedRowIds.map((id, index) => {
		const scenario = scenariosByRow.get(id);
		const job = jobByAttempt.get(id);
		return matrixRow(matrix, scenario, id, job.id, { elapsedMs: 80 + index % 100, startedAtEpochMs: 1_790_000_000_000 + index, status: id === scenario.primeRowId ? 'prime-excluded' : 'ready', outcomeStatus: 'ready' });
	});
	return { matrix, jobs, actualRows, receipts: jobs.map((job) => ownedReceipt(job.id)) };
}

function tempDir(prefix: string) {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeCustomChild(source: string) {
	const dir = tempDir('bomc-isolated-custom-child-');
	const file = path.join(dir, 'test-child.mjs');
	writeFileSync(file, source, 'utf8');
	return file;
}

async function testPage() {
	return 'data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>owned-harness-test</title><main>ready</main>');
}

function writeChildEntry() {
	const file = path.join(harnessDir, 'test-child.mjs');
	const playwrightUrl = import.meta.resolve('@playwright/test');
	const lines = [
		'import playwright from ' + JSON.stringify(playwrightUrl) + '; const { chromium } = playwright;',
		"let seq = 0; let active = null; const waiters = new Map();",
		"const send = (type, payload = {}, attemptId = null) => { const message = { protocol: 'bomc-isolation-ipc-v1', runToken: active.runToken, jobToken: active.jobToken, attemptId, seq: ++seq, type, payload }; process.send(message); return message.seq; };",
		"const sendWait = async (type, payload, attemptId = null) => { const acknowledgedSeq = send(type, payload, attemptId); return new Promise((resolve) => waiters.set(acknowledgedSeq, resolve)); };",
		"process.on('message', (message) => {",
		"  if (message?.type === 'ack') { const resolve = waiters.get(message.ackSeq); if (resolve) { waiters.delete(message.ackSeq); resolve(message.decision); } return; }",
		"  if (message?.type === 'job' && !active) { active = message; void run(message).catch((error) => { try { send('fatal-error', { message: String(error) }); } catch {} }); }",
		"});",
		"setInterval(() => { if (active) send('heartbeat', { epochMs: Date.now() }); }, 100).unref();",
		"async function run(message) {",
		"  const { wsEndpoint, job, run: config } = message.payload;",
		"  const browser = await chromium.connect(wsEndpoint, { timeout: 5000 });",
		"  send('connected', { testChild: true });",
		"  send('environment-before', { environment: { testEnvironment: 'stable' } });",
		"  const attemptId = job.id;",
		"  const decision = await sendWait('attempt-entered', { attemptId, appId: 'editor', fixtureId: 'S2-jcm', mode: 'cold' }, attemptId);",
		"  if (decision === 'stop') return;",
		"  const openEpochMs = Date.now();",
		"  send('open', { perfMs: 1, epochMs: openEpochMs, openAction: 'test page evaluate' }, attemptId);",
		"  if (config.behavior === 'node-hang') { while (true) {} }",
		"  const context = await browser.newContext();",
		"  const page = await context.newPage();",
		"  await page.goto(config.url);",
		"  if (config.behavior === 'renderer-hang') await page.evaluate(() => { while (true) {} });",
		"  const observedAtEpochMs = Date.now();",
		"  send('app-outcome', { kind: 'ready', text: 'ready', elapsedMs: Math.max(0, observedAtEpochMs - openEpochMs), observedAtEpochMs }, attemptId);",
		"  send('evidence', { status: 'ready', openOccurred: true, startedAtEpochMs: openEpochMs, elapsedMs: Math.max(0, observedAtEpochMs - openEpochMs), firstValidFrame: { method: 'test-draw' }, cleanupErrors: [] }, attemptId);",
		"  send('cleanup-start', {}, attemptId);",
		"  await page.close(); await context.close();",
		"  const row = { id: attemptId, scenarioRowId: attemptId, app: 'editor', fixtureId: 'S2-jcm', mode: 'cold', openOccurred: true, startedAtEpochMs: openEpochMs, elapsedMs: Math.max(0, observedAtEpochMs - openEpochMs), firstValidFrame: { method: 'test-draw' }, status: 'ready', cleanupStatus: 'complete', cleanupErrors: [] };",
		"  const resultDecision = await sendWait('attempt-result', { row }, attemptId);",
		"  if (resultDecision === 'stop') return;",
		"  send('environment-after', { environment: { testEnvironment: 'stable' } });",
		"  const terminalDecision = await sendWait('job-terminal', { status: 'ok' });",
		"  if (terminalDecision !== 'stop') { await browser.close(); if (process.connected) process.disconnect(); }",
		"}"
	];
	writeFileSync(file, lines.join('\n'), 'utf8');
	return file;
}

const childEntry = writeChildEntry();

const shortBudgets = {
	launchMs: 10_000,
	connectMs: 5_000,
	attemptOpenMs: 5_000,
	openOutcomeMs: 700,
	outcomeEvidenceMs: 2_000,
	evidenceResultMs: 2_000,
	jobTerminalMs: 5_000,
	heartbeatIntervalMs: 100,
	heartbeatMaxGapMs: 500,
	gracefulChildExitMs: 800,
	childStopWaitMs: 300,
	terminationMs: 5_000,
	resourceVerificationMs: 5_000
};

function supervisorArgs(url: string, behavior: string, id = 'editor-S2-jcm-cold-01', overrides: Record<string, unknown> = {}) {
	return {
		args: {
			job: { id, kind: 'cold', appId: 'editor', fixtureId: 'S2-jcm', mode: 'cold' },
			run: { testMode: true, url, behavior },
			budgets: { ...shortBudgets, ...overrides },
			childEntry,
			processOps: undefined
		}
	};
}

function nodeProbe(source: string, timeoutMs = 120_000) {
	const script = 'import { matchOwnedRootIdentity, superviseOwnedJob, normalizeChildMessage, makeActualRow } from ' + JSON.stringify(supervisorUrl) + ';\n' +
		'import { summarizeIsolatedDiagnostics } from ' + JSON.stringify(supervisorUrl) + ';\n' +
		'import { makeWorkerDiagnosticProbe, makeWorkerNativeControlProbe, installDiagnosticConsoleStream, BROWSER_LAUNCH_ARGS } from ' + JSON.stringify(runnerUrl) + ';\n' + source;
	const result = spawnSync('node', ['--input-type=module', '-e', script], { cwd: path.resolve(import.meta.dir, '../..'), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || 'Supervisor probe exited ' + String(result.status) + '.');
	return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) || 'null');
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => rmSync(harnessDir, { recursive: true, force: true }));

describe('isolated process ownership', () => {
	test('kills an owned stalled renderer before starting the next sandbox', async () => {
		const url = await testPage();
		const first = JSON.stringify(supervisorArgs(url, 'renderer-hang', 'editor-S2-jcm-cold-01').args);
		const second = JSON.stringify(supervisorArgs(url, 'healthy', 'editor-S2-jcm-cold-02', { openOutcomeMs: 5_000 }).args);
		const result = nodeProbe('const run = async (args) => { args.persist = async () => {}; return superviseOwnedJob(args); }; const firstResult = await run(' + first + '); const secondResult = await run(' + second + '); console.log(JSON.stringify({ firstResult, secondResult }));');
		const firstResult = result.firstResult;
		const secondResult = result.secondResult;
		expect(firstResult.rows[0].outcomeStatus).toBe('timeout');
		expect(firstResult.rows[0].elapsedMs).toBe(700);
		expect(firstResult.ownershipReceipt.verified).toBe(true);
		expect(firstResult.ownershipReceipt.remainingOwnedProcesses).toEqual([]);
		if (secondResult.rows[0]?.outcomeStatus !== 'ready') throw new Error(JSON.stringify({
			row: secondResult.rows[0],
			failure: secondResult.failure,
			stderrTail: secondResult.ownershipReceipt.stderrTail,
			events: secondResult.events.map((event: any) => ({ type: event.type, attemptId: event.attemptId, payload: event.payload }))
		}));
		expect(secondResult.rows[0].outcomeStatus).toBe('ready');
		expect(secondResult.ownershipReceipt.verified).toBe(true);
		expect(firstResult.ownershipReceipt.completedAtEpochMs).toBeLessThanOrEqual(secondResult.ownershipReceipt.startedAtEpochMs);
	}, 120_000);

	test('treats a child heartbeat stall as observer failure, not a synthetic timeout', async () => {
		const url = await testPage();
		const args = JSON.stringify(supervisorArgs(url, 'node-hang', 'editor-S2-jcm-cold-01', { heartbeatMaxGapMs: 500, openOutcomeMs: 5_000 }).args);
		const result = nodeProbe('const args = ' + args + '; args.persist = async () => {}; const result = await superviseOwnedJob(args); console.log(JSON.stringify(result));');
		if (!result.rows?.length) throw new Error(JSON.stringify(result));
		expect(result.rows[0].openOccurred).toBe(true);
		expect(result.rows[0].elapsedMs).toBeNull();
		expect(result.rows[0].harnessStatus).toBe('observer-error');
		expect(result.rows[0].observationIntegrity).toBe('observer-unavailable');
		expect(result.ownershipReceipt.verified).toBe(true);
	}, 60_000);

	test('reclaims only the failed sandbox while a sentinel process and browser stay live', async () => {
		const url = await testPage();
		const args = JSON.stringify(supervisorArgs(url, 'renderer-hang', 'editor-S2-jcm-cold-01').args);
		const source = [
			"import { spawn } from 'node:child_process';",
			"import { chromium } from '@playwright/test';",
			"const args = " + args + "; args.persist = async () => {};",
			"const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
			"const sentinelServer = await chromium.launchServer({ headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader'], host: '127.0.0.1', port: 0, timeout: 10000 });",
			"const sentinelBrowser = await chromium.connect(sentinelServer.wsEndpoint());",
			"const page = await sentinelBrowser.newPage(); await page.goto(args.run.url);",
			"const beforePid = sentinelServer.process().pid;",
			"const result = await superviseOwnedJob(args);",
			"const sentinelAlive = sentinel.exitCode === null && sentinel.signalCode === null;",
			"const serverAlive = sentinelServer.process().exitCode === null && sentinelServer.process().signalCode === null;",
			"const title = await page.title();",
			"await page.close(); await sentinelBrowser.close(); await sentinelServer.close(); sentinel.kill();",
			"console.log(JSON.stringify({ result, beforePid, sentinelAlive, serverAlive, title }));"
		].join('\n');
		const probe = nodeProbe(source);
		const result = probe.result;
		expect(result.ownershipReceipt.verified).toBe(true);
		expect(probe.sentinelAlive).toBe(true);
		expect(probe.serverAlive).toBe(true);
		expect(probe.title).toBe('owned-harness-test');
		expect(result.ownershipReceipt.killedRootPids).not.toContain(probe.beforePid);
	}, 60_000);

	test('refuses stale, foreign, mismatched, or ambiguous process identities', () => {
		const expected = { pid: 81, creationUtc: '2026-10-03T09:00:00.0000000Z', executable: 'C:/Program Files/Chromium/chrome.exe', parentPid: 22, profilePath: 'C:/Temp/pw-profile-81' };
		const exact = { querySucceeded: true, root: { pid: 81, ppid: 22, creationUtc: expected.creationUtc, executable: expected.executable, commandLine: '"C:/Program Files/Chromium/chrome.exe" --user-data-dir=C:/Temp/pw-profile-81' }, rootIdentityMatches: true, descendants: [], profileMatches: [] };
		const cases = [
			{ ...expected, creationUtc: '2026-10-03T09:00:01.0000000Z' },
			{ ...expected, executable: 'C:/Program Files/Other/chrome.exe' },
			{ ...expected, parentPid: 23 },
			{ ...expected, profilePath: 'C:/Temp/pw-profile-810' }
		];
		const result = nodeProbe('const expected = ' + JSON.stringify(expected) + '; const exact = ' + JSON.stringify(exact) + '; const cases = ' + JSON.stringify(cases) + '; console.log(JSON.stringify({ exact: matchOwnedRootIdentity(exact, expected), changed: cases.map((item) => matchOwnedRootIdentity(exact, item)), unavailable: matchOwnedRootIdentity({ ...exact, querySucceeded: false }, expected), absent: matchOwnedRootIdentity({ ...exact, root: null }, expected) }));');
		expect(result.exact).toBe(true);
		expect(result.changed).toEqual([false, false, false, false]);
		expect(result.unavailable).toBe(false);
		expect(result.absent).toBe(false);
	});

	test('keeps run failed and prevents continuation when owned-tree reclamation cannot be verified', async () => {
		const url = await testPage();
		const args = JSON.stringify(supervisorArgs(url, 'renderer-hang', 'editor-S2-jcm-cold-01').args);
		const source = [
			"import { execFile } from 'node:child_process';",
			"const args = " + args + "; args.persist = async () => {};",
			"args.processOps = { killOwnedTree: async ({ identity }) => await new Promise((resolve) => { const taskkill = (process.env.SystemRoot || 'C:/Windows') + '/System32/taskkill.exe'; execFile(taskkill, ['/PID', String(identity.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, shell: false }, () => resolve({ command: 'taskkill.exe', exitCode: 1, error: 'injected failure after owned cleanup' })); }) };",
			"const result = await superviseOwnedJob(args); console.log(JSON.stringify(result));"
		].join('\n');
		const result = nodeProbe(source);
		if (result.collectionEligible) throw new Error(JSON.stringify({ receipt: result.ownershipReceipt, rows: result.rows, failure: result.failure }));
		expect(result.collectionEligible).toBe(false);
		expect(result.ownershipReceipt.verified).toBe(false);
		expect(result.ownershipReceipt.error).toContain('injected failure after owned cleanup');
		expect(result.rows[0].harnessStatus).toBe('cleanup-failed');
		expect(result.nextJobAuthorized).toBe(false);
	}, 60_000);

	test('retains interrupted observations and stops after a durable-write failure', async () => {
		const url = await testPage();
		const interruptedArgs = JSON.stringify(supervisorArgs(url, 'renderer-hang', 'editor-S2-jcm-cold-01').args);
		const writerFailureArgs = JSON.stringify(supervisorArgs(url, 'healthy', 'editor-S2-jcm-cold-01').args);
		const source = [
			'const interruptedArgs = ' + interruptedArgs + ';',
			'let interrupt = false; const interruptedRecords = []; interruptedArgs.run.isInterrupted = () => interrupt;',
			'interruptedArgs.persist = async (record) => { interruptedRecords.push(record); if (record.recordType === "attempt-journal" && record.type === "open") interrupt = true; };',
			'const interrupted = await superviseOwnedJob(interruptedArgs);',
			'const secondJobWouldStartAfterInterrupt = !interrupted.failure && interrupted.nextJobAuthorized;',
			'const writerFailureArgs = ' + writerFailureArgs + ';',
			'let writeFailed = false; const writerRecords = []; writerFailureArgs.persist = async (record) => { if (!writeFailed && record.recordType === "attempt-journal" && record.type === "app-outcome") { writeFailed = true; throw new Error("injected durable journal failure"); } writerRecords.push(record); };',
			'const writerFailure = await superviseOwnedJob(writerFailureArgs);',
			'const secondJobWouldStartAfterWriteFailure = !writerFailure.failure && writerFailure.nextJobAuthorized;',
			'console.log(JSON.stringify({ interrupted, interruptedRecords, secondJobWouldStartAfterInterrupt, writerFailure, writerRecords, secondJobWouldStartAfterWriteFailure }));'
		].join('\n');
		const result = nodeProbe(source, 120_000);
		expect(result.interrupted.failure?.phase).toBe('interrupt');
		expect(result.interrupted.ownershipReceipt.verified).toBe(true);
		expect(result.interrupted.rows[0].openOccurred).toBe(true);
		expect(result.interrupted.rows[0].elapsedMs).toBeNull();
		expect(result.interruptedRecords.some((record: any) => record.recordType === 'attempt-journal' && record.type === 'open')).toBe(true);
		expect(result.interruptedRecords.some((record: any) => record.recordType === 'actual-row-finalized')).toBe(true);
		expect(result.secondJobWouldStartAfterInterrupt).toBe(false);
		expect(result.writerFailure.failure?.kind).toBe('protocol-error');
		expect(result.writerFailure.rows[0].openOccurred).toBe(true);
		expect(result.writerFailure.failure).not.toBeNull();
		expect(result.writerRecords.some((record: any) => record.recordType === 'attempt-journal' && record.type === 'open')).toBe(true);
		expect(result.secondJobWouldStartAfterWriteFailure).toBe(false);
	}, 120_000);
});

describe('isolated collection contracts', () => {
	test('blocked prime is a disposition, never an attempt or timing sample', () => {
		const matrix = buildModelScenarioMatrix('B0', APP_IDS, FIXTURE_IDS);
		const scenario = matrix.scenarios.find((item: any) => item.id === 'editor-L-old-warm');
		const job = buildIsolationJobs(matrix).find((item: any) => item.id === scenario.id);
		const prime = matrixRow(matrix, scenario, scenario.primeRowId, job.id, { status: 'timeout', outcomeStatus: 'timeout', elapsedMs: 120_000 });
		const receipt = ownedReceipt(job.id);
		const dispositions = buildBlockedWarmDispositions(job, 'blocked-prime-failed', scenario.primeRowId, receipt);
		const summary = summarizeIsolatedModel(matrix, [prime], dispositions).summaries[scenario.id];
		expect(dispositions).toHaveLength(10);
		expect(dispositions.every((row: any) => row.recordType === 'disposition' && row.openOccurred === false && row.startedAtEpochMs === null && row.elapsedMs === null && row.firstValidFrame === null && row.excludedFromTiming)).toBe(true);
		expect(dispositions.map((row: any) => row.scenarioRowId)).toEqual(scenario.attemptRowIds);
		expect(summary.blockedRowIds).toEqual(scenario.attemptRowIds);
		expect(summary.completedRowCount).toBe(0);
		expect(summary.p50Ms).toBeNull();
		expect(summary.p95Ms).toBeNull();
		expect([prime].map((row: any) => row.scenarioRowId)).not.toContain(scenario.attemptRowIds[0]);
	});

	test('keeps a lost warm context closed without reprime and authorizes only after recovery proof', async () => {
		const source = `
import playwright from ${JSON.stringify(import.meta.resolve('@playwright/test'))};
const { chromium } = playwright;
let active = null; let seq = 0; const waiters = new Map(); let browser = null; let context = null;
const send = (type, payload = {}, attemptId = null) => {
	const message = { protocol: 'bomc-isolation-ipc-v1', runToken: active.runToken, jobToken: active.jobToken, attemptId, seq: ++seq, type, payload };
	process.send(message, (error) => { if (error) process.exitCode = 91; }); return message.seq;
};
const waitAck = (ackSeq) => new Promise((resolve) => waiters.set(ackSeq, resolve));
const sendWait = async (type, payload = {}, attemptId = null) => { const ackSeq = send(type, payload, attemptId); return waitAck(ackSeq); };
const enter = async (job, id, prime, contextId) => {
	const decision = await sendWait('attempt-entered', { attemptId: id, appId: job.appId, fixtureId: job.fixtureId, mode: prime ? 'warm-prime' : 'warm', prime, contextId }, id);
	if (decision !== 'continue') throw new Error('parent stopped warm test child');
};
const heartbeat = setInterval(() => { if (active && process.connected) send('heartbeat', { epochMs: Date.now() }); }, 100); heartbeat.unref();
process.on('message', (message) => {
	if (message?.type === 'ack' && message.protocol === 'bomc-isolation-ipc-v1' && message.runToken === active?.runToken && message.jobToken === active?.jobToken) { const resolve = waiters.get(message.acknowledgedSeq); if (resolve) { waiters.delete(message.acknowledgedSeq); resolve(message.decision); } return; }
	if (message?.type === 'stop') { try { void context?.close().catch(() => {}); void browser?.close().catch(() => {}); } catch {} return; }
	if (message?.type !== 'job' || active) return;
	active = message;
	void (async () => {
		const { wsEndpoint, job, run } = message.payload;
		browser = await chromium.connect(wsEndpoint, { timeout: 5000 });
		send('connected', { childPid: process.pid });
		send('environment-before', { environment: run.expectedEnvironment });
		if (job.kind === 'environment-recovery') {
			send('environment-after', { environment: run.expectedEnvironment });
			await sendWait('job-terminal', { status: 'ok', afterEnvironment: run.expectedEnvironment, afterEnvironmentStatus: 'available', recoveryOnly: true });
			await browser.close(); process.disconnect(); return;
		}
		const contextId = 'one-warm-context';
		context = await browser.newContext();
		const primeId = job.primeRowId;
		await enter(job, primeId, true, contextId);
		let page = await context.newPage(); await page.goto('data:text/html,<title>warm-prime</title>');
		const primeEpoch = Date.now();
		send('open', { perfMs: 1, epochMs: primeEpoch, openAction: 'synthetic warm prime' }, primeId);
		send('app-outcome', { kind: 'ready', text: 'ready', elapsedMs: 10, observedAtEpochMs: primeEpoch + 10 }, primeId);
		send('evidence', { status: 'ready', firstValidFrame: { method: 'test-connected-draw' }, cleanupErrors: [], contextId }, primeId);
		send('cleanup-start', {}, primeId); await page.close();
		const primeRow = { id: primeId, scenarioRowId: primeId, app: job.appId, fixtureId: job.fixtureId, mode: 'warm', prime: true, openOccurred: true, startedAtEpochMs: primeEpoch, elapsedMs: 10, outcomeStatus: 'ready', status: 'prime-excluded', firstValidFrame: { method: 'test-connected-draw' }, cleanupStatus: 'complete', cleanupErrors: [] };
		if (await sendWait('attempt-result', { row: primeRow }, primeId) !== 'continue') throw new Error('prime result was not continued');
		const measuredId = job.attemptRowIds[0];
		await enter(job, measuredId, false, contextId);
		page = await context.newPage(); await page.goto('data:text/html,<title>warm-measured-hang</title>');
		const measuredEpoch = Date.now();
		send('open', { perfMs: 2, epochMs: measuredEpoch, openAction: 'synthetic measured warm open' }, measuredId);
		await page.evaluate(() => { while (true) {} });
	})().catch((error) => { try { send('fatal-error', { message: String(error) }); } catch {} });
});
`;
		const child = writeCustomChild(source);
		const url = await testPage();
		const env = { browser: 'test-chromium', nodeVersion: process.version, webglAdapter: { available: true, renderer: 'SwiftShader test' } };
		const measuredIds = Array.from({ length: 10 }, (_, index) => `editor-L-old-warm-${String(index + 1).padStart(2, '0')}`);
		const supervisorInput = {
			job: { id: 'editor-L-old-warm', kind: 'warm', appId: 'editor', fixtureId: 'L-old', mode: 'warm', primeRowId: 'editor-L-old-warm-prime', attemptRowIds: measuredIds },
			run: { testMode: true, url, cwd: process.cwd(), expectedEnvironment: env },
			budgets: { ...shortBudgets, openOutcomeMs: 700, connectMs: 5000 },
			childEntry: child
		};
		const result = nodeProbe('const args = ' + JSON.stringify(supervisorInput) + '; args.persist = async () => {}; const result = await superviseOwnedJob(args); console.log(JSON.stringify(result));', 120_000);
		if (result.rows[1]?.harnessStatus !== 'cleanup-recovered') throw new Error(JSON.stringify({ rows: result.rows, failure: result.failure, receipt: result.ownershipReceipt, dispositions: result.dispositions, eventTypes: result.events.map((event: any) => ({ type: event.type, attemptId: event.attemptId, payload: event.payload })) }));
		expect(result.rows).toHaveLength(2);
		expect(result.rows[0].scenarioRowId).toBe('editor-L-old-warm-prime');
		expect(result.rows[0].outcomeStatus).toBe('ready');
		expect(result.rows[1].scenarioRowId).toBe(measuredIds[0]);
		expect(result.rows[1].outcomeStatus).toBe('timeout');
		expect(result.rows[1].harnessStatus).toBe('cleanup-recovered');
		expect(result.rows[1].cleanupStatus).not.toBe('complete');
		expect(result.rows[1].identityAudit.valid).toBe(true);
		expect(result.ownershipReceipt.resourceDisposition).toBe('forced-verified');
		expect(result.ownershipReceipt.recoverySandbox.verified).toBe(true);
		expect(result.dispositions.map((row: any) => row.scenarioRowId)).toEqual(measuredIds.slice(1));
		expect(result.dispositions.every((row: any) => row.reason === 'blocked-warm-context-lost' && row.blockedByRowId === measuredIds[0])).toBe(true);
		expect(result.nextJobAuthorized).toBe(true);
		expect(result.failure).toBeNull();
		const lateFatal = result.events.find((event: any) => event.type === 'fatal-error');
		expect(lateFatal?.lateAfterDeadline).toBe(true);
		const entered = result.events.filter((event: any) => event.type === 'attempt-entered');
		expect(entered.map((event: any) => event.payload.attemptId)).toEqual(['editor-L-old-warm-prime', measuredIds[0]]);
		expect(entered.map((event: any) => event.payload.contextId)).toEqual(['one-warm-context', 'one-warm-context']);
	}, 120_000);

	test('separates B0 coverage evidence from loader success and keeps B1/P1 strict', () => {
		const b0 = makeB0CoverageFixture();
		const good = evaluateCollectionCoverage(b0.matrix, b0.actualRows, b0.dispositions, b0.receipts);
		expect(b0.actualRows).toHaveLength(144);
		expect(b0.dispositions).toHaveLength(120);
		expect(good.coverageComplete).toBe(true);
		expect(good.collectionEvidencePass).toBe(true);
		expect(good.actualAttemptMatrixComplete).toBe(false);
		expect(good.modelPass).toBe(false);
		expect(good.actualAttemptCount).toBe(144);
		expect(good.blockedWarmCount).toBe(120);

		const duplicate = evaluateCollectionCoverage(b0.matrix, [...b0.actualRows, b0.actualRows[0]], b0.dispositions, b0.receipts);
		expect(duplicate.coverageComplete).toBe(false);
		expect(duplicate.collectionEvidencePass).toBe(false);

		const blocked = b0.dispositions[0];
		const scenario = b0.matrix.scenarios.find((item: any) => item.attemptRowIds.includes(blocked.scenarioRowId));
		const overlapRow = matrixRow(b0.matrix, scenario, blocked.scenarioRowId, scenario.id);
		const overlap = evaluateCollectionCoverage(b0.matrix, [...b0.actualRows, overlapRow], b0.dispositions, b0.receipts);
		expect(overlap.coverageComplete).toBe(false);
		expect(overlap.coverageAudit.duplicateIds).toContain(blocked.scenarioRowId);

		const wrongCause = b0.dispositions.map((row: any, index: number) => index === 0 ? { ...row, blockedByRowId: 'rooms-Y-old-warm-prime' } : row);
		expect(evaluateCollectionCoverage(b0.matrix, b0.actualRows, wrongCause, b0.receipts).collectionEvidencePass).toBe(false);
		expect(evaluateCollectionCoverage(b0.matrix, b0.actualRows, b0.dispositions.slice(1), b0.receipts).coverageComplete).toBe(false);
		const badRejectionRows = b0.actualRows.map((row: any) => row.status === 'expected-rejection' ? { ...row, rejectionMessageMatchesB0: false } : row);
		expect(evaluateCollectionCoverage(b0.matrix, badRejectionRows, b0.dispositions, b0.receipts).collectionEvidencePass).toBe(false);

		for (const baseline of ['B1', 'P1'] as const) {
			const strict = makeStrictCollection(baseline);
			const strictPass = evaluateCollectionCoverage(strict.matrix, strict.actualRows, [], strict.receipts);
			expect(strict.matrix.expectedRowCount).toBe(504);
			expect(strict.actualRows).toHaveLength(504);
			expect(strictPass.actualAttemptMatrixComplete).toBe(true);
			expect(strictPass.collectionEvidencePass).toBe(true);
			expect(strictPass.modelPass).toBe(true);
			const warm = strict.matrix.scenarios.find((item: any) => item.mode === 'warm');
			const missingId = warm.attemptRowIds[0];
			const disposition = { recordType: 'disposition', id: missingId, scenarioRowId: missingId, jobId: warm.id, mode: 'warm', openOccurred: false, startedAtEpochMs: null, elapsedMs: null, firstValidFrame: null, excludedFromTiming: true, reason: 'blocked-prime-failed', blockedByRowId: warm.primeRowId, ownershipReceipt: ownedReceipt(warm.id) };
			const withDisposition = evaluateCollectionCoverage(strict.matrix, strict.actualRows.filter((row: any) => row.scenarioRowId !== missingId), [disposition], strict.receipts);
			expect(withDisposition.coverageComplete).toBe(true);
			expect(withDisposition.actualAttemptMatrixComplete).toBe(false);
			expect(withDisposition.collectionEvidencePass).toBe(false);
			expect(withDisposition.modelPass).toBe(false);
		}
	});

	test('classifies setup, late delivery, missing frame, cleanup failure, and foreign IPC correctly', () => {
		expect(classifyAttemptOutcome(null, { kind: 'setup-error', text: 'chooser failed' })).toEqual({ outcomeStatus: 'setup-error', elapsedMs: null, actualObservedElapsedMs: null, censoredAtDeadline: false, lateOutcome: null, observationIntegrity: 'valid' });
		const late = classifyAttemptOutcome({ perfMs: 10, epochMs: 1_000 }, { kind: 'ready', text: 'ready', observedAtEpochMs: 122_001 }, 120_000);
		expect(late.outcomeStatus).toBe('timeout');
		expect(late.elapsedMs).toBe(120_000);
		expect(late.actualObservedElapsedMs).toBe(121_001);
		expect(late.lateOutcome?.kind).toBe('ready');
		const row = makeActualRow(
			{ id: 'editor-L-old-cold-01', kind: 'cold', appId: 'editor', fixtureId: 'L-old', mode: 'cold' },
			{
				attemptId: 'editor-L-old-cold-01',
				open: { perfMs: 10, epochMs: 1_000, openAction: 'Open' },
				appOutcome: { kind: 'ready', observedAtEpochMs: 1_100 },
				outcomeStatus: 'ready', elapsedMs: 100, observationIntegrity: 'valid',
				evidence: { status: 'ready', firstValidFrame: null, cleanupStatus: 'failed', cleanupErrors: ['page close failed'] },
				result: { row: { status: 'harness-error-cleanup', cleanupStatus: 'failed', cleanupErrors: ['page close failed'], firstValidFrame: null } }
			},
			ownedReceipt('editor-L-old-cold-01')
		);
		expect(row.outcomeStatus).toBe('failed-no-valid-frame');
		expect(row.status).toBe('harness-error-cleanup');
		expect(row.cleanupStatus).toBe('failed');
		expect(row.cleanupErrors).toEqual(['page close failed']);
		expect(row.harnessStatus).toBe('cleanup-failed');
		const expected = { runToken: 'run', jobToken: 'job', nextSequence: 1 };
		const message = { protocol: 'bomc-isolation-ipc-v1', runToken: 'run', jobToken: 'job', attemptId: null, seq: 1, type: 'heartbeat', payload: {} };
		normalizeChildMessage(message, expected);
		expect(() => normalizeChildMessage(message, expected)).toThrow(/out of order/);
		expect(() => normalizeChildMessage({ ...message, seq: 2, runToken: 'foreign' }, expected)).toThrow(/token mismatch/);
	});

	test('streams worker diagnostics while the page main thread is stalled and rejects invalid streams', async () => {
		const workerModuleSource = `await new Promise((resolve) => setTimeout(resolve, 300));
self.addEventListener('message', (event) => {
	if (event.data?.type === 'load') {
		event.ports[0]?.postMessage('port-ok');
		self.postMessage({ type: 'complete', id: event.data.id, result: { faces: [{ id: 1 }], preparedRuntimeScene: { groups: [{ id: 1 }] }, counts: { faces: 1 } } });
	}
});`;
		const source = `
import { EventEmitter } from 'node:events';
import playwright from ${JSON.stringify(import.meta.resolve('@playwright/test'))};
const { chromium } = playwright;
const { createServer } = await import('node:http');
const prefix = '__BOMC_DIAG_V3__';
const fakePage = new EventEmitter(); const wrongTokenEvents = [];
const wrongTokenState = installDiagnosticConsoleStream(fakePage, 'expected-token', (event) => wrongTokenEvents.push(event));
fakePage.emit('console', { text: () => prefix + JSON.stringify({ streamToken: 'foreign-token', workerId: '1', realm: 'worker', seq: 1, phase: 'worker-input', epochMs: 1 }) });
const overflowPage = new EventEmitter(); const overflowEvents = [];
const overflowState = installDiagnosticConsoleStream(overflowPage, 'expected-token', (event) => overflowEvents.push(event));
overflowPage.emit('console', { text: () => prefix + ' '.repeat(64 * 1024) });
const importSpec = { id: 'diagnostic-editor-S2-jcm-wrapped', appId: 'editor', fixtureId: 'S2-jcm', mode: 'wrapped', kind: 'diagnostic' };
const importToken = 'import-failure-token';
const importSummary = summarizeIsolatedDiagnostics([importSpec], [{
	id: importSpec.id, scenarioRowId: importSpec.id, app: 'editor', fixtureId: 'S2-jcm', mode: 'wrapped', diagnosticStreamToken: importToken,
	diagnosticStreamEvents: [
		{ streamToken: importToken, workerId: '1', realm: 'main', seq: 1, phase: 'wrapped-worker', url: 'http://127.0.0.1/e4-import.worker.js', epochMs: 1 },
		{ streamToken: importToken, workerId: '1', realm: 'worker', seq: 1, phase: 'worker-import-error', error: 'missing module', epochMs: 2 }
	], diagnosticStreamErrors: [], diagnosticErrors: [], openOccurred: true, startedAtEpochMs: 1, elapsedMs: 10, outcomeStatus: 'error', firstValidFrame: null,
	ownershipReceipt: { verified: true, resourceDisposition: 'graceful' }, identityAudit: { valid: true }, harnessStatus: 'ok'
}]);

const server = createServer((request, response) => {
	if (request.url === '/') {
		response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		response.end('<!doctype html><meta charset="utf-8"><title>diagnostic stream fixture</title>');
		return;
	}
	if (request.url === '/e4-import.worker.js') {
		response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
		response.end(${JSON.stringify(workerModuleSource)});
		return;
	}
	response.writeHead(404); response.end('missing');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); const url = 'http://127.0.0.1:' + address.port + '/';
const browser = await chromium.launch({ headless: true, args: BROWSER_LAUNCH_ARGS });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const token = 'stream-T10'; const events = [];
let evaluationSettled = false; const installedStreamTiming = [];
const streamState = installDiagnosticConsoleStream(page, token, (event) => { events.push(event); if (event.phase === 'worker-module-ready') installedStreamTiming.push(evaluationSettled); });
await page.addInitScript(makeWorkerDiagnosticProbe('diag'), { channel: 'diag', streamToken: token });
try {
	await page.goto(url, { waitUntil: 'domcontentloaded' });
	const evaluation = page.evaluate(async () => {
		const worker = new Worker('/e4-import.worker.js', { type: 'module' });
		const channel = new MessageChannel();
		const portReply = new Promise((resolve) => {
			channel.port2.addEventListener('message', (event) => resolve(event.data), { once: true });
			channel.port2.start();
		});
		const buffer = new ArrayBuffer(32);
		worker.postMessage({ type: 'load', id: 42, sourceName: 'diagnostic-input.bomc', buffer, port: channel.port1 }, [buffer, channel.port1]);
		worker.postMessage({ type: 'progress', id: 42, progress: { stage: 'queued-after-load', completed: 2, total: 2, unit: 'stage' } });
		const transferredByteLength = buffer.byteLength;
		const until = performance.now() + 1600;
		while (performance.now() < until) {}
		const portMessage = await Promise.race([portReply, new Promise((resolve) => setTimeout(() => resolve(null), 1500))]);
		return { transferredByteLength, portMessage };
	}).then((value) => { evaluationSettled = true; return value; });
	const early = await new Promise((resolve) => {
		const start = Date.now();
		const timer = setInterval(() => {
			const event = events.find((item) => item.phase === 'worker-module-ready' && item.realm === 'worker');
			if (event) { clearInterval(timer); resolve({ event, evaluationSettled, waitedMs: Date.now() - start }); }
			else if (Date.now() - start > 2200) { clearInterval(timer); resolve(null); }
		}, 10);
	});
	const pageResult = await evaluation;
	await new Promise((resolve) => setTimeout(resolve, 100));
	const phases = (phase) => events.filter((event) => event.phase === phase);
	const completePrePost = events.filter((event) => event.phase === 'worker-pre-post' && event.type === 'complete');
	const completePostReturn = events.filter((event) => event.phase === 'worker-post-return' && event.type === 'complete');
	const completeMainReceive = events.filter((event) => event.phase === 'main-receive' && event.type === 'complete');
	const input = phases('worker-input')[0] || null;
	const workerEvents = events.filter((event) => event.realm === 'worker');
	const imported = events.find((event) => event.phase === 'worker-module-ready' && event.realm === 'worker') || null;
	const queued = events.filter((event) => event.phase === 'worker-ingress-queued');
	const replayed = events.filter((event) => event.phase === 'worker-ingress-replayed');
	console.log(JSON.stringify({
		wrongTokenStateInvalid: wrongTokenState.invalid, wrongTokenEvents,
		overflowStateInvalid: overflowState.invalid, overflowEvents,
		importErrorRejected: importSummary.cases[0].acceptance.noWorkerImportError === false && importSummary.cases[0].acceptance.pass === false,
		installedStreamTiming,
		earlyWorkerModuleReady: Boolean(early),
		pageResult, streamInvalid: streamState.invalid, streamEventCount: streamState.eventCount,
		tokenAndIdentityValid: events.every((event) => event.streamToken === token && event.workerId && ['main', 'worker'].includes(event.realm) && Number.isInteger(event.seq)),
		input, imported, queued: queued.map((event) => event.queueLength), replayed: replayed.map((event) => ({ type: event.type, queueLength: event.queueLength })),
		workerIdentityStable: Boolean(imported && workerEvents.every((event) => event.workerId === imported.workerId)),
		progressStages: phases('worker-progress').map((event) => event.stage),
		completePrePostCount: completePrePost.length, completePostReturnCount: completePostReturn.length, completeMainReceiveCount: completeMainReceive.length,
		completeIds: [...completePrePost, ...completePostReturn, ...completeMainReceive].map((event) => event.id),
		completePhases: [...completePrePost, ...completePostReturn, ...completeMainReceive].map((event) => event.phase)
	}));
} finally {
	streamState.dispose(); await page.close().catch(() => {}); await browser.close().catch(() => {});
	await new Promise((resolve) => server.close(resolve));
}
`;
		const result = nodeProbe(source, 60_000);
		expect(result.wrongTokenStateInvalid).toBe(true);
		expect(result.wrongTokenEvents.some((event: any) => event.invalidDiagnostic && event.reason === 'invalid-token-or-event-shape')).toBe(true);
		expect(result.overflowStateInvalid).toBe(true);
		expect(result.overflowEvents.some((event: any) => event.invalidDiagnostic && event.reason === 'event-size-limit')).toBe(true);
		expect(result.importErrorRejected).toBe(true);
		expect(result.earlyWorkerModuleReady).toBe(true);
		expect(result.installedStreamTiming).toContain(false);
		expect(result.streamInvalid).toBe(false);
		expect(result.pageResult.transferredByteLength).toBe(0);
		expect(result.pageResult.portMessage).toBe('port-ok');
		expect(result.tokenAndIdentityValid).toBe(true);
		expect(result.input).toMatchObject({ phase: 'worker-input', id: 42, type: 'load', sourceName: 'diagnostic-input.bomc', byteLength: 32, realm: 'worker' });
		expect(result.imported.url).toMatch(/e4-import\.worker\.js/);
		expect(result.workerIdentityStable).toBe(true);
		expect(result.queued).toEqual([1, 2]);
		expect(result.replayed.map((event: any) => event.type)).toEqual(['load', 'progress']);
		expect(result.progressStages).toContain('queued-after-load');
		expect(result.completePrePostCount).toBe(1);
		expect(result.completePostReturnCount).toBe(1);
		expect(result.completeMainReceiveCount).toBe(1);
		expect(result.completeIds).toEqual([42, 42, 42]);
		expect(result.completePhases).toEqual(['worker-pre-post', 'worker-post-return', 'main-receive']);
	}, 60_000);

	test('locks manifest descriptors, rejects drift, preserves fresh outputs, and records aborted outcomes', async () => {
		const root = tempDir('bomc-isolated-manifest-');
		const fixtureDirectory = path.join(root, 'fixtures');
		const descriptors = FIXTURE_IDS.map((id) => {
			const fixtureBytes = Buffer.from('fixture-data:' + id, 'utf8');
			const locator = path.posix.join('fixtures', id + '.bomc');
			const file = path.join(root, locator);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, fixtureBytes);
			return { id, locator, bytes: fixtureBytes.byteLength, sha256: createHash('sha256').update(fixtureBytes).digest('hex'), expected: {} };
		});
		const fixturePath = path.join(root, 'tooling', 'performance', 'fixtures.json');
		mkdirSync(path.dirname(fixturePath), { recursive: true });
		const manifestOrder = ['S1-new', 'S2-new', 'I-new', 'Y-new', 'L-old', 'Y-old', 'I-old', 'S2-jcm'];
		const manifestDescriptors = manifestOrder.map((id) => descriptors.find((fixture) => fixture.id === id));
		const manifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 'bomc-loader-fixture-manifest-v1', plan: 'BOMC-LOADER-001/v1.0', fixtures: manifestDescriptors }, null, 2), 'utf8');
		writeFileSync(fixturePath, manifestBytes);
		const manifestInfo = await readIsolationManifest(root, fixturePath);
		expect(manifestInfo.fixtures).toHaveLength(8);
		expect(manifestInfo.fixtures.map((fixture: any) => fixture.id)).toEqual(FIXTURE_IDS);
		expect(manifestInfo.manifestSha256).toBe(createHash('sha256').update(manifestBytes).digest('hex'));
		expect(manifestInfo.fixtures.every((fixture: any) => !Object.hasOwn(fixture, 'payloadBytes'))).toBe(true);
		expect(assertManifestSha256(manifestBytes, manifestInfo.manifestSha256)).toBe(manifestInfo.manifestSha256);
		const changedManifest = Buffer.concat([manifestBytes, Buffer.from('\n')]);
		expect(() => assertManifestSha256(changedManifest, manifestInfo.manifestSha256)).toThrow(/changed after the run identity/);
		const output = path.join(root, 'fresh-output');
		mkdirSync(output);
		writeFileSync(path.join(output, 'retained.jsonl'), '{}\n');
		expect(() => assertFreshOutputDirectory(output)).toThrow(/non-empty output directory/);
		const hashes = runtimeModuleHashes();
		expect(hashes.map((item: any) => item.path)).toEqual([
			'tooling/performance/loader-baseline.mjs',
			'tooling/performance/loader-baseline-isolated.mjs',
			'tooling/performance/loader-baseline-isolated-child.mjs',
			'tooling/performance/loader-process-snapshot.ps1'
		]);
		expect(hashes.every((item: any) => /^[0-9a-f]{64}$/.test(item.sha256))).toBe(true);
		const diagnosticMatrix = buildIsolatedDiagnosticMatrix(APP_IDS);
		expect(diagnosticMatrix.expectedRowCount).toBe(13);
		expect(new Set(diagnosticMatrix.expectedRowIds).size).toBe(13);
		expect(diagnosticMatrix.specs.filter((spec: any) => spec.appId === 'editor' && spec.fixtureId === 'L-old').length).toBe(1);

		const firstFixture = path.join(root, descriptors[0].locator);
		writeFileSync(firstFixture, Buffer.concat([Buffer.from('fixture-data:' + FIXTURE_IDS[0]), Buffer.from('!')]));
		await expect(readIsolationManifest(root, fixturePath)).rejects.toThrow(/size\/SHA-256 differs/);

		const child = writeCustomChild(`
import playwright from ${JSON.stringify(import.meta.resolve('@playwright/test'))};
const { chromium } = playwright; let active = null; let seq = 0; const waiters = new Map();
const send = (type, payload = {}, attemptId = null) => new Promise((resolve, reject) => {
	const message = { protocol: 'bomc-isolation-ipc-v1', runToken: active.runToken, jobToken: active.jobToken, attemptId, seq: ++seq, type, payload };
	process.send(message, (error) => error ? reject(error) : resolve(message.seq));
});
const sendWait = async (type, payload, attemptId = null) => { const ack = await send(type, payload, attemptId); return new Promise((resolve) => waiters.set(ack, resolve)); };
process.on('message', (message) => {
	if (message?.type === 'ack') { const resolve = waiters.get(message.acknowledgedSeq); if (resolve) { waiters.delete(message.acknowledgedSeq); resolve(message.decision); } return; }
	if (message?.type !== 'job' || active) return;
	active = message;
	void (async () => {
		const browser = await chromium.connect(message.payload.wsEndpoint, { timeout: 5000 });
		await send('connected', { childPid: process.pid });
		await send('environment-before', { environment: { source: 'abrupt-child-test' } });
		const id = message.payload.job.id;
		await sendWait('attempt-entered', { attemptId: id, appId: 'editor', fixtureId: 'S2-jcm', mode: 'cold' }, id);
		const epoch = Date.now();
		await send('open', { perfMs: 1, epochMs: epoch, openAction: 'abrupt child test Open' }, id);
		await send('app-outcome', { kind: 'ready', text: 'ready', elapsedMs: 20, observedAtEpochMs: epoch + 20 }, id);
		await send('evidence', { status: 'ready', firstValidFrame: { method: 'test-draw' }, cleanupErrors: [] }, id);
		await send('cleanup-start', {}, id);
		setTimeout(() => process.exit(7), 50);
	})();
});
`);
		const url = await testPage();
		const args = JSON.stringify({ job: { id: 'editor-S2-jcm-cold-01', kind: 'cold', appId: 'editor', fixtureId: 'S2-jcm', mode: 'cold' }, run: { testMode: true, url, cwd: process.cwd() }, budgets: { ...shortBudgets, openOutcomeMs: 500, outcomeEvidenceMs: 1500, evidenceResultMs: 1500 }, childEntry: child });
		const abrupt = nodeProbe(`const args = ${args}; const records = []; args.persist = async (record) => records.push(record); const result = await superviseOwnedJob(args); console.log(JSON.stringify({ result, records }));`, 90_000);
		const finalized = abrupt.records.filter((record: any) => record.recordType === 'actual-row-finalized');
		expect(abrupt.records.some((record: any) => record.recordType === 'attempt-journal' && record.type === 'app-outcome' && record.payload.kind === 'ready')).toBe(true);
		expect(finalized).toHaveLength(1);
		expect(finalized[0].row.outcomeStatus).toBe('ready');
		expect(finalized[0].row.elapsedMs).toBe(20);
		expect(finalized[0].row.firstValidFrame).toEqual({ method: 'test-draw' });
		expect(finalized[0].row.harnessStatus).toBe('observer-error');
		expect(finalized[0].row.cleanupStatus).toBe('aborted-by-supervisor');
		expect(abrupt.result.failure?.phase).toBe('child-exit');
		expect(abrupt.result.ownershipReceipt.verified).toBe(true);
	}, 90_000);
});
