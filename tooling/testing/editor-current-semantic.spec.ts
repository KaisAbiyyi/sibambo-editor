import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
	ACCELERATED_CASE_TITLES, CURRENT_INPUT_ORACLE, CURRENT_S2_PIN, acceleratedFixturesForSuite, createAcceleratedCasePayload,
	loadCurrentS2Oracle, readAcceleratedContext, recordAcceleratedCase, type AcceleratedProofTicket
} from './accelerated-proof';
import { corruptFirstActiveSemanticHash, installEditorMaterialsV2Probe } from '../../apps/editor/tests/materials-v2-helpers';

type WorkerRecord = {
	workerIndex: number; requestId: number | null; sourceName: string | null; inputByteLength: number | null;
	postedMessages: Array<{ type: string | null; id: number | null; sourceName?: string | null; inputByteLength?: number | null; transferCount?: number }>;
	terminals: Array<{ id: number | null; type: string; error: string | null }>;
	idMismatches: unknown[]; errors: unknown[]; terminated: boolean; result: any;
};
type AssetProbe = { path: string; passed: boolean; expectedWidth?: number; expectedHeight?: number; naturalWidth?: number; naturalHeight?: number; error?: string };
type BuildIdentity = { schema: string; app: string; commit: string; dirty: boolean; sourceSha256: string };
declare global {
	interface Window {
		__m2UiProbe: {
			snapshot(): { activeRequestId: number | null; requests: WorkerRecord[] };
			resetDraw(canvas: HTMLCanvasElement): number | null;
			drawInfo(canvas: HTMLCanvasElement): { requestId: number | null; total: number; connected: boolean; cssWidth: number; cssHeight: number; pixelWidth: number; pixelHeight: number };
			rememberSession(): void;
			sessionStillMounted(): { sameCanvas: boolean; sameTitle: boolean; title: string };
			waitForAssetProbes(requestId: number): Promise<AssetProbe[]>;
		};
	}
}

const fixture = acceleratedFixturesForSuite('current-semantic')[0]!;

test('S2-current semantic materials match the pinned Ruby oracle and retain the prior viewport on corrupt replacement', async ({ page }, testInfo) => {
	test.setTimeout(240_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await installEditorMaterialsV2Probe(page);
	const ticket = activeTicket();
	if (!ticket) test.skip();
	const activeTicketValue = ticket as AcceleratedProofTicket;
	const reference = activeTicketValue.referencePins.find((row) => row.id === 'current-input-oracle');
	if (!reference) throw new Error('The current-semantic ticket has no pinned current-input oracle.');
	const { fixture: oracleFixture, active: activeOracleRows } = loadCurrentS2Oracle(reference);
	const inputBytes = readFileSync(fixture.realPath);
	if (inputBytes.byteLength !== CURRENT_S2_PIN.bytes || sha256(inputBytes) !== CURRENT_S2_PIN.sha256) throw new Error('S2-current fixture bytes changed after the accelerated source seal.');
	const corruption = await corruptFirstActiveSemanticHash(inputBytes);
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

	const buildIdentity = await readBuildIdentity(page);
	expect(buildTuple(buildIdentity)).toEqual(activeTicketValue.buildIdentity);
	await page.goto('/?renderer=webgl2', { waitUntil: 'networkidle' });
	const fileInput = page.getByLabel('BOMC 1.2 file');
	await expect(fileInput).toBeEnabled({ timeout: 30_000 });
	const initialWorkerStartIndex = await page.evaluate(() => window.__m2UiProbe.snapshot().requests.length);
	await fileInput.setInputFiles(fixture.realPath);
	const canvas = page.locator('canvas[aria-label="Interactive 3D model viewport"]');
	await expect(canvas).toBeVisible({ timeout: 180_000 });
	const initialWorker = await waitForTerminalWorker(page, initialWorkerStartIndex, fixture.fileName, fixture.bytes);
	const footerStatus = page.locator('.footer-status');
	await expect.poll(async () => (await footerStatus.innerText()).trim(), { timeout: 180_000 })
		.toMatch(/^(?:Ready|BOMC has no Editor authoring section\.)$/);
	const readyStatusText = (await footerStatus.innerText()).trim();
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(page).toHaveTitle('PROJECT SBOOST 2');
	const initialResult = initialWorker.result;
	const canvasHandle = await canvas.elementHandle();
	if (!canvasHandle) throw new Error('S2-current semantic viewport canvas was not mounted.');
	const drawRequestId = await page.evaluate((element) => window.__m2UiProbe.resetDraw(element as HTMLCanvasElement), canvasHandle);
	expect(drawRequestId).toBe(initialWorker.requestId);
	await page.getByRole('button', { name: 'Zoom Extents' }).click();
	await expect.poll(async () => page.evaluate((element) => window.__m2UiProbe.drawInfo(element as HTMLCanvasElement).total, canvasHandle), { timeout: 30_000 }).toBeGreaterThan(0);
	const drawInfo = await page.evaluate((element) => window.__m2UiProbe.drawInfo(element as HTMLCanvasElement), canvasHandle);
	const assetProbes = await withDeadline(page.evaluate((id) => window.__m2UiProbe.waitForAssetProbes(id), initialWorker.requestId!), 30_000, 'S2-current generated semantic PNG decode');
	const beforeCorruptPath = testInfo.outputPath('semantic-before-corrupt.png');
	const beforeCorruptSha256 = await captureViewportPixels(page, canvas, beforeCorruptPath);
	await page.evaluate(() => window.__m2UiProbe.rememberSession());
	const sessionBefore = await page.evaluate(() => window.__m2UiProbe.sessionStillMounted());

	const corruptWorkerStartIndex = await page.evaluate(() => window.__m2UiProbe.snapshot().requests.length);
	await fileInput.setInputFiles({
		name: 'S2-current-semantic-hash-corrupt.bomc', mimeType: 'application/octet-stream', buffer: corruption.bytes
	});
	const corruptWorker = await waitForTerminalWorker(page, corruptWorkerStartIndex, 'S2-current-semantic-hash-corrupt.bomc', corruption.bytes.byteLength);
	await expect(page.locator('.viewport-status')).toContainText('RGBA hash mismatch', { timeout: 180_000 });
	await expect(page.locator('.footer-status')).toContainText('Zoom Extents');
	const afterCorruptPath = testInfo.outputPath('semantic-after-corrupt.png');
	const afterCorruptSha256 = await captureViewportPixels(page, canvas, afterCorruptPath);
	const sessionAfter = await page.evaluate(() => window.__m2UiProbe.sessionStillMounted());

	const actualProofs = initialResult?.semanticMaterials?.materialProofs ?? [];
	const proofByMaterial = new Map<number, any>(actualProofs.map((row: any) => [row.materialIndex, row]));
	const actualAssets = new Set<string>((initialResult?.assets ?? []).map((row: any) => row.path));
	const actualMaterialPaths = new Map<number, any>((initialResult?.materialPaths ?? []).map((row: any) => [row.index, row]));
	const actualGroupPaths: any[] = initialResult?.groupPaths ?? [];
	const workerMetricsMatched = activeOracleRows.every((expected) => {
		const proof = proofByMaterial.get(expected.materialIndex);
		const materialPath = actualMaterialPaths.get(expected.materialIndex);
		if (!proof || !expected.semantic || !materialPath) return false;
		const expectedAsset = proof.assetPath;
		const relatedMetrics = (initialResult?.textureMetrics ?? []).filter((row: any) => row.materialIndex === expected.materialIndex);
		return proof.textureIndex === expected.textureIndex && proof.mode === expected.semantic.colorizeMode
			&& proof.expectedRgbaSha256 === expected.semantic.outputRgbaSha256
			&& proof.actualRgbaSha256 === expected.semantic.outputRgbaSha256
			&& materialPath.textureAsset === expectedAsset && actualAssets.has(expectedAsset)
			&& materialPath.textureWidthM === expected.textureWidthM && materialPath.textureHeightM === expected.textureHeightM
			&& relatedMetrics.every((row: any) => row.textureAsset === expectedAsset);
	});
	const activeGroupsMapped = actualGroupPaths.some((row) => activeIndicesFor(activeOracleRows).includes(row.materialIndex))
		&& actualGroupPaths.every((row) => !activeIndicesFor(activeOracleRows).includes(row.materialIndex)
			|| row.textureAsset === proofByMaterial.get(row.materialIndex)?.assetPath);
	const allSemanticPngPaths = [...new Set(actualProofs.map((row: any) => row.assetPath))].sort();
	const semanticPngsDecoded = allSemanticPngPaths.length > 0
		&& assetProbes.map((row) => row.path).sort().join('\0') === allSemanticPngPaths.join('\0')
		&& assetProbes.every((row) => row.passed && row.naturalWidth === row.expectedWidth && row.naturalHeight === row.expectedHeight);
	const decodeContextUrl = new URL(page.url());
	const sameOriginBlobDecode = decodeContextUrl.protocol === 'http:' && decodeContextUrl.origin !== 'null'
		&& assetProbes.length > 0 && allSemanticPngPaths.every((assetPath) => assetPath.startsWith('bomc/textures/semantic-'));
	const activeIndices = activeOracleRows.map((row) => row.materialIndex);
	const oracleIdentityMatched = reference.bytes === CURRENT_INPUT_ORACLE.bytes && reference.sha256 === CURRENT_INPUT_ORACLE.sha256
		&& oracleFixture.id === 'S2-current' && oracleFixture.bytes === CURRENT_S2_PIN.bytes && oracleFixture.sha256 === CURRENT_S2_PIN.sha256
		&& activeIndices.join(',') === '17,19,32,33,34,35,36,43,45,46';
	const workerCompletedOnce = initialWorker.terminals.length === 1 && initialWorker.terminals[0]?.type === 'complete'
		&& initialWorker.terminals[0]?.id === initialWorker.requestId && initialWorker.terminated
		&& initialWorker.idMismatches.length === 0 && initialWorker.errors.length === 0;
	const fixtureIdentityMatched = initialWorker.sourceName === fixture.fileName
		&& initialWorker.inputByteLength === fixture.bytes && fixture.sha256 === CURRENT_S2_PIN.sha256
		&& initialWorker.postedMessages.filter((row) => row.type === 'load').length === 1;
	const buildIdentityMatched = sameBuildTuple(buildIdentity, activeTicketValue.buildIdentity);
	const tenActiveSemanticMaterials = initialResult?.semanticMaterials?.sectionVersion === 2
		&& initialResult.semanticMaterials.activeCount === 10 && initialResult.semanticMaterials.verifiedCount === 10
		&& activeProofCount(actualProofs, activeIndices) === 10
		&& initialResult.counts?.materials === 48 && initialResult.counts?.textures === 13
		&& initialResult.sourceFileBytes === CURRENT_S2_PIN.bytes && initialResult.diagnosticTextureCount === 13
		&& initialResult.texturePayloadBytes > 0;
	const workerMetricsBounds = initialResult?.semanticMaterials?.baseDecodeCount === new Set(activeOracleRows.map((row) => row.textureIndex)).size
		&& initialResult.semanticMaterials.maxLiveBaseFrames === 1
		&& initialResult.semanticMaterials.maxLiveOutputFrames === 1
		&& initialResult.semanticMaterials.maxMemoEntries <= 65_536
		&& initialResult.semanticMaterials.generatedAssetCount === allSemanticPngPaths.length;
	const corruptReplacementRejected = corruptWorker.terminals.length === 1 && corruptWorker.terminals[0]?.type === 'error'
		&& String(corruptWorker.terminals[0]?.error ?? '').includes('RGBA hash mismatch') && corruptWorker.result === null
		&& corruptWorker.terminated && corruptWorker.idMismatches.length === 0 && corruptWorker.errors.length === 0
		&& corruption.changedPayloadBytes === 1 && corruption.changedSections.length === 1 && corruption.changedSections[0] === 'MATERIALS';
	const priorCanvasRetained = sessionBefore.sameCanvas && sessionAfter.sameCanvas;
	const priorTitleRetained = sessionBefore.sameTitle && sessionAfter.sameTitle
		&& sessionBefore.title === 'PROJECT SBOOST 2' && sessionAfter.title === sessionBefore.title;
	const priorPixelsRetained = beforeCorruptSha256 === afterCorruptSha256;
	const observations = {
		fixtureIdentityMatched, oracleIdentityMatched, buildIdentityMatched, workerCompletedOnce, tenActiveSemanticMaterials,
		workerMetricsMatched: workerMetricsMatched && workerMetricsBounds && activeGroupsMapped, semanticPngsDecoded, semanticPngsSameOrigin: sameOriginBlobDecode,
		ready: drawInfo.connected && drawInfo.requestId === initialWorker.requestId && drawInfo.total > 0,
		corruptReplacementRejected, priorCanvasRetained, priorTitleRetained, priorPixelsRetained,
		noPageErrors: pageErrors.length === 0, noConsoleErrors: consoleErrors.length === 0
	};
	const payload = createAcceleratedCasePayload(activeTicketValue, ACCELERATED_CASE_TITLES.currentSemantic, {
		inputHashes: {
			[fixture.id]: fixture.sha256, 'current-input-oracle': reference.sha256,
			'S2-current-corrupt-replacement': corruption.corruptedSha256
		},
		observations,
		data: {
			fixture: { id: fixture.id, fileName: fixture.fileName, bytes: fixture.bytes, sha256: fixture.sha256, realPath: fixture.realPath },
			oracle: { id: oracleFixture.id, bytes: oracleFixture.bytes, sha256: oracleFixture.sha256, activeMaterialIndices: activeIndices },
			buildIdentity, initialWorker, corruptWorker, readyStatusText, workerMetrics: initialResult?.semanticMaterials,
			textureMetrics: initialResult?.textureMetrics, materialPaths: initialResult?.materialPaths, groupPaths: actualGroupPaths,
			assetProbes, decodeContextOrigin: decodeContextUrl.origin, decodeContextProtocol: decodeContextUrl.protocol,
			corruption: { materialIndex: corruption.materialIndex, expectedHash: corruption.expectedHash, corruptedHash: corruption.corruptedHash, sourceSha256: corruption.sourceSha256, corruptedSha256: corruption.corruptedSha256, changedPayloadBytes: corruption.changedPayloadBytes, changedSections: corruption.changedSections },
			drawInfo, sessionBefore, sessionAfter, beforeCorruptSha256, afterCorruptSha256, pageErrors, consoleErrors
		}
	});
	const definition = activeTicketValue.cases.find((row) => row.title === ACCELERATED_CASE_TITLES.currentSemantic)!;
	const sidecarPath = testInfo.outputPath(definition.sidecarName);
	mkdirSync(path.dirname(sidecarPath), { recursive: true });
	writeFileSync(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
	recordAcceleratedCase(activeTicketValue, ACCELERATED_CASE_TITLES.currentSemantic, {
		sidecarPath, artifactPaths: [beforeCorruptPath, afterCorruptPath], payload
	});
	await testInfo.attach(definition.sidecarName, { path: sidecarPath, contentType: 'application/json' });
	await testInfo.attach('semantic-before-corrupt.png', { path: beforeCorruptPath, contentType: 'image/png' });
	await testInfo.attach('semantic-after-corrupt.png', { path: afterCorruptPath, contentType: 'image/png' });
	for (const [name, passed] of Object.entries(observations)) expect(passed, `${name} evidence`).toBe(true);
});

function activeTicket(): AcceleratedProofTicket | null {
	const context = readAcceleratedContext('current-semantic');
	return context && !('discoveryOnly' in context) ? context : null;
}

async function readBuildIdentity(page: Page): Promise<BuildIdentity> {
	const response = await page.request.get('/__build.json', { timeout: 5_000 });
	expect(response.ok()).toBe(true);
	const identity = await response.json() as BuildIdentity;
	expect(identity).toMatchObject({ schema: 'sibambo-app-build-identity-v2', app: 'editor' });
	return identity;
}

async function waitForTerminalWorker(page: Page, startIndex: number, sourceName: string, inputByteLength: number): Promise<WorkerRecord> {
	const request = { startIndex, sourceName, inputByteLength };
	await expect.poll(() => page.evaluate(({ startIndex: afterIndex, sourceName: expectedName, inputByteLength: expectedBytes }) => {
		const rows = window.__m2UiProbe.snapshot().requests;
		return rows.filter((row) => row.workerIndex >= afterIndex && row.postedMessages.some((message) =>
			message.type === 'load' && message.sourceName === expectedName && message.inputByteLength === expectedBytes
		)).length;
	}, request), { timeout: 30_000 }).toBe(1);
	const workerIndex = await page.evaluate(({ startIndex: afterIndex, sourceName: expectedName, inputByteLength: expectedBytes }) => {
		const rows = window.__m2UiProbe.snapshot().requests;
		return rows.find((row) => row.workerIndex >= afterIndex && row.postedMessages.some((message) =>
			message.type === 'load' && message.sourceName === expectedName && message.inputByteLength === expectedBytes
		))?.workerIndex ?? null;
	}, request);
	if (workerIndex === null) throw new Error(`The E4 worker request for ${sourceName} (${inputByteLength} bytes) is missing.`);
	await expect.poll(() => page.evaluate((index) => window.__m2UiProbe.snapshot().requests[index]?.terminals.length ?? 0, workerIndex), { timeout: 180_000 }).toBe(1);
	const row = await page.evaluate((index) => window.__m2UiProbe.snapshot().requests[index] ?? null, workerIndex);
	if (!row) throw new Error(`The actual E4 worker request ${workerIndex} is missing from the browser probe.`);
	return row;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms.`)), timeoutMs); })
		]);
	} finally { if (timer) clearTimeout(timer); }
}

async function settleFrames(page: Page) {
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function captureViewportPixels(page: Page, canvas: Locator, outputPath: string) {
	const originalStatusVisibility = await page.evaluate(() => {
		const status = document.querySelector<HTMLElement>('.viewport-status');
		if (!status) return null;
		const visibility = status.style.visibility;
		status.style.visibility = 'hidden';
		return visibility;
	});
	try {
		await settleFrames(page);
		return sha256(await canvas.screenshot({ path: outputPath }));
	} finally {
		if (originalStatusVisibility !== null) {
			await page.evaluate((visibility) => {
				const status = document.querySelector<HTMLElement>('.viewport-status');
				if (status) status.style.visibility = visibility;
			}, originalStatusVisibility);
		}
	}
}

function activeProofCount(proofs: any[], activeIndices: number[]) { return activeIndices.filter((index) => proofs.some((row) => row.materialIndex === index)).length; }
function activeIndicesFor(rows: Array<{ materialIndex: number }>) { return rows.map((row) => row.materialIndex); }
function buildTuple(identity: BuildIdentity) { return { commit: identity.commit, dirty: identity.dirty, sourceSha256: identity.sourceSha256 }; }
function sameBuildTuple(identity: BuildIdentity, expected: AcceleratedProofTicket['buildIdentity']) {
	return identity.commit === expected.commit && identity.dirty === expected.dirty && identity.sourceSha256 === expected.sourceSha256;
}
function sha256(value: Uint8Array) { return createHash('sha256').update(value).digest('hex'); }
