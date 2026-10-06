import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markProofOutcome, readProofTicket, writeProofSidecar, type ProofTicket } from '../../testing/proof-run-contract';

type CanvasFacts = { connected: boolean; cssWidth: number; cssHeight: number; pixelWidth: number; pixelHeight: number };
type ProofOutput = { byteLength: number; sha256: string; revision: number; compressionMode: string; stats: any; bytesBase64?: string; canonicalGraph?: any; canonicalRevision?: number; viewport?: { screenshotBase64: string; observation: any; canvasFacts: CanvasFacts | null; loaderCounts: any; importWorkerLifecycle: { created: number; terminated: number } } };
type ProofSnapshot = { activeJobStarted: boolean; activeProgress: unknown[]; activeJobId: number | null; workerStarts: number; currentOutput: any; viewportMounted: boolean; viewportConnected: boolean };
type ProofObservation = { workerTimes: Array<{ fixture: string; startedAtMs: number; completedAtMs: number }>; framesDuringWorkerWrites: unknown[]; workerStarts: number; workerTerminations: number; listenerRemovalCount: number; activeJobId: number | null; viewportMounted: boolean; viewportConnected: boolean; canvasFacts: CanvasFacts | null };
type ProofDispose = { terminatedWorker: boolean; workerTerminations: number; listenerRemovalCount: number; viewportDisposed: boolean; viewportDisposals: number };
type ProofWindow = Omit<Window, '__bomcWriterProof'> & { __bomcWriterProof: {
	ready: boolean;
	writeFixture(fixture: string, options?: { compressionMode?: string; mount?: boolean; includeBytes?: boolean }): Promise<ProofOutput>;
	writeSequence(fixture: 'shared'): Promise<ProofOutput[]>;
	cancelActive(): Promise<any>;
	dispatchLateReplyForTest(jobId?: number): any;
	observe(): ProofObservation;
	dispose(): ProofDispose;
	snapshot(): ProofSnapshot;
} };

function evaluateProof(page: Page, expression: (...args: any[]) => any, argument?: any): Promise<any> {
	return page.evaluate<any, any>(expression, argument);
}

const worklogRoot = path.resolve(process.env.SIBAMBO_WRITER_WORKLOG || '');
const attempt = process.env.SIBAMBO_WRITER_ATTEMPT!;
const attemptRoot = path.join(worklogRoot, 'browser', `attempt-${attempt}`);
const reportDir = path.join(attemptRoot, 'reports');
const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const proofTicket: ProofTicket | null = process.env.SIBAMBO_PROOF_TICKET ? readProofTicket('writer') as ProofTicket : null;
const sidecarDetails = new WeakMap<TestInfo, Record<string, unknown>>();
const pageErrorsByTest = new WeakMap<TestInfo, { pageErrors: string[]; consoleErrors: string[] }>();
const sourcePaths = [
	'package.json', 'bun.lock', 'packages/tsconfig.json', 'tooling/testing/proof-run-contract.ts', 'tooling/testing/bomc-proof-runner.ts', 'tooling/testing/tsconfig.json',
	'apps/editor/src/routes/+page.svelte',
	'packages/bomc-document/package.json', 'packages/bomc-document/tsconfig.json', 'packages/bomc-document/README.md',
	'packages/bomc-document/src/index.ts',
	'packages/bomc-document/src/types.ts', 'packages/bomc-document/src/document.ts',
	'packages/bomc-document/src/binary.ts', 'packages/bomc-document/src/section-codec.ts',
	'packages/bomc-document/src/writer.ts', 'packages/bomc-document/src/reader.ts',
	'packages/bomc-document/src/source-envelope.ts', 'packages/bomc-document/src/test-fixtures/documents.ts',
	'packages/bomc-document/src/binary.test.ts', 'packages/bomc-document/src/document.test.ts', 'packages/bomc-document/src/roundtrip.test.ts',
	'packages/bomc-document/src/writer-cache.test.ts', 'packages/bomc-document/src/source-envelope.test.ts', 'packages/bomc-document/src/consumer-compatibility.test.ts',
	'tooling/performance/bomc-writer/index.html',
	'tooling/performance/bomc-writer/entry.ts', 'tooling/performance/bomc-writer/writer.worker.ts',
	'tooling/performance/bomc-writer/oracle.rb', 'tooling/performance/bomc-writer/interop.ts',
	'tooling/performance/bomc-writer/benchmark.ts', 'tooling/performance/bomc-writer/proof.spec.ts',
	'tooling/performance/bomc-writer/vite.config.ts', 'tooling/performance/bomc-writer/playwright.config.ts', 'tooling/performance/bomc-writer/tsconfig.json'
];
const sourceIdentityBefore = captureSourceIdentity();

function captureSourceIdentity() {
	return {
		gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: editorRoot, encoding: 'utf8' }).trim(),
		files: sourcePaths.map((relativePath) => ({ path: relativePath, sha256: createHash('sha256').update(readFileSync(path.join(editorRoot, relativePath))).digest('hex') }))
	};
}

test.beforeEach(async ({ page }, testInfo) => {
	testInfo.annotations.push({ type: 'started-at', description: new Date().toISOString() });
	const errors = { pageErrors: [] as string[], consoleErrors: [] as string[] };
	pageErrorsByTest.set(testInfo, errors);
	page.on('pageerror', (error) => errors.pageErrors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error') errors.consoleErrors.push(message.text()); });
	await page.goto('/');
	if (proofTicket) markProofOutcome(proofTicket, testInfo.title);
	await expect.poll(() => evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof?.ready ?? false), { timeout: 10_000 }).toBe(true);
});

test.afterEach(async ({ page, browser }, testInfo) => {
	const beforeDispose = await evaluateProof(page, () => {
		const proof = (window as unknown as ProofWindow).__bomcWriterProof;
		return proof ? { snapshot: proof.snapshot(), observation: proof.observe() } : null;
	}).catch((error) => ({ failure: error instanceof Error ? error.message : String(error) }));
	const dispose = await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof?.dispose()).catch((error) => ({ failure: error instanceof Error ? error.message : String(error) }));
	const afterDispose = await evaluateProof(page, () => {
		const proof = (window as unknown as ProofWindow).__bomcWriterProof;
		return proof ? { snapshot: proof.snapshot(), observation: proof.observe() } : null;
	}).catch((error) => ({ failure: error instanceof Error ? error.message : String(error) }));
	const observedErrors = pageErrorsByTest.get(testInfo) ?? { pageErrors: [], consoleErrors: [] };
	const details = sidecarDetails.get(testInfo) ?? {};
	const stage = testInfo.annotations.find((item) => item.type === 'stage')?.description ?? null;
	const report = {
		planId: proofTicket?.planId ?? 'BOMC-WEB-WRITER-001', planVersion: proofTicket?.planVersion ?? '1.1',
		legacyPlanId: 'BOMC-WEB-WRITER-001', legacyPlanVersion: '1.1', title: testInfo.title,
		observedStatus: testInfo.status, expectedStatus: testInfo.expectedStatus,
		stage,
		startedAt: testInfo.annotations.find((item) => item.type === 'started-at')?.description ?? null, completedAt: new Date().toISOString(),
		toolVersions: {
			bun: execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(), node: process.version,
			chromium: browser.version(), fflate: JSON.parse(readFileSync(path.join(editorRoot, 'node_modules/fflate/package.json'), 'utf8')).version
		},
		requestedModes: ['auto'], requestedModeAnnotation: testInfo.annotations.find((item) => item.type === 'compression-mode')?.description ?? null,
		actualMode: (beforeDispose as any)?.snapshot?.currentOutput?.compressionMode ?? null,
		sourceIdentityBefore, sourceIdentityAfter: captureSourceIdentity(),
		errors: [...testInfo.errors.map((error) => error.message), ...observedErrors.pageErrors, ...observedErrors.consoleErrors],
		pageErrors: observedErrors.pageErrors, consoleErrors: observedErrors.consoleErrors,
		beforeDispose, dispose, afterDispose, ...details,
		attachments: testInfo.attachments.map((attachment) => ({ name: attachment.name, contentType: attachment.contentType, path: attachment.path ?? null }))
	};
	mkdirSync(reportDir, { recursive: true });
	const filename = testInfo.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() + '.json';
	writeFileSync(path.join(reportDir, filename), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
	if (proofTicket) {
		const sidecarPath = writeProofSidecar(proofTicket, testInfo.title, report);
		await testInfo.attach('readiness-proof-sidecar', { path: sidecarPath, contentType: 'application/json' });
	}
	expect(observedErrors.pageErrors).toEqual([]);
	expect(observedErrors.consoleErrors).toEqual([]);
});

test('writer output survives independent read and real viewport draw', async ({ page }, testInfo) => {
	testInfo.annotations.push({ type: 'compression-mode', description: 'auto' });
	testInfo.annotations.push({ type: 'stage', description: 'writer-and-viewport-draw' });
	const captures: Array<{ fixture: string; sha256: string; byteLength: number; outputFile: string; captureFile: string; observation: any }> = [];
	for (const fixture of ['color', 'hole'] as const) {
		const output = await evaluateProof(page, async (name) => (window as unknown as ProofWindow).__bomcWriterProof.writeFixture(name, { mount: true, includeBytes: true }), fixture);
		expect(output.byteLength).toBeGreaterThan(32);
		expect(output.compressionMode).toBe('auto');
		expect(output.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(output.canonicalRevision).toBe(output.revision);
		expect(output.canonicalGraph).toBeTruthy();
		expect(output.viewport?.observation.backend).toBe('webgl2');
		expect(output.viewport?.observation.renderer.render.calls).toBeGreaterThan(0);
		expect(output.viewport?.observation.renderer.render.triangles).toBeGreaterThan(0);
		expect(output.viewport?.canvasFacts?.connected).toBe(true);
		expect(output.viewport?.canvasFacts?.cssWidth).toBeGreaterThan(0);
		expect(output.viewport?.canvasFacts?.cssHeight).toBeGreaterThan(0);
		expect(output.viewport?.canvasFacts?.pixelWidth).toBeGreaterThan(0);
		expect(output.viewport?.canvasFacts?.pixelHeight).toBeGreaterThan(0);
		expect(output.viewport?.observation.firstFrameAtMs).not.toBeNull();
		expect(output.viewport?.observation.readyAtMs).not.toBeNull();
		expect(output.viewport?.observation.scene.meshCount).toBeGreaterThan(0);
		expect(output.viewport?.observation.scene.uniqueTriangles).toBeGreaterThan(0);
		expect(output.viewport?.loaderCounts?.faces).toBe(1);
		expect(output.viewport?.importWorkerLifecycle).toEqual({ created: 1, terminated: 1 });
		if (fixture === 'color') {
			expect(output.canonicalGraph.materials.map((item: any) => item.rgba)).toEqual([[155, 28, 49, 255], [0, 128, 255, 128]]);
			expect(output.canonicalGraph.meshes[0].faces[0]).toMatchObject({ frontMaterialId: 'fixture:color:material:0', backMaterialId: 'fixture:color:material:1', surfaceCode: 9, roleCode: 7 });
		} else {
			expect(output.canonicalGraph.meshes[0].faces[0].holes).toEqual([[4, 5, 6, 7]]);
			expect(output.canonicalGraph.meshes[0].faces[0].triangles).toHaveLength(24);
		}
		const filePath = writeBomc(testInfo, `${fixture}.bomc`, output.bytesBase64!);
		await testInfo.attach(`${fixture}-bomc`, { path: filePath, contentType: 'application/octet-stream' });
		const capture = Buffer.from(output.viewport!.screenshotBase64, 'base64');
		const capturePath = testInfo.outputPath(`${fixture}-viewport.png`);
		mkdirSync(path.dirname(capturePath), { recursive: true });
		writeFileSync(capturePath, capture, { flag: 'wx' });
		captures.push({ fixture, sha256: output.sha256, byteLength: output.byteLength, outputFile: path.basename(filePath), captureFile: path.basename(capturePath), observation: output.viewport!.observation });
		await testInfo.attach(`${fixture}-viewport`, { path: capturePath, contentType: 'image/png' });
	}
	const finalState = await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof.observe());
	expect(finalState.workerStarts).toBe(1);
	expect(finalState.viewportMounted).toBe(true);
	const canvas = await page.locator('#viewport canvas').elementHandle();
	if (!canvas) throw new Error('The writer proof canvas is missing after the hole output was mounted.');
	const dispose = await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof.dispose());
	expect(dispose.terminatedWorker).toBe(true);
	expect(dispose.workerTerminations).toBe(1);
	expect(dispose.listenerRemovalCount).toBeGreaterThanOrEqual(2);
	expect(dispose.viewportDisposed).toBe(true);
	const canvasConnectedAfter = await canvas.evaluate((element) => element.isConnected);
	const afterDispose = await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof.observe());
	expect(canvasConnectedAfter).toBe(false);
	expect(afterDispose.viewportMounted).toBe(false);
	expect(afterDispose.viewportConnected).toBe(false);
	await canvas.dispose();
	await writeSidecar(testInfo, { captures, workerObservation: finalState, dispose, canvasConnectedAfter, afterDispose });
});

test('writer cancellation and disposal ignore late results', async ({ page }, testInfo) => {
	testInfo.annotations.push({ type: 'compression-mode', description: 'auto' });
	testInfo.annotations.push({ type: 'stage', description: 'cancelled-large-write-recovered' });
	await evaluateProof(page, () => {
		const proof = (window as unknown as ProofWindow).__bomcWriterProof;
		void proof.writeFixture('B-FACES', { includeBytes: false }).catch(() => undefined);
	});
	await expect.poll(() => evaluateProof(page, () => {
		const state = (window as unknown as ProofWindow).__bomcWriterProof.snapshot();
		return state.activeJobStarted && state.activeProgress.length > 0;
	}), { timeout: 30_000 }).toBe(true);
	const before = await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof.snapshot());
	const cancelled = await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof.cancelActive());
	expect(cancelled.jobId).toBe(before.activeJobId);
	expect(cancelled.rejectionCode).toBe('ABORTED');
	expect(cancelled.settlementCount).toBe(1);
	expect(cancelled.terminatedOnce).toBe(true);
	expect(cancelled.listenerRemovalCount).toBeGreaterThanOrEqual(2);
	const late = await evaluateProof(page, (jobId) => (window as unknown as ProofWindow).__bomcWriterProof.dispatchLateReplyForTest(jobId), cancelled.jobId);
	expect(late.ignored).toBe(true);
	const fresh = await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof.writeFixture('empty', { mount: false, includeBytes: true }));
	expect(fresh.compressionMode).toBe('auto');
	expect(fresh.canonicalGraph).toMatchObject({ name: 'Untitled', meshes: [], materials: [] });
	expect(fresh.stats.totalBytes).toBe(fresh.byteLength);
	const emptyPath = writeBomc(testInfo, 'empty-recovery.bomc', fresh.bytesBase64!);
	await testInfo.attach('empty-recovery-bomc', { path: emptyPath, contentType: 'application/octet-stream' });
	expect(await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof.snapshot().workerStarts)).toBe(2);
	const dispose = await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof.dispose());
	expect(dispose.terminatedWorker).toBe(true);
	expect(dispose.workerTerminations).toBe(2);
	expect(dispose.listenerRemovalCount).toBeGreaterThanOrEqual(4);
	expect(dispose.viewportDisposed).toBe(true);
	const disposedState = await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof.snapshot());
	expect(disposedState.viewportMounted).toBe(false);
	expect(disposedState.viewportConnected).toBe(false);
	const lateAfterDispose = await evaluateProof(page, (jobId) => (window as unknown as ProofWindow).__bomcWriterProof.dispatchLateReplyForTest(jobId), cancelled.jobId);
	const afterLateDispose = await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof.snapshot());
	expect(lateAfterDispose.ignored).toBe(true);
	expect(afterLateDispose.workerStarts).toBe(2);
	expect(afterLateDispose.workerTerminations).toBe(2);
	expect(afterLateDispose.activeJobId).toBeNull();
	expect(afterLateDispose.currentOutput).toEqual(disposedState.currentOutput);
	expect(afterLateDispose.viewportMounted).toBe(false);
	expect(afterLateDispose.viewportConnected).toBe(false);
	const repeatedDispose = await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof.dispose());
	expect(repeatedDispose.terminatedWorker).toBe(false);
	expect(repeatedDispose.workerTerminations).toBe(2);
	expect(repeatedDispose.listenerRemovalCount).toBe(dispose.listenerRemovalCount);
	expect(repeatedDispose.viewportDisposals).toBe(dispose.viewportDisposals);
	const afterRepeatedDispose = await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof.snapshot());
	expect(afterRepeatedDispose).toEqual(afterLateDispose);
	await writeSidecar(testInfo, { cancelled, late, fresh: { byteLength: fresh.byteLength, sha256: fresh.sha256, stats: fresh.stats }, dispose, disposedState, lateAfterDispose, afterLateDispose, repeatedDispose, afterRepeatedDispose });
});

test('writer cache is reused in a persistent browser worker', async ({ page }, testInfo) => {
	testInfo.annotations.push({ type: 'compression-mode', description: 'auto' });
	testInfo.annotations.push({ type: 'stage', description: 'warm-cache-transform-and-responsiveness-observed' });
	const sequence = await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof.writeSequence('shared')) as ProofOutput[];
	expect(sequence).toHaveLength(3);
	const [cold, warm, transformed] = sequence;
	expect(sequence.every((output) => output.compressionMode === 'auto')).toBe(true);
	for (const [name, output] of [['cold', cold], ['warm', warm], ['transform-only', transformed]] as const) {
		const outputPath = writeBomc(testInfo, `shared-${name}.bomc`, output!.bytesBase64!);
		await testInfo.attach(`shared-${name}-bomc`, { path: outputPath, contentType: 'application/octet-stream' });
	}
	expect(cold!.canonicalGraph).toBeTruthy();
	expect(warm!.sha256).toBe(cold!.sha256);
	expect(warm!.byteLength).toBe(cold!.byteLength);
	expect(warm!.stats.encodedSectionTypes).toEqual([]);
	expect(warm!.stats.compressionAttemptTypes).toEqual([]);
	expect(warm!.stats.hashMs).toBe(0);
	expect(transformed!.canonicalRevision).toBe(cold!.canonicalRevision! + 1);
	expect(transformed!.stats.encodedSectionTypes).toEqual([1, 13, 241]);
	expect(transformed!.stats.reusedSectionTypes).toEqual(cold!.stats.encodedSectionTypes.filter((type: number) => ![1, 13, 241].includes(type)));
	expect(transformed!.stats.reusedSectionTypes).toEqual(expect.arrayContaining([5, 6, 7, 8, 9, 14]));
	expect(transformed!.canonicalGraph!.instances.find((row: any) => row.id === 'fixture:shared:instance:1')!.matrix[12]).toBe(6.25);
	expect(Object.is(cold!.canonicalGraph!.meshes[0].positions[0], 1.0000000000000002)).toBe(true);
	expect(Object.is(cold!.canonicalGraph!.meshes[0].faces[0].normal[1], -0)).toBe(true);
	const start = Date.now();
	const large = await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof.writeFixture('B-FACES', { includeBytes: false }));
	const observation = await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof.observe());
	expect(large.byteLength).toBeGreaterThan(0);
	expect(observation.workerTimes.some((row: any) => row.fixture === 'B-FACES' && row.completedAtMs >= row.startedAtMs)).toBe(true);
	expect(observation.framesDuringWorkerWrites).toBeInstanceOf(Array);
	expect(Date.now() - start).toBeGreaterThanOrEqual(0);
	const dispose = await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof.dispose());
	expect(dispose.terminatedWorker).toBe(true);
	expect(dispose.workerTerminations).toBe(1);
	expect(dispose.listenerRemovalCount).toBeGreaterThanOrEqual(2);
	const disposedState = await evaluateProof(page, () => (window as unknown as ProofWindow).__bomcWriterProof.observe());
	expect(disposedState.activeJobId).toBeNull();
	expect(disposedState.viewportMounted).toBe(false);
	expect(disposedState.viewportConnected).toBe(false);
	await writeSidecar(testInfo, {
		stage: 'warm-cache-transform-and-responsiveness-observed',
		sequence: sequence.map(({ bytesBase64: _bytes, canonicalGraph, ...row }) => ({ ...row, graphName: canonicalGraph?.name })),
		large: { byteLength: large.byteLength, sha256: large.sha256, stats: large.stats }, observation, dispose, disposedState,
		responsiveness: observation.framesDuringWorkerWrites.length > 0 ? 'frames-observed-during-worker-window' : 'UNPROVEN-no-frame-fell-inside-worker-window'
	});
});

async function writeSidecar(testInfo: TestInfo, value: unknown) {
	sidecarDetails.set(testInfo, value as Record<string, unknown>);
}

function writeBomc(testInfo: TestInfo, name: string, base64: string) {
	const filePath = testInfo.outputPath(name);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, Buffer.from(base64, 'base64'), { flag: 'wx' });
	return filePath;
}
