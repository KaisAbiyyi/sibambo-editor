import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPS, readBuild, stableEnvironment, workerTraceAudit } from './loader-baseline.mjs';
import {
	PRODUCTION_BUDGETS,
	matchOwnedRootIdentity,
	readIsolationManifest,
	readProcessSnapshots,
	runtimeModuleHashes,
	superviseOwnedJob
} from './loader-baseline-isolated.mjs';

const PLAN = 'BOMC-LOADER-001/v1.2';
const MANIFEST_SHA256 = 'dd87a9556e00d92265a622f46170d2fbad7f27d19595fea34d3d338757d51aed';
const S2_JCM = Object.freeze({
	id: 'S2-jcm',
	locator: 'docs/worklogs/reviews/2026-09-26_E4-BOMC-001_v1.4/containers/PROJECT SBOOST 2.jcm-best-deflate.diagnostic.bomc',
	bytes: 3_354_834,
	sha256: '39851b73848aa42cb742e1be6230965327a41c31ec6b1051848304ac09faf637'
});
const IDENTITY_PACKAGE_NAMES = [
	'@sibambo/contracts',
	'@sibambo/e4-import',
	'@sibambo/provenance',
	'@sibambo/scene-runtime',
	'@sibambo/viewport'
];
const EDITOR_APP = APPS.find((app) => app.id === 'editor');
const EDITOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKLOG_RELATIVE = path.join('docs', 'worklogs', 'BOMC-LOADER-001');
const SERVER_PORT = 5175;

function fail(message) {
	throw new Error(message);
}

function assertOutputPath(workspaceRoot, output, { rejectExisting = true } = {}) {
	const root = path.resolve(workspaceRoot);
	const absoluteOutput = path.resolve(output);
	const worklogRoot = path.join(root, WORKLOG_RELATIVE);
	const relative = path.relative(worklogRoot, absoluteOutput);
	if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		fail('Output must be a fresh directory below W/docs/worklogs/BOMC-LOADER-001/.');
	}
	if (rejectExisting && existsSync(absoluteOutput)) fail(`Output directory already exists: ${absoluteOutput}.`);
	return { workspaceRoot: root, output: absoluteOutput, worklogRoot };
}

export function parsePackingSmokeArgs(argv) {
	if (!Array.isArray(argv)) fail('Arguments must be an array.');
	const values = new Map();
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag !== '--workspace-root' && flag !== '--output') fail(`Unknown argument: ${String(flag)}.`);
		if (values.has(flag)) fail(`Argument ${flag} must appear exactly once.`);
		const value = argv[index + 1];
		if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) fail(`Argument ${flag} requires a value.`);
		values.set(flag, value);
		index += 1;
	}
	if (!values.has('--workspace-root') || !values.has('--output')) fail('Both --workspace-root and --output are required exactly once.');
	const workspaceRoot = path.resolve(values.get('--workspace-root'));
	const rawOutput = values.get('--output');
	if (!path.isAbsolute(rawOutput)) fail('--output must be an absolute path.');
	const { output } = assertOutputPath(workspaceRoot, rawOutput);
	return { workspaceRoot, output };
}

function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function identityOf(build) {
	return build && typeof build === 'object' && build.identity && typeof build.identity === 'object' ? build.identity : null;
}

function frameIsValid(frame) {
	return Boolean(frame && frame.viewportCanvas === true && frame.tagName === 'CANVAS' &&
		['cssWidth', 'cssHeight', 'bufferWidth', 'bufferHeight'].every((key) => Number.isFinite(frame[key]) && frame[key] > 0) &&
		typeof frame.method === 'string' && frame.method.length > 0);
}

function check(failures, condition, name) {
	if (!condition) failures.push(name);
}

function exactEventCount(events, phase, type) {
	return events.filter((event) => event?.phase === phase && event?.type === type);
}

function graphCountsMatch(counts) {
	const expected = {
		resultFacesLength: 270,
		preparedRuntimeSceneGroupsLength: 291,
		sourceCounts: { materials: 48, tags: 19, meshes: 80, faces: 7078, definitions: 106, instances: 122, transforms: 101, textures: 14, edges: 14354 }
	};
	return counts?.resultFacesLength === expected.resultFacesLength &&
		counts?.preparedRuntimeSceneGroupsLength === expected.preparedRuntimeSceneGroupsLength &&
		counts?.sourceCounts && Object.entries(expected.sourceCounts).every(([key, value]) => counts.sourceCounts[key] === value);
}

export function evaluatePackingSmokeCase({ job, result, buildBefore, buildAfter, expectedBuild }) {
	const failures = [];
	const warnings = [];
	const rows = Array.isArray(result?.rows) ? result.rows : [];
	check(failures, rows.length === 1, 'rows.exactlyOne');
	const row = rows.length === 1 && rows[0] && typeof rows[0] === 'object' ? rows[0] : null;
	const expectedIdentity = identityOf(expectedBuild);
	const beforeIdentity = identityOf(buildBefore);
	const afterIdentity = identityOf(buildAfter);
	check(failures, Boolean(expectedIdentity), 'build.expectedIdentity.present');
	check(failures, Boolean(beforeIdentity) && stableJson(beforeIdentity) === stableJson(expectedIdentity), 'build.before.matchesExpected');
	check(failures, Boolean(afterIdentity) && stableJson(afterIdentity) === stableJson(expectedIdentity), 'build.after.matchesExpected');
	check(failures, expectedIdentity?.dirty === false && beforeIdentity?.dirty === false && afterIdentity?.dirty === false, 'build.candidateClean');
	check(failures, result?.failure === null, 'result.failure.null');
	check(failures, result?.collectionEligible === true, 'result.collectionEligible');
	check(failures, result?.ownershipReceipt?.verified === true, 'result.ownershipReceipt.verified');
	check(failures, result?.identityAudit?.valid === true, 'result.identityAudit.valid');

	let workerAudit = null;
	let durableEvents = [];
	if (row) {
		check(failures, row.scenarioRowId === job?.id, 'row.scenarioRowId.matchesJob');
		check(failures, row.jobId === job?.id, 'row.jobId.matchesJob');
		check(failures, row.app === 'editor', 'row.app.editor');
		check(failures, row.fixtureId === S2_JCM.id, 'row.fixtureId.S2-jcm');
		check(failures, row.fixtureBytes === S2_JCM.bytes, 'row.fixtureBytes.pinned');
		check(failures, row.fixtureSha256 === S2_JCM.sha256, 'row.fixtureSha256.pinned');
		check(failures, row.mode === 'diagnostic-excluded', 'row.mode.diagnostic-excluded');
		check(failures, row.outcomeStatus === 'ready', 'row.outcomeStatus.ready');
		check(failures, row.openOccurred === true, 'row.openOccurred');
		check(failures, Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && row.elapsedMs <= PRODUCTION_BUDGETS.openOutcomeMs, 'row.elapsedMs.bounded');
		check(failures, row.observationIntegrity === 'valid', 'row.observationIntegrity.valid');
		check(failures, row.harnessStatus === 'ok', 'row.harnessStatus.ok');
		check(failures, row.cleanupStatus === 'complete', 'row.cleanupStatus.complete');
		check(failures, row.ownershipReceipt?.verified === true, 'row.ownershipReceipt.verified');
		check(failures, row.identityAudit?.valid === true, 'row.identityAudit.valid');
		check(failures, frameIsValid(row.firstValidFrame), 'row.firstValidFrame.connectedCanvasPositiveDraw');
		for (const name of ['consoleErrors', 'pageErrors', 'diagnosticStreamErrors']) {
			check(failures, Array.isArray(row[name]), `row.${name}.array`);
			check(failures, Array.isArray(row[name]) && row[name].length === 0, `row.${name}.empty`);
		}
		check(failures, Array.isArray(row.diagnosticStreamEvents), 'row.diagnosticStreamEvents.array');
		if (Array.isArray(row.diagnosticStreamEvents)) {
			check(failures, row.diagnosticStreamEvents.every((event) => event && typeof event === 'object'), 'row.diagnosticStreamEvents.validObjects');
			durableEvents = row.diagnosticStreamEvents.filter((event) => event && typeof event === 'object');
		}
		check(failures, ['native', 'wrapped'].includes(job?.mode), 'job.mode.supported');
		if (['native', 'wrapped'].includes(job?.mode)) {
			workerAudit = workerTraceAudit({ ...row, diagnostic: { ...(row.diagnostic || {}), events: durableEvents } }, job.mode);
			check(failures, workerAudit.completeLifecycle === true, 'worker.completeLifecycle');
			check(failures, workerAudit.matchedWorkerCount === 1, 'worker.exactlyOneImporter');
			check(failures, workerAudit.unmatchedWorkers.length === 0, 'worker.noUnmatchedWorkers');
			check(failures, workerAudit.secondaryWorkers.length === 0, 'worker.noSecondaryWorkers');
			check(failures, workerAudit.importErrorCount === 0, 'worker.noImportErrors');
			check(failures, durableEvents.every((event) => !/worker.*error/i.test(String(event.phase || ''))), 'worker.noWorkerErrors');

			const expectedWorkerPhase = job.mode === 'wrapped' ? 'wrapped-worker' : 'native-worker';
			const workers = durableEvents.filter((event) => event.phase === expectedWorkerPhase);
			check(failures, workers.length === 1, 'worker.oneMatchedWorkerEvent');
			const workerId = workers.length === 1 ? workers[0].workerId : undefined;
			if (job.mode === 'native') {
				const complete = exactEventCount(durableEvents, 'native-main-receive', 'complete');
				check(failures, complete.length === 1, 'native.exactlyOneCompleteReceipt');
				check(failures, complete.length === 1 && Number.isInteger(complete[0].id), 'native.completeRequestId.integer');
				check(failures, complete.length === 1 && workerId !== undefined && complete[0].workerId === workerId, 'native.completeWorkerId.matches');
			} else {
				const pre = exactEventCount(durableEvents, 'worker-pre-post', 'complete');
				const returned = exactEventCount(durableEvents, 'worker-post-return', 'complete');
				const received = exactEventCount(durableEvents, 'main-receive', 'complete');
				check(failures, pre.length === 1, 'wrapped.exactlyOnePrePost');
				check(failures, returned.length === 1, 'wrapped.exactlyOnePostReturn');
				check(failures, received.length === 1, 'wrapped.exactlyOneMainReceive');
				const lifecycle = [...pre, ...returned, ...received];
				check(failures, lifecycle.length === 3 && lifecycle.every((event) => Number.isInteger(event.id)), 'wrapped.requestIds.integer');
				check(failures, lifecycle.length === 3 && lifecycle.every((event) => event.id === lifecycle[0].id), 'wrapped.requestIds.match');
				check(failures, lifecycle.length === 3 && lifecycle.every((event) => event.workerId === workerId), 'wrapped.workerIds.match');
				check(failures, lifecycle.length === 3 && lifecycle.every((event) => Number.isFinite(event.epochMs)), 'wrapped.epochs.finite');
				check(failures, pre.length === 1 && returned.length === 1 && returned[0].epochMs >= pre[0].epochMs, 'wrapped.postReturn.afterPrePost');
				const graph = pre[0]?.graph;
				check(failures, Boolean(graph && !Object.hasOwn(graph, 'error')), 'wrapped.graph.noError');
				check(failures, graph?.sourceBufferRetainedBytes === S2_JCM.bytes, 'wrapped.sourceBufferRetained');
				check(failures, graph?.sourceBufferInTransferList === false, 'wrapped.sourceBuffer.notTransferred');
				check(failures, graph?.graphIncludesSourceBuffer === false, 'wrapped.graph.excludesSourceBuffer');
				check(failures, Number.isInteger(graph?.transferBufferCount) && graph.transferBufferCount <= 30, 'wrapped.transferBufferCount.atMost30');
				check(failures, graph?.nakedArrayBufferProperties === 0, 'wrapped.noNakedArrayBuffers');
				check(failures, graph?.sharedArrayBufferCount === 0, 'wrapped.noSharedArrayBuffers');
				check(failures, Array.isArray(graph?.nonPlainClasses) && graph.nonPlainClasses.length === 0, 'wrapped.noNonPlainClasses');
				check(failures, graphCountsMatch(graph?.runtimeCounts), 'wrapped.runtimeCounts.pinned');
				if (graph && Object.hasOwn(graph, 'viewBuffersMissingFromTransferList')) warnings.push('wrapped.emptyOrMissingBackingCountIsDiagnosticOnly');
			}
		}
		if (row.tracePath == null) warnings.push('optional.traceUnavailable');
		if (row.screenshotPath == null) warnings.push('optional.screenshotUnavailable');
		if (Array.isArray(row.diagnosticErrors) && row.diagnosticErrors.length > 0) warnings.push('optional.diagnosticCaptureError');
	} else {
		failures.push('row.present');
	}
	return { pass: failures.length === 0, failures, warnings, workerAudit };
}

function execFileCaptured(file, args, options = {}) {
	return new Promise((resolve, reject) => {
		execFile(file, args, options, (error, stdout, stderr) => {
			if (error) {
				error.stdout = stdout || '';
				error.stderr = stderr || '';
				error.commandFile = file;
				error.commandArgs = args;
				reject(error);
				return;
			}
			resolve({ stdout: stdout || '', stderr: stderr || '' });
		});
	});
}

function writeJson(filePath, value) {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256File(filePath) {
	return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function normalizeWindowsPath(value) {
	return path.resolve(value).replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
}

function getGitIdentity(editorRoot) {
	const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: editorRoot, encoding: 'utf8', windowsHide: true }).trim();
	const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: editorRoot, encoding: 'utf8', windowsHide: true });
	return { head, clean: status.trim().length === 0, status };
}

async function locateBun() {
	const { stdout } = await execFileCaptured('where.exe', ['bun'], { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024, encoding: 'utf8' });
	const executable = stdout.split(/\r?\n/).map((value) => value.trim()).find((value) => value && /\.exe$/i.test(value));
	if (!executable) fail('Could not resolve the installed Bun executable for the build-identity helper.');
	return executable;
}

async function localBuildIdentity(editorRoot) {
	const appRoot = path.join(editorRoot, 'apps', 'editor');
	const options = {
		appName: 'editor',
		appRoot,
		repoRoot: editorRoot,
		packageNames: IDENTITY_PACKAGE_NAMES
	};
	const code = `import { getAppBuildIdentity } from "../../tooling/research/build-identity.ts"; process.stdout.write(JSON.stringify(getAppBuildIdentity(${JSON.stringify(options)})));`;
	const bun = await locateBun();
	const { stdout } = await execFileCaptured(bun, ['-e', code], {
		cwd: appRoot,
		windowsHide: true,
		timeout: 30_000,
		maxBuffer: 4 * 1024 * 1024,
		encoding: 'utf8'
	});
	return JSON.parse(stdout.trim());
}

function compareServedBuild(served, local, gitIdentity) {
	const identity = served?.identity;
	const failures = [];
	if (!identity || identity.schema !== 'sibambo-app-build-identity-v2') failures.push('served schema is not v2');
	if (identity?.app !== 'editor') failures.push('served app is not Editor');
	if (identity?.commit !== gitIdentity.head || local?.commit !== gitIdentity.head) failures.push('served/local commit differs from candidate HEAD');
	if (identity?.dirty !== false || local?.dirty !== false || !gitIdentity.clean) failures.push('candidate source is not clean');
	for (const key of ['sourceSha256', 'buildConfigSha256']) {
		if (!identity?.[key] || identity[key] !== local?.[key]) failures.push(`${key} differs from local helper`);
	}
	if (!Array.isArray(identity?.packageClosure) || stableJson(identity.packageClosure) !== stableJson(local?.packageClosure)) failures.push('packageClosure differs from local helper');
	return failures;
}

async function readPortListeners(port) {
	const script = `$ErrorActionPreference = 'Stop'; $items = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object LocalAddress,LocalPort,OwningProcess); ConvertTo-Json -InputObject $items -Depth 4 -Compress`;
	const { stdout } = await execFileCaptured('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
		windowsHide: true,
		timeout: 5_000,
		maxBuffer: 256 * 1024,
		encoding: 'utf8'
	});
	let listeners;
	try { listeners = JSON.parse(stdout.trim()); }
	catch { fail(`Port ${port} listener query did not return valid JSON.`); }
	if (!Array.isArray(listeners)) fail(`Port ${port} listener query did not return an explicit JSON array.`);
	return listeners;
}

async function establishServerIdentity(server, serverEntry) {
	if (!Number.isInteger(server.pid) || !server.spawnfile || !Array.isArray(server.spawnargs)) fail('Owned Editor server handle is missing PID, spawnfile, or spawn arguments.');
	if (normalizeWindowsPath(server.spawnfile) !== normalizeWindowsPath(process.execPath)) fail('Editor server spawnfile differs from the active Node executable.');
	if (!server.spawnargs.some((argument) => normalizeWindowsPath(argument) === normalizeWindowsPath(serverEntry))) fail('Editor server spawn arguments do not name the checked build/index.js.');
	const initialBatch = await readProcessSnapshots([{ pid: server.pid, creationUtc: '', parentPid: process.pid }], { timeoutMs: PRODUCTION_BUDGETS.processSnapshotMs });
	const initial = initialBatch.snapshots?.[0];
	if (initialBatch.querySucceeded !== true || initial?.querySucceeded !== true || !initial.root || initial.root.pid !== server.pid || initial.root.ppid !== process.pid) {
		fail('New Editor server process snapshot is unavailable or has the wrong PID/parent.');
	}
	if (normalizeWindowsPath(initial.root.executable) !== normalizeWindowsPath(process.execPath)) fail('Editor server executable differs from the spawned Node handle.');
	if (!normalizeWindowsPath(initial.root.commandLine).includes(normalizeWindowsPath(serverEntry))) fail('Editor server command line does not identify the checked build/index.js.');
	const expected = {
		pid: server.pid,
		creationUtc: initial.root.creationUtc,
		executable: process.execPath,
		parentPid: process.pid,
		profilePath: ''
	};
	const exactBatch = await readProcessSnapshots([expected], { timeoutMs: PRODUCTION_BUDGETS.processSnapshotMs });
	const exact = exactBatch.snapshots?.[0];
	if (exactBatch.querySucceeded !== true || !matchOwnedRootIdentity(exact, expected)) fail('Editor server exact PID/birth/executable/parent identity failed verification.');
	return { expected, initial, verified: exact };
}

function waitForExit(child, timeoutMs) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (exited) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.removeListener('exit', onExit);
			child.removeListener('close', onExit);
			resolve(exited);
		};
		const onExit = () => finish(true);
		const timer = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), timeoutMs);
		child.once('exit', onExit);
		child.once('close', onExit);
	});
}

async function closeServer(server, serverIdentity) {
	const closure = {
		attempted: Boolean(server),
		verified: false,
		identityBeforeClose: serverIdentity,
		freshIdentity: null,
		exitObserved: false,
		absenceSnapshot: null,
		listenersAfter: null,
		error: null
	};
	if (!server) {
		closure.error = 'No owned Editor server was started.';
		return closure;
	}
	try {
		const expected = serverIdentity?.expected;
		if (!expected) fail('Server birth identity was not established; no process signal was issued.');
		const freshBatch = await readProcessSnapshots([expected], { timeoutMs: PRODUCTION_BUDGETS.processSnapshotMs });
		const fresh = freshBatch.snapshots?.[0];
		closure.freshIdentity = fresh;
		if (freshBatch.querySucceeded !== true || fresh?.querySucceeded !== true) fail('Fresh Editor server ownership snapshot is unavailable.');
		if (fresh.root) {
			if (!matchOwnedRootIdentity(fresh, expected)) fail('Fresh Editor server PID/birth/executable/parent identity no longer matches the owned handle.');
			server.kill('SIGTERM');
		}
		closure.exitObserved = await waitForExit(server, 5_000);
		if (!closure.exitObserved && fresh.root) fail('Owned Editor server did not exit within five seconds.');
		const absenceBatch = await readProcessSnapshots([expected], { timeoutMs: PRODUCTION_BUDGETS.processSnapshotMs });
		const absence = absenceBatch.snapshots?.[0];
		closure.absenceSnapshot = absence;
		if (absenceBatch.querySucceeded !== true || absence?.querySucceeded !== true) fail('Post-exit Editor server ownership query is unavailable.');
		if (absence.root !== null || absence.descendants.length !== 0 || absence.profileMatches.length !== 0) fail('Owned Editor server or descendant remains after shutdown.');
		const listeners = await readPortListeners(SERVER_PORT);
		closure.listenersAfter = listeners;
		if (listeners.length !== 0) fail(`Port ${SERVER_PORT} still has a listener after Editor server shutdown.`);
		closure.verified = true;
	} catch (error) {
		closure.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	}
	return closure;
}

async function waitForBuild(baseUrl, app, timeoutMs) {
	const deadline = performance.now() + timeoutMs;
	let lastError = null;
	while (performance.now() < deadline) {
		const remaining = Math.max(1, deadline - performance.now());
		let timer = null;
		try {
			return await Promise.race([
				readBuild(baseUrl, app, 'DEV-PACK'),
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error('Server build identity readiness deadline elapsed.')), remaining);
				})
			]);
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, Math.min(150, Math.max(0, deadline - performance.now()))));
		} finally {
			if (timer !== null) clearTimeout(timer);
		}
	}
	throw new Error(`Editor server did not become ready within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}.`);
}

function appendDurably(fd, record) {
	appendFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
	fsyncSync(fd);
}

function assertPinnedManifest(manifestInfo) {
	if (manifestInfo.manifestSha256 !== MANIFEST_SHA256) fail(`Fixture manifest SHA-256 differs from the frozen pin: ${manifestInfo.manifestSha256}.`);
	const fixture = manifestInfo.fixtures.find((entry) => entry.id === S2_JCM.id);
	if (!fixture || fixture.locator !== S2_JCM.locator || fixture.bytes !== S2_JCM.bytes || fixture.sha256 !== S2_JCM.sha256) {
		fail('S2-jcm fixture descriptor differs from the frozen byte/hash/path identity.');
	}
	return fixture;
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPackingSmoke({ workspaceRoot, output }) {
	const paths = assertOutputPath(workspaceRoot, output);
	if (!path.isAbsolute(output)) fail('--output must be an absolute path.');
	if (!existsSync(paths.workspaceRoot) || !existsSync(path.join(paths.workspaceRoot, 'sibambo-editor'))) fail('Workspace root or Editor repository does not exist.');
	if (!existsSync(path.dirname(paths.output))) fail('Output parent directory must already exist.');
	const editorRoot = path.join(paths.workspaceRoot, 'sibambo-editor');
	const outputRoot = paths.output;
	mkdirSync(outputRoot, { recursive: false });
	const runId = randomUUID();
	const startedAt = new Date().toISOString();
	const summary = {
		schemaVersion: 'bomc-loader-packing-smoke-v1',
		plan: PLAN,
		runId,
		workspaceRoot: paths.workspaceRoot,
		output: outputRoot,
		startedAt,
		status: 'running',
		pass: false,
		cases: [],
		serverClosure: { attempted: false, verified: false },
		failures: []
	};
	writeJson(path.join(outputRoot, 'summary.json'), summary);
	const app = EDITOR_APP;
	const baseUrl = `http://127.0.0.1:${SERVER_PORT}/`;
	let server = null;
	let serverIdentity = null;
	let stdoutLog = null;
	let stderrLog = null;
	let expectedBuild = null;
	let localIdentity = null;
	let manifestAtEntry = null;
	let modulesAtEntry = null;
	let smokeToolShaAtEntry = null;
	let allCasesPassed = false;
	let childSpawnCount = 0;

	try {
		if (process.platform !== 'win32') fail('Packing smoke requires the frozen Windows environment.');
		if (process.version !== 'v22.17.0') fail(`Node runner version differs from v22.17.0: ${process.version}.`);
		const gitIdentity = getGitIdentity(editorRoot);
		if (!gitIdentity.clean) fail(`Editor repository must be clean before server startup: ${gitIdentity.status.trim()}.`);
		if (!EDITOR_ROOT || normalizeWindowsPath(EDITOR_ROOT) !== normalizeWindowsPath(editorRoot)) fail('Smoke adapter path is not inside the selected Editor repository.');
		const manifestPath = path.join(editorRoot, 'tooling', 'performance', 'fixtures.json');
		manifestAtEntry = await readIsolationManifest(paths.workspaceRoot, manifestPath);
		const fixture = assertPinnedManifest(manifestAtEntry);
		modulesAtEntry = runtimeModuleHashes();
		smokeToolShaAtEntry = sha256File(fileURLToPath(import.meta.url));
		const environmentPath = path.join(paths.workspaceRoot, 'docs', 'worklogs', 'BOMC-LOADER-001', '2026-10-03-CP0-luna-review-v1.1', 'B0-editor-boot', 'metadata.json');
		const bootMetadata = JSON.parse(readFileSync(environmentPath, 'utf8'));
		if (!bootMetadata.environment || typeof bootMetadata.environment !== 'object') fail('Accepted B0 Editor boot metadata lacks its expected browser environment.');
		const expectedEnvironment = stableEnvironment(bootMetadata.environment);
		localIdentity = await localBuildIdentity(editorRoot);
		if (localIdentity.commit !== gitIdentity.head || localIdentity.dirty !== false || !gitIdentity.clean) fail('Local build helper did not identify a clean current candidate commit.');
		const listenersBefore = await readPortListeners(SERVER_PORT);
		if (listenersBefore.length !== 0) fail(`Refusing to attach to an existing listener on port ${SERVER_PORT}.`);
		const serverEntry = path.join(editorRoot, 'build', 'index.js');
		if (!existsSync(serverEntry)) fail('Checked adapter-node build is missing apps/editor/build/index.js.');
		stdoutLog = openSync(path.join(outputRoot, 'server.stdout.log'), 'a');
		stderrLog = openSync(path.join(outputRoot, 'server.stderr.log'), 'a');
		server = spawn(process.execPath, [serverEntry], {
			cwd: editorRoot,
			env: { ...process.env, HOST: '127.0.0.1', PORT: String(SERVER_PORT) },
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		if (Number.isInteger(server.pid)) {
			summary.server = { pid: server.pid, spawnfile: server.spawnfile, spawnargs: server.spawnargs, parentPid: process.pid, host: '127.0.0.1', port: SERVER_PORT };
		}
		server.stdout?.on('data', (chunk) => appendFileSync(stdoutLog, chunk));
		server.stderr?.on('data', (chunk) => appendFileSync(stderrLog, chunk));
		writeJson(path.join(outputRoot, 'summary.json'), summary);
		serverIdentity = await establishServerIdentity(server, serverEntry);
		summary.server.identity = serverIdentity;
		writeJson(path.join(outputRoot, 'summary.json'), summary);
		const readyBuild = await waitForBuild(baseUrl, app, 10_000);
		const buildFailures = compareServedBuild(readyBuild, localIdentity, gitIdentity);
		if (buildFailures.length) fail(`Candidate build identity mismatch: ${buildFailures.join('; ')}.`);
		expectedBuild = { ...readyBuild, identity: readyBuild.identity };
		summary.identityEntry = {
			gitIdentity,
			manifest: { path: manifestAtEntry.path, sha256: manifestAtEntry.manifestSha256 },
			modules: modulesAtEntry,
			smokeToolSha256: smokeToolShaAtEntry,
			runtime: { node: process.version, nodeExecutable: process.execPath, browser: expectedEnvironment.browser, browserLaunchArgs: expectedEnvironment.browserLaunchArgs },
			stableEnvironment: expectedEnvironment,
			localBuildIdentity: localIdentity,
			expectedBuild: expectedBuild.identity
		};
		writeJson(path.join(outputRoot, 'metadata.json'), summary.identityEntry);
		writeJson(path.join(outputRoot, 'summary.json'), summary);

		for (const mode of ['native', 'wrapped']) {
			const id = `dev-pack-${runId}-${mode}`;
			const job = {
				id,
				kind: 'diagnostic',
				mode,
				appId: 'editor',
				fixtureId: S2_JCM.id,
				fixture,
				attemptIds: [id],
				expectedOutcome: 'ready'
			};
			const caseOutput = path.join(outputRoot, mode);
			mkdirSync(caseOutput, { recursive: false });
			let buildBefore = null;
			let buildAfter = null;
			let supervisorResult = null;
			let caseFailure = null;
			try {
				buildBefore = await readBuild(baseUrl, app, 'DEV-PACK');
				const beforeFailures = compareServedBuild(buildBefore, localIdentity, gitIdentity);
				if (beforeFailures.length || stableJson(buildBefore.identity) !== stableJson(expectedBuild.identity)) {
					fail(`Build identity changed before ${mode} job: ${beforeFailures.join('; ') || 'served identity differs from run entry'}.`);
				}
				const journalPath = path.join(caseOutput, 'journal.jsonl');
				const journalFd = openSync(journalPath, 'a');
				try {
					supervisorResult = await superviseOwnedJob({
						job,
						run: {
							cwd: editorRoot,
							workspaceRoot: paths.workspaceRoot,
							urls: { editor: baseUrl },
							outputDir: caseOutput,
							expectedEnvironment
						},
						persist: async (record) => appendDurably(journalFd, record)
					});
					childSpawnCount += 1;
				} finally {
					closeSync(journalFd);
				}
			} catch (error) {
				caseFailure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			}
			try { buildAfter = await readBuild(baseUrl, app, 'DEV-PACK'); }
			catch (error) { caseFailure ||= `Build identity after ${mode} job unavailable: ${error instanceof Error ? error.message : String(error)}`; }
			const resultPath = path.join(caseOutput, 'result.json');
			writeJson(resultPath, { job, buildBefore, buildAfter, supervisorResult, caseFailure });
			const acceptance = caseFailure
				? { pass: false, failures: ['job.completedWithoutHarnessError'], warnings: [], workerAudit: null }
				: evaluatePackingSmokeCase({ job, result: supervisorResult, buildBefore, buildAfter, expectedBuild });
			const caseSummary = {
				jobId: id,
				mode,
				status: acceptance.pass ? 'pass' : 'fail',
				acceptance,
				caseFailure,
				buildBefore: identityOf(buildBefore),
				buildAfter: identityOf(buildAfter),
				resultPath: path.relative(outputRoot, resultPath).replaceAll(path.sep, '/')
			};
			summary.cases.push(caseSummary);
			writeJson(path.join(caseOutput, 'acceptance.json'), acceptance);
			writeJson(path.join(outputRoot, 'summary.json'), summary);
			if (!acceptance.pass) {
				summary.failures.push(`${mode}: ${acceptance.failures.join(', ')}`);
				break;
			}
		}
		allCasesPassed = summary.cases.length === 2 && summary.cases.every((item) => item.status === 'pass');
	} catch (error) {
		summary.failures.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
	} finally {
		try {
			if (modulesAtEntry) {
				const modulesAtExit = runtimeModuleHashes();
				const smokeToolShaAtExit = sha256File(fileURLToPath(import.meta.url));
				const manifestAtExit = await readIsolationManifest(paths.workspaceRoot, path.join(editorRoot, 'tooling', 'performance', 'fixtures.json'));
				assertPinnedManifest(manifestAtExit);
				summary.identityExit = {
					modules: modulesAtExit,
					smokeToolSha256: smokeToolShaAtExit,
					manifestSha256: manifestAtExit.manifestSha256,
					modulesUnchanged: stableJson(modulesAtEntry) === stableJson(modulesAtExit),
				smokeToolUnchanged: smokeToolShaAtEntry === smokeToolShaAtExit,
					manifestUnchanged: manifestAtEntry?.manifestSha256 === manifestAtExit.manifestSha256
				};
				if (!summary.identityExit.modulesUnchanged || !summary.identityExit.smokeToolUnchanged || !summary.identityExit.manifestUnchanged) summary.failures.push('Global module, smoke tool, or fixture manifest identity changed during collection.');
			} else {
				summary.identityExit = { verified: false, error: 'Run entry identity was not established.' };
			}
		} catch (error) {
			summary.identityExit = { verified: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
			summary.failures.push(`Global identity exit check failed: ${summary.identityExit.error}`);
		}
		if (server) {
			summary.serverClosure = await closeServer(server, serverIdentity);
			if (!summary.serverClosure.verified) summary.failures.push(`Editor server closure unverified: ${summary.serverClosure.error || 'closure predicates failed'}`);
		} else {
			summary.serverClosure = { attempted: false, verified: false, error: 'No owned Editor server was spawned.' };
		}
		for (const stream of [server?.stdout, server?.stderr]) stream?.destroy();
		for (const descriptor of [stdoutLog, stderrLog]) if (descriptor !== null) {
			try { closeSync(descriptor); } catch { /* a prior process teardown may already close it */ }
		}
		if (childSpawnCount > 0) summary.childSpawnCount = childSpawnCount;
		summary.pass = allCasesPassed && summary.serverClosure.verified === true && summary.failures.length === 0 && summary.identityExit?.modulesUnchanged === true && summary.identityExit?.smokeToolUnchanged === true && summary.identityExit?.manifestUnchanged === true;
		summary.status = summary.pass ? 'pass' : 'fail';
		summary.finishedAt = new Date().toISOString();
		writeJson(path.join(outputRoot, 'server-closure.json'), summary.serverClosure);
		writeJson(path.join(outputRoot, 'summary.json'), summary);
	}
	return summary;
}

async function main() {
	const args = parsePackingSmokeArgs(process.argv.slice(2));
	const result = await runPackingSmoke(args);
	process.stdout.write(`${JSON.stringify({ output: result.output, status: result.status, cases: result.cases.map(({ mode, status }) => ({ mode, status })), serverClosure: result.serverClosure.verified })}\n`);
	if (result.pass !== true) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
