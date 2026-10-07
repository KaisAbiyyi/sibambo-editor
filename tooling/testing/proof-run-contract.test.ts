import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
	captureProofRuntime, captureSourceIdentity, claimProofAttempt, collectExecutionRootFiles, evaluateFinalGate, inventoryFiles,
	markProofOutcome, parsePlaywrightReportJson, readProofTicket, resolveProofPaths, setupFailureReason, validateSealedSourceSnapshot,
	 type ColdCycle, type FinalGateReceipt, type PlaywrightReport, type ProofAttempt,
	type ProofTicket, type ProofTrack
} from './proof-run-contract';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const workspaceRoot = path.resolve(import.meta.dir, '../..', '..');
const worklogRoot = path.join(workspaceRoot, 'docs', 'worklogs');
const runtime = captureProofRuntime();
const ownedRoots: string[] = [];
const originalEnv = new Map<string, string | undefined>();
const sourceSnapshotRoot = mkdtempSync(path.join(worklogRoot, 'BOMC-EDITOR-NEXT-001', '.proof-contract-snapshot-'));
const sourceSnapshotPath = path.join(sourceSnapshotRoot, 'common-source-snapshot.json');
const originalSnapshotEnv = process.env.SIBAMBO_PROOF_SNAPSHOT;

beforeAll(() => {
	writeFileSync(sourceSnapshotPath, `${JSON.stringify({
		schemaVersion: 'sibambo-editor-next-source-snapshot-v1', planId: 'BOMC-EDITOR-NEXT-001', planVersion: '1.1', capturedAt: new Date().toISOString(),
		sourceIdentity: captureSourceIdentity(), runtime
	}, null, 2)}\n`, { flag: 'wx' });
	process.env.SIBAMBO_PROOF_SNAPSHOT = sourceSnapshotPath;
});

afterAll(() => {
	if (originalSnapshotEnv === undefined) delete process.env.SIBAMBO_PROOF_SNAPSHOT; else process.env.SIBAMBO_PROOF_SNAPSHOT = originalSnapshotEnv;
	if (existsSync(sourceSnapshotRoot)) rmSync(sourceSnapshotRoot, { recursive: true, force: true });
});

afterEach(() => {
	for (const key of [...originalEnv.keys()]) {
		const value = originalEnv.get(key);
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	originalEnv.clear();
	for (const root of ownedRoots.splice(0)) if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe('BOMC readiness proof ownership contract', () => {
	it('claims once, supports config reimports after Playwright creates output, and keeps discovery read-only', () => {
		const root = makeRoot('BOMC-VIEWER-RECOVERY-001');
		const ticket = claim({ track: 'mirror', root });
		const beforeDuplicate = collectExecutionRootFiles(root);
		expect(() => claim({ track: 'mirror', root })).toThrow();
		expect(collectExecutionRootFiles(root)).toEqual(beforeDuplicate);

		setEnv({
			SIBAMBO_PROOF_DISCOVERY: '0', SIBAMBO_PROOF_TICKET: path.join(ticket.claimRoot, 'run-ticket.json'),
			SIBAMBO_PROOF_NONCE: ticket.nonce, SIBAMBO_PROOF_ATTEMPT: '01',
			SIBAMBO_RECOVERY_WORKLOG: root, SIBAMBO_RECOVERY_ATTEMPT: '01'
		});
		mkdirSync(ticket.outputDir, { recursive: true });
		writeFileSync(path.join(ticket.outputDir, 'playwright-created.txt'), 'owned by the selected run');
		const firstRead = readProofTicket('mirror');
		const secondRead = readProofTicket('mirror');
		if ('discoveryOnly' in firstRead || 'discoveryOnly' in secondRead) throw new Error('Run ticket unexpectedly resolved as discovery metadata.');
		expect(firstRead.nonce).toBe(ticket.nonce);
		expect(secondRead.nonce).toBe(ticket.nonce);
		expect(ticket.snapshotPath).toBe(sourceSnapshotPath);

		setEnv({ SIBAMBO_PROOF_DISCOVERY: '1', SIBAMBO_PROOF_TICKET: undefined, SIBAMBO_PROOF_NONCE: undefined,
			SIBAMBO_RECOVERY_WORKLOG: root, SIBAMBO_RECOVERY_ATTEMPT: '01', SIBAMBO_PROOF_ATTEMPT: '01' });
		const beforeDiscovery = collectExecutionRootFiles(root);
		const discovery = readProofTicket('mirror');
		expect('discoveryOnly' in discovery && discovery.discoveryOnly).toBe(true);
		expect(() => markProofOutcome(discovery, ticket.testTitles[0]!)).toThrow();
		expect(collectExecutionRootFiles(root)).toEqual(beforeDiscovery);
	}, 15_000);

	it('requires the plan-scoped absolute snapshot and exact runtime identity', () => {
		setEnv({ SIBAMBO_PROOF_SNAPSHOT: undefined });
		expect(() => validateSealedSourceSnapshot(captureSourceIdentity(), runtime)).toThrow(/SIBAMBO_PROOF_SNAPSHOT must be an absolute path/);
		const outside = makeRoot('BOMC-WEB-WRITER-001');
		setEnv({ SIBAMBO_PROOF_SNAPSHOT: path.join(outside, 'common-source-snapshot.json') });
		expect(() => validateSealedSourceSnapshot(captureSourceIdentity(), runtime)).toThrow(/strict child/);
		setEnv({ SIBAMBO_PROOF_SNAPSHOT: sourceSnapshotPath });
		expect(() => validateSealedSourceSnapshot(captureSourceIdentity(), { ...runtime, bun: 'other-runtime' })).toThrow(/proof runtime differs/);
	});

	it('rejects outside roots, junction escapes, and wrong ticket environment values', () => {
		const topic = path.join(worklogRoot, 'BOMC-VIEWER-RECOVERY-001');
		mkdirSync(topic, { recursive: true });
		const root = makeRoot('BOMC-VIEWER-RECOVERY-001');
		expect(() => resolveProofPaths({ track: 'mirror', executionRoot: path.join(topic, '..', 'outside-proof-root'), attempt: '01' })).toThrow();

		const beforeJunction = inventoryFiles(collectExecutionRootFiles(root));
		const outside = makeRoot('BOMC-EDITOR-STABILITY-001');
		const junction = path.join(root, 'junction-escape');
		symlinkSync(outside, junction, 'junction');
		expect(inventoryFiles(collectExecutionRootFiles(root))).not.toEqual(beforeJunction);
		expect(() => resolveProofPaths({ track: 'mirror', executionRoot: junction, attempt: '01' })).toThrow();

		const ticket = claim({ track: 'mirror', root });
		const ticketPath = path.join(ticket.claimRoot, 'run-ticket.json');
		setEnv({ SIBAMBO_PROOF_DISCOVERY: '0', SIBAMBO_PROOF_TICKET: ticketPath, SIBAMBO_PROOF_NONCE: 'wrong-nonce',
			SIBAMBO_RECOVERY_WORKLOG: root, SIBAMBO_RECOVERY_ATTEMPT: '01' });
		expect(() => readProofTicket('mirror')).toThrow(/nonce/);
		setEnv({ SIBAMBO_PROOF_NONCE: ticket.nonce });
		expect(() => readProofTicket('writer')).toThrow(/does not match writer/);
		setEnv({ SIBAMBO_RECOVERY_ATTEMPT: '02' });
		expect(() => readProofTicket('mirror')).toThrow(/environment/);
	});

	it('allows attempt 02 only after a same-input recognized setup-only attempt 01 receipt', () => {
		const root = makeRoot('BOMC-VIEWER-RECOVERY-001');
		const first = claim({ track: 'mirror', root });
		const receipt = failedReceipt(first, true, 'browser-launch-failure');
		writeReceipt(first, receipt);
		const second = claim({ track: 'mirror', root, attempt: '02' });
		expect(second.previousReceipt).toBe(first.finalGateFile);
		expect(second.identitySha256).toBe(first.identitySha256);

		const invalidRoot = makeRoot('BOMC-VIEWER-RECOVERY-001');
		const invalid = claim({ track: 'mirror', root: invalidRoot });
		writeReceipt(invalid, failedReceipt(invalid, false, null));
		expect(() => claim({ track: 'mirror', root: invalidRoot, attempt: '02' })).toThrow(/Attempt-02 requires/);
	});

	it('rejects a ticket whose required sidecar path was changed after claim', () => {
		const root = makeRoot('BOMC-VIEWER-RECOVERY-001');
		const ticket = claim({ track: 'mirror', root });
		const ticketPath = path.join(ticket.claimRoot, 'run-ticket.json');
		const serialized = JSON.parse(readFileSync(ticketPath, 'utf8')) as ProofTicket;
		serialized.requiredSidecars[0] = path.join(root, 'outside.json');
		writeFileSync(ticketPath, `${JSON.stringify(serialized, null, 2)}\n`);
		setEnv({ SIBAMBO_PROOF_DISCOVERY: '0', SIBAMBO_PROOF_TICKET: ticketPath, SIBAMBO_PROOF_NONCE: ticket.nonce,
			SIBAMBO_PROOF_ATTEMPT: '01', SIBAMBO_RECOVERY_WORKLOG: root, SIBAMBO_RECOVERY_ATTEMPT: '01' });
		expect(() => readProofTicket('mirror')).toThrow(/required sidecars/);
	});

	it('accepts only the passed same-source cold-03 cache for warm-01', () => {
		const root = makeRoot('BOMC-EDITOR-STABILITY-001');
		const cold = claim({ track: 'cold', root, cycle: 'cold-03' });
		mkdirSync(cold.cacheDir!, { recursive: false });
		writeReceipt(cold, { ...passedReceipt(cold), ticketSnapshot: cold });
		const warm = claim({ track: 'cold', root, cycle: 'warm-01', previousReceipt: cold.finalGateFile });
		expect(warm.cacheDir).toBe(cold.cacheDir);
		expect(warm.previousReceipt).toBe(cold.finalGateFile);

		const changedRoot = makeRoot('BOMC-EDITOR-STABILITY-001');
		const changed = claim({ track: 'cold', root: changedRoot, cycle: 'cold-03' });
		mkdirSync(changed.cacheDir!, { recursive: false });
		const changedSnapshot = { ...changed, identitySha256: `${changed.identitySha256}-changed` };
		writeReceipt(changed, { ...passedReceipt(changed), ticketSnapshot: changedSnapshot });
		expect(() => claim({ track: 'cold', root: changedRoot, cycle: 'warm-01', previousReceipt: changed.finalGateFile })).toThrow(/source\/fixture\/runtime identity differs/);
		expect(() => claim({ track: 'cold', root, cycle: 'warm-01', previousReceipt: changed.finalGateFile })).toThrow(/must be the cold-03 final receipt/);
	});

	it('requires exact final results, markers, sidecars, source identity, and clean child exit', () => {
		const root = makeRoot('BOMC-VIEWER-RECOVERY-001');
		const ticket = claim({ track: 'mirror', root });
		const markers = ticket.testTitles.map((title) => markProofOutcome(ticket, title));
		const sidecars = ticket.requiredSidecars.map((file, index) => {
			mkdirSync(path.dirname(file), { recursive: true });
			const payload = { title: ticket.testTitles[index], planId: ticket.planId, planVersion: ticket.planVersion, testedHead: ticket.testedHead,
				nonce: ticket.nonce, identitySha256: ticket.identitySha256, observedStatus: 'passed', expectedStatus: 'passed', stage: 'test-complete', errors: [] };
			writeFileSync(file, JSON.stringify(payload), { flag: 'wx' });
			return file;
		});
		const identity = captureSourceIdentity();
		const accepted = evaluateFinalGate({ ticket, report: passedReport(ticket.testTitles), child: { exitCode: 0, signal: null }, cleanup: { passed: true, details: {} }, currentIdentity: identity, markerFiles: markers, sidecarFiles: sidecars });
		expect(accepted.gate).toBe('passed');
		const firstMarker = markers[0]!;
		const changedMarker = JSON.parse(readFileSync(firstMarker, 'utf8')) as Record<string, unknown>;
		changedMarker.testedHead = `${ticket.testedHead}-changed`;
		writeFileSync(firstMarker, JSON.stringify(changedMarker));
		expect(evaluateFinalGate({ ticket, report: passedReport(ticket.testTitles), child: { exitCode: 0, signal: null }, cleanup: { passed: true, details: {} }, currentIdentity: identity, markerFiles: markers, sidecarFiles: sidecars }).gate).toBe('failed');
		const firstSidecar = sidecars[0]!;
		const changedSidecar = JSON.parse(readFileSync(firstSidecar, 'utf8')) as Record<string, unknown>;
		changedSidecar.observedStatus = 'failed';
		writeFileSync(firstSidecar, JSON.stringify(changedSidecar));
		const badSidecar = evaluateFinalGate({ ticket, report: passedReport(ticket.testTitles), child: { exitCode: 0, signal: null }, cleanup: { passed: true, details: {} }, currentIdentity: identity, markerFiles: markers, sidecarFiles: sidecars });
		expect(badSidecar.gate).toBe('failed');

		const exitedBadly = evaluateFinalGate({ ticket, report: passedReport(ticket.testTitles), child: { exitCode: 1, signal: null }, cleanup: { passed: true, details: {} }, currentIdentity: identity, markerFiles: markers, sidecarFiles: sidecars });
		expect(exitedBadly.gate).toBe('failed');
		expect(exitedBadly.retryEligible).toBe(false);
		const skipped = evaluateFinalGate({ ticket, report: passedReport(ticket.testTitles, 'skipped'), child: { exitCode: 0, signal: null }, cleanup: { passed: true, details: {} }, currentIdentity: identity, markerFiles: markers, sidecarFiles: sidecars });
		expect(skipped.gate).toBe('failed');
		const zeroCases = evaluateFinalGate({ ticket, report: passedReport([]), child: { exitCode: 0, signal: null }, cleanup: { passed: true, details: {} }, currentIdentity: identity, markerFiles: markers, sidecarFiles: sidecars });
		expect(zeroCases.gate).toBe('failed');
		const flakyReport = passedReport(ticket.testTitles);
		const flakySpec = flakyReport.suites![0]!.specs![0]!;
		flakySpec.tests[0]!.status = 'flaky';
		flakySpec.tests[0]!.results = [
			{ status: 'failed', retry: 0, errors: [{ message: 'first attempt failed' }] },
			{ status: 'passed', retry: 1, errors: [] }
		];
		expect(evaluateFinalGate({ ticket, report: flakyReport, child: { exitCode: 0, signal: null }, cleanup: { passed: true, details: {} }, currentIdentity: identity, markerFiles: markers, sidecarFiles: sidecars }).gate).toBe('failed');
		const runnerErrorReport = passedReport(ticket.testTitles);
		runnerErrorReport.errors = [{ message: 'runner error' }];
		expect(evaluateFinalGate({ ticket, report: runnerErrorReport, child: { exitCode: 0, signal: null }, cleanup: { passed: true, details: {} }, currentIdentity: identity, markerFiles: markers, sidecarFiles: sidecars }).gate).toBe('failed');
		const changed = { ...identity, identitySha256: `${identity.identitySha256}-changed` };
		expect(evaluateFinalGate({ ticket, report: passedReport(ticket.testTitles), child: { exitCode: 0, signal: null }, cleanup: { passed: true, details: {} }, currentIdentity: changed, markerFiles: markers, sidecarFiles: sidecars }).gate).toBe('failed');
		expect(evaluateFinalGate({ ticket, report: null, child: { exitCode: 1, signal: null }, cleanup: { passed: true, details: {} }, currentIdentity: identity, markerFiles: markers, sidecarFiles: sidecars }).gate).toBe('blocked');
		expect(parsePlaywrightReportJson('{broken-json')).toBe(null);
		expect(evaluateFinalGate({ ticket, report: parsePlaywrightReportJson('{broken-json'), child: { exitCode: 1, signal: null }, cleanup: { passed: true, details: {} }, currentIdentity: identity, markerFiles: markers, sidecarFiles: sidecars }).gate).toBe('blocked');
	});

	it('classifies only recognized zero-outcome setup failures as retryable', () => {
		const root = makeRoot('BOMC-VIEWER-RECOVERY-001');
		const ticket = claim({ track: 'mirror', root });
		const identity = captureSourceIdentity();
		const reason = setupFailureReason('', 'browserType.launch: executable does not exist', null, 0);
		expect(reason).toBe('browser-launch-failure');
		const retryable = evaluateFinalGate({ ticket, report: null, child: { exitCode: 1, signal: null }, cleanup: { passed: true, details: {} }, currentIdentity: identity, markerFiles: [], sidecarFiles: [], setupFailureReason: reason });
		expect(retryable.retryEligible).toBe(true);
		expect(setupFailureReason('', 'unclassified failure', null, 0)).toBe(null);
		expect(setupFailureReason('', 'browserType.launch: executable does not exist', null, 1)).toBe(null);
	});
});

function makeRoot(topicId: string) {
	const topic = path.join(worklogRoot, topicId);
	mkdirSync(topic, { recursive: true });
	const root = mkdtempSync(path.join(topic, '.readiness-contract-unit-'));
	ownedRoots.push(root);
	return root;
}

function claim(input: { track: ProofTrack; root: string; attempt?: ProofAttempt; cycle?: ColdCycle; previousReceipt?: string }) {
	return claimProofAttempt({ track: input.track, executionRoot: input.root, attempt: input.attempt ?? '01', cycle: input.cycle,
		previousReceipt: input.previousReceipt, runtime });
}

function setEnv(values: Record<string, string | undefined>) {
	for (const [key, value] of Object.entries(values)) {
		if (!originalEnv.has(key)) originalEnv.set(key, process.env[key]);
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
}

function passedReceipt(ticket: ProofTicket): FinalGateReceipt {
	return { schemaVersion: 'sibambo-proof-final-gate-v1', gate: 'passed', retryEligible: false, planId: ticket.planId, planVersion: ticket.planVersion,
		track: ticket.track, cycle: ticket.cycle, attempt: ticket.attempt, ticketSnapshot: ticket, child: { exitCode: 0, signal: null }, caseOutcomes: [],
		errors: [], setupFailureReason: null, markerFiles: [], sidecarFiles: [], cleanup: { passed: true, details: {} }, limits: [], completedAt: new Date().toISOString() };
}

function failedReceipt(ticket: ProofTicket, retryEligible: boolean, setupFailureReason: string | null): FinalGateReceipt {
	return { ...passedReceipt(ticket), gate: 'failed', retryEligible, setupFailureReason, child: { exitCode: 1, signal: null } };
}

function writeReceipt(ticket: ProofTicket, receipt: FinalGateReceipt) {
	writeFileSync(ticket.finalGateFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
}

function passedReport(titles: string[], status: 'expected' | 'skipped' = 'expected'): PlaywrightReport {
	return { errors: [], suites: titles.map((title) => ({ title: 'selected-spec', specs: [{ title, tests: [{ expectedStatus: 'passed', status, results: [{ status: status === 'expected' ? 'passed' : 'skipped', retry: 0, errors: [] }] }] }] })) };
}
