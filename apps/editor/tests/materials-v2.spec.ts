import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
	captureSourceHashes, corruptFirstActiveSemanticHash, loadOracleMetadata,
	readPinnedInput, installEditorMaterialsV2Probe, type OracleMetadata, type PinnedInput
} from './materials-v2-helpers';

const oracle = loadOracleMetadata();

type BuildIdentity = {
	schema: string; app: string; commit: string; dirty: boolean; sourceSha256: string;
	workingTree: { buildInputModifiedPaths: string[]; buildInputUntrackedPaths: string[]; otherModifiedPaths: string[]; otherUntrackedPaths: string[]; generatedOutputPaths: string[] };
};
type WorkerRecord = {
	workerIndex: number; scriptURL: string; requestId: number | null; sourceName: string | null; inputByteLength: number | null;
	postedMessages: Array<{ type: string | null; id: number | null; sourceName?: string | null; inputByteLength?: number | null; transferCount?: number }>;
	terminals: Array<{ id: number | null; type: string; error: string | null }>;
	idMismatches: Array<{ expected: number | null; actual: number | null }>;
	errors: Array<{ message: string; filename: string }>; terminated: boolean; result: any;
};
type UiProbeApi = {
	requests: WorkerRecord[];
	resetDraw(canvas: HTMLCanvasElement): number | null;
	drawInfo(canvas: HTMLCanvasElement): { requestId: number | null; counts: Record<string, number>; total: number; connected: boolean; cssWidth: number; cssHeight: number; pixelWidth: number; pixelHeight: number };
	rememberSession(): void;
	sessionStillMounted(): { sameCanvas: boolean; sameTitle: boolean; title: string };
	waitForAssetProbes(requestId: number): Promise<Array<{ path: string; passed: boolean; expectedWidth?: number; expectedHeight?: number; naturalWidth?: number; naturalHeight?: number; error?: string }>>;
	snapshot(): { activeRequestId: number | null; requests: WorkerRecord[] };
};
type UiProbeWindow = Window & { __m2UiProbe: UiProbeApi };
declare global {
	interface Window { __m2UiProbe: UiProbeApi }
}

test.beforeEach(async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await installEditorMaterialsV2Probe(page);
});

test('S1-new loads v2 materials in the application worker and draws verified generated textures', async ({ page }, testInfo) => {
	test.setTimeout(180_000);
	const runtime = observeRuntime(page);
	const identityBefore = await readBuildIdentity(page);
	const sourceHashesBefore = await captureSourceHashes();
	let fixture: PinnedInput | undefined;
	let worker: WorkerRecord | undefined;
	let assetProbes: any[] = [];
	let failure: string | null = null;
	try {
		fixture = readPinnedInput('S1-new');
		await page.goto('/?renderer=webgl2');
		const requestIndex = await requestCount(page);
		const importDeadline = Date.now() + 120_000;
		await chooseBomcFile(page, fixture, false);
		worker = await waitForSuccessfulWorkerAndReady(page, requestIndex, importDeadline);
		const expectedFixture = oracle.fixtures.find((row) => row.id === 'S1-new')!;
		assertSourceRequest(worker, fixture);
		assertSemanticResult(worker.result, expectedFixture, fixture);
		expect(worker.terminals).toHaveLength(1);
		expect(worker.terminals[0]).toMatchObject({ id: worker.requestId, type: 'complete', error: null });
		expect(worker.idMismatches).toEqual([]);
		expect(worker.errors).toEqual([]);
		expect(worker.terminated).toBe(true);
		assetProbes = await withDeadline(waitForAssetProbes(page, worker.requestId!), 30_000, 'S1-new generated PNG image probes');
		assertAssetImageProbes(worker.result, assetProbes);
		await provePositiveViewportDraw(page, worker.requestId!);
		expect(runtime.wasmResponses.length).toBeGreaterThan(0);
		expect(runtime.wasmResponses.every((item) => item.status === 200 && item.sameOrigin)).toBe(true);
		expect(runtime.pageErrors).toEqual([]);
		expect(runtime.consoleErrors).toEqual([]);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		const identityAfter = await readBuildIdentity(page).catch(() => null);
		const sourceHashesAfter = await captureSourceHashes();
		await writeUiReport(testInfo, 'editor-s1-new', {
			gate: 'M2-UI', fixture: fixtureIdentity(fixture), identityBefore, identityAfter,
			sourceHashesBefore, sourceHashesAfter, worker: await readWorkerRecord(page, worker?.workerIndex ?? 0),
			assetProbes, wasmResponses: runtime.wasmResponses, pageErrors: runtime.pageErrors, consoleErrors: runtime.consoleErrors, failure
		});
		expect(identityAfter).toEqual(identityBefore);
		expect(sourceHashesAfter).toEqual(sourceHashesBefore);
	}
});

test('S2-new maps every active material and texture metric to its verified semantic PNG', async ({ page }, testInfo) => {
	test.setTimeout(180_000);
	const runtime = observeRuntime(page);
	const identityBefore = await readBuildIdentity(page);
	const sourceHashesBefore = await captureSourceHashes();
	let fixture: PinnedInput | undefined;
	let worker: WorkerRecord | undefined;
	let assetProbes: any[] = [];
	let failure: string | null = null;
	try {
		fixture = readPinnedInput('S2-new');
		await page.goto('/?renderer=webgl2');
		const requestIndex = await requestCount(page);
		const importDeadline = Date.now() + 120_000;
		await chooseBomcFile(page, fixture, false);
		worker = await waitForSuccessfulWorkerAndReady(page, requestIndex, importDeadline);
		const expectedFixture = oracle.fixtures.find((row) => row.id === 'S2-new')!;
		assertSourceRequest(worker, fixture);
		assertSemanticResult(worker.result, expectedFixture, fixture);
		expect(worker.terminals).toHaveLength(1);
		expect(worker.terminals[0]).toMatchObject({ id: worker.requestId, type: 'complete', error: null });
		expect(worker.idMismatches).toEqual([]);
		expect(worker.errors).toEqual([]);
		expect(worker.terminated).toBe(true);
		assetProbes = await withDeadline(waitForAssetProbes(page, worker.requestId!), 30_000, 'S2-new generated PNG image probes');
		assertAssetImageProbes(worker.result, assetProbes);
		await provePositiveViewportDraw(page, worker.requestId!);
		expect(runtime.wasmResponses.length).toBeGreaterThan(0);
		expect(runtime.wasmResponses.every((item) => item.status === 200 && item.sameOrigin)).toBe(true);
		expect(runtime.pageErrors).toEqual([]);
		expect(runtime.consoleErrors).toEqual([]);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		const identityAfter = await readBuildIdentity(page).catch(() => null);
		const sourceHashesAfter = await captureSourceHashes();
		await writeUiReport(testInfo, 'editor-s2-new', {
			gate: 'M2-UI', fixture: fixtureIdentity(fixture), identityBefore, identityAfter,
			sourceHashesBefore, sourceHashesAfter, worker: await readWorkerRecord(page, worker?.workerIndex ?? 0),
			assetProbes, wasmResponses: runtime.wasmResponses, pageErrors: runtime.pageErrors, consoleErrors: runtime.consoleErrors, failure
		});
		expect(identityAfter).toEqual(identityBefore);
		expect(sourceHashesAfter).toEqual(sourceHashesBefore);
	}
});

test('S2-jcm v1 remains on the native JCM path without semantic codec requests', async ({ page }, testInfo) => {
	test.setTimeout(180_000);
	const runtime = observeRuntime(page);
	const identityBefore = await readBuildIdentity(page);
	const sourceHashesBefore = await captureSourceHashes();
	let fixture: PinnedInput | undefined;
	let worker: WorkerRecord | undefined;
	let failure: string | null = null;
	try {
		fixture = readPinnedInput('S2-jcm');
		await page.goto('/?renderer=webgl2');
		const requestIndex = await requestCount(page);
		const importDeadline = Date.now() + 120_000;
		await chooseBomcFile(page, fixture, false);
		worker = await waitForSuccessfulWorkerAndReady(page, requestIndex, importDeadline);
		assertSourceRequest(worker, fixture);
		const result = worker.result;
		expect(result.counts.textures).toBe(14);
		expect(result.semanticMaterials).toMatchObject({ sectionVersion: 1, activeCount: 0, verifiedCount: 0, generatedAssetCount: 0 });
		expect(result.semanticMaterials.materialProofs).toEqual([]);
		expect(result.assets.some((asset: any) => asset.path.startsWith('bomc/textures/semantic-'))).toBe(false);
		expect(result.materialPaths.every((material: any) => !material.textureAsset?.startsWith('bomc/textures/semantic-'))).toBe(true);
		expect(result.groupPaths.every((group: any) => !group.textureAsset?.startsWith('bomc/textures/semantic-'))).toBe(true);
		expect(worker.terminals).toHaveLength(1);
		expect(worker.terminals[0]).toMatchObject({ id: worker.requestId, type: 'complete', error: null });
		expect(worker.idMismatches).toEqual([]);
		expect(worker.errors).toEqual([]);
		expect(worker.terminated).toBe(true);
		expect(runtime.wasmResponses).toEqual([]);
		await provePositiveViewportDraw(page, worker.requestId!);
		expect(runtime.pageErrors).toEqual([]);
		expect(runtime.consoleErrors).toEqual([]);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		const identityAfter = await readBuildIdentity(page).catch(() => null);
		const sourceHashesAfter = await captureSourceHashes();
		await writeUiReport(testInfo, 'editor-s2-jcm', {
			gate: 'M2-UI', fixture: fixtureIdentity(fixture), identityBefore, identityAfter,
			sourceHashesBefore, sourceHashesAfter, worker: await readWorkerRecord(page, worker?.workerIndex ?? 0),
			wasmResponses: runtime.wasmResponses, pageErrors: runtime.pageErrors, consoleErrors: runtime.consoleErrors, failure
		});
		expect(identityAfter).toEqual(identityBefore);
		expect(sourceHashesAfter).toEqual(sourceHashesBefore);
	}
});

test('corrupt semantic replacement errors while the usable S2-jcm session stays mounted', async ({ page }, testInfo) => {
	test.setTimeout(180_000);
	const runtime = observeRuntime(page);
	const identityBefore = await readBuildIdentity(page);
	const sourceHashesBefore = await captureSourceHashes();
	let baselineFixture: PinnedInput | undefined;
	let replacementFixture: PinnedInput | undefined;
	let baselineWorker: WorkerRecord | undefined;
	let failedWorker: WorkerRecord | undefined;
	let corruption: any = null;
	let sessionBefore: any = null;
	let sessionAfter: any = null;
	let failure: string | null = null;
	try {
		baselineFixture = readPinnedInput('S2-jcm');
		replacementFixture = readPinnedInput('S2-new');
		corruption = await corruptFirstActiveSemanticHash(replacementFixture.bytes);
		expect(corruption.changedPayloadBytes).toBe(1);
		expect(corruption.changedSections).toEqual(['MATERIALS']);
		expect(corruption.expectedHash).not.toBe(corruption.corruptedHash);
		await page.goto('/?renderer=webgl2');
		const baselineIndex = await requestCount(page);
		const baselineDeadline = Date.now() + 120_000;
		await chooseBomcFile(page, baselineFixture, false);
		baselineWorker = await waitForSuccessfulWorkerAndReady(page, baselineIndex, baselineDeadline);
		expect(baselineWorker.result.semanticMaterials).toMatchObject({ sectionVersion: 1, activeCount: 0, verifiedCount: 0, generatedAssetCount: 0 });
		expect(runtime.wasmResponses).toEqual([]);
		await provePositiveViewportDraw(page, baselineWorker.requestId!);
		await page.evaluate(() => (window as UiProbeWindow).__m2UiProbe.rememberSession());
		sessionBefore = await page.evaluate(() => (window as UiProbeWindow).__m2UiProbe.sessionStillMounted());
		expect(sessionBefore).toMatchObject({ sameCanvas: true, sameTitle: true });

		const replacementIndex = await requestCount(page);
		const replacementDeadline = Date.now() + 120_000;
		const modifiedFile: PinnedInput = { ...replacementFixture, fileName: 'S2-new-semantic-hash-corrupt.bomc', bytes: corruption.bytes, byteLength: corruption.bytes.byteLength, sha256: corruption.corruptedSha256 };
		await chooseBomcFile(page, modifiedFile, true);
		failedWorker = await waitForTerminalWorker(page, replacementIndex, replacementDeadline);
		await expect(page.locator('.viewport-status')).toContainText('RGBA hash mismatch', { timeout: remainingMs(replacementDeadline) });
		await expect(page.locator('.footer-status')).toContainText('Zoom Extents');
		expect(failedWorker.terminals).toHaveLength(1);
		expect(failedWorker.terminals[0]).toMatchObject({ id: failedWorker.requestId, type: 'error' });
		expect(failedWorker.terminals[0].error).toContain('RGBA hash mismatch');
		expect(failedWorker.result).toBeNull();
		expect(failedWorker.idMismatches).toEqual([]);
		expect(failedWorker.errors).toEqual([]);
		expect(failedWorker.terminated).toBe(true);
		sessionAfter = await page.evaluate(() => (window as UiProbeWindow).__m2UiProbe.sessionStillMounted());
		expect(sessionAfter).toMatchObject({ sameCanvas: true, sameTitle: true });
		await provePositiveViewportDraw(page, failedWorker.requestId!);
		// Hash rejection happens before PNG encoding, so this request may need no WASM asset.
		expect(runtime.wasmResponses.every((item) => item.status === 200 && item.sameOrigin)).toBe(true);
		expect(runtime.pageErrors).toEqual([]);
		expect(runtime.consoleErrors).toEqual([]);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		const identityAfter = await readBuildIdentity(page).catch(() => null);
		const sourceHashesAfter = await captureSourceHashes();
		await writeUiReport(testInfo, 'editor-corrupt-semantic-replacement', {
			gate: 'M2-UI-failure-preservation', fixture: fixtureIdentity(baselineFixture), replacementFixture: fixtureIdentity(replacementFixture),
			corruption: corruption ? { materialIndex: corruption.materialIndex, expectedHash: corruption.expectedHash, corruptedHash: corruption.corruptedHash, sourceSha256: corruption.sourceSha256, corruptedSha256: corruption.corruptedSha256, changedPayloadBytes: corruption.changedPayloadBytes, changedSections: corruption.changedSections } : null,
			identityBefore, identityAfter, sourceHashesBefore, sourceHashesAfter,
			baselineWorker: await readWorkerRecord(page, baselineWorker?.workerIndex ?? 0), failedWorker: await readWorkerRecord(page, failedWorker?.workerIndex ?? 1),
			sessionBefore, sessionAfter, wasmResponses: runtime.wasmResponses, pageErrors: runtime.pageErrors, consoleErrors: runtime.consoleErrors, failure
		});
		expect(identityAfter).toEqual(identityBefore);
		expect(sourceHashesAfter).toEqual(sourceHashesBefore);
	}
});

async function readBuildIdentity(page: Page): Promise<BuildIdentity> {
	const response = await page.request.get('/__build.json', { timeout: 5000 });
	if (!response.ok()) throw new Error(`Editor build identity returned HTTP ${response.status()}.`);
	const identity = await response.json() as BuildIdentity;
	if (identity.schema !== 'sibambo-app-build-identity-v2' || identity.app !== 'editor' || !/^[a-f0-9]{40}$/i.test(identity.commit) || !/^[a-f0-9]{64}$/i.test(identity.sourceSha256)) {
		throw new Error('Editor build identity response is incomplete or belongs to another app.');
	}
	return identity;
}

function observeRuntime(page: Page) {
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	const wasmResponses: Array<{ url: string; status: number; sameOrigin: boolean }> = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
	page.context().on('response', (response) => {
		const url = response.url();
		if (!/\.wasm(?:[?#]|$)/i.test(url)) return;
		wasmResponses.push({ url, status: response.status(), sameOrigin: new URL(url).origin === new URL(page.url()).origin });
	});
	return { pageErrors, consoleErrors, wasmResponses };
}

async function requestCount(page: Page) {
	return page.evaluate(() => (window as UiProbeWindow).__m2UiProbe.snapshot().requests.length);
}

async function chooseBomcFile(page: Page, fixture: PinnedInput, loadedModel: boolean) {
	const chooserPromise = page.waitForEvent('filechooser', { timeout: 30_000 });
	if (loadedModel) {
		await page.locator('nav.editor-menubar details.menu-root').first().locator('summary').click();
		await page.getByRole('button', { name: /Open Model…/ }).click();
	} else {
		await page.getByRole('button', { name: 'Open Model…', exact: true }).click();
	}
	const chooser = await chooserPromise;
	await chooser.setFiles({ name: fixture.fileName, mimeType: 'application/octet-stream', buffer: fixture.bytes });
	if (loadedModel) {
		await page.keyboard.press('Escape');
		await expect(page.locator('nav.editor-menubar details.menu-root[open]')).toHaveCount(0);
	}
}

async function waitForSuccessfulWorkerAndReady(page: Page, requestIndex: number, deadline: number) {
	await expect.poll(() => requestCount(page), { timeout: Math.min(30_000, remainingMs(deadline)) }).toBe(requestIndex + 1);
	const record = await waitForTerminalWorker(page, requestIndex, deadline);
	expect(record.terminals).toHaveLength(1);
	expect(record.terminals[0].type, record.terminals[0].error || '').toBe('complete');
	await expect(page.locator('.viewport-status')).toHaveCount(0, { timeout: remainingMs(deadline) });
	await expect(page.locator('.footer-status')).toHaveText('Ready', { timeout: remainingMs(deadline) });
	return record;
}

async function waitForTerminalWorker(page: Page, requestIndex: number, deadline: number) {
	await expect.poll(() => requestCount(page), { timeout: Math.min(30_000, remainingMs(deadline)) }).toBeGreaterThan(requestIndex);
	await expect.poll(async () => {
		const snapshot = await page.evaluate(() => (window as UiProbeWindow).__m2UiProbe.snapshot());
		return snapshot.requests[requestIndex]?.terminals.length ?? 0;
	}, { timeout: remainingMs(deadline) }).toBe(1);
	const snapshot = await page.evaluate(() => (window as UiProbeWindow).__m2UiProbe.snapshot());
	const record = snapshot.requests[requestIndex];
	if (!record) throw new Error(`Application worker request ${requestIndex} disappeared from its probe.`);
	return record;
}

async function waitForAssetProbes(page: Page, requestId: number) {
	return page.evaluate((id) => (window as UiProbeWindow).__m2UiProbe.waitForAssetProbes(id), requestId);
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms.`)), timeoutMs); })
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function remainingMs(deadline: number) {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Error('The 120,000 ms Editor import budget elapsed.');
	return remaining;
}

async function provePositiveViewportDraw(page: Page, requestId: number) {
	const canvas = page.locator('canvas[aria-label="Interactive 3D model viewport"]');
	await expect(canvas).toBeVisible();
	const handle = await canvas.elementHandle();
	if (!handle) throw new Error('Mounted model canvas element is missing.');
	const dimensions = await canvas.boundingBox();
	if (!dimensions) throw new Error('Mounted model canvas has no layout box.');
	expect(dimensions.width).toBeGreaterThan(0);
	expect(dimensions.height).toBeGreaterThan(0);
	const activeRequestId = await page.evaluate((element) => (window as UiProbeWindow).__m2UiProbe.resetDraw(element as HTMLCanvasElement), handle);
	expect(activeRequestId).toBe(requestId);
	await page.getByRole('button', { name: 'Zoom Extents' }).click();
	await expect.poll(async () => {
		const info = await page.evaluate((element) => (window as UiProbeWindow).__m2UiProbe.drawInfo(element as HTMLCanvasElement), handle);
		return info.requestId === requestId && info.total > 0;
	}, { timeout: 30_000 }).toBe(true);
	const info = await page.evaluate((element) => (window as UiProbeWindow).__m2UiProbe.drawInfo(element as HTMLCanvasElement), handle);
	expect(info).toMatchObject({ requestId, connected: true });
	expect(info.cssWidth).toBeGreaterThan(0);
	expect(info.cssHeight).toBeGreaterThan(0);
	expect(info.pixelWidth).toBeGreaterThan(0);
	expect(info.pixelHeight).toBeGreaterThan(0);
	expect(Object.values(info.counts).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
	await handle.dispose();
}

function assertSourceRequest(worker: WorkerRecord, fixture: PinnedInput) {
	expect(worker.scriptURL).toContain('e4-import.worker');
	expect(worker.requestId).toEqual(expect.any(Number));
	expect(worker.sourceName).toBe(fixture.fileName);
	expect(worker.inputByteLength).toBe(fixture.byteLength);
	expect(worker.postedMessages[0]).toMatchObject({ type: 'load', id: worker.requestId, sourceName: fixture.fileName, inputByteLength: fixture.byteLength, transferCount: 1 });
}

function assertSemanticResult(result: any, fixture: OracleMetadata['fixtures'][number], input: PinnedInput) {
	const active = fixture.materials.filter((material) => material.activeSemantic);
	const semantic = result.semanticMaterials;
	expect(result.counts.materials).toBe(fixture.materials.length);
	expect(result.counts.textures).toBe(input.sourceTextureCount);
	expect(semantic).toMatchObject({ sectionVersion: 2, activeCount: input.activeSemanticCount, verifiedCount: input.activeSemanticCount });
	expect(semantic.materialProofs).toHaveLength(input.activeSemanticCount);
	expect(semantic.baseDecodeCount).toBe(new Set(active.map((material) => material.textureIndex)).size);
	expect(semantic.maxLiveBaseFrames).toBe(1);
	expect(semantic.maxLiveOutputFrames).toBe(1);
	expect(semantic.maxMemoEntries).toBeLessThanOrEqual(65_536);
	const proofs = new Map<number, any>(semantic.materialProofs.map((row: any) => [row.materialIndex, row]));
	const assetPaths = new Set<string>(result.assets.map((asset: any) => asset.path));
	const materialPaths = new Map<number, string | null>(result.materialPaths.map((material: any) => [material.index, material.textureAsset]));
	const activeIndices = new Set(active.map((material) => material.materialIndex));
	for (const expected of active) {
		const proof = proofs.get(expected.materialIndex);
		if (!proof || !expected.semantic) throw new Error(`Active material ${expected.materialIndex} has no oracle/proof record.`);
		expect(proof).toMatchObject({
			textureIndex: expected.textureIndex, mode: expected.semantic.colorizeMode,
			expectedRgbaSha256: expected.semantic.outputRgbaSha256, actualRgbaSha256: expected.semantic.outputRgbaSha256
		});
		expect(proof.assetPath).toBe(materialPaths.get(expected.materialIndex));
		expect(assetPaths.has(proof.assetPath)).toBe(true);
		const metrics = result.textureMetrics.filter((row: any) => row.materialIndex === expected.materialIndex);
		for (const metric of metrics) expect(metric.textureAsset).toBe(proof.assetPath);
	}
	for (const group of result.groupPaths) {
		if (group.materialIndex !== null && activeIndices.has(group.materialIndex)) {
			expect(group.textureAsset).toBe(proofs.get(group.materialIndex)?.assetPath);
		} else if (group.textureAsset) {
			expect(group.textureAsset.startsWith('bomc/textures/semantic-')).toBe(false);
		}
	}
	expect(result.groupPaths.some((group: any) => group.materialIndex !== null && activeIndices.has(group.materialIndex))).toBe(true);
	expect(result.semanticMaterials.generatedAssetCount).toBeGreaterThan(0);
	expect(result.semanticMaterials.generatedAssetCount).toBeLessThanOrEqual(input.activeSemanticCount);
		expect(result.sourceFileBytes).toBe(input.byteLength);
		expect(result.texturePayloadBytes).toBeGreaterThan(0);
	expect(result.diagnosticTextureCount).toBe(input.sourceTextureCount);
}

function assertAssetImageProbes(result: any, probes: any[]) {
	const generatedPaths = new Set<string>(result.semanticMaterials.materialProofs.map((proof: any) => proof.assetPath));
	const referencedPaths = new Set<string>();
	for (const material of result.materialPaths) if (material.textureAsset?.startsWith('bomc/textures/semantic-')) referencedPaths.add(material.textureAsset);
	for (const group of result.groupPaths) if (group.textureAsset?.startsWith('bomc/textures/semantic-')) referencedPaths.add(group.textureAsset);
	for (const assetPath of referencedPaths) expect(generatedPaths.has(assetPath)).toBe(true);
	expect(referencedPaths.size).toBeGreaterThan(0);
	expect(probes.map((row) => row.path).sort()).toEqual([...referencedPaths].sort());
	expect(probes.every((row) => row.passed && row.naturalWidth === row.expectedWidth && row.naturalHeight === row.expectedHeight)).toBe(true);
}

async function readWorkerRecord(page: Page, index: number) {
	return page.evaluate((workerIndex) => (window as UiProbeWindow).__m2UiProbe.snapshot().requests[workerIndex] ?? null, index).catch(() => null);
}

async function writeUiReport(testInfo: TestInfo, name: string, report: Record<string, unknown>) {
	const outputPath = testInfo.outputPath(`${name}.json`);
	mkdirSync(path.dirname(outputPath), { recursive: true });
	const body = Buffer.from(`${JSON.stringify({ test: name, recordedAt: new Date().toISOString(), ...report }, null, 2)}\n`);
	writeFileSync(outputPath, body, { flag: 'wx' });
	await testInfo.attach(`${name}-proof-report`, { body, contentType: 'application/json' });
}

function fixtureIdentity(fixture: PinnedInput | undefined): Record<string, unknown> | null {
	return fixture ? { id: fixture.id, fileName: fixture.fileName, bytes: fixture.byteLength, sha256: fixture.sha256, materialVersion: fixture.materialVersion, sourceTextureCount: fixture.sourceTextureCount, activeSemanticCount: fixture.activeSemanticCount } : null;
}
