import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

type OracleMaterial = {
	materialIndex: number; name: string | null; displayName: string | null; rgba: number[]; opacity: number;
	textureIndex: number | null; textureWidthM: number; textureHeightM: number; activeSemantic: boolean;
	semantic?: { materialType: number; colorizeMode: number; deltas: number[]; outputRgbaSha256: string };
};
type OracleFixture = { id: string; bytes: number; sha256: string; materialVersion: number; sourceTextureCount: number; activeSemanticCount: number; materials: OracleMaterial[] };
type OracleMetadata = {
	schemaVersion: string; producer: { commit: string; root: string; sourceSha256: Record<string, string> };
	fixtureManifestSha256: string; fixtures: OracleFixture[]; activeSemanticMaterialCount: number;
};
type PngCase = { width: number; height: number; sourceRgba: number[][]; mode: 1 | 2; deltas: number[]; expectedRgba: number[][]; expectedRgbaSha256: string };
type MaterialProof = {
	materialIndex: number; textureIndex: number; mode: 1 | 2; expectedRgbaSha256: string; actualRgbaSha256: string;
	assetPath: string; colorizeMs: number; hashMs: number; encodeMs: number; reusedAsset: boolean;
};
type WorkerResult = {
	requestId: number; status: 'complete' | 'error' | 'cancelled'; error?: string; rows: MaterialProof[];
	workerLifecycle: { created: boolean; terminated: boolean; listenersRemoved: boolean; terminalMessageCount: number; terminalType: string | null };
	report?: any;
};

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const editorRoot = path.resolve(harnessDir, '../../..');
const workspaceRoot = path.resolve(editorRoot, '..');
const attempt = process.env.SIBAMBO_M2_ATTEMPT;
const worklogRoot = path.resolve(process.env.SIBAMBO_M2_WORKLOG || '');
const outputDir = path.join(worklogRoot, 'pixel-playwright', `attempt-${attempt}`);
const metadata = JSON.parse(readFileSync(path.join(worklogRoot, 'oracle', 'metadata.json'), 'utf8')) as OracleMetadata;
const vectorOracle = JSON.parse(readFileSync(path.join(editorRoot, 'packages/e4-import/src/test-fixtures/semantic-colorize-ruby-v1.json'), 'utf8')) as { caseCount: number; pngCase: PngCase };
const fixturePins: Record<string, { bytes: number; sha256: string; materials: number; sourceTextures: number; active: number; jpeg: number; webp: number }> = {
	'S1-new': { bytes: 2_428_754, sha256: 'd306fb89c0a59edf5ecdbcaf26d27e795e521cceb1c689e59958e1038932918c', materials: 50, sourceTextures: 15, active: 12, jpeg: 11, webp: 1 },
	'S2-new': { bytes: 2_319_634, sha256: 'df19a9f07df845661d065b98b221dbcfc53e9ec2c3efe7a11f434b7fcb0ac452', materials: 48, sourceTextures: 13, active: 10, jpeg: 10, webp: 0 },
	'I-new': { bytes: 28_765_513, sha256: '01bf898df9a8b377f4d48ea4825c51427f2e18dbded865144363d5642a235825', materials: 184, sourceTextures: 68, active: 17, jpeg: 13, webp: 4 },
	'Y-new': { bytes: 34_496_013, sha256: '5bca4efdf0ac4f502b810179d51e49defbbc63406e98bb1f7641db1fb1d14c6f', materials: 125, sourceTextures: 43, active: 15, jpeg: 14, webp: 1 }
};

assertOracleProvenance();

for (const fixtureId of ['S1-new', 'S2-new', 'I-new', 'Y-new']) {
	test(`texture-only semantic pixel proof ${fixtureId}`, async ({ page, browser }, testInfo) => {
		test.setTimeout(330_000);
		const expected = metadata.fixtures.find((fixture) => fixture.id === fixtureId)!;
		const pin = fixturePins[fixtureId];
		const runtime = observePage(page);
		await page.goto('/');
		let result: WorkerResult | undefined;
		let executionError: Error | undefined;
		try {
			result = await withDeadline(page.evaluate((request) => (window as Window & { __m2Proof: any }).__m2Proof.run(request), {
				fixtureId, sha256: expected.sha256, expectedMaterials: expected.materials
			}), 300_000, fixtureId);
		} catch (error) {
			executionError = error instanceof Error ? error : new Error(String(error));
			await page.evaluate(() => (window as Window & { __m2Proof: any }).__m2Proof.cancel()).catch(() => undefined);
		} finally {
			const snapshot = await page.evaluate(() => (window as Window & { __m2Proof: any }).__m2Proof.snapshot()).catch(() => null);
			const buildIdentity = await captureSourceIdentity();
			const report = {
				fixtureId, pinned: pin, sourceIdentity: buildIdentity, browserVersion: browser.version(),
				pageCapabilities: await page.evaluate(() => ({
					userAgent: navigator.userAgent, offscreenCanvas: typeof OffscreenCanvas === 'function',
					createImageBitmap: typeof createImageBitmap === 'function', webAssembly: typeof WebAssembly === 'object',
					viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }
				})).catch(() => null),
				result: result || null, snapshot, pageErrors: runtime.pageErrors, consoleErrors: runtime.consoleErrors,
				wasmResponses: runtime.wasmResponses, executionError: executionError?.message || null,
				recordedAt: new Date().toISOString()
			};
			await persistReport(report, fixtureId, testInfo);
		}

		if (executionError) throw executionError;
		expect(result).toBeDefined();
		expect(result!.status, result!.error).toBe('complete');
		expect(result!.workerLifecycle).toMatchObject({ created: true, terminated: true, listenersRemoved: true, terminalMessageCount: 1, terminalType: 'complete' });
		expect(result!.rows).toHaveLength(pin.active);
		expect(result!.rows.map((row) => row.materialIndex).sort((a, b) => a - b)).toEqual(expected.materials.filter((row) => row.activeSemantic).map((row) => row.materialIndex).sort((a, b) => a - b));
		expect(result!.rows.every((row) => row.expectedRgbaSha256 === row.actualRgbaSha256)).toBe(true);
		expect(result!.rows.every((row) => row.assetPath.startsWith('bomc/textures/semantic-'))).toBe(true);
		expect(result!.report).toMatchObject({
			fixtureId, sourceFileBytes: pin.bytes, sourceFileSha256: pin.sha256, materialVersion: 2,
			materialCount: pin.materials, sourceTextureCount: pin.sourceTextures, activeCount: pin.active,
			sourcePayloadsUnchanged: true, generatedAliasesSourceBlob: false, workerErrors: 0, geometryLoadedSections: []
		});
		expect(result!.report.activeMediaCounts).toEqual({ PNG: 0, JPEG: pin.jpeg, WebP: pin.webp });
		expect(result!.report.diagnostics).toMatchObject({
			activeCount: pin.active, verifiedCount: pin.active,
			baseDecodeCount: new Set(expected.materials.filter((row) => row.activeSemantic).map((row) => row.textureIndex)).size,
			maxLiveBaseFrames: 1, maxLiveOutputFrames: 1
		});
		expect(result!.report.diagnostics.maxMemoEntries).toBeLessThanOrEqual(65_536);
		expect(result!.report.generatedPngRoundTrips.length).toBeGreaterThan(0);
		expect(result!.report.generatedPngRoundTrips.every((row: any) => row.passed && row.expectedRgbaSha256 === row.actualRgbaSha256)).toBe(true);
		expect(result!.report.baseObservations).toHaveLength(result!.report.diagnostics.baseDecodeCount);
		expect(result!.report.baseObservations.map((row: any) => row.textureIndex)).toEqual([...new Set<number>(result!.report.activeTextureIndices as number[])].sort((a, b) => a - b));
		expect(runtime.pageErrors).toEqual([]);
		expect(runtime.consoleErrors).toEqual([]);
		expect(runtime.wasmResponses.length).toBeGreaterThan(0);
		expect(runtime.wasmResponses.every((item) => item.status === 200 && item.sameOrigin)).toBe(true);
	});
}

test('generated PNG codec case preserves alpha-zero RGB and Ruby output bytes', async ({ page, browser }, testInfo) => {
	test.setTimeout(30_000);
	const runtime = observePage(page);
	await page.goto('/');
	let result: WorkerResult | undefined;
	let executionError: Error | undefined;
	try {
		result = await withDeadline(page.evaluate((request) => (window as Window & { __m2Proof: any }).__m2Proof.run(request), {
			fixtureId: 'generated-png', sha256: 'generated-png', expectedMaterials: [], pngCase: vectorOracle.pngCase
		}), 25_000, 'generated-png');
	} catch (error) {
		executionError = error instanceof Error ? error : new Error(String(error));
		await page.evaluate(() => (window as Window & { __m2Proof: any }).__m2Proof.cancel()).catch(() => undefined);
	} finally {
		const snapshot = await page.evaluate(() => (window as Window & { __m2Proof: any }).__m2Proof.snapshot()).catch(() => null);
		const report = { fixtureId: 'generated-png', browserVersion: browser.version(), result: result || null, snapshot, pageErrors: runtime.pageErrors, consoleErrors: runtime.consoleErrors, wasmResponses: runtime.wasmResponses, executionError: executionError?.message || null, recordedAt: new Date().toISOString() };
		await persistReport(report, 'generated-png', testInfo);
	}
	if (executionError) throw executionError;
	expect(result).toBeDefined();
	expect(result!.status, result!.error).toBe('complete');
	expect(result!.workerLifecycle).toMatchObject({ created: true, terminated: true, listenersRemoved: true, terminalMessageCount: 1, terminalType: 'complete' });
	expect(result!.report).toMatchObject({ fixtureId: 'generated-png', sourcePngRoundTripExact: true, generatedPngRoundTripExact: true, expectedRgbaSha256: vectorOracle.pngCase.expectedRgbaSha256, actualRgbaSha256: vectorOracle.pngCase.expectedRgbaSha256, workerErrors: 0 });
	expect(runtime.pageErrors).toEqual([]);
	expect(runtime.consoleErrors).toEqual([]);
	expect(runtime.wasmResponses.length).toBeGreaterThan(0);
	expect(runtime.wasmResponses.every((item) => item.status === 200 && item.sameOrigin)).toBe(true);
});

test('all four pinned real inputs account for 54 active JPEG/WebP material rows', async () => {
	const rows = ['S1-new', 'S2-new', 'I-new', 'Y-new'].map((fixtureId) => {
		const reportPath = path.join(outputDir, 'reports', `${fixtureId}.json`);
		const report = JSON.parse(readFileSync(reportPath, 'utf8'));
		return report.result.report.activeMediaCounts;
	});
	const total = rows.reduce((sum, row) => ({ JPEG: sum.JPEG + row.JPEG, WebP: sum.WebP + row.WebP }), { JPEG: 0, WebP: 0 });
	expect(total).toEqual({ JPEG: 48, WebP: 6 });
	const report = { gate: 'M2-PIXEL-active-source-media-accounting', fixtures: ['S1-new', 'S2-new', 'I-new', 'Y-new'], activeMaterialRows: 54, activeMediaCounts: total, passed: true };
	await persistReport(report, 'aggregate-source-media');
});

function assertOracleProvenance() {
	if (metadata.schemaVersion !== 'bomc-materials-v2-ruby-oracle-v1' || metadata.activeSemanticMaterialCount !== 54 || vectorOracle.caseCount !== 1408) {
		throw new Error('Ruby oracle metadata or vector identity is invalid.');
	}
	const manifestPath = path.join(editorRoot, 'tooling/performance/fixtures.json');
	const manifestSha = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
	if (manifestSha !== metadata.fixtureManifestSha256) throw new Error('Oracle fixture manifest SHA-256 changed.');
	const producerRoot = path.join(workspaceRoot, 'bom_engine_plugin');
	const producerCommit = execFileSync('git', ['-C', producerRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	if (producerCommit !== metadata.producer.commit) throw new Error('Current producer commit differs from Ruby oracle provenance.');
	for (const [relativePath, expectedHash] of Object.entries(metadata.producer.sourceSha256)) {
		if (shaFile(path.join(producerRoot, relativePath)) !== expectedHash) throw new Error(`Producer oracle source hash differs: ${relativePath}`);
	}
	for (const [fixtureId, pin] of Object.entries(fixturePins)) {
		const fixture = metadata.fixtures.find((candidate) => candidate.id === fixtureId);
		if (!fixture || fixture.bytes !== pin.bytes || fixture.sha256 !== pin.sha256 || fixture.materials.length !== pin.materials ||
			fixture.sourceTextureCount !== pin.sourceTextures || fixture.activeSemanticCount !== pin.active) {
			throw new Error(`Ruby metadata does not match the frozen ${fixtureId} inventory.`);
		}
	}
	const activeCount = metadata.fixtures.reduce((sum, fixture) => sum + fixture.materials.filter((material) => material.activeSemantic).length, 0);
	if (activeCount !== 54) throw new Error(`Ruby metadata accounts for ${activeCount} active rows, expected 54.`);
}

function observePage(page: Page) {
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	const wasmResponses: Array<{ url: string; status: number; sameOrigin: boolean }> = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
	page.on('response', (response) => {
		const url = response.url();
		if (!/\.wasm(?:[?#]|$)/i.test(url)) return;
		wasmResponses.push({ url, status: response.status(), sameOrigin: new URL(url).origin === 'http://127.0.0.1:5196' });
	});
	return { pageErrors, consoleErrors, wasmResponses };
}

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} proof exceeded ${ms} ms budget.`)), ms); })
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function persistReport(report: unknown, name: string, testInfo?: TestInfo) {
	const directory = path.join(outputDir, 'reports');
	mkdirSync(directory, { recursive: true });
	const reportPath = path.join(directory, `${name}.json`);
	const body = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
	writeFileSync(reportPath, body, { flag: 'wx' });
	if (testInfo) await testInfo.attach(`${name}-proof-report`, { body, contentType: 'application/json' });
}

async function captureSourceIdentity() {
	const paths = [
		'packages/e4-import/src/bomc-loader.ts',
		'packages/e4-import/src/semantic-colorize.ts',
		'packages/e4-import/src/image-pixel-codec.ts',
		'packages/e4-import/package.json', 'bun.lock'
	];
	return Object.fromEntries(paths.map((relative) => [relative, shaFile(path.join(editorRoot, relative))]));
}

function shaFile(filePath: string) { return createHash('sha256').update(readFileSync(filePath)).digest('hex'); }
