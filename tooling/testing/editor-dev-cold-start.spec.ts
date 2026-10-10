import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { captureSourceHashes, installEditorMaterialsV2Probe, loadOracleMetadata, readPinnedInput } from '../../apps/editor/tests/materials-v2-helpers';
import { markProofOutcome, readProofTicket, writeProofSidecar, type ProofTicket } from './proof-run-contract';
import { expectedEditorBuildIdentity, type AcceleratedBuildIdentity } from './accelerated-proof';

const cycle = process.env.SIBAMBO_STABILITY_CYCLE!;
const runRoot = path.resolve(process.env.SIBAMBO_STABILITY_RUN!);
const oracle = loadOracleMetadata();
const proofContext = process.env.SIBAMBO_PROOF_TICKET ? readProofTicket('cold') : null;
const proofTicket = proofContext && !('discoveryOnly' in proofContext) ? proofContext as ProofTicket : null;

type ColdWindow = Window & { __m2UiProbe: any };
type BuildIdentity = { schema: string; app: string; commit: string; dirty: boolean; sourceSha256: string };

async function readBuildIdentity(page: Page): Promise<BuildIdentity> {
	const response = await page.request.get('/__build.json', { timeout: 5_000 });
	if (!response.ok()) throw new Error(`Build identity endpoint returned HTTP ${response.status()}.`);
	const identity = await response.json() as Partial<BuildIdentity>;
	if (identity.schema !== 'sibambo-app-build-identity-v2' || identity.app !== 'editor') throw new Error('Editor build identity schema/app is invalid.');
	if (typeof identity.commit !== 'string' || !/^[a-f0-9]{40}$/i.test(identity.commit)) throw new Error('Editor build identity commit is invalid.');
	if (typeof identity.dirty !== 'boolean' || typeof identity.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(identity.sourceSha256)) throw new Error('Editor build identity source proof is invalid.');
	return identity as BuildIdentity;
}

test('one S2-new selection reaches first ready draw without a dev full reload', async ({ page }, testInfo) => {
	test.setTimeout(180_000);
	const started = performance.now();
	const input = readPinnedInput('S2-new');
	const inputSha = createHash('sha256').update(input.bytes).digest('hex');
	expect(input.byteLength).toBe(2_319_634);
	expect(inputSha).toBe('df19a9f07df845661d065b98b221dbcfc53e9ec2c3efe7a11f434b7fcb0ac452');
	const sourceBefore = await captureSourceHashes();
	const navigations: string[] = [];
	const fullReloadFrames: string[] = [];
	const wasmResponses: Array<{ url: string; status: number; sameOrigin: boolean }> = [];
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	let selectedAt = 0;
	let worker: any = null;
	let assetProbes: any[] = [];
	let buildIdentity: BuildIdentity | null = null;
	let expectedBuildIdentity: AcceleratedBuildIdentity | null = null;
	let observedStage = 'listeners-installed';
	page.on('framenavigated', (frame) => { if (frame === page.mainFrame() && selectedAt) navigations.push(frame.url()); });
	page.on('websocket', (socket) => socket.on('framereceived', (event) => {
		const payload = typeof event.payload === 'string' ? event.payload : '';
		if (/full-reload|vite:beforeFullReload/i.test(payload)) fullReloadFrames.push(payload.slice(0, 500));
	}));
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
	page.context().on('response', (response) => {
		if (/\.wasm(?:[?#]|$)/i.test(response.url())) wasmResponses.push({ url: response.url(), status: response.status(), sameOrigin: new URL(response.url()).origin === new URL(page.url()).origin });
	});
	await page.addInitScript(() => {
		const nativeWorker = window.Worker;
		window.Worker = new Proxy(nativeWorker, {
			construct(target, args, newTarget) {
				const worker = Reflect.construct(target, args, newTarget);
				return worker;
			}
		});
	});
	await installEditorMaterialsV2Probe(page);
	try {
		if (proofTicket) {
			buildIdentity = await readBuildIdentity(page);
			expectedBuildIdentity = expectedEditorBuildIdentity();
			expect(expectedBuildIdentity.commit).toBe(proofTicket.testedHead);
			expect(buildIdentity.commit).toBe(proofTicket.testedHead);
			expect(buildTuple(buildIdentity)).toEqual(expectedBuildIdentity);
		} else {
			const identityResponse = await page.request.get('/__build.json').catch(() => null);
			if (identityResponse?.ok()) buildIdentity = await identityResponse.json();
		}
		await page.goto('/?renderer=webgl2');
		if (proofTicket) markProofOutcome(proofTicket, testInfo.title);
		observedStage = 'initial-navigation-complete';
		const main = page.locator('main[data-app="editor"]');
		await expect(main).toHaveAttribute('data-editor-ready', 'true', { timeout: 30_000 });
		const emptyOpen = page.locator('.empty-workspace .empty-open');
		await expect(emptyOpen).toBeVisible();
		await expect(emptyOpen).toBeEnabled();
		const initialRequests = await page.evaluate(() => (window as unknown as ColdWindow).__m2UiProbe.snapshot().requests.length);
		expect(initialRequests).toBe(0);
		const chooserEvent = page.waitForEvent('filechooser', { timeout: 30_000 });
		await emptyOpen.click();
		const chooser = await chooserEvent;
		selectedAt = performance.now();
		await chooser.setFiles({ name: input.fileName, mimeType: 'application/octet-stream', buffer: input.bytes });
		observedStage = 'fixture-selected';
		const deadline = Date.now() + 120_000;
		await expect.poll(() => page.evaluate(() => (window as unknown as ColdWindow).__m2UiProbe.snapshot().requests.length), { timeout: 30_000 }).toBe(initialRequests + 1);
		await expect.poll(async () => {
			const snapshot = await page.evaluate(() => (window as unknown as ColdWindow).__m2UiProbe.snapshot());
			return snapshot.requests[initialRequests]?.terminals?.length ?? 0;
		}, { timeout: Math.max(1, deadline - Date.now()) }).toBe(1);
		const probe = await page.evaluate(() => (window as unknown as ColdWindow).__m2UiProbe.snapshot());
		worker = probe.requests[initialRequests];
		expect(worker.terminals).toHaveLength(1);
		expect(worker.terminals[0]).toMatchObject({ type: 'complete', id: worker.requestId, error: null });
		expect(worker.terminated).toBe(true);
		expect(worker.idMismatches).toEqual([]);
		expect(worker.errors).toEqual([]);
		expect(worker.sourceName).toBe(input.fileName);
		expect(worker.inputByteLength).toBe(input.byteLength);
		await expect(page.locator('.viewport-status')).toHaveCount(0, { timeout: Math.max(1, deadline - Date.now()) });
		await expect(page.locator('.footer-status')).toHaveText('Ready', { timeout: Math.max(1, deadline - Date.now()) });
		await expect.poll(() => page.title(), { timeout: Math.max(1, deadline - Date.now()) }).toBe('PROJECT SBOOST 2');
		const fixture = oracle.fixtures.find((row) => row.id === 'S2-new')!;
		expect(worker.result.semanticMaterials).toMatchObject({ sectionVersion: 2, activeCount: 10, verifiedCount: 10, generatedAssetCount: 9 });
		assetProbes = await page.evaluate((requestId) => (window as unknown as ColdWindow).__m2UiProbe.waitForAssetProbes(requestId), worker.requestId);
		expect(assetProbes).toHaveLength(9);
		expect(assetProbes.every((row: any) => row.passed && row.naturalWidth === row.expectedWidth && row.naturalHeight === row.expectedHeight)).toBe(true);
		expect(worker.result.counts.materials).toBe(fixture.materials.length);
		const canvas = page.locator('canvas[aria-label="Interactive 3D model viewport"]');
		await expect(canvas).toBeVisible();
		const handle = await canvas.elementHandle();
		if (!handle) throw new Error('Cold-start model canvas is missing.');
		const drawRequest = await page.evaluate((element) => (window as unknown as ColdWindow).__m2UiProbe.resetDraw(element as HTMLCanvasElement), handle);
		expect(drawRequest).toBe(worker.requestId);
		await page.getByRole('button', { name: 'Zoom Extents' }).click();
		await expect.poll(async () => (await page.evaluate((element) => (window as unknown as ColdWindow).__m2UiProbe.drawInfo(element as HTMLCanvasElement), handle)).total, { timeout: 30_000 }).toBeGreaterThan(0);
		const draw = await page.evaluate((element) => (window as unknown as ColdWindow).__m2UiProbe.drawInfo(element as HTMLCanvasElement), handle);
		expect(draw).toMatchObject({ connected: true, requestId: worker.requestId });
		expect(draw.cssWidth).toBeGreaterThan(0); expect(draw.cssHeight).toBeGreaterThan(0);
		expect(wasmResponses.length).toBeGreaterThan(0);
		expect(wasmResponses.every((item) => item.status === 200 && item.sameOrigin)).toBe(true);
		expect(navigations).toEqual([]);
		expect(fullReloadFrames).toEqual([]);
		expect(pageErrors).toEqual([]);
		expect(consoleErrors).toEqual([]);
		observedStage = 'first-draw-and-appearance-accepted';
		await handle.dispose();
	} finally {
		const sourceAfter = await captureSourceHashes();
		const sourceUnchanged = JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore);
		const errors = [...testInfo.errors.map((error) => error.message), ...(sourceUnchanged ? [] : ['Editor source changed during the cold-start case.'])];
		const report = {
			cycle, observedStatus: sourceUnchanged ? testInfo.status : 'failed', expectedStatus: testInfo.expectedStatus, stage: observedStage,
			fixture: { id: input.id, bytes: input.byteLength, sha256: inputSha }, runTicket: proofTicket, sourceUnchanged,
			buildIdentity, expectedBuildIdentity, sourceBefore, sourceAfter, worker, assetProbes, wasmResponses, navigations, fullReloadFrames, pageErrors, consoleErrors,
			errors,
			startedAtMs: started, selectedAtMs: selectedAt, finishedAtMs: performance.now(), elapsedMs: performance.now() - started
		};
		if (proofTicket) writeProofSidecar(proofTicket, testInfo.title, report);
		else {
			const output = path.join(runRoot, 'dev', cycle);
			mkdirSync(output, { recursive: true });
			writeFileSync(path.join(output, 'cycle.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
		}
		expect(sourceAfter).toEqual(sourceBefore);
	}
});

test('Open controls remain disabled until the client bindings are ready', async ({ page }, testInfo) => {
	test.skip(cycle !== 'cold-01', 'The SSR actionability control runs only after the genuine cold selection case.');
	test.setTimeout(60_000);
	const pageErrors: string[] = [];
	const fixtureRequests: string[] = [];
	const workerUrls: string[] = [];
	let releaseScripts!: () => void;
	let released = false;
	const deferredRoutes = new Set<import('@playwright/test').Route>();
	const ownedContinuations = new Set<Promise<void>>();
	const routeErrorsObserved: string[] = [];
	let routeCleanupFailure: unknown = null;
	const scriptsReleased = new Promise<void>((resolve) => { releaseScripts = resolve; });
	const release = () => { if (!released) { released = true; releaseScripts(); } };
	const deferScripts = async (route: import('@playwright/test').Route) => {
		const continuation = (async () => {
			if (route.request().resourceType() === 'script') {
				deferredRoutes.add(route);
				await scriptsReleased;
				if (!deferredRoutes.delete(route)) return;
			}
			await route.continue();
		})();
		ownedContinuations.add(continuation);
		void continuation.then(
			() => ownedContinuations.delete(continuation),
			error => { routeErrorsObserved.push(error instanceof Error ? error.message : String(error)); ownedContinuations.delete(continuation); }
		);
		return continuation;
	};
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('request', (request) => { if (request.url().includes('/__fixture__/')) fixtureRequests.push(request.url()); });
	page.on('worker', (worker) => workerUrls.push(worker.url()));
	await page.route('**/*', deferScripts);
	let stage = 'scripts-deferred';
	try {
		await page.goto('/?renderer=webgl2', { waitUntil: 'commit' });
		if (proofTicket) markProofOutcome(proofTicket, testInfo.title);
		stage = 'ssr-committed';
		const main = page.locator('main[data-app="editor"]');
		await expect(main).toHaveAttribute('data-editor-ready', 'false');
		const menuOpen = page.locator('.editor-menubar .menu-popover button').filter({ hasText: /^Open Model…\s*Ctrl\+O$/ });
		const emptyOpen = page.locator('.empty-workspace .empty-open');
		const allOpenButtons = page.getByRole('button', { name: 'Open Model…', includeHidden: true });
		await expect(allOpenButtons).toHaveCount(2);
		await expect(page.getByRole('button', { name: 'Open Model…' })).toHaveCount(1);
		await expect(menuOpen).toHaveCount(1);
		await expect(emptyOpen).toHaveCount(1);
		await expect(menuOpen).toBeDisabled();
		await expect(emptyOpen).toBeDisabled();
		const sourceInput = page.locator('input[type="file"][accept^=".bomc"]');
		await expect(sourceInput).toBeDisabled();
		release();
		await expect(main).toHaveAttribute('data-editor-ready', 'true', { timeout: 30_000 });
		await expect(emptyOpen).toBeEnabled();
		await expect(sourceInput).toBeEnabled();
		const fileSummary = page.locator('.editor-menubar details.menu-root').first().locator('summary');
		await expect(fileSummary).toHaveText('File');
		await fileSummary.click();
		await expect(menuOpen).toBeVisible();
		await expect(menuOpen).toBeEnabled();
		stage = 'client-bindings-ready';
		expect(fixtureRequests).toEqual([]);
		expect(workerUrls).toEqual([]);
		expect(pageErrors).toEqual([]);
	} finally {
		release();
		try {
			while (ownedContinuations.size > 0) await Promise.all([...ownedContinuations]);
		} catch (error) {
			routeCleanupFailure = error;
		}
		if (deferredRoutes.size > 0 && !routeCleanupFailure) routeCleanupFailure = new Error(`${deferredRoutes.size} owned deferred script route(s) were not continued.`);
		if (routeErrorsObserved.length > 0 && !routeCleanupFailure) routeCleanupFailure = new Error(`Deferred route continuation failed: ${routeErrorsObserved.join(' | ')}`);
		await page.unroute('**/*', deferScripts);
		const routeErrors = routeCleanupFailure ? [routeCleanupFailure instanceof Error ? routeCleanupFailure.message : String(routeCleanupFailure)] : [];
		const report = { observedStatus: routeErrors.length ? 'failed' : testInfo.status, expectedStatus: testInfo.expectedStatus, stage, errors: [...testInfo.errors.map((error) => error.message), ...pageErrors, ...routeErrors], pageErrors, routeErrors, fixtureRequests, workerUrls, deferredRoutesRemaining: deferredRoutes.size };
		if (proofTicket) writeProofSidecar(proofTicket, testInfo.title, report);
		if (routeCleanupFailure) throw routeCleanupFailure;
	}
});

function buildTuple(identity: BuildIdentity) {
	return { commit: identity.commit, dirty: identity.dirty, sourceSha256: identity.sourceSha256 };
}
