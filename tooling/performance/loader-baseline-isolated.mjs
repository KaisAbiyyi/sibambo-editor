import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync, appendFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
	APPS,
	BROWSER_LAUNCH_ARGS,
	assertFreshOutputDirectory,
	appUrl,
	assertWithinRoot,
	buildModelScenarioMatrix,
	discoverBrowserEnvironment,
	evaluateModelAcceptance,
	parseArgs,
	readBuild,
	stableEnvironment,
	summarizeTimingRows,
	verifyFixtureBytes,
	verifyScenarioRows,
	workerTraceAudit
} from './loader-baseline.mjs';

export const ISOLATED_SCHEMA = 'bomc-loader-isolated-baseline-v1';
export const ISOLATED_METHOD = 'bomc-model-isolated-v3';
export const IPC_PROTOCOL = 'bomc-isolation-ipc-v1';
export const PRODUCTION_BUDGETS = Object.freeze({
	launchMs: 10_000,
	connectMs: 45_000,
	attemptOpenMs: 90_000,
	openOutcomeMs: 120_000,
	deliveryAllowanceMs: 1_000,
	outcomeEvidenceMs: 30_000,
	evidenceResultMs: 15_000,
	jobTerminalMs: 45_000,
	heartbeatIntervalMs: 250,
	heartbeatMaxGapMs: 5_000,
	gracefulChildExitMs: 5_000,
	childStopWaitMs: 1_000,
	terminationMs: 5_000,
	processSnapshotMs: 30_000,
	resourceVerificationMs: 30_000
});

const WORKSPACE_PLAN = 'BOMC-LOADER-001/v1.0';
const FIXTURE_IDS = ['L-old', 'Y-old', 'I-old', 'S2-jcm', 'S1-new', 'S2-new', 'I-new', 'Y-new'];
const SUPPORTED_IDS = ['L-old', 'Y-old', 'I-old', 'S2-jcm'];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNAPSHOT_SCRIPT = fileURLToPath(new URL('./loader-process-snapshot.ps1', import.meta.url));

function epochNow() { return performance.timeOrigin + performance.now(); }
function monotonicNow() { return performance.now(); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function asError(error) { return error instanceof Error ? error.message : String(error); }
function normalizeWindowsPath(value) {
	if (typeof value !== 'string' || !value.trim()) return '';
	return path.win32.normalize(value.trim().replaceAll('/', '\\').replace(/^"|"$/g, '')).replace(/\\+$/, '').toLowerCase();
}
function profileArgument(commandLine) {
	if (typeof commandLine !== 'string') return null;
	const matches = [...commandLine.matchAll(/(?:^|\s)--user-data-dir=(?:"([^"]+)"|(\S+))/gi)];
	if (matches.length !== 1) return null;
	return matches[0][1] || matches[0][2] || null;
}
function sameProfileArgument(commandLine, profilePath) {
	const actual = profileArgument(commandLine);
	return Boolean(actual && normalizeWindowsPath(actual) === normalizeWindowsPath(profilePath));
}
function hashFile(filePath) {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		let size = 0;
		const stream = createReadStream(filePath);
		const timer = setTimeout(() => {
			stream.destroy(new Error('Streaming fixture verification exceeded 30,000ms.'));
		}, 30_000);
		stream.on('data', (chunk) => { size += chunk.byteLength; hash.update(chunk); });
		stream.once('error', (error) => { clearTimeout(timer); reject(error); });
		stream.once('end', () => { clearTimeout(timer); resolve({ size, sha256: hash.digest('hex') }); });
	});
}

export async function readIsolationManifest(workspaceRoot, fixturePath) {
	const root = path.resolve(workspaceRoot);
	const absoluteManifestPath = path.resolve(fixturePath);
	const manifestRelative = path.relative(root, absoluteManifestPath);
	if (manifestRelative === '..' || manifestRelative.startsWith('..' + path.sep) || path.isAbsolute(manifestRelative)) {
		throw new Error('Fixture manifest must remain inside --workspace-root.');
	}
	const manifestBytes = readFileSync(absoluteManifestPath);
	const manifest = JSON.parse(manifestBytes.toString('utf8'));
	if (manifest.schemaVersion !== 'bomc-loader-fixture-manifest-v1' || manifest.plan !== WORKSPACE_PLAN || !Array.isArray(manifest.fixtures) || manifest.fixtures.length !== 8) {
		throw new Error('Fixture manifest schema, frozen plan identity, or eight-row count differs from the accepted baseline.');
	}
	const ids = manifest.fixtures.map((fixture) => fixture.id);
	if (ids.length !== FIXTURE_IDS.length || new Set(ids).size !== ids.length || FIXTURE_IDS.some((id) => !ids.includes(id))) {
		throw new Error('Fixture manifest IDs differ from the frozen eight-input baseline.');
	}
	const descriptors = [];
	const fixtureById = new Map(manifest.fixtures.map((fixture) => [fixture.id, fixture]));
	for (const id of FIXTURE_IDS) {
		const fixture = fixtureById.get(id);
		if (!Number.isSafeInteger(fixture.bytes) || fixture.bytes < 0 || !/^[0-9a-f]{64}$/.test(fixture.sha256)) {
			throw new Error(fixture.id + ': invalid pinned byte count or SHA-256 descriptor.');
		}
		const filePath = assertWithinRoot(root, fixture.locator);
		const actual = await hashFile(filePath);
		if (actual.size !== fixture.bytes || actual.sha256 !== fixture.sha256) {
			throw new Error(fixture.id + ': streamed fixture size/SHA-256 differs from the pinned descriptor.');
		}
		descriptors.push({ ...fixture, filePath });
	}
	return {
		manifest,
		manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
		fixtures: descriptors,
		path: manifestRelative.replaceAll('\\', '/')
	};
}

export function buildIsolationJobs(matrix) {
	if (!matrix || !['B0', 'B1', 'P1'].includes(matrix.baseline) || !Array.isArray(matrix.scenarios)) throw new Error('Model scenario matrix is required.');
	const jobs = [];
	for (const scenario of matrix.scenarios) {
		if (scenario.kind === 'expected-rejection') {
			for (const id of scenario.attemptRowIds) jobs.push({
				id,
				kind: 'rejection',
				scenarioId: scenario.id,
				appId: scenario.appId,
				fixtureId: scenario.fixtureId,
				mode: 'cold',
				attemptIds: [id],
				expectedOutcome: 'BOMC 1.2 MATERIALS v2 rejected before geometry/preview'
			});
			continue;
		}
		if (scenario.mode === 'warm') {
			jobs.push({
				id: scenario.id,
				kind: 'warm',
				scenarioId: scenario.id,
				appId: scenario.appId,
				fixtureId: scenario.fixtureId,
				mode: 'warm',
				primeRowId: scenario.primeRowId,
				attemptRowIds: [...scenario.attemptRowIds],
				attemptIds: [scenario.primeRowId, ...scenario.attemptRowIds],
				expectedOutcome: scenario.expectedOutcome || 'ready'
			});
			continue;
		}
		for (const id of scenario.attemptRowIds) jobs.push({
			id,
			kind: 'cold',
			scenarioId: scenario.id,
			appId: scenario.appId,
			fixtureId: scenario.fixtureId,
			mode: 'cold',
			attemptIds: [id],
			expectedOutcome: scenario.expectedOutcome || 'ready'
		});
	}
	return jobs;
}

export function buildIsolatedDiagnosticMatrix(appIds) {
	if (!Array.isArray(appIds) || appIds.length === 0 || new Set(appIds).size !== appIds.length || appIds.some((id) => !APPS.some((app) => app.id === id))) {
		throw new Error('Diagnostic matrix requires a non-empty unique selection of known app IDs.');
	}
	const orderedApps = APPS.filter((app) => appIds.includes(app.id)).map((app) => app.id);
	const specs = [];
	const seen = new Set();
	const add = (appId, fixtureId, mode) => {
		if (!orderedApps.includes(appId) || (mode === 'wrapped' && !SUPPORTED_IDS.includes(fixtureId))) return;
		const id = 'diagnostic-' + appId + '-' + fixtureId + '-' + mode;
		if (seen.has(id)) return;
		seen.add(id);
		specs.push({ id, appId, fixtureId, mode, kind: 'diagnostic' });
	};
	add('editor', 'S2-jcm', 'native');
	add('editor', 'S2-jcm', 'wrapped');
	add('rooms', 'S2-jcm', 'wrapped');
	for (const appId of orderedApps) for (const fixtureId of SUPPORTED_IDS) add(appId, fixtureId, 'wrapped');
	const expectedRowIds = specs.map((spec) => spec.id);
	return { appIds: orderedApps, specs, expectedRowIds, expectedRowCount: expectedRowIds.length };
}

export function matchOwnedRootIdentity(snapshot, expected) {
	if (!snapshot || snapshot.querySucceeded !== true || snapshot.rootIdentityMatches !== true || !snapshot.root || !expected) return false;
	const root = snapshot.root;
	if (!Number.isInteger(expected.pid) || root.pid !== expected.pid || root.ppid !== expected.parentPid) return false;
	if (!expected.creationUtc || root.creationUtc !== expected.creationUtc) return false;
	if (normalizeWindowsPath(root.executable) !== normalizeWindowsPath(expected.executable)) return false;
	if (expected.profilePath) {
		if (!sameProfileArgument(root.commandLine, expected.profilePath)) return false;
	} else if (profileArgument(root.commandLine) !== null) {
		return false;
	}
	return true;
}

function execFileResult(file, args, options) {
	return new Promise((resolve) => {
		execFile(file, args, options, (error, stdout, stderr) => {
			resolve({
				exitCode: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
				error: error ? error.message : null,
				stdout: stdout || '',
				stderr: stderr || ''
			});
		});
	});
}

async function readProcessSnapshot({ pid, creationUtc = '', profilePath = '', parentPid = 0, timeoutMs = PRODUCTION_BUDGETS.processSnapshotMs }) {
	if (process.platform !== 'win32') throw new Error('Owned process verification requires the frozen Windows CIM snapshot helper.');
	const result = await execFileResult('powershell.exe', [
		'-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SNAPSHOT_SCRIPT,
		'-RootPid', String(pid),
		'-RootCreationUtc', creationUtc,
		'-ProfilePath', profilePath,
		'-ExpectedParentPid', String(parentPid)
	], { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
	let snapshot = null;
	try { snapshot = JSON.parse(result.stdout.trim()); } catch {}
	if (!snapshot) return { querySucceeded: false, root: null, rootIdentityMatches: false, descendants: [], profileMatches: [], error: result.error || result.stderr || 'PowerShell returned no valid JSON snapshot.' };
	if (result.error && snapshot.querySucceeded === true) return { ...snapshot, querySucceeded: false, error: result.error };
	return snapshot;
}

export async function readProcessSnapshots(requests, { timeoutMs = PRODUCTION_BUDGETS.processSnapshotMs } = {}) {
	if (process.platform !== 'win32') throw new Error('Owned process verification requires the frozen Windows CIM snapshot helper.');
	if (!Array.isArray(requests) || requests.length < 1 || requests.length > 1024 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid process snapshot batch size or timeout.');
	const normalized = requests.map((request, index) => {
		const { pid, creationUtc = '', profilePath = '', parentPid = 0 } = request || {};
		if (!Number.isInteger(pid) || pid <= 0 || pid > 2147483647 || !Number.isInteger(parentPid) || parentPid < 0 || parentPid > 2147483647 || typeof creationUtc !== 'string' || typeof profilePath !== 'string') throw new Error('Invalid process snapshot request identity.');
		return { id: 'root-' + index, pid, creationUtc, profilePath, parentPid };
	});
	const schemaVersion = 'bomc-process-snapshot-batch-v1';
	const directory = mkdtempSync(path.join(os.tmpdir(), 'bomc-process-snapshot-'));
	const requestFile = path.join(directory, 'requests.json');
	try {
		writeFileSync(requestFile, JSON.stringify({ schemaVersion, requests: normalized }), { encoding: 'utf8', flag: 'wx' });
		const result = await execFileResult('powershell.exe', [
			'-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SNAPSHOT_SCRIPT, '-RequestsFile', requestFile
		], { windowsHide: true, timeout: Math.max(1, Math.floor(timeoutMs)), maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
		let batch = null;
		try { batch = JSON.parse(result.stdout.trim()); } catch {}
		const processEntryValid = (entry) => entry && Number.isInteger(entry.pid) && entry.pid > 0 && Number.isInteger(entry.ppid) && typeof entry.creationUtc === 'string' && entry.creationUtc.length > 0 && typeof entry.executable === 'string' && typeof entry.commandLine === 'string';
		const snapshotValid = (snapshot) => snapshot && snapshot.querySucceeded === true && typeof snapshot.rootIdentityMatches === 'boolean' && (snapshot.root === null || processEntryValid(snapshot.root)) && Array.isArray(snapshot.descendants) && snapshot.descendants.every(processEntryValid) && Array.isArray(snapshot.profileMatches) && snapshot.profileMatches.every(processEntryValid);
		const valid = !result.error && batch?.schemaVersion === schemaVersion && batch.querySucceeded === true && batch.queryCount === 1 && typeof batch.inspectionId === 'string' && batch.inspectionId.length > 0 && Array.isArray(batch.snapshots) && batch.snapshots.length === normalized.length && batch.snapshots.every((entry, index) => entry.id === normalized[index].id && snapshotValid(entry.snapshot));
		if (!valid) {
			const error = result.error || batch?.error || result.stderr || 'PowerShell returned an invalid or incomplete process snapshot batch.';
			return { querySucceeded: false, queryCount: batch?.queryCount ?? 0, inspectionId: batch?.inspectionId ?? null, snapshots: normalized.map(() => ({ querySucceeded: false, root: null, rootIdentityMatches: false, descendants: [], profileMatches: [], error })) };
		}
		return { querySucceeded: true, queryCount: 1, inspectionId: batch.inspectionId, snapshots: batch.snapshots.map((entry) => entry.snapshot) };
	} finally {
		if (existsSync(requestFile)) unlinkSync(requestFile);
		rmdirSync(directory);
	}
}

function handleIdentity(handle, profilePath = '') {
	const pid = handle?.pid;
	const spawnfile = handle?.spawnfile;
	const spawnargs = handle?.spawnargs;
	if (!Number.isInteger(pid) || !spawnfile || !Array.isArray(spawnargs)) throw new Error('Spawned process handle is missing its PID, executable, or argument snapshot.');
	let profile = '';
	if (profilePath) {
		const profileArgs = spawnargs.filter((arg) => /^--user-data-dir=/i.test(arg));
		if (profileArgs.length !== 1) throw new Error('BrowserServer spawn arguments must contain exactly one --user-data-dir token.');
		profile = profileArgs[0].slice(profileArgs[0].indexOf('=') + 1).replace(/^"|"$/g, '');
		if (normalizeWindowsPath(profile) !== normalizeWindowsPath(profilePath)) throw new Error('BrowserServer profile token differs from its recorded profile path.');
	}
	return { pid, executable: spawnfile, spawnargs: [...spawnargs], parentPid: process.pid, profilePath: profile };
}

async function establishOwnedIdentity(handle, profilePath = '', timeoutMs = PRODUCTION_BUDGETS.processSnapshotMs) {
	const spawned = handleIdentity(handle, profilePath);
	const initial = await readProcessSnapshot({ pid: spawned.pid, profilePath: spawned.profilePath, parentPid: spawned.parentPid, timeoutMs });
	if (initial.querySucceeded !== true || !initial.root || initial.root.pid !== spawned.pid || initial.root.ppid !== spawned.parentPid) {
		throw new Error('New process root CIM snapshot is unavailable or has an unexpected parent.');
	}
	if (normalizeWindowsPath(initial.root.executable) !== normalizeWindowsPath(spawned.executable)) throw new Error('New process executable identity differs from its spawned process handle.');
	if (spawned.profilePath && !sameProfileArgument(initial.root.commandLine, spawned.profilePath)) throw new Error('New browser root does not carry the exact generated profile argument.');
	const expected = {
		pid: spawned.pid,
		creationUtc: initial.root.creationUtc,
		executable: spawned.executable,
		parentPid: spawned.parentPid,
		profilePath: spawned.profilePath
	};
	const verified = await readProcessSnapshot({ pid: expected.pid, creationUtc: expected.creationUtc, profilePath: expected.profilePath, parentPid: expected.parentPid, timeoutMs });
	if (!matchOwnedRootIdentity(verified, expected)) throw new Error('New process exact PID/birth/executable/parent/profile identity failed verification.');
	return { expected, initialSnapshot: verified, knownProcesses: [verified.root, ...(verified.descendants || [])].filter(Boolean) };
}

function pushKnown(target, processes) {
	const byIdentity = new Map(target.map((entry) => [entry.pid + '|' + entry.creationUtc, entry]));
	for (const entry of processes || []) if (entry && Number.isInteger(entry.pid) && entry.creationUtc) byIdentity.set(entry.pid + '|' + entry.creationUtc, entry);
	return [...byIdentity.values()];
}

function processAlive(handle) {
	return Boolean(handle && handle.exitCode === null && handle.signalCode === null);
}

async function waitHandleExit(handle, timeoutMs) {
	if (!processAlive(handle)) return true;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			handle.removeListener('exit', onExit);
			handle.removeListener('close', onExit);
			resolve(value);
		};
		const onExit = () => finish(true);
		const timer = setTimeout(() => finish(!processAlive(handle)), timeoutMs);
		handle.once('exit', onExit);
		handle.once('close', onExit);
	});
}

async function invokeOwnedTreeKill(identity, snapshot, processOps) {
	if (processOps?.killOwnedTree) return processOps.killOwnedTree({ identity, snapshot });
	const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
	const result = await execFileResult(taskkill, ['/PID', String(identity.pid), '/T', '/F'], {
		windowsHide: true,
		timeout: 5_000,
		maxBuffer: 1024 * 1024,
		encoding: 'utf8',
		shell: false
	});
	return { command: taskkill, args: ['/PID', String(identity.pid), '/T', '/F'], exitCode: result.exitCode, error: result.error, stdout: result.stdout, stderr: result.stderr };
}

async function killVerifiedTree(identityRecord, handle, processOps, receipt, exitWaitMs = 0, snapshotTimeoutMs = PRODUCTION_BUDGETS.processSnapshotMs) {
	if (!processAlive(handle)) return { attempted: false, alreadyExited: true };
	const fresh = await readProcessSnapshot({
		pid: identityRecord.expected.pid,
		creationUtc: identityRecord.expected.creationUtc,
		profilePath: identityRecord.expected.profilePath,
		parentPid: identityRecord.expected.parentPid,
		timeoutMs: snapshotTimeoutMs
	});
	receipt.snapshots.push({ phase: 'pre-force-owned-tree', root: identityRecord.expected, snapshot: fresh });
	if (!matchOwnedRootIdentity(fresh, identityRecord.expected)) {
		if (await waitHandleExit(handle, exitWaitMs)) return { attempted: false, alreadyExited: true, rootIdentityNoLongerLive: true };
		throw new Error('Refused taskkill because the live root no longer matches its exact owned identity.' + (fresh.querySucceeded !== true ? ' CIM inspection failed: ' + fresh.error : ''));
	}
	identityRecord.knownProcesses = pushKnown(identityRecord.knownProcesses || [], fresh.descendants || []);
	const result = await invokeOwnedTreeKill(identityRecord.expected, fresh, processOps);
	receipt.killCommands.push({ identity: identityRecord.expected, result });
	if (result?.exitCode !== 0) throw new Error(result?.error || 'Owned taskkill.exe returned a nonzero exit code.');
	receipt.killedRootPids.push(identityRecord.expected.pid);
	return { attempted: true, result };
}

async function verifyOwnedGone(records, receipt, timeoutMs, snapshotTimeoutMs = PRODUCTION_BUDGETS.processSnapshotMs) {
	const deadline = monotonicNow() + timeoutMs;
	let latest = [];
	const audits = records.flatMap((record) => [
		...(record.identity.knownProcesses || []).map((entry) => ({ kind: 'process', record, expected: entry, request: { pid: entry.pid, creationUtc: entry.creationUtc } })),
		...(record.identity.expected.profilePath ? [{ kind: 'profile', record, expected: record.identity.expected, request: { pid: record.identity.expected.pid, profilePath: record.identity.expected.profilePath } }] : [])
	]);
	if (!audits.length) throw new Error('No established owned process identities to verify.');
	while (monotonicNow() <= deadline) {
		latest = [];
		for (const record of records) {
			if (record.handle && processAlive(record.handle)) {
				latest.push({ pid: record.identity.expected.pid, creationUtc: record.identity.expected.creationUtc, reason: 'owned process handle remains live' });
			}
		}
		const remainingMs = Math.floor(deadline - monotonicNow());
		if (remainingMs <= 0) { latest.push({ reason: 'process verification budget exhausted before inspection' }); break; }
		const batch = await readProcessSnapshots(audits.map((audit) => audit.request), { timeoutMs: Math.min(snapshotTimeoutMs, remainingMs) });
		receipt.snapshots.push({ phase: 'post-exit-batch-audit', inspectionId: batch.inspectionId, queryCount: batch.queryCount, querySucceeded: batch.querySucceeded, processes: audits.map((audit, index) => ({ kind: audit.kind, expected: audit.expected, snapshot: batch.snapshots[index] })) });
		for (let index = 0; index < audits.length; index += 1) {
			const { kind, expected } = audits[index];
			const snapshot = batch.snapshots[index];
			if (snapshot.querySucceeded !== true) {
				latest.push({ pid: expected.pid, creationUtc: expected.creationUtc, reason: snapshot.error || 'CIM query failed' });
			} else if (kind === 'process' && snapshot.root?.pid === expected.pid && snapshot.root.creationUtc === expected.creationUtc) {
				latest.push({ pid: expected.pid, creationUtc: expected.creationUtc, reason: 'owned PID/birth identity remains present' });
			} else if (kind === 'profile') {
				for (const match of snapshot.profileMatches) latest.push({ pid: match.pid, creationUtc: match.creationUtc, reason: 'exact browser profile token remains present' });
			}
		}
		if (!latest.length) {
			receipt.remainingOwnedProcesses = [];
			return true;
		}
		await delay(100);
	}
	receipt.remainingOwnedProcesses = latest;
	return false;
}

function expectedJobAttemptIds(job) {
	if (job.kind === 'environment-recovery') return [];
	if (Array.isArray(job.attemptIds) && job.attemptIds.length) return [...job.attemptIds];
	if (Array.isArray(job.attemptRowIds) && job.attemptRowIds.length) return job.primeRowId ? [job.primeRowId, ...job.attemptRowIds] : [...job.attemptRowIds];
	return [job.id];
}

function waitForBounded(promise, timeoutMs, label) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(label + ' exceeded ' + timeoutMs + 'ms.')), timeoutMs);
		Promise.resolve(promise).then(
			(value) => { clearTimeout(timer); resolve(value); },
			(error) => { clearTimeout(timer); reject(error); }
		);
	});
}

export function normalizeChildMessage(message, expected) {
	if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Child IPC message is not an object.');
	if (message.protocol !== IPC_PROTOCOL || message.runToken !== expected.runToken || message.jobToken !== expected.jobToken) throw new Error('Child IPC protocol/run/job token mismatch.');
	if (!Number.isInteger(message.seq) || message.seq !== expected.nextSequence) throw new Error('Child IPC sequence is missing, repeated, or out of order.');
	if (!['connected', 'environment-before', 'attempt-entered', 'open', 'app-outcome', 'evidence', 'cleanup-start', 'diagnostic-event', 'attempt-result', 'environment-after', 'job-terminal', 'heartbeat', 'fatal-error'].includes(message.type)) {
		throw new Error('Child IPC event type is not in the frozen protocol: ' + String(message.type));
	}
	if (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) throw new Error('Child IPC event payload is not a plain object.');
	expected.nextSequence += 1;
	return message;
}

export function classifyAttemptOutcome(open, payload, deadlineMs = PRODUCTION_BUDGETS.openOutcomeMs) {
	if (!payload || typeof payload !== 'object') return { outcomeStatus: null, elapsedMs: null, actualObservedElapsedMs: null, censoredAtDeadline: false, lateOutcome: null, observationIntegrity: 'protocol-invalid' };
	if (!open) return payload.kind === 'setup-error'
		? { outcomeStatus: 'setup-error', elapsedMs: null, actualObservedElapsedMs: null, censoredAtDeadline: false, lateOutcome: null, observationIntegrity: 'valid' }
		: { outcomeStatus: null, elapsedMs: null, actualObservedElapsedMs: null, censoredAtDeadline: false, lateOutcome: null, observationIntegrity: 'invalid-clock' };
	const observedElapsedMs = Number.isFinite(payload.observedAtEpochMs) && Number.isFinite(open.epochMs)
		? payload.observedAtEpochMs - open.epochMs
		: payload.elapsedMs;
	if (!Number.isFinite(observedElapsedMs) || observedElapsedMs < -1_000) return {
		outcomeStatus: payload.kind ?? null,
		elapsedMs: null,
		actualObservedElapsedMs: Number.isFinite(observedElapsedMs) ? observedElapsedMs : null,
		censoredAtDeadline: false,
		lateOutcome: null,
		observationIntegrity: 'invalid-clock'
	};
	const actualObservedElapsedMs = Math.max(0, observedElapsedMs);
	if (payload.kind === 'timeout' || observedElapsedMs > deadlineMs) return {
		outcomeStatus: 'timeout',
		elapsedMs: deadlineMs,
		actualObservedElapsedMs,
		censoredAtDeadline: payload.kind === 'timeout',
		lateOutcome: observedElapsedMs > deadlineMs ? payload : null,
		observationIntegrity: 'valid'
	};
	return {
		outcomeStatus: payload.kind ?? null,
		elapsedMs: actualObservedElapsedMs,
		actualObservedElapsedMs,
		censoredAtDeadline: false,
		lateOutcome: null,
		observationIntegrity: 'valid'
	};
}

export function makeActualRow(job, current, receipt) {
	const eventRow = {
		...(current?.evidence && typeof current.evidence === 'object' ? current.evidence : {}),
	...(current?.result?.row && typeof current.result.row === 'object' ? current.result.row : {})
	};
	const outcome = current?.appOutcome;
	const rowId = current?.attemptId || eventRow.scenarioRowId || eventRow.id || job.id;
	let outcomeStatus = current?.outcomeStatus ?? (eventRow.status === 'prime-excluded' ? 'ready' : eventRow.status ?? null);
	let observationIntegrity = current?.observationIntegrity || 'valid';
	let harnessStatus = current?.harnessStatus || 'ok';
	if (!outcome && current?.harnessStatus === 'observer-error') outcomeStatus = null;
	if (outcome?.observationError || eventRow.observerError) {
		harnessStatus = 'observer-error';
		observationIntegrity = 'observer-unavailable';
	}
	if (!current?.open && outcomeStatus !== 'setup-error') observationIntegrity = 'invalid-clock';
	if (current?.open && !Number.isFinite(current.elapsedMs) && outcomeStatus !== 'timeout' && observationIntegrity === 'valid') observationIntegrity = 'invalid-clock';
	if (eventRow.cleanupStatus === 'failed') harnessStatus = 'cleanup-failed';
	if (outcomeStatus === 'ready' && !eventRow.firstValidFrame) outcomeStatus = 'failed-no-valid-frame';
	const row = {
		...eventRow,
		id: rowId,
		scenarioRowId: rowId,
		kind: job.kind === 'diagnostic' ? 'diagnostic' : job.kind === 'rejection' ? 'model' : 'model',
		app: eventRow.app || job.appId,
		fixtureId: eventRow.fixtureId || job.fixtureId,
		fixtureLocator: job.fixture?.locator || eventRow.fixtureLocator || null,
		fixtureBytes: eventRow.fixtureBytes ?? job.fixture?.bytes ?? null,
		fixtureSha256: eventRow.fixtureSha256 ?? job.fixture?.sha256 ?? null,
		mode: eventRow.mode || job.mode,
		prime: eventRow.prime ?? current?.prime ?? false,
		expectedOutcome: eventRow.expectedOutcome || job.expectedOutcome || 'ready',
		openOccurred: Boolean(current?.open),
		openAction: current?.open?.openAction || eventRow.openAction || null,
		startedAtEpochMs: current?.open?.epochMs ?? null,
		elapsedMs: current?.elapsedMs ?? null,
		outcomeStatus,
		harnessStatus,
		resourceDisposition: receipt?.resourceDisposition || 'graceful',
		observationIntegrity,
		appOutcome: outcome || null,
		parentDeadline: current?.parentDeadline ?? null,
		actualObservedElapsedMs: current?.actualObservedElapsedMs ?? null,
		censoredAtDeadline: current?.censoredAtDeadline === true,
		warmContextLost: current?.warmContextLost === true,
		ownershipReceipt: receipt || null
	};
	row.jobId = job.id;
	row.diagnosticStreamEvents = current?.diagnosticEvents || [];
	row.diagnosticStreamErrors = current?.diagnosticStreamErrors || [];
	row.diagnosticStreamToken = current?.diagnosticStreamToken || null;
	row.fixtureLocator = job.fixture?.locator || null;
	if (current?.diagnosticStreamErrors?.length) {
		harnessStatus = row.harnessStatus = 'observer-error';
		observationIntegrity = row.observationIntegrity = 'observer-unavailable';
	}
	if (!current?.open) row.elapsedMs = null;
	if (outcomeStatus === 'timeout' && current?.censoredAtDeadline) row.elapsedMs = current.deadlineBudgetMs ?? current.elapsedMs;
	if (!current?.result) {
		row.status = outcomeStatus === 'timeout' ? 'harness-error-cleanup' : 'harness-error-observer';
		row.cleanupStatus = 'aborted-by-supervisor';
		row.cleanupErrors = current?.failure ? [current.failure.message] : ['Attempt result was not returned before supervisor ownership closure.'];
		row.firstValidFrame = eventRow.firstValidFrame ?? null;
	}
	return row;
}

export function buildBlockedWarmDispositions(job, reason, blockedByRowId, ownershipReceipt, startAtIndex = 0) {
	if (job?.kind !== 'warm' || !['blocked-prime-failed', 'blocked-warm-context-lost'].includes(reason) || typeof blockedByRowId !== 'string' || !ownershipReceipt?.verified) throw new Error('A blocked warm disposition requires a warm job, an admissible cause, and verified resource ownership.');
	const ids = Array.isArray(job.attemptRowIds) ? job.attemptRowIds : [];
	const remaining = reason === 'blocked-prime-failed' ? ids : ids.slice(startAtIndex);
	return remaining.map((id) => ({
		recordType: 'disposition',
		id,
		scenarioRowId: id,
		jobId: job.id,
		scenarioId: job.scenarioId || job.id,
		app: job.appId,
		fixtureId: job.fixtureId,
		mode: 'warm',
		prime: false,
		openOccurred: false,
		startedAtEpochMs: null,
		elapsedMs: null,
		firstValidFrame: null,
		excludedFromTiming: true,
		reason,
		blockedByRowId,
		ownershipReceipt,
		createdAtEpochMs: epochNow()
	}));
}

export async function superviseOwnedJob({ job, run, persist, budgets = null, childEntry = fileURLToPath(new URL('./loader-baseline-isolated-child.mjs', import.meta.url)), processOps = null }) {
	if (!job || typeof job.id !== 'string' || !job.id || typeof persist !== 'function') throw new Error('superviseOwnedJob requires a named job and durable persist callback.');
	const selectedBudgets = budgets
		? { ...PRODUCTION_BUDGETS, ...budgets, deliveryAllowanceMs: Number.isFinite(budgets.deliveryAllowanceMs) ? budgets.deliveryAllowanceMs : 0 }
		: PRODUCTION_BUDGETS;
	const startedAtEpochMs = epochNow();
	const startedAtMonotonicMs = monotonicNow();
	const runToken = randomUUID();
	const jobToken = randomUUID();
	const state = {
		runToken,
		jobToken,
		nextSequence: 1,
		connected: false,
		lastHeartbeatAt: null,
		environmentBefore: null,
		environmentAfter: null,
		current: null,
		terminal: null,
		failure: null,
		events: [],
		completedAttempts: [],
		primeFailedRowId: null,
		primeFailureAdmissible: false,
		primePassed: false,
		primeContextLossAdmissible: false,
		warmContextLostBy: null,
		forcedReclamationStarted: false,
		forcedReclamationStartedAtEpochMs: null,
		teardownFatalAfterForce: false,
		diagnosticEventKeys: new Map(),
		diagnosticSequenceByRealm: new Map(),
		diagnosticEventCount: 0,
		diagnosticByteCount: 0,
		diagnosticStreamInvalid: false,
		changeWaiters: new Set()
	};
	const receipt = {
		runToken,
		jobToken,
		jobId: job.id,
		startedAtEpochMs,
		completedAtEpochMs: null,
		launch: null,
		child: null,
		snapshots: [],
		killCommands: [],
		killedRootPids: [],
		killFailures: [],
		remainingOwnedProcesses: [],
		verified: false,
		resourceDisposition: 'unverified',
		error: null,
		stdoutTail: '',
		stderrTail: ''
	};
	let server = null;
	let browserHandle = null;
	let browserIdentity = null;
	let child = null;
	let childIdentity = null;
	let childSpawned = false;
	let terminalSeen = false;
	let forceRequired = false;
	let productDeadline = false;
	let productDeadlineMonotonicMs = null;
	let actualRow = null;
	let childChain = Promise.resolve();
	let teardownObservationWrite = Promise.resolve();
	let childExit = false;
	let serverCloseError = null;
	const persistRecord = async (record) => {
		await persist({ runToken, jobToken, jobId: job.id, parentEpochMs: epochNow(), ...record });
	};
	const wake = () => {
		for (const resolve of [...state.changeWaiters]) resolve();
	};
	const fail = (kind, message, phase = null) => {
		if (state.failure) return;
		state.failure = { kind, message, phase, atEpochMs: epochNow() };
		if (state.current) {
			state.current.failure = state.failure;
			state.current.harnessStatus = ['setup-error', 'observer-error', 'protocol-error', 'identity-error', 'cleanup-failed'].includes(kind) ? kind : 'observer-error';
			if (kind === 'observer-error') state.current.observationIntegrity = 'observer-unavailable';
			if (kind === 'protocol-error') state.current.observationIntegrity = 'protocol-invalid';
		}
		receipt.error = message;
		forceRequired = true;
		wake();
	};
	const beginForcedReclamation = async (cause) => {
		if (state.forcedReclamationStarted) return;
		state.forcedReclamationStarted = true;
		state.forcedReclamationStartedAtEpochMs = epochNow();
		try {
			await persistRecord({ recordType: 'ownership-event', phase: 'forced-reclamation-started', cause, startedAtEpochMs: state.forcedReclamationStartedAtEpochMs });
		} catch (error) {
			fail('observer-error', 'Could not durably record the forced-reclamation boundary: ' + asError(error), 'ledger-write');
		}
	};
	const hasValidProductOutcome = (current, row = current?.result?.row ?? null) => {
		if (!current?.open || !current.appOutcome || current.appOutcome.observationError || current.observationIntegrity !== 'valid' || current.harnessStatus !== 'ok' || current.diagnosticStreamErrors?.length || state.diagnosticStreamInvalid) return false;
		if (!Number.isFinite(current.elapsedMs) || current.elapsedMs < 0 || current.elapsedMs > PRODUCTION_BUDGETS.openOutcomeMs) return false;
		if (['error', 'timeout'].includes(current.outcomeStatus)) return true;
		if (current.outcomeStatus !== 'ready') return false;
		if (row?.observerError) return false;
		if (row) return Boolean(row.firstValidFrame) || (current.evidence?.status === 'failed-no-valid-frame' && !row.firstValidFrame);
		return Boolean(current.evidence?.firstValidFrame) || current.evidence?.status === 'failed-no-valid-frame';
	};
	const cleanupTerminalAdmissible = (payload) => {
		const current = state.current;
		if (!current?.cleanupLossAdmissible || payload.lastAttemptId !== current.attemptId || state.failure || !hasValidProductOutcome(current, current.result?.row)) return false;
		if (payload.afterEnvironment !== null || payload.afterEnvironmentStatus !== 'unavailable-quarantined' || state.environmentAfter !== null) return false;
		if (payload.status === 'cleanup-failed') return job.kind !== 'warm' || (current.prime && state.primeFailureAdmissible && state.primeFailedRowId === current.attemptId);
		if (payload.status !== 'warm-context-lost' || job.kind !== 'warm' || state.warmContextLostBy !== current.attemptId) return false;
		return current.prime
			? state.primeContextLossAdmissible === true && current.primeContextLossCause === true && state.primePassed === false && current.outcomeStatus === 'ready' && Boolean(current.result?.row?.firstValidFrame)
			: state.primePassed === true && !current.prime;
	};
	const awaitChange = async (ms) => new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			state.changeWaiters.delete(finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		state.changeWaiters.add(finish);
	});
	const waitUntil = async (predicate, timeoutMs, phase, watchHeartbeat = true) => {
		const deadline = monotonicNow() + timeoutMs;
		while (!predicate() && !state.failure) {
			if (typeof run.isInterrupted === 'function' && run.isInterrupted()) {
				fail('observer-error', 'Parent received SIGINT/SIGTERM while this owned sandbox was active.', 'interrupt');
				break;
			}
			if (watchHeartbeat && state.connected && state.lastHeartbeatAt !== null && monotonicNow() - state.lastHeartbeatAt > selectedBudgets.heartbeatMaxGapMs) {
				fail('observer-error', 'Child heartbeat exceeded the frozen maximum gap.', phase);
				break;
			}
			const remaining = deadline - monotonicNow();
			if (remaining <= 0) break;
			await awaitChange(Math.min(100, remaining));
		}
		return predicate();
	};
	const sendAck = (seq, decision) => {
		if (!child || !child.connected) return;
		child.send({
			type: 'ack',
			protocol: IPC_PROTOCOL,
			runToken,
			jobToken,
			acknowledgedSeq: seq,
			ackSeq: seq,
			decision
		});
	};
	const appendEvent = async (message, { lateAfterDeadline = false } = {}) => {
		const parentReceiptEpochMs = epochNow();
		const eventRecord = { recordType: 'attempt-journal', type: message.type, attemptId: message.attemptId ?? null, childSeq: message.seq, payload: message.payload, childEpochMs: message.payload.epochMs ?? message.payload.observedAtEpochMs ?? null, parentReceiptEpochMs, ...(lateAfterDeadline ? { lateAfterDeadline: true } : {}) };
		await persistRecord(eventRecord);
		state.events.push(eventRecord);
		return eventRecord;
	};
	const handleMessage = async (rawMessage, receivedAtMonotonicMs) => {
		const message = normalizeChildMessage(rawMessage, state);
		const lateAfterDeadline = Number.isFinite(productDeadlineMonotonicMs) && receivedAtMonotonicMs >= productDeadlineMonotonicMs && state.current?.parentDeadline?.kind === 'open-outcome-deadline';
		if (message.type === 'heartbeat') {
			if (!lateAfterDeadline) state.lastHeartbeatAt = monotonicNow();
			await persistRecord({ recordType: 'heartbeat', childSeq: message.seq, childEpochMs: message.payload.epochMs ?? null, ...(lateAfterDeadline ? { lateAfterDeadline: true } : {}) });
			wake();
			return;
		}
		const attemptTypes = new Set(['attempt-entered', 'open', 'app-outcome', 'evidence', 'cleanup-start', 'diagnostic-event', 'attempt-result']);
		if (attemptTypes.has(message.type)) {
			if (!message.attemptId || typeof message.attemptId !== 'string') throw new Error(message.type + ' must name its active attempt ID.');
			if (message.type === 'attempt-entered') {
				const allowed = expectedJobAttemptIds(job);
				if (!allowed.includes(message.attemptId) || message.payload.attemptId !== message.attemptId) throw new Error('Child entered an attempt ID outside the supervisor job.');
				if (state.current && !state.current.result) throw new Error('Child entered a second attempt before the previous result was journaled.');
				state.current = { attemptId: message.attemptId, enteredAtMonotonicMs: monotonicNow(), open: null, appOutcome: null, evidence: null, result: null, elapsedMs: null, outcomeStatus: null, harnessStatus: 'ok', observationIntegrity: 'valid', prime: message.payload.prime === true, diagnosticEvents: [], diagnosticSequenceByRealm: new Map() };
				await appendEvent(message);
				sendAck(message.seq, 'continue');
				wake();
				return;
			}
			if (!state.current || message.attemptId !== state.current.attemptId) throw new Error('Child attempt event does not match the active entered attempt.');
			if (lateAfterDeadline && message.type !== 'diagnostic-event') {
				await appendEvent(message, { lateAfterDeadline: true });
				if (message.type === 'attempt-result') sendAck(message.seq, 'stop');
				wake();
				return;
			}
			if (message.type === 'open') {
				if (state.current.open) throw new Error('Child emitted duplicate Open clock for one attempt.');
				const open = message.payload;
				if (!Number.isFinite(open.perfMs) || !Number.isFinite(open.epochMs) || typeof open.openAction !== 'string' || !open.openAction) throw new Error('Child Open clock/action is missing or non-finite.');
				const receiptEpoch = epochNow();
				const ageMs = receiptEpoch - open.epochMs;
				if (ageMs < -1_000 || ageMs > selectedBudgets.attemptOpenMs + 1_000) throw new Error('Child Open epoch is future-dated or arrived outside the bounded action window.');
				state.current.open = { ...open, receiptEpochMs: receiptEpoch, receiptMonotonicMs: monotonicNow() };
				await appendEvent(message);
				wake();
				return;
			}
			if (message.type === 'app-outcome') {
				if (state.current.appOutcome) throw new Error('Child emitted more than one first app-outcome observation.');
				const payload = message.payload;
				if (!state.current.open && payload.kind !== 'setup-error') throw new Error('Child reported a post-Open app result without a captured Open clock.');
				state.current.appOutcome = payload;
				const classified = classifyAttemptOutcome(state.current.open, payload, PRODUCTION_BUDGETS.openOutcomeMs);
				state.current.outcomeStatus = classified.outcomeStatus;
				state.current.elapsedMs = classified.elapsedMs;
				state.current.actualObservedElapsedMs = classified.actualObservedElapsedMs;
				state.current.censoredAtDeadline = classified.censoredAtDeadline;
				state.current.lateOutcome = classified.lateOutcome;
				state.current.observationIntegrity = classified.observationIntegrity;
				if (classified.observationIntegrity === 'invalid-clock') state.current.harnessStatus = 'setup-error';
				if (payload.observationError) {
					state.current.harnessStatus = 'observer-error';
					state.current.observationIntegrity = 'observer-unavailable';
				}
				await appendEvent(message);
				wake();
				return;
			}
			if (message.type === 'evidence') {
				if (!state.current.appOutcome) throw new Error('Attempt evidence arrived before an app outcome observation.');
				state.current.evidence = message.payload;
				await appendEvent(message);
				wake();
				return;
			}
			if (message.type === 'cleanup-start') {
				state.current.cleanupStarted = true;
				await appendEvent(message);
				wake();
				return;
			}
			if (message.type === 'diagnostic-event') {
				const event = message.payload;
				state.current.diagnosticStreamToken = event.streamToken || state.current.diagnosticStreamToken || null;
				if (event.invalidDiagnostic === true) {
					state.diagnosticStreamInvalid = true;
					state.current.diagnosticStreamErrors = [...(state.current.diagnosticStreamErrors || []), event.reason || 'child reported diagnostic stream overflow'];
					await persistRecord({ recordType: 'diagnostic-event', attemptId: message.attemptId, childSeq: message.seq, event, parentReceiptEpochMs: epochNow(), ...(lateAfterDeadline ? { lateAfterDeadline: true } : {}) });
					if (!lateAfterDeadline) fail('observer-error', 'Diagnostic stream exceeded its bounded/token-tagged integrity contract: ' + String(event.reason || 'unspecified overflow'), 'diagnostic-stream');
					wake();
					return;
				}
				if (event.streamToken !== jobToken + ':' + message.attemptId || typeof event.workerId !== 'string' || !event.workerId || !['main', 'worker'].includes(event.realm) || !Number.isInteger(event.seq) || event.seq < 1 || typeof event.phase !== 'string' || !Number.isFinite(event.epochMs)) throw new Error('Diagnostic stream event has a foreign token or invalid identity/clock fields.');
				const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
				if (eventBytes > 64 * 1024 || state.diagnosticEventCount + 1 > 10_000 || state.diagnosticByteCount + eventBytes > 5 * 1024 * 1024) throw new Error('Parent diagnostic stream cap exceeded.');
				const eventKey = [event.streamToken, event.workerId, event.realm, event.seq].join('|');
				const serialized = JSON.stringify(event);
				if (state.diagnosticEventKeys.has(eventKey)) {
					if (state.diagnosticEventKeys.get(eventKey) !== serialized) throw new Error('Diagnostic stream duplicate identity carries different payloads.');
					return;
				}
				const sequenceKey = event.realm === 'worker' ? event.workerId + '|' + event.realm : event.realm;
				const previousSequence = state.current.diagnosticSequenceByRealm.get(sequenceKey) || 0;
				if (event.seq !== previousSequence + 1) throw new Error('Diagnostic stream sequence is repeated, missing, or out of order within one worker realm.');
				state.current.diagnosticSequenceByRealm.set(sequenceKey, event.seq);
				state.diagnosticEventKeys.set(eventKey, serialized);
				state.diagnosticEventCount += 1;
				state.diagnosticByteCount += eventBytes;
				state.current.diagnosticEvents.push(event);
				await persistRecord({ recordType: 'diagnostic-event', attemptId: message.attemptId, childSeq: message.seq, event, sourceEpochMs: event.epochMs, parentReceiptEpochMs: epochNow(), ...(lateAfterDeadline ? { lateAfterDeadline: true } : {}) });
				if (event.phase === 'worker-import-error') {
					state.current.diagnosticStreamErrors = [...(state.current.diagnosticStreamErrors || []), String(event.error || 'Worker import failed.')];
					if (!lateAfterDeadline) fail('observer-error', 'Wrapped worker module import failed during diagnostic capture.', 'diagnostic-import');
				}
				wake();
				return;
			}
			if (message.type === 'attempt-result') {
				if (!state.current.evidence || !state.current.cleanupStarted) throw new Error('Attempt result arrived before durable evidence and cleanup-start observations.');
				if (!message.payload.row || (message.payload.row.scenarioRowId ?? message.payload.row.id) !== state.current.attemptId) throw new Error('Attempt result row ID differs from the active attempt.');
				state.current.result = message.payload;
				state.completedAttempts.push(state.current);
				if (message.payload.row.cleanupStatus !== 'complete') {
					const row = message.payload.row;
					const cleanupLossAdmissible = !state.failure && !state.current.failure && state.current.harnessStatus === 'ok' && !row.observerError && !state.diagnosticStreamInvalid && !state.current.diagnosticStreamErrors?.length && hasValidProductOutcome(state.current, row);
					forceRequired = true;
					await beginForcedReclamation(cleanupLossAdmissible ? 'returned-attempt-cleanup-failure' : 'returned-attempt-cleanup-failure-not-admissible');
					if (!cleanupLossAdmissible) {
						state.current.harnessStatus = 'cleanup-failed';
						fail('observer-error', 'Returned cleanup failure has no admissible bounded product outcome, valid observation, and usable causal state.', 'attempt-cleanup');
					} else {
						state.current.cleanupLossAdmissible = true;
						if (job.kind === 'warm' && state.current.prime) {
							state.primePassed = false;
							const observedReadyFrame = state.current.outcomeStatus === 'ready' && Boolean(row.firstValidFrame);
							if (observedReadyFrame) {
								state.current.primeContextLossCause = true;
								state.current.warmContextLost = true;
								state.primeContextLossAdmissible = true;
								state.warmContextLostBy = state.current.attemptId;
								state.primeFailedRowId = null;
								state.primeFailureAdmissible = false;
							} else {
								const failedPrimeOutcome = ['error', 'timeout'].includes(state.current.outcomeStatus)
									|| (state.current.outcomeStatus === 'ready' && !row.firstValidFrame && state.current.evidence?.status === 'failed-no-valid-frame');
								if (failedPrimeOutcome) {
									state.primeFailedRowId = state.current.attemptId;
									state.primeFailureAdmissible = true;
									state.current.primeFailureAdmissible = true;
								} else {
									state.current.cleanupLossAdmissible = false;
									state.current.harnessStatus = 'cleanup-failed';
									fail('observer-error', 'Warm prime cleanup failed without an admissible product failure or ready-frame context-loss cause.', 'attempt-cleanup');
								}
							}
						} else if (job.kind === 'warm' && !state.current.prime && state.primePassed) {
							state.current.warmContextLost = true;
							state.warmContextLostBy = state.current.attemptId;
						} else if (job.kind === 'warm') {
							state.current.cleanupLossAdmissible = false;
							state.current.harnessStatus = 'cleanup-failed';
							fail('observer-error', 'Warm measured cleanup loss lacks a usable successful prime.', 'attempt-cleanup');
						}
					}
				}
				if (message.payload.row.observerError) {
					state.current.harnessStatus = 'observer-error';
					state.current.observationIntegrity = 'observer-unavailable';
					if (!state.failure) fail('observer-error', 'Attempt result contains an observer error.', 'attempt-result');
				}
				await appendEvent(message);
				const row = message.payload.row;
				if (state.current.prime) {
					const primePassed = state.current.outcomeStatus === 'ready' && Number.isFinite(state.current.elapsedMs) && state.current.elapsedMs <= PRODUCTION_BUDGETS.openOutcomeMs && Boolean(row.firstValidFrame) && row.cleanupStatus === 'complete' && !row.observerError && state.current.observationIntegrity === 'valid' && !state.diagnosticStreamInvalid;
					state.primePassed = primePassed;
					if (!primePassed && !state.current.cleanupLossAdmissible) {
						const normalizedPrimeOutcome = state.current.outcomeStatus === 'ready' && !row.firstValidFrame ? 'failed-no-valid-frame' : state.current.outcomeStatus;
						const admissibleProductFailure = ['error', 'timeout', 'failed-no-valid-frame'].includes(normalizedPrimeOutcome) && state.current.open && Number.isFinite(state.current.elapsedMs) && row.cleanupStatus === 'complete' && !row.observerError && state.current.observationIntegrity === 'valid' && !state.diagnosticStreamInvalid;
						if (admissibleProductFailure) {
						state.primeFailedRowId = state.current.attemptId;
						state.primeFailureAdmissible = true;
					} else {
						state.current.harnessStatus = state.current.harnessStatus === 'ok' ? 'observer-error' : state.current.harnessStatus;
						forceRequired = true;
					}
					}
				}
				if (state.current.cleanupLossAdmissible || state.current.harnessStatus !== 'ok' || state.current.warmContextLost || (state.primeFailedRowId && !state.primeFailureAdmissible)) forceRequired = true;
				const decision = !state.failure && state.current.harnessStatus === 'ok' && !state.current.cleanupLossAdmissible && !state.current.warmContextLost && !state.primeFailedRowId ? 'continue' : 'stop';
				sendAck(message.seq, decision);
				wake();
				return;
			}
			throw new Error('Unexpected attempt event: ' + message.type);
		}
		if (message.attemptId !== null && message.attemptId !== undefined) throw new Error(message.type + ' is a job-level event and must use attemptId=null.');
		if (lateAfterDeadline) {
			await appendEvent(message, { lateAfterDeadline: true });
			if (message.type === 'job-terminal') sendAck(message.seq, 'stop');
			wake();
			return;
		}
		if (message.type === 'connected') {
			await appendEvent(message);
			state.connected = true;
			state.lastHeartbeatAt = monotonicNow();
			wake();
			return;
		}
		if (message.type === 'environment-before') {
			state.environmentBefore = message.payload.environment || null;
			await appendEvent(message);
			wake();
			return;
		}
		if (message.type === 'environment-after') {
			state.environmentAfter = message.payload.environment || null;
			await appendEvent(message);
			wake();
			return;
		}
		if (message.type === 'job-terminal') {
			state.terminal = message.payload;
			terminalSeen = true;
			await appendEvent(message);
			const allowedPrimeFailure = message.payload.status === 'prime-failed' && state.primeFailureAdmissible && message.payload.lastAttemptId === state.primeFailedRowId;
			const allowedCleanupFailure = ['cleanup-failed', 'warm-context-lost'].includes(message.payload.status) && cleanupTerminalAdmissible(message.payload);
			if (message.payload.status !== 'ok' && !allowedPrimeFailure && !allowedCleanupFailure && !state.failure) fail('observer-error', 'Child job terminal reported ' + String(message.payload.status) + '.', 'job-terminal');
			if (allowedCleanupFailure) {
				forceRequired = true;
				await beginForcedReclamation('returned-attempt-cleanup-terminal');
			}
			sendAck(message.seq, allowedCleanupFailure || (message.payload.status !== 'ok' && !allowedPrimeFailure) ? 'stop' : 'continue');
			wake();
			return;
		}
		if (message.type === 'fatal-error') {
			await appendEvent(message, { lateAfterDeadline });
			if (state.forcedReclamationStarted && hasValidProductOutcome(state.current)) {
				state.teardownFatalAfterForce = true;
				await persistRecord({ recordType: 'teardown-observation', phase: 'fatal-error', attemptId: state.current?.attemptId ?? null, payload: message.payload, forcedReclamationStartedAtEpochMs: state.forcedReclamationStartedAtEpochMs });
				wake();
				return;
			}
			if (lateAfterDeadline) {
				wake();
				return;
			}
			fail('observer-error', message.payload.message || 'Child reported a fatal observer error.', 'child-fatal');
			return;
		}
		throw new Error('Unsupported job-level IPC event.');
	};

	const attachChild = () => {
		child.on('message', (message) => {
			const receivedAtMonotonicMs = monotonicNow();
			childChain = childChain.then(() => handleMessage(message, receivedAtMonotonicMs)).catch((error) => {
				fail('protocol-error', asError(error), 'ipc');
				void persistRecord({ recordType: 'harness-failure', kind: 'protocol-error', message: asError(error) }).catch(() => {});
			});
		});
		child.on('error', (error) => fail('observer-error', asError(error), 'child-process'));
		child.on('exit', (code, signal) => {
			childExit = true;
			if (!terminalSeen && state.forcedReclamationStarted && hasValidProductOutcome(state.current)) {
				teardownObservationWrite = teardownObservationWrite.then(() => persistRecord({ recordType: 'teardown-observation', phase: 'child-exit', code, signal, attemptId: state.current?.attemptId ?? null, forcedReclamationStartedAtEpochMs: state.forcedReclamationStartedAtEpochMs })).catch((error) => {
					if (!state.failure) fail('observer-error', 'Could not persist child teardown exit observation: ' + asError(error), 'ledger-write');
				});
			} else if (!terminalSeen && !state.failure) fail('observer-error', 'Child exited before durable job-terminal.', 'child-exit');
			wake();
		});
		child.stdout?.on('data', (chunk) => { receipt.stdoutTail = (receipt.stdoutTail + chunk.toString('utf8')).slice(-16_384); });
		child.stderr?.on('data', (chunk) => { receipt.stderrTail = (receipt.stderrTail + chunk.toString('utf8')).slice(-16_384); });
	};

	try {
		if (typeof run.isInterrupted === 'function' && run.isInterrupted()) throw new Error('Parent received SIGINT/SIGTERM before this owned sandbox was started.');
		if (process.platform !== 'win32') throw new Error('Isolated supervisor requires the frozen Windows process ownership helper.');
		if (!existsSync(childEntry) || !existsSync(SNAPSHOT_SCRIPT)) throw new Error('Fixed child or read-only Windows process snapshot helper is missing.');
		server = await chromium.launchServer({
			headless: true,
			args: [...BROWSER_LAUNCH_ARGS],
			host: '127.0.0.1',
			port: 0,
			timeout: selectedBudgets.launchMs,
			handleSIGINT: false,
			handleSIGTERM: false,
			handleSIGHUP: false
		});
		browserHandle = server.process();
		if (!browserHandle) throw new Error('Playwright BrowserServer did not expose its public process handle.');
		const profileArgs = browserHandle.spawnargs.filter((arg) => /^--user-data-dir=/i.test(arg));
		if (profileArgs.length !== 1) throw new Error('Playwright BrowserServer process handle does not expose one generated profile argument.');
		const profilePath = profileArgs[0].slice(profileArgs[0].indexOf('=') + 1).replace(/^"|"$/g, '');
		const browserOwned = await establishOwnedIdentity(browserHandle, profilePath, selectedBudgets.processSnapshotMs);
		browserIdentity = browserOwned;
		receipt.snapshots.push({ phase: 'browser-root-established', snapshot: browserOwned.initialSnapshot });
		receipt.launch = { pid: browserOwned.expected.pid, identity: browserOwned.expected, spawnargs: browserOwned.expected.spawnargs, descendants: browserOwned.knownProcesses };
		await persistRecord({ recordType: 'ownership-event', phase: 'browser-root-established', identity: browserOwned.expected, snapshot: browserOwned.initialSnapshot });

		child = spawn(process.execPath, [childEntry], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, cwd: run.cwd || process.cwd() });
		attachChild();
		await new Promise((resolve, reject) => {
			if (child.pid) { childSpawned = true; resolve(); return; }
			child.once('spawn', () => { childSpawned = true; resolve(); });
			child.once('error', reject);
		});
		const childOwned = await establishOwnedIdentity(child, '', selectedBudgets.processSnapshotMs);
		childIdentity = childOwned;
		receipt.snapshots.push({ phase: 'child-root-established', snapshot: childOwned.initialSnapshot });
		receipt.child = { pid: childOwned.expected.pid, identity: childOwned.expected, descendants: childOwned.knownProcesses };
		const browserAfterChild = await readProcessSnapshot({
			pid: browserOwned.expected.pid,
			creationUtc: browserOwned.expected.creationUtc,
			profilePath: browserOwned.expected.profilePath,
			parentPid: browserOwned.expected.parentPid,
			timeoutMs: selectedBudgets.processSnapshotMs
		});
		if (!matchOwnedRootIdentity(browserAfterChild, browserOwned.expected)) throw new Error('Browser root ownership changed before the child was started.');
		receipt.snapshots.push({ phase: 'browser-tree-after-child-start', snapshot: browserAfterChild });
		browserIdentity.knownProcesses = pushKnown(browserIdentity.knownProcesses, browserAfterChild.descendants);
		await persistRecord({ recordType: 'ownership-event', phase: 'child-root-established', browserSnapshot: browserAfterChild, childSnapshot: childOwned.initialSnapshot, childIdentity: childOwned.expected });

		const { isInterrupted: _isInterrupted, ...childRun } = run;
		child.send({
			protocol: IPC_PROTOCOL,
			runToken,
			jobToken,
			attemptId: null,
			seq: 0,
			type: 'job',
			payload: { wsEndpoint: server.wsEndpoint(), job, run: childRun }
		});
		const connectedAndReady = await waitUntil(() => state.connected && state.environmentBefore, selectedBudgets.connectMs, 'connect and before-environment', false);
		if (!connectedAndReady) {
			if (!state.failure) fail('observer-error', 'Child did not connect and report before-environment within the frozen bound.', 'connect');
			throw new Error(state.failure.message);
		}
		if (run.expectedEnvironment && JSON.stringify(state.environmentBefore) !== JSON.stringify(stableEnvironment(run.expectedEnvironment))) {
			fail('identity-error', 'Child before-environment differs from the run-accepted WebGL/Chromium environment.', 'environment-before');
			throw new Error(state.failure.message);
		}

		const attemptIds = expectedJobAttemptIds(job);
		for (const attemptId of attemptIds) {
			if (state.failure || forceRequired || state.primeFailedRowId || state.warmContextLostBy) break;
			const entered = await waitUntil(() => state.current?.attemptId === attemptId, selectedBudgets.attemptOpenMs, 'attempt-entered', true);
			if (!entered) {
				if (!state.failure) fail('setup-error', 'Attempt did not enter before the attempt-to-Open guard.', 'attempt-entered');
				break;
			}
			const current = state.current;
			const opened = await waitUntil(() => current.open !== null || current.appOutcome?.kind === 'setup-error', selectedBudgets.attemptOpenMs, 'attempt entered to Open', true);
			if (!opened) {
				if (!state.failure) fail('setup-error', 'Attempt did not emit an Open clock within the frozen bound.', 'open');
				current.failure = state.failure;
				current.harnessStatus = state.failure.kind;
				current.observationIntegrity = 'observer-unavailable';
				actualRow = makeActualRow(job, current, null);
				break;
			}
			if (!current.open && current.appOutcome?.kind === 'setup-error') {
				const gotEvidence = await waitUntil(() => Boolean(current.evidence), selectedBudgets.outcomeEvidenceMs, 'setup error evidence', true);
				if (gotEvidence) await waitUntil(() => Boolean(current.result), selectedBudgets.evidenceResultMs, 'setup error result', true);
			} else {
				const openAge = Math.max(0, epochNow() - current.open.epochMs);
				const outcomeAllowance = selectedBudgets.openOutcomeMs + selectedBudgets.deliveryAllowanceMs;
				const remainingOutcomeMs = Math.max(0, outcomeAllowance - openAge);
				const outcomeReceived = await waitUntil(() => Boolean(current.appOutcome), remainingOutcomeMs, 'Open to app outcome', true);
				if (!outcomeReceived && !state.failure) {
					const heartbeatHealthy = state.lastHeartbeatAt !== null && monotonicNow() - state.lastHeartbeatAt <= selectedBudgets.heartbeatMaxGapMs && processAlive(child);
					if (heartbeatHealthy) {
						productDeadline = true;
						productDeadlineMonotonicMs = monotonicNow();
						current.outcomeStatus = 'timeout';
						current.elapsedMs = selectedBudgets.openOutcomeMs;
						current.actualObservedElapsedMs = Math.max(0, epochNow() - current.open.epochMs);
						current.deadlineBudgetMs = selectedBudgets.openOutcomeMs;
						current.censoredAtDeadline = true;
						current.parentDeadline = { kind: 'open-outcome-deadline', limitMs: selectedBudgets.openOutcomeMs, firedAtEpochMs: epochNow(), deliveryAllowanceMs: selectedBudgets.deliveryAllowanceMs };
						current.appOutcome = { kind: 'timeout', text: 'Parent open-to-outcome deadline fired while the child heartbeat remained responsive.', elapsedMs: selectedBudgets.openOutcomeMs, observedAtEpochMs: epochNow(), censoredAtDeadline: true };
						if (job.kind === 'warm' && state.primePassed && !current.prime) {
							current.warmContextLost = true;
							state.warmContextLostBy = attemptId;
						}
						forceRequired = true;
						await beginForcedReclamation('open-outcome-deadline');
						await persistRecord({ recordType: 'parent-deadline', attemptId, phase: 'open-outcome', limitMs: selectedBudgets.openOutcomeMs, actualObservedElapsedMs: current.actualObservedElapsedMs, childResponsive: true });
					} else {
						fail('observer-error', 'Child stopped heartbeating before an app outcome; no synthetic application timeout is permitted.', 'heartbeat');
						current.harnessStatus = 'observer-error';
						current.observationIntegrity = 'observer-unavailable';
						current.failure = state.failure;
					}
				}
				if (!forceRequired && !state.failure) {
					const gotEvidence = await waitUntil(() => Boolean(current.evidence), selectedBudgets.outcomeEvidenceMs, 'app outcome to evidence', true);
					if (!gotEvidence && !state.failure) fail('observer-error', 'Child did not provide evidence within its independent evidence guard.', 'evidence');
					if (!state.failure) {
						const gotResult = await waitUntil(() => Boolean(current.result), selectedBudgets.evidenceResultMs, 'evidence to attempt-result', true);
						if (!gotResult && !state.failure) fail('observer-error', 'Child did not provide a durable attempt-result within its independent result guard.', 'attempt-result');
					}
				}
			}
			if (state.failure || forceRequired) {
				if (state.failure) {
					current.harnessStatus = state.failure.kind;
					current.failure = state.failure;
					if (state.failure.kind === 'observer-error') current.observationIntegrity = 'observer-unavailable';
				}
				current.failure = state.failure;
				actualRow = makeActualRow(job, current, null);
				break;
			}
			actualRow = makeActualRow(job, current, null);
		}

		const cleanupTerminalExpected = Boolean(state.current?.cleanupLossAdmissible);
		if ((!forceRequired || cleanupTerminalExpected) && !state.failure) {
			const terminal = await waitUntil(
				() => Boolean(state.terminal) || (state.forcedReclamationStarted && childExit && hasValidProductOutcome(state.current)) || (state.forcedReclamationStarted && state.teardownFatalAfterForce && hasValidProductOutcome(state.current)),
				selectedBudgets.jobTerminalMs,
				'job terminal',
				true
			);
			if (!terminal && !state.failure) fail('observer-error', 'Child did not report job-terminal within the frozen bound.', 'job-terminal');
			if (state.terminal && !state.failure) {
				const allowedPrimeFailure = state.terminal.status === 'prime-failed' && state.primeFailureAdmissible && state.terminal.lastAttemptId === state.primeFailedRowId;
				const allowedCleanupFailure = ['cleanup-failed', 'warm-context-lost'].includes(state.terminal.status) && cleanupTerminalAdmissible(state.terminal);
				if (state.terminal.status !== 'ok' && !allowedPrimeFailure && !allowedCleanupFailure) {
					forceRequired = true;
					fail('observer-error', 'Child job terminal reported ' + String(state.terminal.status) + '.', 'job-terminal');
				}
				if (allowedCleanupFailure) forceRequired = true;
				if ((state.terminal.status === 'ok' || allowedPrimeFailure) && run.expectedEnvironment && JSON.stringify(state.environmentAfter) !== JSON.stringify(stableEnvironment(run.expectedEnvironment))) {
					fail('identity-error', 'Child after-environment differs from the run-accepted environment.', 'environment-after');
					forceRequired = true;
				}
			}
		}
	} catch (error) {
		if (!state.failure) fail('observer-error', asError(error), 'supervisor');
		forceRequired = true;
	}

	if (forceRequired || state.failure) await beginForcedReclamation(state.failure?.phase || 'forced-resource-cleanup');
	if (child && child.connected && forceRequired) {
		try { child.send({ type: 'stop', protocol: IPC_PROTOCOL, runToken, jobToken, decision: 'stop' }); } catch {}
	}
	if (server && browserHandle && browserIdentity) {
		const browserRecord = { identity: browserIdentity, handle: browserHandle };
		const childRecord = child && childIdentity ? { identity: childIdentity, handle: child } : null;
		if (!forceRequired && !state.failure && terminalSeen) {
			const childExited = await waitHandleExit(child, selectedBudgets.gracefulChildExitMs);
			if (!childExited) {
				forceRequired = true;
				serverCloseError = 'Child failed to exit after healthy terminal ACK.';
			}
			if (!forceRequired) {
				try {
					await waitForBounded(server.close(), selectedBudgets.terminationMs, 'BrowserServer graceful close');
				} catch (error) {
					serverCloseError = asError(error);
					forceRequired = true;
				}
			}
			if (!forceRequired) {
				const browserExited = await waitHandleExit(browserHandle, selectedBudgets.terminationMs);
				if (!browserExited) { serverCloseError = 'BrowserServer process did not exit after close.'; forceRequired = true; }
			}
		}
		if (forceRequired || state.failure) {
			await beginForcedReclamation(serverCloseError ? 'browser-server-close-fallback' : state.failure?.phase || 'forced-resource-cleanup');
			for (const record of [browserRecord, childRecord].filter(Boolean)) {
				try { await killVerifiedTree(record.identity, record.handle, processOps, receipt, record === childRecord ? selectedBudgets.childStopWaitMs : selectedBudgets.terminationMs, selectedBudgets.processSnapshotMs); }
				catch (error) {
					const message = asError(error);
					receipt.killFailures.push({ pid: record.identity.expected.pid, message });
					receipt.error = [receipt.error, message].filter(Boolean).join('; ');
				}
			}
		}
		const allRecords = [browserRecord, childRecord].filter(Boolean);
		const verified = await verifyOwnedGone(allRecords, receipt, selectedBudgets.resourceVerificationMs, selectedBudgets.processSnapshotMs).catch((error) => {
			receipt.error = receipt.error || asError(error);
			return false;
		});
		receipt.verified = verified && receipt.killFailures.length === 0;
		if (serverCloseError) {
			receipt.serverCloseError = serverCloseError;
			await persistRecord({ recordType: 'ownership-event', phase: 'server-close-error', message: serverCloseError });
		}
		if (state.failure?.kind === 'protocol-error' || state.failure?.kind === 'identity-error' || state.failure?.kind === 'observer-error' || state.failure?.kind === 'setup-error') receipt.resourceDisposition = receipt.verified ? 'forced-verified' : 'unverified';
		else if (forceRequired) receipt.resourceDisposition = receipt.verified ? 'forced-verified' : 'unverified';
		else receipt.resourceDisposition = receipt.verified ? 'graceful' : 'unverified';
		await persistRecord({
			recordType: 'ownership-event',
			phase: 'terminal-ownership-receipt',
			verified: receipt.verified,
			resourceDisposition: receipt.resourceDisposition,
			killCommands: receipt.killCommands,
			killFailures: receipt.killFailures,
			killedRootPids: receipt.killedRootPids,
			remainingOwnedProcesses: receipt.remainingOwnedProcesses
		}).catch((error) => { receipt.error = receipt.error || asError(error); receipt.verified = false; });
	} else {
		receipt.verified = false;
		receipt.resourceDisposition = 'unverified';
		receipt.error = receipt.error || 'No verifiable BrowserServer root handle was available.';
	}
	await teardownObservationWrite;

	let identityAudit = {
		before: state.environmentBefore,
		after: state.environmentAfter,
		proofKind: state.environmentAfter ? 'same-browser' : 'unavailable',
		valid: Boolean(state.environmentBefore && (
			run.expectedEnvironment
				? JSON.stringify(state.environmentBefore) === JSON.stringify(stableEnvironment(run.expectedEnvironment)) && state.environmentAfter && JSON.stringify(state.environmentAfter) === JSON.stringify(stableEnvironment(run.expectedEnvironment))
				: state.terminal?.status === 'ok' && JSON.stringify(state.environmentBefore) === JSON.stringify(state.environmentAfter)
		))
	};
	const serverCloseRecoveryEligible = Boolean(serverCloseError && state.completedAttempts.some((current) => hasValidProductOutcome(current, current.result?.row)));
	const recoveryEvidenceEligible = Boolean(
		state.current?.cleanupLossAdmissible
		|| (productDeadline && hasValidProductOutcome(state.current))
		|| state.warmContextLostBy
		|| serverCloseRecoveryEligible
	);
	const recoveryNeeded = job.kind !== 'environment-recovery' && receipt.verified && receipt.resourceDisposition === 'forced-verified' && !state.failure && Boolean(run.expectedEnvironment) && recoveryEvidenceEligible;
	if (recoveryNeeded) {
		const recovery = await superviseOwnedJob({
			job: { id: job.id + '-environment-recovery', kind: 'environment-recovery', attemptIds: [] },
			run,
			persist,
			budgets: { ...selectedBudgets, connectMs: PRODUCTION_BUDGETS.connectMs, jobTerminalMs: PRODUCTION_BUDGETS.jobTerminalMs },
			childEntry,
			processOps
		});
		const recoveryOkay = recovery.ownershipReceipt.verified && recovery.failure === null && recovery.identityAudit.valid;
		receipt.recoverySandbox = {
			jobId: job.id + '-environment-recovery',
			proofKind: 'recovery-sandbox',
			identityAudit: recovery.identityAudit,
			ownershipReceipt: recovery.ownershipReceipt,
			verified: recoveryOkay
		};
		await persistRecord({ recordType: 'ownership-event', phase: 'environment-recovery-receipt', recovery: receipt.recoverySandbox });
		if (recoveryOkay) identityAudit = { before: state.environmentBefore, after: recovery.identityAudit.before, proofKind: 'recovery-sandbox', valid: true, recovery: receipt.recoverySandbox };
		else {
			identityAudit = { before: state.environmentBefore, after: recovery.identityAudit.before || null, proofKind: 'recovery-sandbox', valid: false, recovery: receipt.recoverySandbox };
			state.failure = recovery.failure || { kind: 'identity-error', message: 'Fresh environment recovery sandbox did not prove the accepted environment and owned-process cleanup.', phase: 'environment-recovery', atEpochMs: epochNow() };
			if (!recovery.ownershipReceipt.verified) {
				receipt.verified = false;
				receipt.resourceDisposition = 'unverified';
			}
		}
	}
	const attempts = [...state.completedAttempts];
	if (state.current && !attempts.includes(state.current)) attempts.push(state.current);
	const rows = attempts.map((current) => {
		const row = makeActualRow(job, current, receipt);
		row.baseline = run.baseline || null;
		row.scenarioId = job.scenarioId || job.id;
		row.identityAudit = identityAudit;
		row.resourceDisposition = receipt.resourceDisposition;
		if (!receipt.verified) row.harnessStatus = 'cleanup-failed';
		else if ((current.cleanupLossAdmissible || current.censoredAtDeadline || current.warmContextLost) && identityAudit.valid && identityAudit.proofKind === 'recovery-sandbox' && !state.failure) row.harnessStatus = 'cleanup-recovered';
		if (serverCloseError && current === attempts.at(-1)) {
			row.cleanupStatus = 'failed';
			row.cleanupErrors = [...(row.cleanupErrors || []), serverCloseError];
			if (row.harnessStatus === 'ok' && receipt.verified && identityAudit.proofKind === 'recovery-sandbox' && identityAudit.valid && !state.failure) row.harnessStatus = 'cleanup-recovered';
			else if (row.harnessStatus === 'ok') row.harnessStatus = 'cleanup-failed';
		}
		return row;
	});
	for (const row of rows) {
		try { await persistRecord({ recordType: 'actual-row-finalized', row }); }
		catch (error) {
			receipt.error = asError(error);
			receipt.verified = false;
			row.harnessStatus = 'cleanup-failed';
			row.resourceDisposition = 'unverified';
			state.failure = { kind: 'observer-error', message: receipt.error, phase: 'ledger-write', atEpochMs: epochNow() };
		}
	}
	let dispositions = [];
	if (job.kind === 'warm' && receipt.verified && identityAudit.valid && !state.failure && !state.diagnosticStreamInvalid) {
		if (state.primeFailureAdmissible || (productDeadline && state.current?.prime && state.current.observationIntegrity === 'valid')) {
			const cause = rows.find((row) => row.scenarioRowId === job.primeRowId);
			if (cause && ['ok', 'cleanup-recovered'].includes(cause.harnessStatus) && ['error', 'timeout', 'failed-no-valid-frame'].includes(cause.outcomeStatus)) {
				dispositions = buildBlockedWarmDispositions(job, 'blocked-prime-failed', cause.scenarioRowId, receipt);
			}
		} else if (state.warmContextLostBy && receipt.resourceDisposition === 'forced-verified') {
			const causeIndex = job.attemptRowIds.indexOf(state.warmContextLostBy);
			const cause = rows.find((row) => row.scenarioRowId === state.warmContextLostBy);
			const primeContextLossCause = state.primeContextLossAdmissible === true && state.warmContextLostBy === job.primeRowId && cause?.prime === true && cause.outcomeStatus === 'ready' && Boolean(cause.firstValidFrame) && cause.cleanupStatus === 'failed' && cause.harnessStatus === 'cleanup-recovered' && cause.resourceDisposition === 'forced-verified' && cause.ownershipReceipt?.recoverySandbox?.verified;
			if (primeContextLossCause) {
				dispositions = buildBlockedWarmDispositions(job, 'blocked-warm-context-lost', cause.scenarioRowId, receipt, 0);
			} else if (causeIndex >= 0 && cause?.harnessStatus === 'cleanup-recovered' && cause.cleanupStatus !== 'complete') {
				dispositions = buildBlockedWarmDispositions(job, 'blocked-warm-context-lost', cause.scenarioRowId, receipt, causeIndex + 1);
			}
		}
	}
	for (const disposition of dispositions) await persistRecord({ ...disposition });
	receipt.completedAtEpochMs = epochNow();
	const observationOkay = rows.length > 0 && rows.every((row) => row.observationIntegrity === 'valid');
	const collectionEligible = receipt.verified && identityAudit.valid && observationOkay && rows.every((row) => ['ok', 'cleanup-recovered'].includes(row.harnessStatus)) && !state.failure;
	return {
		rows,
		dispositions,
		identityAudit,
		ownershipReceipt: receipt,
		collectionEligible,
		nextJobAuthorized: receipt.verified,
		failure: state.failure,
		events: state.events,
		productDeadline,
		primeFailureAdmissible: dispositions.some((item) => item.reason === 'blocked-prime-failed'),
		warmContextLost: dispositions.some((item) => item.reason === 'blocked-warm-context-lost')
	};
}

function rowIdentity(row) { return row?.scenarioRowId ?? row?.id ?? null; }

function receiptIsValid(receipt) {
	if (!receipt || receipt.verified !== true || !['graceful', 'forced-verified'].includes(receipt.resourceDisposition)) return false;
	if (receipt.resourceDisposition === 'forced-verified' && receipt.recoverySandbox && receipt.recoverySandbox.verified !== true) return false;
	return true;
}

function validateDisposition(disposition, matrix, actualById) {
	const errors = [];
	const scenario = matrix.scenarios.find((item) => item.mode === 'warm' && item.attemptRowIds.includes(disposition?.scenarioRowId));
	const cause = actualById.get(disposition?.blockedByRowId);
	if (!scenario) errors.push('disposition ID is not a warm measured ID');
	if (!cause) errors.push('disposition cause row is missing');
	if (disposition?.recordType !== 'disposition' || disposition?.openOccurred !== false || disposition?.startedAtEpochMs !== null || disposition?.elapsedMs !== null || disposition?.firstValidFrame !== null || disposition?.excludedFromTiming !== true) errors.push('disposition carries attempt timing/frame fields or wrong record type');
	if (!receiptIsValid(disposition?.ownershipReceipt)) errors.push('disposition ownership/recovery receipt is incomplete');
	if (cause && scenario && cause.jobId !== disposition.jobId) errors.push('disposition cause belongs to a different sandbox job');
	if (disposition?.reason === 'blocked-prime-failed') {
		if (!scenario || disposition.blockedByRowId !== scenario.primeRowId) errors.push('prime-failed disposition does not reference its scenario prime');
		if (!cause || !['error', 'timeout', 'failed-no-valid-frame'].includes(cause.outcomeStatus) || !['ok', 'cleanup-recovered'].includes(cause.harnessStatus) || cause.observationIntegrity !== 'valid') errors.push('prime-failed cause is not a bounded admissible product outcome');
	} else if (disposition?.reason === 'blocked-warm-context-lost') {
		const primeIsContextLossCause = Boolean(scenario && disposition.blockedByRowId === scenario.primeRowId);
		if (!scenario || (!scenario.attemptRowIds.includes(disposition.blockedByRowId) && !primeIsContextLossCause)) errors.push('context-lost cause is neither an actual measured row nor the explicitly admissible ready-frame prime cleanup-loss cause');
		const prime = scenario ? actualById.get(scenario.primeRowId) : null;
		if (primeIsContextLossCause) {
			if (!prime || prime !== cause || prime.prime !== true || prime.outcomeStatus !== 'ready' || !prime.firstValidFrame || prime.cleanupStatus !== 'failed' || prime.harnessStatus !== 'cleanup-recovered' || prime.resourceDisposition !== 'forced-verified' || !prime.identityAudit?.valid || !prime.ownershipReceipt?.recoverySandbox?.verified) errors.push('prime context-loss cause lacks actual ready/frame, failed cleanup, cleanup recovery, and verified forced/recovery proof');
		} else {
			if (!prime || prime.outcomeStatus !== 'ready' || !prime.firstValidFrame || prime.cleanupStatus !== 'complete') errors.push('context-lost disposition lacks its successful actual prime');
			if (!cause || cause.harnessStatus !== 'cleanup-recovered' || cause.cleanupStatus === 'complete' || !cause.identityAudit?.valid || !cause.ownershipReceipt?.recoverySandbox?.verified) errors.push('context-lost cause lacks recovered page failure and fresh environment proof');
		}
		if (cause?.ownershipReceipt?.resourceDisposition !== 'forced-verified') errors.push('context-lost disposition lacks verified forced reclamation');
	} else errors.push('disposition reason is not one of the two frozen warm blocks');
	return errors;
}

export function summarizeIsolatedModel(matrix, actualRows, dispositions = []) {
	const summaries = {};
	const actualById = new Map(actualRows.map((row) => [rowIdentity(row), row]));
	const dispositionIds = new Set(dispositions.map(rowIdentity));
	for (const scenario of matrix.scenarios.filter((item) => item.kind === 'timing-series')) {
		const measuredIds = scenario.attemptRowIds;
		const rows = measuredIds.map((id) => actualById.get(id)).filter(Boolean);
		const timedRows = rows.map((row) => ({
			...row,
			compatibilityStatus: row.status,
			status: row.outcomeStatus ?? (row.harnessStatus === 'setup-error' ? 'setup-error' : 'failed'),
			openOccurred: row.openOccurred === true,
			startedAtEpochMs: row.startedAtEpochMs,
			elapsedMs: row.elapsedMs
		}));
		const summary = summarizeTimingRows(timedRows, scenario.expectedAttempts);
		const blockedIds = measuredIds.filter((id) => dispositionIds.has(id));
		const missingIds = measuredIds.filter((id) => !actualById.has(id) && !dispositionIds.has(id));
		const prime = scenario.primeRowId ? actualById.get(scenario.primeRowId) : null;
		const primePassed = !scenario.primeRowId || Boolean(prime?.outcomeStatus === 'ready' && prime.firstValidFrame && prime.harnessStatus === 'ok' && prime.cleanupStatus === 'complete' && prime.observationIntegrity === 'valid' && prime.identityAudit?.valid && receiptIsValid(prime.ownershipReceipt));
		const integrityValid = timedRows.every((row) => row.observationIntegrity === 'valid' && row.identityAudit?.valid && receiptIsValid(row.ownershipReceipt) && ['ok', 'cleanup-recovered'].includes(row.harnessStatus));
		const percentileEligible = summary.completedRowCount === scenario.expectedAttempts && summary.invalidOrMissingDurationCount === 0 && summary.missingOpenClockCount === 0 && integrityValid && blockedIds.length === 0 && missingIds.length === 0 && primePassed;
		if (!percentileEligible) {
			summary.p50Ms = null;
			summary.p95Ms = null;
			summary.minMs = null;
			summary.maxMs = null;
		}
		summary.seriesId = scenario.id;
		summary.primeRowId = scenario.primeRowId;
		summary.primePassed = primePassed;
		summary.blockedRowIds = blockedIds;
		summary.missingRowIds = missingIds;
		summary.percentileEligible = percentileEligible;
		summary.deadlineCensoredObservationCount = rows.filter((row) => row.censoredAtDeadline === true || row.outcomeStatus === 'timeout' && row.elapsedMs === PRODUCTION_BUDGETS.openOutcomeMs).length;
		summary.latencyInterpretation = summary.deadlineCensoredObservationCount
			? 'Includes deadline-censored observations at the 120,000ms application limit; these are not successful load latencies.'
			: 'Outcome-clock durations include valid failed application observations; no success-only filtering was applied.';
		summary.seriesPass = summary.seriesPass && percentileEligible && primePassed && rows.every((row) => row.outcomeStatus === 'ready');
		summary.compatibilityStatuses = rows.map((row) => ({ id: rowIdentity(row), status: row.status, outcomeStatus: row.outcomeStatus, harnessStatus: row.harnessStatus }));
		summaries[scenario.id] = summary;
	}
	const strict = evaluateModelAcceptance(matrix, actualRows, summaries);
	const isolatedRowsValid = actualRows.length > 0 && actualRows.every((row) => row.observationIntegrity === 'valid' && row.identityAudit?.valid && receiptIsValid(row.ownershipReceipt) && row.harnessStatus === 'ok');
	return {
		summaries,
		strictAcceptance: strict,
		modelPass: strict.pass && isolatedRowsValid && dispositions.length === 0,
		actualMatrixAudit: strict.matrixAudit,
		isolatedRowsValid
	};
}

export function evaluateCollectionCoverage(matrix, actualRows, dispositions, receipts = []) {
	const expected = matrix.expectedRowIds;
	const actualMatrixAudit = verifyScenarioRows(actualRows, expected);
	const actualById = new Map(actualRows.map((row) => [rowIdentity(row), row]));
	const unionById = new Map();
	const duplicateIds = [];
	const unknownIds = [];
	for (const row of actualRows) {
		const id = rowIdentity(row);
		if (!expected.includes(id)) unknownIds.push(id);
		if (unionById.has(id)) duplicateIds.push(id);
		unionById.set(id, 'actual');
	}
	const dispositionErrors = [];
	for (const row of dispositions) {
		const id = rowIdentity(row);
		if (!expected.includes(id)) unknownIds.push(id);
		if (unionById.has(id)) duplicateIds.push(id);
		unionById.set(id, 'disposition');
		dispositionErrors.push(...validateDisposition(row, matrix, actualById).map((message) => `${id}: ${message}`));
	}
	const missingRowIds = expected.filter((id) => !unionById.has(id));
	const coverageComplete = expected.length > 0 && unionById.size === expected.length && duplicateIds.length === 0 && unknownIds.length === 0 && missingRowIds.length === 0;
	const coverageAudit = { expectedRowCount: expected.length, actualRowCount: actualRows.length, dispositionCount: dispositions.length, coveredRowCount: unionById.size, duplicateIds, unknownIds, missingRowIds, coverageComplete };
	const jobList = buildIsolationJobs(matrix);
	const inferredReceipts = receipts.length ? receipts : [...new Map([...actualRows, ...dispositions].filter((row) => row.ownershipReceipt).map((row) => [row.jobId, row.ownershipReceipt])).entries()].map(([jobId, receipt]) => ({ jobId, ...receipt }));
	const receiptByJob = new Map(inferredReceipts.map((receipt) => [receipt.jobId, receipt]));
	const missingReceiptJobs = jobList.filter((job) => !receiptIsValid(receiptByJob.get(job.id))).map((job) => job.id);
	const identityFailures = [...actualRows, ...dispositions].filter((row) => row.identityAudit?.valid !== true && row.ownershipReceipt?.resourceDisposition !== 'graceful').map(rowIdentity);
	const jobOwnershipComplete = missingReceiptJobs.length === 0 && identityFailures.length === 0;
	const harnessFailureCount = actualRows.filter((row) => !['ok', 'cleanup-recovered'].includes(row.harnessStatus)).length;
	const actualOpenCount = actualRows.filter((row) => row.openOccurred === true && Number.isFinite(row.startedAtEpochMs)).length;
	const blockedWarmCount = dispositions.length;
	const outcomeCounts = {
		ready: actualRows.filter((row) => row.outcomeStatus === 'ready').length,
		timeout: actualRows.filter((row) => row.outcomeStatus === 'timeout').length,
		error: actualRows.filter((row) => row.outcomeStatus === 'error').length,
		failedAfterOpen: actualRows.filter((row) => row.outcomeStatus === 'failed-after-open').length,
		failedNoValidFrame: actualRows.filter((row) => row.outcomeStatus === 'failed-no-valid-frame').length,
		setupError: actualRows.filter((row) => row.outcomeStatus === 'setup-error').length
	};
	const modelSummary = summarizeIsolatedModel(matrix, actualRows, dispositions);
	const allThreeB0 = matrix.baseline === 'B0' && matrix.appIds.join(',') === APPS.map((item) => item.id).join(',') && matrix.fixtureIds.join(',') === FIXTURE_IDS.join(',');
	const mandatoryActualIds = matrix.scenarios.flatMap((scenario) => scenario.kind === 'expected-rejection' || scenario.mode === 'cold' || scenario.mode === 'warm' ? (scenario.primeRowId ? [scenario.primeRowId] : []).concat(scenario.kind === 'expected-rejection' || scenario.mode === 'cold' ? scenario.attemptRowIds : []) : []);
	const mandatoryActualValid = mandatoryActualIds.every((id) => {
		const row = actualById.get(id);
		return Boolean(row && row.openOccurred === true && Number.isFinite(row.startedAtEpochMs) && Number.isFinite(row.elapsedMs) && row.observationIntegrity === 'valid' && ['ok', 'cleanup-recovered'].includes(row.harnessStatus));
	});
	const rejectionRows = matrix.scenarios.filter((scenario) => scenario.kind === 'expected-rejection').map((scenario) => actualById.get(scenario.attemptRowIds[0]));
	const rejectionsValid = rejectionRows.every((row) => row?.status === 'expected-rejection' && row.rejectionMessageMatchesB0 === true && row.firstValidFrame === null);
	const allRowsValid = actualRows.every((row) => row.observationIntegrity === 'valid' && row.identityAudit?.valid === true && receiptIsValid(row.ownershipReceipt) && ['ok', 'cleanup-recovered'].includes(row.harnessStatus));
	const collectionEvidencePass = allThreeB0 && coverageComplete && dispositionErrors.length === 0 && mandatoryActualValid && rejectionsValid && allRowsValid && jobOwnershipComplete && harnessFailureCount === 0;
	const strictEvidencePass = matrix.baseline !== 'B0' && actualMatrixAudit.matrixComplete && modelSummary.modelPass && allRowsValid && jobOwnershipComplete;
	return {
		actualMatrixAudit,
		actualAttemptMatrixComplete: actualMatrixAudit.matrixComplete,
		coverageAudit,
		coverageComplete,
		actualAttemptCount: actualRows.length,
		actualOpenCount,
		blockedWarmCount,
		missingCount: missingRowIds.length,
		harnessFailureCount,
		outcomeCounts,
		dispositionErrors,
		missingReceiptJobs,
		jobOwnershipComplete,
		collectionEvidencePass: matrix.baseline === 'B0' ? collectionEvidencePass : strictEvidencePass,
		modelPass: modelSummary.modelPass,
		modelAcceptance: modelSummary.strictAcceptance,
		modelSummaries: modelSummary.summaries,
		allThreeB0
	};
}

const EXPECTED_S2_SOURCE_COUNTS = Object.freeze({ materials: 48, tags: 19, meshes: 80, faces: 7078, definitions: 106, instances: 122, transforms: 101, textures: 14, edges: 14354 });

function sameCountObject(actual, expected) {
	return Boolean(actual && typeof actual === 'object' && Object.keys(expected).every((key) => actual[key] === expected[key]));
}

function diagnosticCaseSummary(spec, row) {
	if (!row) return { ...spec, actual: false, status: 'missing', acceptance: { pass: false, reason: 'actual diagnostic case is missing' } };
	const events = (row.diagnosticStreamEvents || []).filter((event) => event.streamToken === row.diagnosticStreamToken);
	const diagnosticMode = spec.mode;
	const workerAudit = workerTraceAudit({ ...row, diagnostic: { events } }, diagnosticMode);
	const workerPhase = diagnosticMode === 'native' ? 'native-worker' : 'wrapped-worker';
	const matched = events.filter((event) => event.phase === workerPhase);
	const workerId = matched.length === 1 ? matched[0].workerId : null;
	const unmatchedPhase = diagnosticMode === 'native' ? 'native-unmatched-worker' : 'unmatched-worker';
	const unmatchedCount = events.filter((event) => event.phase === unmatchedPhase).length;
	const streamErrors = [...(row.diagnosticStreamErrors || [])];
	const diagnosticErrors = [...(row.diagnosticErrors || []), ...streamErrors];
	const input = events.find((event) => event.phase === 'worker-input' && event.workerId === workerId) || null;
	const moduleReady = events.find((event) => event.phase === 'worker-module-ready' && event.workerId === workerId) || null;
	const expectedFile = path.basename(row.fixtureLocator || row.fixture?.locator || '');
	const replies = events.filter((event) => ['worker-pre-post', 'worker-post-return', 'main-receive', 'native-main-receive'].includes(event.phase) && event.type === 'complete' && event.workerId === workerId);
	const inputId = input?.id;
	const completeMainReceipt = diagnosticMode === 'native'
		? events.find((event) => event.phase === 'native-main-receive' && event.type === 'complete' && event.workerId === workerId && Number.isInteger(event.id)) || null
		: events.find((event) => event.phase === 'main-receive' && event.type === 'complete' && event.workerId === workerId && event.id === inputId) || null;
	const replyIdsMatch = diagnosticMode === 'native'
		? Boolean(completeMainReceipt && Number.isInteger(completeMainReceipt.id))
		: Number.isInteger(inputId) && replies.every((event) => event.id === inputId);
	const completePrePost = events.find((event) => event.phase === 'worker-pre-post' && event.type === 'complete' && event.workerId === workerId && event.id === inputId) || null;
	const completeReturn = events.find((event) => event.phase === 'worker-post-return' && event.type === 'complete' && event.workerId === workerId && event.id === inputId) || null;
	const sourceNameCorrect = diagnosticMode !== 'wrapped' || Boolean(input && expectedFile && input.sourceName === expectedFile && input.byteLength === row.fixtureBytes);
	let moduleIdentityValid = false;
	try {
		moduleIdentityValid = Boolean(moduleReady && matched.length === 1 && moduleReady.url === matched[0].url && /\/\_app\/immutable\/workers\/e4-import\.worker[^/]*\.js$/.test(new URL(moduleReady.url).pathname));
	} catch {}
	const inputIdentityValid = diagnosticMode !== 'wrapped' || Boolean(input && input.type === 'load' && Number.isInteger(input.id) && sourceNameCorrect && moduleIdentityValid);
	const secondaryWorkersValid = workerAudit.secondaryWorkers.every((worker) => {
		try { return spec.appId === 'rooms' && worker.workerKind === 'rooms-analysis' && new URL(worker.url).origin === new URL(matched[0]?.url).origin && /\/\_app\/immutable\/workers\/rooms-analysis\.worker[^/]*\.js$/.test(new URL(worker.url).pathname); }
		catch { return false; }
	});
	const streamValid = !row.diagnosticStreamErrors?.length && events.every((event) => typeof event.phase === 'string' && Number.isFinite(event.epochMs));
	const timelyOpen = row.openOccurred === true && Number.isFinite(row.startedAtEpochMs) && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && row.elapsedMs <= PRODUCTION_BUDGETS.openOutcomeMs;
	const appReadyAndFrame = row.outcomeStatus === 'ready' && Boolean(row.firstValidFrame);
	const ownershipClean = receiptIsValid(row.ownershipReceipt) && row.identityAudit?.valid === true && ['ok', 'cleanup-recovered'].includes(row.harnessStatus);
	const isS2Native = spec.appId === 'editor' && spec.fixtureId === 'S2-jcm' && diagnosticMode === 'native';
	const isS2Wrapped = spec.appId === 'editor' && spec.fixtureId === 'S2-jcm' && diagnosticMode === 'wrapped';
	const isRoomsYOld = spec.appId === 'rooms' && spec.fixtureId === 'Y-old' && diagnosticMode === 'wrapped';
	const isRoomsS2 = spec.appId === 'rooms' && spec.fixtureId === 'S2-jcm' && diagnosticMode === 'wrapped';
	const isLold = spec.appId === 'editor' && spec.fixtureId === 'L-old' && diagnosticMode === 'wrapped';
	const counts = workerAudit.runtimeCounts;
	const sourceCountsMatchS2 = !(isS2Wrapped || isRoomsS2) || sameCountObject(counts?.sourceCounts, EXPECTED_S2_SOURCE_COUNTS) && counts?.resultFacesLength === 270 && counts?.preparedRuntimeSceneGroupsLength === 291;
	const adaptedCountsPresent = diagnosticMode !== 'wrapped' || Boolean(Number.isInteger(counts?.resultFacesLength) && Number.isInteger(counts?.preparedRuntimeSceneGroupsLength) && counts.sourceCounts && typeof counts.sourceCounts === 'object');
	const completeReplyPhases = diagnosticMode === 'native' ? Boolean(completeMainReceipt && replyIdsMatch) : Boolean(completePrePost && completeReturn && completeMainReceipt && replyIdsMatch);
	const workerLifecycle = diagnosticMode === 'native' ? Boolean(workerAudit.completeLifecycle && completeMainReceipt) : Boolean(workerAudit.completeLifecycle && completeReplyPhases);
	const captureErrors = (row.diagnosticErrors || []).filter((error) => /^(Diagnostic collection|Trace stop) exceeded the \d+ms Node watchdog\.$/.test(error));
	const nonCaptureErrors = (row.diagnosticErrors || []).filter((error) => !captureErrors.includes(error));
	const commonEvidenceValid = timelyOpen && matched.length === 1 && unmatchedCount === 0 && secondaryWorkersValid && workerAudit.importErrorCount === 0 && inputIdentityValid && replyIdsMatch && streamValid && diagnosticErrors.length === captureErrors.length && nonCaptureErrors.length === 0 && ownershipClean;
	const boundedOutcomeValid = ['ready', 'error', 'timeout', 'failed-no-valid-frame'].includes(row.outcomeStatus);
	const readyEvidenceValid = row.outcomeStatus !== 'ready' || appReadyAndFrame && workerLifecycle && adaptedCountsPresent;
	const boundedDiagnostic = commonEvidenceValid && boundedOutcomeValid && readyEvidenceValid;
	const boundedLoldDiagnostic = isLold ? boundedDiagnostic : null;
	const pass = isS2Native || isS2Wrapped || isRoomsS2
		? commonEvidenceValid && appReadyAndFrame && workerLifecycle && sourceCountsMatchS2 && adaptedCountsPresent
		: boundedDiagnostic;
	const phases = new Set(events.map((event) => event.phase));
	const lastObserved = events.filter((event) => Number.isFinite(event.epochMs)).reduce((latest, event) => !latest || event.epochMs > latest.epochMs ? event : latest, null);
	const runtimeCountFailureReason = row.outcomeStatus === 'ready' && !adaptedCountsPresent ? 'successful output did not expose plain adapted/source counts' : row.outcomeStatus !== 'ready' ? `successful output unavailable: ${row.outcomeStatus}` : null;
	return {
		...spec,
		actual: true,
		status: row.outcomeStatus,
		elapsedMs: row.elapsedMs,
		tracePath: row.tracePath || null,
		postmortemCaptureUnavailable: captureErrors.length || row.outcomeStatus === 'timeout' && !row.tracePath ? { value: true, reason: captureErrors.join('; ') || 'renderer was reclaimed before final page/trace capture' } : { value: false, reason: null },
		workerTraceAudit: workerAudit,
		diagnosticStreamEvents: events,
		diagnosticStreamIdentity: { streamToken: row.diagnosticStreamToken || null, workerId, matchedWorkerCount: matched.length, unmatchedWorkerCount: unmatchedCount, eventCount: events.length, streamValid },
		inputIdentity: input ? { type: input.type, id: input.id, sourceName: input.sourceName ?? null, byteLength: input.byteLength ?? null, sourceNameCorrect } : null,
		moduleReady: moduleReady ? { url: moduleReady.url, epochMs: moduleReady.epochMs } : null,
		progressObservations: events.filter((event) => event.phase === 'worker-progress').map(({ id, stage, completed, total, unit, epochMs }) => ({ id, stage, completed, total, unit, epochMs })),
		completeLifecycleObservations: {
			prePostEpochMs: completePrePost?.epochMs ?? null,
			postReturnEpochMs: completeReturn?.epochMs ?? null,
			mainReceiptEpochMs: completeMainReceipt?.epochMs ?? null,
			missingPhases: [!completePrePost && 'worker-pre-post', !completeReturn && 'worker-post-return', !completeMainReceipt && 'main-receive'].filter(Boolean)
		},
		lastObservedPhase: lastObserved ? { phase: lastObserved.phase, epochMs: lastObserved.epochMs, workerId: lastObserved.workerId, realm: lastObserved.realm } : null,
		phaseAbsence: ['worker-input', 'worker-module-ready', 'worker-progress', 'worker-pre-post', 'worker-post-return', 'main-receive'].filter((phase) => !phases.has(phase)),
		sourceOwnership: completePrePost?.graph ? {
			sourceBufferRetainedBytes: completePrePost.graph.sourceBufferRetainedBytes ?? null,
			sourceBufferInTransferList: completePrePost.graph.sourceBufferInTransferList ?? null,
			graphIncludesSourceBuffer: completePrePost.graph.graphIncludesSourceBuffer ?? null,
			transferBufferCount: completePrePost.graph.transferBufferCount ?? null,
			transferBytes: completePrePost.graph.transferBytes ?? null,
			runtimeCounts: completePrePost.graph.runtimeCounts ?? null
		} : null,
		runtimeCounts: counts,
		runtimeCountFailureReason,
		acceptance: {
			appReadyAndValidFrame: appReadyAndFrame,
			workerMatchedExactlyOnce: matched.length === 1,
			noUnmatchedWorker: unmatchedCount === 0,
			secondaryWorkersValid,
			inputIdentityValid,
			noWorkerImportError: workerAudit.importErrorCount === 0,
			completeWorkerLifecycle: workerLifecycle,
			boundedLoldDiagnostic,
			boundedRoomsYOldDiagnostic: isRoomsYOld ? boundedDiagnostic : null,
			runtimeCountsCaptured: adaptedCountsPresent,
			sourceCountsMatchPinnedS2: sourceCountsMatchS2,
			identityStable: row.identityAudit?.valid === true,
			cleanupComplete: receiptIsValid(row.ownershipReceipt),
			streamValid,
			pass: Boolean(pass)
		}
	};
}

export function summarizeIsolatedDiagnostics(expectedSpecs, rows) {
	const rowById = new Map(rows.map((row) => [rowIdentity(row), row]));
	const cases = expectedSpecs.map((spec) => diagnosticCaseSummary(spec, rowById.get(spec.id)));
	const lOld = cases.find((item) => item.appId === 'editor' && item.fixtureId === 'L-old' && item.mode === 'wrapped');
	const s2Native = cases.find((item) => item.appId === 'editor' && item.fixtureId === 'S2-jcm' && item.mode === 'native');
	const s2Wrapped = cases.find((item) => item.appId === 'editor' && item.fixtureId === 'S2-jcm' && item.mode === 'wrapped');
	const roomsYOld = cases.find((item) => item.appId === 'rooms' && item.fixtureId === 'Y-old' && item.mode === 'wrapped');
	const roomsS2 = cases.find((item) => item.appId === 'rooms' && item.fixtureId === 'S2-jcm' && item.mode === 'wrapped');
	const runtimeCountAudit = cases.filter((item) => item.mode === 'wrapped' && SUPPORTED_IDS.includes(item.fixtureId)).map((item) => ({
		appId: item.appId,
		fixtureId: item.fixtureId,
		status: item.status,
		runtimeCounts: item.runtimeCounts,
		captured: item.acceptance.runtimeCountsCaptured,
		reason: item.runtimeCountFailureReason
	}));
	const controlsPass = Boolean(s2Native?.acceptance.pass && s2Wrapped?.acceptance.pass && roomsS2?.acceptance.pass);
	const fullScope = expectedSpecs.length === 13 && cases.length === 13 && cases.every((item) => item.actual);
	const lOldBoundedAndMatched = Boolean(lOld?.acceptance.boundedLoldDiagnostic && lOld.acceptance.workerMatchedExactlyOnce && lOld.acceptance.noUnmatchedWorker);
	const runtimeCountAuditComplete = runtimeCountAudit.length === expectedSpecs.filter((spec) => spec.mode === 'wrapped' && SUPPORTED_IDS.includes(spec.fixtureId)).length
		&& runtimeCountAudit.every((item) => item.captured || item.status !== 'ready' && Boolean(item.reason));
	const allDiagnosticResourcesClean = cases.length === expectedSpecs.length && cases.every((item) => item.actual && item.acceptance.cleanupComplete);
	const allDiagnosticCasesAccepted = cases.length === expectedSpecs.length && cases.every((item) => item.actual && item.acceptance.pass);
	const pass = Boolean(fullScope && controlsPass && lOldBoundedAndMatched && runtimeCountAuditComplete && allDiagnosticResourcesClean && allDiagnosticCasesAccepted);
	return {
		caseCount: cases.filter((item) => item.actual).length,
		expectedCaseCount: expectedSpecs.length,
		fullScope,
		cases,
		runtimeCountAudit,
		acceptance: {
			s2NativeComplete: s2Native?.acceptance.pass === true,
			s2WrappedComplete: s2Wrapped?.acceptance.pass === true,
			lOldBoundedAndMatched,
			roomsS2FrameTrace: roomsS2?.acceptance.pass === true,
			roomsYOldBoundedDiagnostic: roomsYOld?.acceptance.boundedRoomsYOldDiagnostic === true,
			runtimeCountAuditComplete,
			allDiagnosticResourcesClean,
			allDiagnosticCasesAccepted,
			controlsPass,
			pass
		}
	};
}

const RUNTIME_MODULES = [
	'tooling/performance/loader-baseline.mjs',
	'tooling/performance/loader-baseline-isolated.mjs',
	'tooling/performance/loader-baseline-isolated-child.mjs',
	'tooling/performance/loader-process-snapshot.ps1'
];
const ACCEPTED_BOOT_RELATIVE = 'docs/worklogs/BOMC-LOADER-001/2026-10-03-CP0-luna-review-v1.1/B0-editor-boot';
const ACCEPTED_BOOT_HASHES = Object.freeze({
	'boot-attempts.jsonl': '7c3796082aaac9e0ef3eae57360a4d19cf84423ccf51ca41918f5adf50f88782',
	'metadata.json': 'f39091d7a19cad5c9acba1decf31adbcf9e0fdddbc9354f114095b851034cdfc',
	'summary.json': 'e4e620497900e3d0d6119c0212f200cb5e128fd0e4c4ba08a51a8b9e3c0f55ec'
});

function digestBytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function writeAtomicJson(file, value) {
	mkdirSync(path.dirname(file), { recursive: true });
	const temporary = file + `.tmp-${process.pid}-${randomUUID()}`;
	writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
	renameSync(temporary, file);
}

function appendJsonLine(file, value) {
	mkdirSync(path.dirname(file), { recursive: true });
	appendFileSync(file, JSON.stringify(value) + '\n', 'utf8');
}

function moduleHashes() {
	return RUNTIME_MODULES.map((relativePath) => {
		const file = path.join(ROOT, relativePath);
		return { path: relativePath.replaceAll('\\', '/'), sha256: digestBytes(readFileSync(file)) };
	});
}

export function runtimeModuleHashes() {
	return moduleHashes();
}

export function assertManifestSha256(manifestBytes, expectedSha256) {
	const bytes = Buffer.isBuffer(manifestBytes) ? manifestBytes : Buffer.from(manifestBytes);
	const actualSha256 = digestBytes(bytes);
	if (actualSha256 !== expectedSha256) throw new Error('Fixture manifest SHA-256 changed after the run identity was frozen.');
	return actualSha256;
}

function assertModuleHashes(expected) {
	const actual = moduleHashes();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('An isolated runner/runtime/helper module changed after the run identity was frozen.');
	return actual;
}

function loadAcceptedBootEnvironment(workspaceRoot) {
	const directory = path.join(workspaceRoot, ACCEPTED_BOOT_RELATIVE);
	const files = {};
	for (const [name, expected] of Object.entries(ACCEPTED_BOOT_HASHES)) {
		const bytes = readFileSync(path.join(directory, name));
		const actual = digestBytes(bytes);
		if (actual !== expected) throw new Error(`Accepted Editor boot evidence ${name} changed: expected ${expected}, got ${actual}.`);
		files[name] = { path: path.posix.join(ACCEPTED_BOOT_RELATIVE.replaceAll('\\', '/'), name), sha256: actual };
	}
	const metadata = JSON.parse(readFileSync(path.join(directory, 'metadata.json'), 'utf8'));
	if (metadata.baseline !== 'B0' || metadata.suite !== 'boot' || metadata.environment?.webglAdapter?.available !== true || !/SwiftShader/i.test(metadata.environment?.webglAdapter?.renderer || '')) {
		throw new Error('Pinned accepted boot metadata does not describe the frozen B0 Windows/Chromium/SwiftShader environment.');
	}
	return { environment: stableEnvironment(metadata.environment), files };
}

async function runGit(args) {
	const result = await execFileResult('git', args, { cwd: ROOT, windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', shell: false });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.error || result.stderr || result.exitCode}`);
	return result.stdout.trimEnd();
}

async function toolingCheckoutIdentity(modules) {
	const baseHead = await runGit(['rev-parse', 'HEAD']);
	const taskPaths = [...RUNTIME_MODULES, 'tooling/performance/loader-baseline.test.ts', 'tooling/performance/loader-baseline-isolated.test.ts'];
	const status = await runGit(['status', '--short', '--', ...taskPaths]);
	const diff = await runGit(['diff', '--binary', '--', ...taskPaths]);
	const sourceFileHashes = taskPaths.filter((relativePath) => existsSync(path.join(ROOT, relativePath))).map((relativePath) => ({ path: relativePath, sha256: digestBytes(readFileSync(path.join(ROOT, relativePath))) }));
	return {
		baseHead,
		taskOwnedStatus: status.split(/\r?\n/).filter(Boolean),
		taskOwnedFiles: sourceFileHashes,
		taskOwnedDiffSha256: digestBytes(Buffer.from(JSON.stringify({ status, diff, sourceFileHashes, modules }), 'utf8')),
		runtimeModules: modules
	};
}

function withinWorklogRoot(workspaceRoot, outputDir) {
	const root = path.resolve(workspaceRoot, 'docs', 'worklogs', 'BOMC-LOADER-001');
	const relative = path.relative(root, outputDir);
	return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function verifyFixturePinned(fixture) {
	const actual = await hashFile(fixture.filePath);
	if (actual.size !== fixture.bytes || actual.sha256 !== fixture.sha256) throw new Error(`${fixture.id}: fixture bytes/SHA-256 drifted during isolated collection.`);
	return actual;
}

function verifyManifestPinned(fixturePath, expectedSha256) {
	const actualSha256 = assertManifestSha256(readFileSync(fixturePath), expectedSha256);
	return { sha256: actualSha256 };
}

function buildJobRunData({ options, runId, outputDir, workspaceRoot, expectedEnvironment, modules, builds }) {
	return {
		runId,
		baseline: options.baseline,
		workspaceRoot,
		outputDir,
		cwd: ROOT,
		expectedEnvironment,
		urls: Object.fromEntries(APPS.map((app) => [app.id, options.urls[app.id]])),
		builds: Object.fromEntries(APPS.map((app) => [app.id, builds[app.id].identity])),
		moduleSha256: modules
	};
}

export async function runIsolatedBaseline(argv = process.argv.slice(2), { diagnosticControlPack = false } = {}) {
	const options = parseArgs(argv);
	if (!['model', 'diagnostic'].includes(options.suite)) throw new Error('The isolated runner accepts only --suite model or --suite diagnostic; use loader-baseline.mjs for legacy --suite all or --suite boot.');
	if (diagnosticControlPack && (options.baseline !== 'B0' || options.suite !== 'diagnostic' || options.apps.map((item) => item.id).join(',') !== APPS.map((item) => item.id).join(','))) {
		throw new Error('Programmatic diagnostic control pack requires B0, --suite diagnostic, and all three apps in canonical order.');
	}
	const outputDir = path.resolve(options.output);
	const workspaceRoot = path.resolve(options.workspaceRoot);
	const fixturePath = path.resolve(options.fixtures);
	if (!withinWorklogRoot(workspaceRoot, outputDir)) throw new Error('Isolated evidence output must be a new directory below docs/worklogs/BOMC-LOADER-001/.');
	assertFreshOutputDirectory(outputDir);
	const runId = randomUUID();
	const mode = diagnosticControlPack ? 'control-pack' : options.suite;
	const runStatePath = path.join(outputDir, 'run-state.json');
	const runState = { schemaVersion: ISOLATED_SCHEMA, runId, method: ISOLATED_METHOD, state: 'running', baseline: options.baseline, suite: options.suite, scope: diagnosticControlPack ? 'control-pack' : options.apps.length === APPS.length ? 'all-three-apps' : 'partial-scope', selectedAppIds: options.apps.map((app) => app.id), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), actualRowCount: 0, dispositionCount: 0, lastCompletedJobId: null };
	mkdirSync(outputDir, { recursive: true });
	mkdirSync(path.join(outputDir, 'case-ownership'), { recursive: true });
	writeAtomicJson(runStatePath, runState);
	let interruptedBy = null;
	const onInterrupt = (signal) => {
		if (interruptedBy) return;
		interruptedBy = signal;
		runState.state = 'interrupted';
		runState.interruptReason = signal;
		runState.interruptedAt = new Date().toISOString();
		runState.updatedAt = new Date().toISOString();
		writeAtomicJson(runStatePath, runState);
	};
	const onSigint = () => onInterrupt('SIGINT');
	const onSigterm = () => onInterrupt('SIGTERM');
	process.on('SIGINT', onSigint);
	process.on('SIGTERM', onSigterm);
	let activeRun = null;
	const actualRows = [];
	const dispositions = [];
	const receipts = [];
	const identityAudits = [];
	const ownershipByJobToken = new Map();
	let matrix = null;
	let diagnosticMatrix = null;
	let expectedSpecs = [];
	let metadata = null;
	try {
		const manifestInfo = await readIsolationManifest(workspaceRoot, fixturePath);
		const fixtureDescriptors = manifestInfo.fixtures;
		const modules = moduleHashes();
		const checkout = await toolingCheckoutIdentity(modules);
		const expectedBoot = loadAcceptedBootEnvironment(workspaceRoot);
		const expectedEnvironment = stableEnvironment(expectedBoot.environment);
		const builds = {};
		for (const app of APPS) builds[app.id] = await readBuild(options.urls[app.id], app, options.baseline);
		const runtimeIdentity = {
			nodeVersion: process.version,
			nodeExecutable: process.execPath,
			playwrightVersion: JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.resolve('@playwright/test'))), 'package.json'), 'utf8')).version,
			browserVersion: expectedEnvironment.browser,
			browserLaunchArgs: [...BROWSER_LAUNCH_ARGS]
		};
		if (runtimeIdentity.nodeVersion !== expectedEnvironment.nodeVersion || runtimeIdentity.browserVersion !== expectedEnvironment.browser) throw new Error('Installed Node/Chromium version differs from the accepted B0 environment identity.');
		matrix = options.suite === 'model'
			? buildModelScenarioMatrix(options.baseline, options.apps.map((app) => app.id), fixtureDescriptors.map((fixture) => fixture.id))
			: null;
		diagnosticMatrix = options.suite === 'diagnostic' ? buildIsolatedDiagnosticMatrix(options.apps.map((app) => app.id)) : null;
		expectedSpecs = diagnosticMatrix ? (diagnosticControlPack ? diagnosticMatrix.specs.slice(0, 3) : diagnosticMatrix.specs) : [];
		if (diagnosticControlPack && (expectedSpecs.length !== 3 || expectedSpecs.map((item) => `${item.appId}/${item.fixtureId}/${item.mode}`).join('|') !== 'editor/S2-jcm/native|editor/S2-jcm/wrapped|rooms/S2-jcm/wrapped')) throw new Error('Frozen diagnostic control pack order/size drifted.');
		const expectedIds = matrix?.expectedRowIds || expectedSpecs.map((spec) => spec.id);
		metadata = {
			schemaVersion: ISOLATED_SCHEMA,
			method: ISOLATED_METHOD,
			plan: 'BOMC-CP0-ISOLATION-001/v1.2',
			parentPlan: 'BOMC-LOADER-001/v1.0',
			review: 'BOMC-LOADER-001/IMPLEMENTATION_REVIEW_2026-10-03_v1.3',
			runId,
			baseline: options.baseline,
			suite: options.suite,
			captureProfile: options.suite === 'diagnostic' ? 'actions-network-no-dom' : null,
			scope: runState.scope,
			capturedAt: new Date().toISOString(),
			toolingCheckout: checkout,
			manifest: { path: manifestInfo.path, schemaVersion: manifestInfo.manifest.schemaVersion, plan: manifestInfo.manifest.plan, sha256: manifestInfo.manifestSha256, descriptors: fixtureDescriptors.map(({ id, locator, bytes, sha256, expected }) => ({ id, locator, bytes, sha256, expected })) },
			builds: Object.fromEntries(APPS.map((app) => [app.id, builds[app.id]])),
			environment: expectedEnvironment,
			expectedEnvironmentSource: expectedBoot,
			runtimeIdentityAtEntry: runtimeIdentity,
			urls: Object.fromEntries(APPS.map((app) => [app.id, appUrl(options.urls[app.id], app)])),
			budgets: { ...PRODUCTION_BUDGETS },
			selectedAppIds: options.apps.map((app) => app.id),
			expectedRowIds: expectedIds,
			expectedRowCount: expectedIds.length,
			modelMatrix: matrix,
			diagnosticMatrix: { ...diagnosticMatrix, specs: expectedSpecs },
			controlPack: diagnosticControlPack ? { scope: 'control-pack', expected: 3, fullDiagnosticAcceptance: false } : null
		};
		writeAtomicJson(path.join(outputDir, 'metadata.json'), metadata);
		const modelFile = path.join(outputDir, 'model-attempts.jsonl');
		const diagnosticFile = path.join(outputDir, 'diagnostic-attempts.jsonl');
		const persist = async (record) => {
			if (record.recordType === 'attempt-journal') appendJsonLine(path.join(outputDir, 'attempt-journal.jsonl'), { ...record, runId, method: ISOLATED_METHOD, schemaVersion: ISOLATED_SCHEMA });
			else if (record.recordType === 'diagnostic-event') appendJsonLine(path.join(outputDir, 'diagnostic-events.jsonl'), { ...record, runId, method: ISOLATED_METHOD, schemaVersion: ISOLATED_SCHEMA });
			else if (record.recordType === 'actual-row-finalized') {
				const row = record.row;
				row.runId = runId;
				row.method = ISOLATED_METHOD;
				row.schemaVersion = ISOLATED_SCHEMA;
				appendJsonLine(options.suite === 'model' ? modelFile : diagnosticFile, { ...record, runId, method: ISOLATED_METHOD, schemaVersion: ISOLATED_SCHEMA });
				actualRows.push(row);
			}
			else if (record.recordType === 'disposition') {
				const disposition = { ...record, runId, method: ISOLATED_METHOD, schemaVersion: ISOLATED_SCHEMA };
				appendJsonLine(path.join(outputDir, 'model-dispositions.jsonl'), disposition);
				dispositions.push(disposition);
			}
			else if (record.recordType === 'ownership-event') {
				appendJsonLine(path.join(outputDir, 'ownership-events.jsonl'), { ...record, runId, method: ISOLATED_METHOD, schemaVersion: ISOLATED_SCHEMA });
				const token = record.jobToken || 'unassigned';
				const list = ownershipByJobToken.get(token) || [];
				list.push(record);
				ownershipByJobToken.set(token, list);
				writeAtomicJson(path.join(outputDir, 'case-ownership', `${token}.json`), { runId, method: ISOLATED_METHOD, records: list });
			}
			else if (record.recordType === 'heartbeat') {
				appendJsonLine(path.join(outputDir, 'attempt-heartbeats.jsonl'), { ...record, runId, method: ISOLATED_METHOD });
			}
		};
		const writeProgress = () => {
			runState.updatedAt = new Date().toISOString();
			runState.actualRowCount = actualRows.length;
			runState.dispositionCount = dispositions.length;
			runState.lastCompletedJobId = identityAudits.at(-1)?.jobId || runState.lastCompletedJobId;
			writeAtomicJson(runStatePath, runState);
			writeAtomicJson(path.join(outputDir, 'series-identity-audit-progress.json'), identityAudits);
			if (matrix) {
				const coverage = evaluateCollectionCoverage(matrix, actualRows, dispositions, receipts);
				writeAtomicJson(path.join(outputDir, 'model-summary-progress.json'), { summaries: coverage.modelSummaries, counts: { actualRows: actualRows.length, dispositions: dispositions.length }, actualMatrixAudit: coverage.actualMatrixAudit, coverageAudit: coverage.coverageAudit, collectionEvidencePass: coverage.collectionEvidencePass, modelPass: coverage.modelPass });
			} else {
				writeAtomicJson(path.join(outputDir, 'diagnostic-summary-progress.json'), summarizeIsolatedDiagnostics(expectedSpecs, actualRows));
			}
		};
		activeRun = buildJobRunData({ options, runId, outputDir, workspaceRoot, expectedEnvironment, modules, builds });
		activeRun.isInterrupted = () => Boolean(interruptedBy);
		const fixtureById = new Map(fixtureDescriptors.map((fixture) => [fixture.id, fixture]));
		const jobs = matrix
			? buildIsolationJobs(matrix)
			: expectedSpecs.map((spec) => ({ ...spec, kind: 'diagnostic', fixtureId: spec.fixtureId, attemptIds: [spec.id], expectedOutcome: 'ready' }));
		for (const job of jobs) {
			if (interruptedBy) throw Object.assign(new Error(`Interrupted by ${interruptedBy}.`), { code: 'INTERRUPTED' });
			const app = APPS.find((item) => item.id === job.appId);
			const fixtureDescriptor = fixtureById.get(job.fixtureId);
			if (!app || !fixtureDescriptor) throw new Error(`${job.id}: required app or pinned fixture descriptor is absent.`);
			assertModuleHashes(modules);
			const buildBefore = await readBuild(options.urls[app.id], app, options.baseline);
			if (JSON.stringify(buildBefore.identity) !== JSON.stringify(builds[app.id].identity)) throw new Error(`${job.id}: app build identity changed before sandbox launch.`);
			const manifestBefore = verifyManifestPinned(fixturePath, manifestInfo.manifestSha256);
			const fixtureBefore = await verifyFixturePinned(fixtureDescriptor);
			const jobFixture = { id: fixtureDescriptor.id, locator: fixtureDescriptor.locator, bytes: fixtureDescriptor.bytes, sha256: fixtureDescriptor.sha256, expected: fixtureDescriptor.expected };
			const jobWithFixture = { ...job, fixture: jobFixture };
			const jobRun = { ...activeRun };
			const result = await superviseOwnedJob({ job: jobWithFixture, run: jobRun, persist });
			const jobAudit = { jobId: job.id, appId: app.id, fixtureId: job.fixtureId, before: { build: buildBefore.identity, fixture: fixtureBefore, manifestSha256: manifestBefore.sha256 }, after: null, environment: result.identityAudit, ownershipReceipt: { verified: result.ownershipReceipt.verified, resourceDisposition: result.ownershipReceipt.resourceDisposition, recoverySandboxVerified: result.ownershipReceipt.recoverySandbox?.verified ?? null } };
			identityAudits.push(jobAudit);
			receipts.push({ jobId: job.id, ...result.ownershipReceipt });
			if (interruptedBy) throw Object.assign(new Error(`Interrupted by ${interruptedBy} while job ownership was being closed.`), { code: 'INTERRUPTED' });
			if (!result.nextJobAuthorized || !result.ownershipReceipt.verified) throw new Error(`${job.id}: ownership receipt did not authorize another sandbox.`);
			if (result.failure) throw Object.assign(new Error(`${job.id}: isolated harness failed at ${result.failure.phase || 'unknown'}: ${result.failure.message}`), { code: interruptedBy ? 'INTERRUPTED' : 'HARNESS_FAILURE', evidence: result });
			if (result.identityAudit.valid !== true) throw new Error(`${job.id}: before/after or recovery environment identity failed.`);
			const buildAfter = await readBuild(options.urls[app.id], app, options.baseline);
			if (JSON.stringify(buildAfter.identity) !== JSON.stringify(builds[app.id].identity)) throw new Error(`${job.id}: app build identity changed after sandbox exit.`);
			const fixtureAfter = await verifyFixturePinned(fixtureDescriptor);
			const manifestAfter = verifyManifestPinned(fixturePath, manifestInfo.manifestSha256);
			const modulesAfter = assertModuleHashes(modules);
			jobAudit.after = { build: buildAfter.identity, fixture: fixtureAfter, manifestSha256: manifestAfter.sha256 };
			jobAudit.moduleSha256 = modulesAfter;
			if (result.dispositions.length) {
				for (const disposition of result.dispositions) {
					if (!dispositions.some((item) => rowIdentity(item) === rowIdentity(disposition))) throw new Error(`${job.id}: returned disposition was not durably appended by parent.`);
				}
			}
			if (job.kind === 'diagnostic') {
				const partialCases = summarizeIsolatedDiagnostics(expectedSpecs, actualRows);
				if (expectedSpecs.length === 13 && job === jobs[2] && !partialCases.acceptance.controlsPass) {
					throw new Error('Required fresh native/wrapped S2-jcm or Rooms/S2-jcm control failed; stop before dependent diagnostic cases and model collection.');
				}
			}
			writeProgress();
		}
		const modulesAtExit = assertModuleHashes(modules);
		const manifestAtExit = verifyManifestPinned(fixturePath, manifestInfo.manifestSha256);
		const buildsAtExit = {};
		for (const app of APPS) {
			buildsAtExit[app.id] = await readBuild(options.urls[app.id], app, options.baseline);
			if (JSON.stringify(buildsAtExit[app.id].identity) !== JSON.stringify(builds[app.id].identity)) throw new Error(`${app.id}: global exit build identity differs from run entry.`);
		}
		const runtimeAtExit = {
			nodeVersion: process.version,
			nodeExecutable: process.execPath,
			playwrightVersion: metadata.runtimeIdentityAtEntry.playwrightVersion,
			browserVersion: expectedEnvironment.browser,
			browserLaunchArgs: [...BROWSER_LAUNCH_ARGS],
			browserExecutables: [...new Set(receipts.map((receipt) => receipt.launch?.identity?.executable).filter(Boolean))]
		};
		if (runtimeAtExit.nodeVersion !== metadata.runtimeIdentityAtEntry.nodeVersion || runtimeAtExit.nodeExecutable !== metadata.runtimeIdentityAtEntry.nodeExecutable || runtimeAtExit.playwrightVersion !== metadata.runtimeIdentityAtEntry.playwrightVersion) throw new Error('Installed Node/Playwright runtime identity changed during collection.');
		metadata.runtimeIdentityAtExit = runtimeAtExit;
		metadata.modulesAtExit = modulesAtExit;
		metadata.manifestAtExit = manifestAtExit;
		metadata.buildsAtExit = buildsAtExit;
		writeAtomicJson(path.join(outputDir, 'metadata.json'), metadata);
		let summary;
		if (matrix) {
			const coverage = evaluateCollectionCoverage(matrix, actualRows, dispositions, receipts);
			if (!coverage.coverageComplete) throw new Error('Selected actual/disposition union is incomplete; final summary is forbidden.');
			if (!coverage.collectionEvidencePass) throw new Error('Selected matrix is accounted but collection evidence fails a frozen pin, ownership, disposition, identity, or scope contract.');
			summary = {
				schemaVersion: ISOLATED_SCHEMA, method: ISOLATED_METHOD, plan: metadata.plan, parentPlan: metadata.parentPlan, review: metadata.review,
				runId, baseline: options.baseline, suite: 'model', scope: runState.scope, startedAt: runState.startedAt, completedAt: new Date().toISOString(),
				metadata: path.join(outputDir, 'metadata.json'), actualMatrixComplete: coverage.actualAttemptMatrixComplete,
				coverage: coverage.coverageAudit, collectionEvidencePass: coverage.collectionEvidencePass, modelPass: coverage.modelPass,
				counts: { actualAttempts: coverage.actualAttemptCount, actualOpens: coverage.actualOpenCount, blockedWarm: coverage.blockedWarmCount, missing: coverage.missingCount, harnessFailures: coverage.harnessFailureCount, ...coverage.outcomeCounts },
				modelAcceptance: coverage.modelAcceptance, timing: coverage.modelSummaries,
				identityAudits, ownershipReceipts: receipts, acceptedBootEvidence: expectedBoot.files, acceptedBootEnvironment: expectedEnvironment,
				warnings: coverage.modelPass ? [] : ['B0 collection evidence is valid, while strict model application acceptance failed.']
			};
			writeAtomicJson(path.join(outputDir, 'summary.json'), summary);
			runState.state = coverage.modelPass ? 'collected' : 'collected-with-failures';
		} else {
			const diagnostic = summarizeIsolatedDiagnostics(expectedSpecs, actualRows);
			if (diagnostic.caseCount !== expectedSpecs.length) throw new Error('Diagnostic expected-row matrix is incomplete; final summary is forbidden.');
			summary = {
				schemaVersion: ISOLATED_SCHEMA, method: ISOLATED_METHOD, plan: metadata.plan, parentPlan: metadata.parentPlan, review: metadata.review,
				runId, baseline: options.baseline, suite: 'diagnostic', scope: mode === 'control-pack' ? 'control-pack' : runState.scope,
				startedAt: runState.startedAt, completedAt: new Date().toISOString(), metadata: path.join(outputDir, 'metadata.json'),
				diagnostic, controlPackAcceptance: mode === 'control-pack' ? { expected: 3, actual: diagnostic.caseCount, controlsPass: diagnostic.acceptance.controlsPass, fullDiagnosticAcceptance: false } : null,
				identityAudits, ownershipReceipts: receipts, acceptedBootEvidence: expectedBoot.files, acceptedBootEnvironment: expectedEnvironment
			};
			writeAtomicJson(path.join(outputDir, 'summary.json'), summary);
			runState.state = diagnosticControlPack ? 'controls-collected' : diagnostic.acceptance.pass ? 'collected' : 'collected-with-failures';
		}
		runState.updatedAt = new Date().toISOString();
		runState.completedAt = runState.updatedAt;
		runState.actualRowCount = actualRows.length;
		runState.dispositionCount = dispositions.length;
		writeAtomicJson(runStatePath, runState);
		return summary;
	} catch (error) {
		const interrupted = Boolean(interruptedBy || error?.code === 'INTERRUPTED');
		runState.state = interrupted ? 'interrupted' : 'failed';
		runState.interruptReason = interruptedBy || null;
		runState.failure = error instanceof Error ? error.stack || error.message : String(error);
		runState.updatedAt = new Date().toISOString();
		runState.actualRowCount = actualRows.length;
		runState.dispositionCount = dispositions.length;
		try {
			writeAtomicJson(runStatePath, runState);
			writeAtomicJson(path.join(outputDir, 'failure-report.json'), { runId, schemaVersion: ISOLATED_SCHEMA, method: ISOLATED_METHOD, interrupted, error: runState.failure, actualRows: actualRows.length, dispositions: dispositions.length, lastCompletedJobId: runState.lastCompletedJobId, identityAudits, ownershipReceipts: receipts });
		} catch {}
		if (interrupted) process.exitCode = interruptedBy === 'SIGINT' ? 130 : 143;
		throw error;
	} finally {
		process.off('SIGINT', onSigint);
		process.off('SIGTERM', onSigterm);
		activeRun = null;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runIsolatedBaseline().then((summary) => {
		const output = path.resolve(parseArgs(process.argv.slice(2)).output);
		console.log(JSON.stringify({ summary: path.join(output, 'summary.json'), collectionEvidencePass: summary.collectionEvidencePass ?? summary.diagnostic?.acceptance?.pass ?? null, modelPass: summary.modelPass ?? null, controlPackAcceptance: summary.controlPackAcceptance ?? null }, null, 2));
		if (summary.suite === 'model') process.exitCode = summary.modelPass ? 0 : summary.baseline === 'B0' && summary.collectionEvidencePass ? 2 : 1;
		else process.exitCode = summary.diagnostic?.acceptance?.pass ? 0 : 1;
	}).catch((error) => {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error));
		process.exitCode ??= 1;
	});
}
