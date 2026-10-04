import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { adapterNodeBuildEntry, evaluatePackingSmokeCase, parsePackingSmokeArgs } from './loader-packing-smoke.mjs';

const WORKSPACE_ROOT = path.resolve(process.cwd(), '..');
const WORKLOG_ROOT = path.join(WORKSPACE_ROOT, 'docs', 'worklogs', 'BOMC-LOADER-001');
const PINNED_FIXTURE = {
	id: 'S2-jcm',
	bytes: 3_354_834,
	sha256: '39851b73848aa42cb742e1be6230965327a41c31ec6b1051848304ac09faf637'
};

describe('BOMC packing smoke build path', () => {
	test('uses the Editor app adapter-node output beneath the repository root', () => {
		const editorRoot = path.resolve('candidate-editor');
		expect(adapterNodeBuildEntry(editorRoot)).toBe(path.join(editorRoot, 'apps', 'editor', 'build', 'index.js'));
	});
});

function buildIdentity() {
	return {
		schema: 'sibambo-app-build-identity-v2',
		app: 'editor',
		version: '0.1.0',
		commit: 'a'.repeat(40),
		dirty: false,
		workingTree: { buildInputModifiedPaths: [], buildInputUntrackedPaths: [], otherModifiedPaths: [], otherUntrackedPaths: [], generatedOutputPaths: [] },
		fingerprintScheme: 'sibambo-app-closure-sha256-v1',
		sourceSha256: 'b'.repeat(64),
		buildConfigSha256: 'c'.repeat(64),
		lockfileSha256: 'd'.repeat(64),
		policySha256: null,
		dataManifestSha256: null,
		packageClosure: [{ name: '@sibambo/e4-import', version: '0.1.0', manifestSha256: 'e'.repeat(64) }],
		capturedAt: '2026-10-04T00:00:00.000Z'
	};
}

function wrappedGraph() {
	return {
		sourceBufferRetainedBytes: PINNED_FIXTURE.bytes,
		sourceBufferInTransferList: false,
		graphIncludesSourceBuffer: false,
		transferBufferCount: 24,
		nakedArrayBufferProperties: 0,
		sharedArrayBufferCount: 0,
		nonPlainClasses: [],
		runtimeCounts: {
			resultFacesLength: 270,
			preparedRuntimeSceneGroupsLength: 291,
			sourceCounts: { materials: 48, tags: 19, meshes: 80, faces: 7078, definitions: 106, instances: 122, transforms: 101, textures: 14, edges: 14354 }
		}
	};
}

function workerEvents(mode) {
	if (mode === 'native') {
		return [
			{ phase: 'native-worker', workerId: '1', epochMs: 100 },
			{ phase: 'native-main-receive', type: 'complete', id: 41, workerId: '1', epochMs: 120 }
		];
	}
	// The page-realm receipt can be delivered before the worker-realm post-return receipt.
	return [
		{ phase: 'wrapped-worker', workerId: '2', epochMs: 100 },
		{ phase: 'worker-pre-post', type: 'complete', id: 51, workerId: '2', epochMs: 110, graph: wrappedGraph() },
		{ phase: 'main-receive', type: 'complete', id: 51, workerId: '2', epochMs: 110.5 },
		{ phase: 'worker-post-return', type: 'complete', id: 51, workerId: '2', epochMs: 111 }
	];
}

function validCase(mode) {
	const id = `dev-pack-test-${mode}`;
	const identity = buildIdentity();
	const row = {
		scenarioRowId: id,
		jobId: id,
		app: 'editor',
		fixtureId: PINNED_FIXTURE.id,
		fixtureBytes: PINNED_FIXTURE.bytes,
		fixtureSha256: PINNED_FIXTURE.sha256,
		mode: 'diagnostic-excluded',
		outcomeStatus: 'ready',
		openOccurred: true,
		elapsedMs: 1200,
		observationIntegrity: 'valid',
		harnessStatus: 'ok',
		cleanupStatus: 'complete',
		firstValidFrame: {
			viewportCanvas: true,
			tagName: 'CANVAS',
			cssWidth: 960,
			cssHeight: 640,
			bufferWidth: 1920,
			bufferHeight: 1280,
			method: 'drawElements'
		},
		consoleErrors: [],
		pageErrors: [],
		diagnosticStreamErrors: [],
		diagnosticErrors: [],
		ownershipReceipt: { verified: true, resourceDisposition: 'graceful' },
		identityAudit: { valid: true },
		diagnosticStreamEvents: workerEvents(mode)
	};
	return {
		job: { id, kind: 'diagnostic', mode, appId: 'editor', fixtureId: PINNED_FIXTURE.id },
		result: {
			rows: [row],
			failure: null,
			collectionEligible: true,
			ownershipReceipt: { verified: true, resourceDisposition: 'graceful' },
			identityAudit: { valid: true }
		},
		buildBefore: { identity: structuredClone(identity) },
		buildAfter: { identity: structuredClone(identity) },
		expectedBuild: { identity }
	};
}

function evaluate(mode, mutate) {
	const input = validCase(mode);
	mutate?.(input);
	return evaluatePackingSmokeCase(input);
}

describe('BOMC packing smoke CLI arguments', () => {
	test('accepts exactly the two required absolute paths', () => {
		const output = path.join(WORKLOG_ROOT, 'smoke-parser-new-output');
		expect(parsePackingSmokeArgs(['--workspace-root', WORKSPACE_ROOT, '--output', output])).toEqual({
			workspaceRoot: WORKSPACE_ROOT,
			output
		});
	});

	test('rejects duplicate, unknown, and missing flags', () => {
		expect(() => parsePackingSmokeArgs(['--workspace-root', WORKSPACE_ROOT, '--workspace-root', WORKSPACE_ROOT, '--output', path.join(WORKLOG_ROOT, 'out')])).toThrow();
		expect(() => parsePackingSmokeArgs(['--workspace-root', WORKSPACE_ROOT, '--output', path.join(WORKLOG_ROOT, 'out'), '--extra'])).toThrow();
		expect(() => parsePackingSmokeArgs(['--workspace-root', WORKSPACE_ROOT])).toThrow();
		expect(() => parsePackingSmokeArgs(['--workspace-root', WORKSPACE_ROOT, '--output'])).toThrow();
	});

	test('rejects relative and escaping output paths', () => {
		expect(() => parsePackingSmokeArgs(['--workspace-root', WORKSPACE_ROOT, '--output', 'relative-output'])).toThrow();
		expect(() => parsePackingSmokeArgs(['--workspace-root', WORKSPACE_ROOT, '--output', path.join(WORKSPACE_ROOT, 'docs', 'worklogs', 'BOMC-LOADER-001-escape', 'out')])).toThrow();
	});

	test('rejects an existing output directory before any resource can start', () => {
		const existing = mkdtempSync(path.join(WORKLOG_ROOT, 'packing-smoke-parser-'));
		try {
			expect(() => parsePackingSmokeArgs(['--workspace-root', WORKSPACE_ROOT, '--output', existing])).toThrow();
		} finally {
			rmdirSync(existing);
		}
	});
});

describe('BOMC packing smoke acceptance', () => {
	test('accepts native and wrapped primary streams with diagnostic-excluded row mode', () => {
		for (const mode of ['native', 'wrapped']) {
			const accepted = evaluate(mode);
			expect(accepted.pass).toBe(true);
			expect(accepted.failures).toEqual([]);
			expect(accepted.workerAudit?.completeLifecycle).toBe(true);
		}
	});

	test('allows main-receive to precede wrapped post-return when IDs and per-realm epochs are valid', () => {
		const accepted = evaluate('wrapped');
		expect(accepted.pass).toBe(true);
		expect(accepted.workerAudit?.workerPostReturnedAfterPrePost).toBe(true);
	});

	test('does not require native worker-input instrumentation', () => {
		const accepted = evaluate('native');
		expect(accepted.pass).toBe(true);
		expect(accepted.workerAudit?.phaseCounts['worker-input']).toBeUndefined();
	});

	test('rejects a missing real draw frame and zero canvas dimensions', () => {
		expect(evaluate('native', ({ result }) => { result.rows[0].firstValidFrame = null; }).failures).toContain('row.firstValidFrame.connectedCanvasPositiveDraw');
		expect(evaluate('native', ({ result }) => { result.rows[0].firstValidFrame.cssWidth = 0; }).failures).toContain('row.firstValidFrame.connectedCanvasPositiveDraw');
	});

	test('rejects progress without a native complete receipt', () => {
		const outcome = evaluate('native', ({ result }) => {
			result.rows[0].diagnosticStreamEvents = [
				{ phase: 'native-worker', workerId: '1', epochMs: 100 },
				{ phase: 'worker-progress', stage: 'complete', workerId: '1', epochMs: 110 }
			];
		});
		expect(outcome.failures).toContain('native.exactlyOneCompleteReceipt');
		expect(outcome.pass).toBe(false);
	});

	test('rejects wrapped request ID mismatches and missing post-return', () => {
		const mismatched = evaluate('wrapped', ({ result }) => { result.rows[0].diagnosticStreamEvents[2].id = 99; });
		expect(mismatched.failures).toContain('wrapped.requestIds.match');
		const missing = evaluate('wrapped', ({ result }) => { result.rows[0].diagnosticStreamEvents = result.rows[0].diagnosticStreamEvents.filter((event) => event.phase !== 'worker-post-return'); });
		expect(missing.failures).toContain('wrapped.exactlyOnePostReturn');
	});

	test('rejects source-buffer transfer, 31 buffers, and changed model counts', () => {
		const sourceTransferred = evaluate('wrapped', ({ result }) => { result.rows[0].diagnosticStreamEvents[1].graph.sourceBufferInTransferList = true; });
		expect(sourceTransferred.failures).toContain('wrapped.sourceBuffer.notTransferred');
		const countExceeded = evaluate('wrapped', ({ result }) => { result.rows[0].diagnosticStreamEvents[1].graph.transferBufferCount = 31; });
		expect(countExceeded.failures).toContain('wrapped.transferBufferCount.atMost30');
		const countsChanged = evaluate('wrapped', ({ result }) => { result.rows[0].diagnosticStreamEvents[1].graph.runtimeCounts.sourceCounts.faces = 7; });
		expect(countsChanged.failures).toContain('wrapped.runtimeCounts.pinned');
	});

	test('rejects a graph that includes the retained source buffer', () => {
		const outcome = evaluate('wrapped', ({ result }) => { result.rows[0].diagnosticStreamEvents[1].graph.graphIncludesSourceBuffer = true; });
		expect(outcome.failures).toContain('wrapped.graph.excludesSourceBuffer');
	});

	test('rejects unknown workers, invalid after identity, and unverified child ownership', () => {
		const unknownWorker = evaluate('wrapped', ({ result }) => { result.rows[0].diagnosticStreamEvents = result.rows[0].diagnosticStreamEvents.filter((event) => event.phase !== 'wrapped-worker'); });
		expect(unknownWorker.failures).toContain('worker.exactlyOneImporter');
		const invalidIdentity = evaluate('native', ({ result }) => { result.identityAudit.valid = false; result.rows[0].identityAudit.valid = false; });
		expect(invalidIdentity.failures).toContain('result.identityAudit.valid');
		const unowned = evaluate('native', ({ result }) => { result.ownershipReceipt.verified = false; result.rows[0].ownershipReceipt.verified = false; });
		expect(unowned.failures).toContain('result.ownershipReceipt.verified');
	});

	test('rejects diagnostic stream errors and missing or duplicate rows', () => {
		const streamError = evaluate('native', ({ result }) => { result.rows[0].diagnosticStreamErrors = ['stream lost']; });
		expect(streamError.failures).toContain('row.diagnosticStreamErrors.empty');
		const missing = evaluate('native', ({ result }) => { result.rows = []; });
		expect(missing.failures).toContain('rows.exactlyOne');
		const duplicate = evaluate('native', ({ result }) => { result.rows.push(structuredClone(result.rows[0])); });
		expect(duplicate.failures).toContain('rows.exactlyOne');
	});

	test('rejects build identity drift across the job', () => {
		const outcome = evaluate('native', ({ buildAfter }) => { buildAfter.identity.sourceSha256 = 'f'.repeat(64); });
		expect(outcome.failures).toContain('build.after.matchesExpected');
	});
});
