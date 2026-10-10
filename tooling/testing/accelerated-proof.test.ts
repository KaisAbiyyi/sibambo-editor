import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	ACCELERATED_CASE_TITLES, CURRENT_INPUT_ORACLE, CURRENT_S2_PIN, acceleratedCaseDefinitions,
	acceleratedFixturesForSuite, acceleratedReferencesForSuite, claimAcceleratedAttempt,
	classifyAcceleratedSetupFailure, createAcceleratedCasePayload, finalizeAcceleratedAttempt,
	acceleratedTopicRoot, loadCurrentS2Oracle, readAcceleratedContext, recordAcceleratedCase, sameAcceleratedIdentity,
	type AcceleratedProofTicket, type AcceleratedRuntime
} from './accelerated-proof';

const ownedRoots: string[] = [];
const savedEnvironment = new Map<string, string | undefined>();
const runtime: AcceleratedRuntime = {
	node: 'v24.0.0', nodePath: 'C:/proof/node.exe', bun: '1.2.0', playwright: '1.55.0',
	browser: 'chromium', browserVersion: 'Chromium 140.0.0.0', backend: 'chromium-headless-webgl2'
};

afterEach(() => {
	for (const [key, value] of savedEnvironment) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	savedEnvironment.clear();
	for (const root of ownedRoots.splice(0)) if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe('EDITOR-ACCELERATED-001 C1 proof contract', () => {
	it('keeps the current exact input, oracle rows, and suite boundaries pinned', () => {
		const current = acceleratedFixturesForSuite('current-cold');
		expect(current.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 }))).toEqual([{
			id: CURRENT_S2_PIN.id, bytes: CURRENT_S2_PIN.bytes, sha256: CURRENT_S2_PIN.sha256
		}]);
		const semanticFixtures = acceleratedFixturesForSuite('current-semantic');
		expect(semanticFixtures.map((row) => row.id)).toEqual([CURRENT_S2_PIN.id]);
		const reference = acceleratedReferencesForSuite('current-semantic')[0]!;
		const pin = {
			id: reference.id, path: reference.path, bytes: readFileSync(reference.path).byteLength,
			sha256: reference.sha256, realPath: realpathSync(reference.path)
		};
		const oracle = loadCurrentS2Oracle(pin);
		expect({ bytes: pin.bytes, sha256: pin.sha256 }).toEqual({ bytes: CURRENT_INPUT_ORACLE.bytes, sha256: CURRENT_INPUT_ORACLE.sha256 });
		expect(oracle.fixture.activeSemanticCount).toBe(10);
		expect(oracle.active.map((row) => row.materialIndex)).toEqual([17, 19, 32, 33, 34, 35, 36, 43, 45, 46]);
		expect(acceleratedCaseDefinitions('current-cold', 'cold-01', current.map((row) => row.id)).map((row) => row.title)).toEqual([
			ACCELERATED_CASE_TITLES.currentCold, ACCELERATED_CASE_TITLES.currentColdHydration
		]);
		expect(acceleratedCaseDefinitions('current-cold', 'cold-02', current.map((row) => row.id)).map((row) => row.title)).toEqual([ACCELERATED_CASE_TITLES.currentCold]);
		expect(acceleratedCaseDefinitions('current-semantic', null, semanticFixtures.map((row) => row.id)).map((row) => row.title)).toEqual([ACCELERATED_CASE_TITLES.currentSemantic]);
	});

	it('claims once under the canonical topic and only reads a matching run ticket', () => {
		const executionRoot = newExecutionRoot();
		const ticket = claim('current-cold', executionRoot, 'cold-02');
		expect(ticket.schemaVersion).toBe('sibambo-accelerated-proof-v1');
		expect(ticket.fixturePins.map((row) => row.id)).toEqual([CURRENT_S2_PIN.id]);
		expect(ticket.cacheDir).toBe(path.join(ticket.attemptRoot, 'vite-cache'));
		expect(existsSync(ticket.cacheDir!)).toBe(true);
		expect(() => claim('current-cold', executionRoot, 'cold-02')).toThrow(/may not be reused/);

		setEnvironment({
			SIBAMBO_ACCELERATED_DISCOVERY: '0', SIBAMBO_ACCELERATED_TICKET: ticket.ticketFile,
			SIBAMBO_ACCELERATED_NONCE: ticket.nonce, SIBAMBO_ACCELERATED_RUN_ROOT: ticket.executionRoot
		});
		const loaded = readAcceleratedContext('current-cold');
		expect(loaded && !('discoveryOnly' in loaded)).toBe(true);
		expect((loaded as AcceleratedProofTicket).runUUID).toBe(ticket.runUUID);
		expect(sameAcceleratedIdentity(loaded as AcceleratedProofTicket, ticket)).toBe(true);
		setEnvironment({ SIBAMBO_ACCELERATED_DISCOVERY: '1' });
		expect(readAcceleratedContext('current-cold')).toBeNull();
	});

	it('allows one identical-source retry only for a recognized pre-outcome setup failure', () => {
		const executionRoot = newExecutionRoot();
		const first = claim('current-semantic', executionRoot);
		const failure = finalizeAcceleratedAttempt({
			ticket: first, report: null, child: { exitCode: 1, signal: null }, cleanup: { passed: true, details: {} },
			identityAfter: first, stderr: 'browserType.launch: executable does not exist'
		});
		expect(failure.gate).toBe('blocked');
		expect(failure.retryEligible).toBe(true);
		expect(failure.setupFailureReason).toBe('browser-launch-failure');
		writeFileSync(first.finalReceiptFile, `${JSON.stringify(failure, null, 2)}\n`, { flag: 'wx' });

		const second = claim('current-semantic', executionRoot, undefined, 2, first.finalReceiptFile);
		expect(second.attempt).toBe(2);
		expect(second.previousReceipt).toBe(first.finalReceiptFile);
		expect(second.attemptRoot).not.toBe(first.attemptRoot);
		expect(sameAcceleratedIdentity(second, first)).toBe(true);
		expect(() => claim('current-semantic', newExecutionRoot(), undefined, 2, first.finalReceiptFile)).toThrow(/original run root/);
		expect(() => claim('current-semantic', executionRoot, undefined, 3, first.finalReceiptFile)).toThrow(/1 or 2/);

		const caseFailure = finalizeAcceleratedAttempt({
			ticket: second,
			report: { errors: [], suites: [{ title: 'current-semantic', specs: [{
				title: ACCELERATED_CASE_TITLES.currentSemantic,
				tests: [{ expectedStatus: 'passed', status: 'unexpected', results: [{ status: 'failed', retry: 0, errors: [{ message: 'assertion failed' }] }] }]
			}] }] },
			child: { exitCode: 1, signal: null }, cleanup: { passed: true, details: {} }, identityAfter: second,
			stderr: 'browserType.launch: executable does not exist'
		});
		expect(caseFailure.retryEligible).toBe(false);
		expect(classifyAcceleratedSetupFailure('', 'browserType.launch: executable does not exist', { exitCode: 1, signal: null }, 1)).toBeNull();
	});

	it('seals report attachment copies to the exact ticketed sidecar and PNG bytes', () => {
		const ticket = claim('current-semantic', newExecutionRoot());
		const title = ACCELERATED_CASE_TITLES.currentSemantic;
		const definition = ticket.cases.find((row) => row.title === title)!;
		const observations = Object.fromEntries(definition.requiredObservations.map((name) => [name, true]));
		const inputHashes = {
			[CURRENT_S2_PIN.id]: CURRENT_S2_PIN.sha256,
			[CURRENT_INPUT_ORACLE.id]: CURRENT_INPUT_ORACLE.sha256,
			'S2-current-corrupt-replacement': 'a'.repeat(64)
		};
		const payload = createAcceleratedCasePayload(ticket, title, { observations, inputHashes, data: { contractCase: true } });
		const sidecarPath = path.join(ticket.outputDir, definition.sidecarName);
		writeFileSync(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
		const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vS8AAAAASUVORK5CYII=', 'base64');
		const artifactPaths = definition.artifactNames.map((name) => {
			const artifactPath = path.join(ticket.outputDir, name);
			writeFileSync(artifactPath, png, { flag: 'wx' });
			return artifactPath;
		});
		recordAcceleratedCase(ticket, title, { sidecarPath, artifactPaths, payload });
		const attachmentDirectory = path.join(ticket.outputDir, 'attachments');
		mkdirSync(attachmentDirectory);
		const sidecarAttachment = path.join(attachmentDirectory, definition.sidecarName);
		writeFileSync(sidecarAttachment, readFileSync(sidecarPath), { flag: 'wx' });
		const artifactAttachments = artifactPaths.map((artifactPath) => {
			const attachmentPath = path.join(attachmentDirectory, path.basename(artifactPath));
			writeFileSync(attachmentPath, readFileSync(artifactPath), { flag: 'wx' });
			return attachmentPath;
		});
		const report = { errors: [], suites: [{ title: 'current-semantic', specs: [{
			title, tests: [{ expectedStatus: 'passed', status: 'expected', results: [{
				status: 'passed', retry: 0, errors: [], attachments: [
					{ name: definition.sidecarName, contentType: 'application/json', path: sidecarAttachment },
					...artifactAttachments.map((attachmentPath) => ({ name: path.basename(attachmentPath), contentType: 'image/png', path: attachmentPath }))
				]
			}] }]
		}] }] };
		const receipt = finalizeAcceleratedAttempt({
			ticket, report, child: { exitCode: 0, signal: null }, cleanup: { passed: true, details: {} }, identityAfter: ticket
		});
		expect(receipt.gate).toBe('passed');
		expect(receipt.retryEligible).toBe(false);
		expect(receipt.markerFiles).toEqual([ticket.markerFiles[0]]);
		expect(receipt.sidecarFiles).toEqual([sidecarPath]);
		writeFileSync(artifactAttachments[0]!, Buffer.from('different bytes'));
		const changedAttachmentReceipt = finalizeAcceleratedAttempt({
			ticket, report, child: { exitCode: 0, signal: null }, cleanup: { passed: true, details: {} }, identityAfter: ticket
		});
		expect(changedAttachmentReceipt.gate).toBe('failed');
		expect(changedAttachmentReceipt.errors.some((error) => error.includes('report attachment') && error.includes('bytes or SHA-256 differ'))).toBe(true);
	});
});

function newExecutionRoot() {
	const parent = mkdtempSync(path.join(acceleratedTopicRoot, '.editor-accelerated-contract-'));
	ownedRoots.push(parent);
	return path.join(parent, 'run-001');
}

function claim(suite: 'current-cold' | 'current-semantic', executionRoot: string, cycle?: 'cold-01' | 'cold-02' | 'cold-03' | 'warm-01', attempt = 1, previousReceipt: string | null = null) {
	return claimAcceleratedAttempt({ suite, executionRoot, attempt, runtime, cycle, previousReceipt });
}

function setEnvironment(values: Record<string, string | undefined>) {
	for (const [key, value] of Object.entries(values)) {
		if (!savedEnvironment.has(key)) savedEnvironment.set(key, process.env[key]);
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
}
