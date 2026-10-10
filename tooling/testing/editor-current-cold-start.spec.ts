import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
	ACCELERATED_CASE_TITLES, CURRENT_S2_PIN, acceleratedFixturesForSuite, createAcceleratedCasePayload, readAcceleratedContext,
	recordAcceleratedCase, type AcceleratedProofTicket
} from './accelerated-proof';
import { installEditorMaterialsV2Probe } from '../../apps/editor/tests/materials-v2-helpers';

type WorkerProbe = {
	requestId: number | null; sourceName: string | null; inputByteLength: number | null;
	postedMessages: Array<{ type: string | null; id: number | null }>;
	terminals: Array<{ id: number | null; type: string; error: string | null }>;
	idMismatches: unknown[]; errors: unknown[]; terminated: boolean; result: any;
};
declare global {
	interface Window {
		__m2UiProbe: { snapshot(): { activeRequestId: number | null; requests: WorkerProbe[] } };
		__acceleratedObservation: {
			initialHydration: { ready: string | null; inputDisabled: boolean | null; openDisabled: boolean[] } | null;
			fileChanges: Array<{ name: string; size: number; selectedAtMs: number }>;
			triangleCount: number;
			firstConnectedPositiveDrawAtMs: number | null;
			firstConnectedPositiveDrawRequestId: number | null;
		};
	}
}

type BuildIdentity = { schema: string; app: string; commit: string; dirty: boolean; sourceSha256: string };
type CaseEvidence = { observations: Record<string, boolean>; inputHashes: Record<string, string>; data: Record<string, unknown> };

const fixture = acceleratedFixturesForSuite('current-cold')[0]!;

test.beforeEach(async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await installEditorMaterialsV2Probe(page);
	await installAcceleratedObservations(page);
});

test(ACCELERATED_CASE_TITLES.currentCold, async ({ page }, testInfo) => {
	const ticket = activeTicket('current-cold');
	if (!ticket) test.skip();
	const activeTicketValue = ticket as AcceleratedProofTicket;
	expect(activeTicketValue.cycle).toBeTruthy();
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	const workerRequests: string[] = [];
	let fullReloadMessages = 0;
	let mainFrameNavigations = 0;
	let initialNavigationComplete = false;
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
	page.on('request', (request) => { if (request.url().includes('e4-import.worker')) workerRequests.push(request.url()); });
	page.on('framenavigated', (frame) => { if (initialNavigationComplete && frame === page.mainFrame()) mainFrameNavigations += 1; });
	page.on('websocket', (socket) => socket.on('framereceived', (frame) => {
		if (typeof frame.payload !== 'string') return;
		try { if ((JSON.parse(frame.payload) as { type?: string }).type === 'full-reload') fullReloadMessages += 1; } catch { /* Other Vite messages are not reload evidence. */ }
	}));

	const buildIdentity = await readBuildIdentity(page);
	expect(buildIdentity).toMatchObject({ schema: 'sibambo-app-build-identity-v2', app: 'editor' });
	expect(buildTuple(buildIdentity)).toEqual(activeTicketValue.buildIdentity);
	await page.goto('/?renderer=webgl2', { waitUntil: 'networkidle' });
	initialNavigationComplete = true;
	const canvas = page.locator('canvas[aria-label="Interactive 3D model viewport"]');
	const initialWorkspace = page.locator('.viewport-frame');
	await expect(initialWorkspace).toBeVisible();
	const beforeImportPath = testInfo.outputPath('before-import.png');
	// The empty shell intentionally has no WebGL canvas until a model/document is opened.
	// Preserve a real pre-import view of the workspace, then assert the actual canvas after import.
	await initialWorkspace.screenshot({ path: beforeImportPath });

	const fileInput = page.getByLabel('BOMC 1.2 file');
	await expect(fileInput).toBeEnabled({ timeout: 30_000 });
	await fileInput.setInputFiles(fixture.realPath);
	await expect(canvas).toBeVisible({ timeout: 180_000 });
	await page.waitForFunction(() => {
		const observation = (window as any).__acceleratedObservation;
		return observation.triangleCount > 0 && observation.firstConnectedPositiveDrawAtMs !== null;
	}, null, { timeout: 180_000 });
	const footerStatus = page.locator('.footer-status');
	await expect.poll(async () => (await footerStatus.innerText()).trim(), { timeout: 180_000 })
		.toMatch(/^(?:Ready|BOMC has no Editor authoring section\.)$/);
	const readyStatusText = (await footerStatus.innerText()).trim();
	const validReadyStatus = readyStatusText === 'Ready' || readyStatusText === 'BOMC has no Editor authoring section.';
	expect(validReadyStatus, `Unexpected current-viewer status: ${readyStatusText}`).toBe(true);
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Orbit' })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Zoom Extents' })).toBeEnabled();
	await settleFrames(page);
	const afterReadyPath = testInfo.outputPath('after-ready.png');
	const afterReadyPixels = await canvas.screenshot({ path: afterReadyPath });
	const readyHash = sha256(afterReadyPixels);

	await page.getByRole('button', { name: 'Orbit' }).click();
	const box = await canvas.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
	await page.mouse.down();
	await page.mouse.move(box!.x + box!.width / 2 + 74, box!.y + box!.height / 2 + 38, { steps: 6 });
	await page.mouse.up();
	await settleFrames(page);
	const afterOrbitHash = sha256(await canvas.screenshot());
	await page.getByRole('button', { name: 'Zoom Extents' }).click();
	await page.getByRole('button', { name: 'Select' }).click();
	const pick = await pickVisibleGeometry(page, canvas);
	const workerRows = await page.evaluate(() => window.__m2UiProbe.snapshot().requests.filter((row) => row.postedMessages.some((message) => message.type === 'load')));
	const observation = await page.evaluate(() => window.__acceleratedObservation);
	const worker = workerRows[0];
	const triangleCount = observation.triangleCount;
	const oneFileSelection = observation.fileChanges.length === 1
		&& observation.fileChanges[0]?.name === fixture.fileName && observation.fileChanges[0]?.size === fixture.bytes;
	const oneWorkerRequest = workerRequests.length === 1 && workerRows.length === 1
		&& worker?.sourceName === fixture.fileName && worker.inputByteLength === fixture.bytes;
	const workerCompletedOnce = !!worker && worker.terminals.length === 1 && worker.terminals[0]?.type === 'complete'
		&& worker.terminals[0]?.id === worker.requestId && worker.terminated && worker.errors.length === 0;
	const fixtureIdentityMatched = oneFileSelection && oneWorkerRequest && CURRENT_S2_PIN.sha256 === fixture.sha256;
	const buildIdentityMatched = sameBuildTuple(buildIdentity, activeTicketValue.buildIdentity);
	const orbitPixelsChanged = readyHash !== afterOrbitHash;
	const positivePick = !!pick && isPickStatus(pick.footerStatus);
	const noDevFullReload = fullReloadMessages === 0;
	const noMainFrameNavigation = mainFrameNavigations === 0;
	const firstConnectedPositiveDraw = observation.firstConnectedPositiveDrawAtMs;
	const selectedAt = observation.fileChanges[0]?.selectedAtMs ?? null;
	const positiveSceneTriangles = triangleCount > 0 && firstConnectedPositiveDraw !== null
		&& selectedAt !== null && firstConnectedPositiveDraw >= selectedAt
		&& observation.firstConnectedPositiveDrawRequestId === worker?.requestId;
	const viewportReadyDraw = readyStatusText.length > 0 && validReadyStatus && positiveSceneTriangles;
	const noPageErrors = pageErrors.length === 0;
	const noConsoleErrors = consoleErrors.length === 0;
	const observations = {
		fixtureIdentityMatched, buildIdentityMatched, oneFileSelection, oneWorkerRequest, workerCompletedOnce, positiveSceneTriangles,
		ready: viewportReadyDraw, orbitPixelsChanged, zoomExtents: true, positivePick, noDevFullReload, noMainFrameNavigation,
		noPageErrors, noConsoleErrors
	};
	const evidence: CaseEvidence = {
		inputHashes: { [fixture.id]: fixture.sha256 }, observations,
		data: {
			fixture: { id: fixture.id, bytes: fixture.bytes, sha256: fixture.sha256, fileName: fixture.fileName, realPath: fixture.realPath },
			buildIdentity, workerRequestUrls: workerRequests, worker, initialHydration: observation.initialHydration, readyStatusText,
			selectionChanges: observation.fileChanges, triangleCount, firstConnectedPositiveDrawAtMs: firstConnectedPositiveDraw,
			firstConnectedPositiveDrawRequestId: observation.firstConnectedPositiveDrawRequestId,
			readyPixelsSha256: readyHash, afterOrbitPixelsSha256: afterOrbitHash,
			fullReloadMessages, mainFrameNavigations, pick, pageErrors, consoleErrors
		}
	};
	await persistCase(activeTicketValue, testInfo, ACCELERATED_CASE_TITLES.currentCold, evidence, [beforeImportPath, afterReadyPath]);
	for (const [name, passed] of Object.entries(observations)) expect(passed, `${name} evidence`).toBe(true);
});

test(ACCELERATED_CASE_TITLES.currentColdHydration, async ({ page }, testInfo) => {
	const ticket = activeTicket('current-cold');
	if (!ticket) test.skip();
	const activeTicketValue = ticket as AcceleratedProofTicket;
	if (activeTicketValue.cycle !== 'cold-01') test.skip();
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
	await page.goto('/?renderer=webgl2', { waitUntil: 'domcontentloaded' });
	const initial = await page.evaluate(() => window.__acceleratedObservation.initialHydration);
	expect(initial).not.toBeNull();
	expect(initial).toMatchObject({ ready: 'false', inputDisabled: true });
	expect(initial!.openDisabled.length).toBeGreaterThan(0);
	expect(initial!.openDisabled.every(Boolean)).toBe(true);
	await page.waitForFunction(() => document.querySelector('main[data-app="editor"]')?.getAttribute('data-editor-ready') === 'true', null, { timeout: 30_000 });
	await expect(page.getByLabel('BOMC 1.2 file')).toBeEnabled();
	const openButtons = page.getByRole('button', { name: /Open Model/ });
	expect(await openButtons.count()).toBeGreaterThan(0);
	for (let index = 0; index < await openButtons.count(); index += 1) await expect(openButtons.nth(index)).toBeEnabled();
	const observation = await page.evaluate(() => window.__acceleratedObservation);
	const worker = await page.evaluate(() => window.__m2UiProbe.snapshot().requests);
	const observations = {
		ssrNotReady: initial!.ready === 'false', openControlsDisabled: initial!.openDisabled.length > 0 && initial!.openDisabled.every(Boolean),
		fileInputDisabled: initial!.inputDisabled, readyAfterHydration: true, openControlsEnabled: true,
		noFixtureRequest: observation.fileChanges.length === 0, noWorkerRequest: worker.length === 0, noPageErrors: pageErrors.length === 0
	};
	await persistCase(activeTicketValue, testInfo, ACCELERATED_CASE_TITLES.currentColdHydration, { observations, inputHashes: {}, data: { initialHydration: initial, fileChanges: observation.fileChanges, workerRequests: worker.length, pageErrors, consoleErrors } }, []);
	for (const [name, passed] of Object.entries(observations)) expect(passed, `${name} evidence`).toBe(true);
});

async function installAcceleratedObservations(page: Page) {
	await page.addInitScript(() => {
		const state = (window as any).__acceleratedObservation = {
			initialHydration: null, fileChanges: [], triangleCount: 0,
			firstConnectedPositiveDrawAtMs: null, firstConnectedPositiveDrawRequestId: null
		};
		const captureInitial = () => {
			if (state.initialHydration) return;
			const main = document.querySelector('main[data-app="editor"]');
			if (!main) return;
			const input = document.querySelector<HTMLInputElement>('input[type="file"][accept*=".bomc"]');
			const openButtons = [...document.querySelectorAll<HTMLButtonElement>('button')]
				.filter((button) => /Open Model/i.test(button.textContent ?? ''));
			state.initialHydration = { ready: main.getAttribute('data-editor-ready'), inputDisabled: input?.disabled ?? null, openDisabled: openButtons.map((button) => button.disabled) };
		};
		new MutationObserver(captureInitial).observe(document, { childList: true, subtree: true });
		document.addEventListener('change', (event) => {
			const input = event.target;
			if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
			const file = input.files?.[0];
			if (file) state.fileChanges.push({ name: file.name, size: file.size, selectedAtMs: performance.now() });
		}, true);
		const instrument = (prototype: any) => {
			if (!prototype) return;
			for (const [name, countIndex, instanceIndex] of [
				['drawElements', 1, null], ['drawArrays', 2, null], ['drawElementsInstanced', 1, 4], ['drawArraysInstanced', 2, 3]
			] as const) {
				const original = prototype[name];
				if (typeof original !== 'function' || original.__acceleratedTriangleProbe) continue;
				const wrapped = function (this: any, ...args: any[]) {
					if (args[0] === this.TRIANGLES) {
						const count = Number(args[countIndex] ?? 0);
						const instances = instanceIndex === null ? 1 : Number(args[instanceIndex] ?? 1);
						const triangles = Math.floor(count / 3) * instances;
						state.triangleCount += triangles;
						if (triangles > 0 && this.canvas?.isConnected && state.fileChanges.length > 0
							&& state.firstConnectedPositiveDrawAtMs === null) {
							state.firstConnectedPositiveDrawAtMs = performance.now();
							state.firstConnectedPositiveDrawRequestId = (window as any).__m2UiProbe?.snapshot?.().activeRequestId ?? null;
						}
					}
					return Reflect.apply(original, this, args);
				};
				Object.defineProperty(wrapped, '__acceleratedTriangleProbe', { value: true });
				Object.defineProperty(prototype, name, { value: wrapped, configurable: true, writable: true });
			}
		};
		instrument(window.WebGL2RenderingContext?.prototype);
	});
}

function activeTicket(suite: 'current-cold'): AcceleratedProofTicket | null {
	const context = readAcceleratedContext(suite);
	return context && !('discoveryOnly' in context) ? context : null;
}

function buildTuple(identity: BuildIdentity) { return { commit: identity.commit, dirty: identity.dirty, sourceSha256: identity.sourceSha256 }; }
function sameBuildTuple(identity: BuildIdentity, expected: AcceleratedProofTicket['buildIdentity']) {
	return identity.commit === expected.commit && identity.dirty === expected.dirty && identity.sourceSha256 === expected.sourceSha256;
}

async function readBuildIdentity(page: Page): Promise<BuildIdentity> {
	const response = await page.request.get('/__build.json');
	expect(response.ok()).toBe(true);
	return await response.json() as BuildIdentity;
}

async function persistCase(ticket: AcceleratedProofTicket, testInfo: TestInfo, title: string, evidence: CaseEvidence, artifacts: string[]) {
	const payload = createAcceleratedCasePayload(ticket, title, evidence);
	const definition = ticket.cases.find((row) => row.title === title);
	expect(definition).toBeTruthy();
	expect(artifacts.map((filePath) => path.basename(filePath)).sort()).toEqual([...(definition?.artifactNames ?? [])].sort());
	const sidecarPath = testInfo.outputPath(definition!.sidecarName);
	mkdirSync(path.dirname(sidecarPath), { recursive: true });
	writeFileSync(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
	recordAcceleratedCase(ticket, title, { sidecarPath, artifactPaths: artifacts, payload });
	await testInfo.attach(definition!.sidecarName, { path: sidecarPath, contentType: 'application/json' });
	for (const artifactPath of artifacts) await testInfo.attach(path.basename(artifactPath), { path: artifactPath, contentType: 'image/png' });
}

async function settleFrames(page: Page) {
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function pickVisibleGeometry(page: Page, canvas: ReturnType<Page['locator']>) {
	const box = await canvas.boundingBox();
	if (!box) return null;
	const points: ReadonlyArray<readonly [number, number]> = [[0.5, 0.5], [0.38, 0.5], [0.62, 0.5], [0.5, 0.38], [0.5, 0.62], [0.35, 0.35], [0.65, 0.35], [0.35, 0.65], [0.65, 0.65], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]];
	const status = page.locator('.footer-status');
	for (const [x, y] of points) {
		await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
		await settleFrames(page);
		const text = (await status.innerText()).trim();
		if (isPickStatus(text)) return { xFraction: x, yFraction: y, footerStatus: text };
	}
	return null;
}

function isPickStatus(value: string) { return /\bselected\b/i.test(value) || /\bFace\s+\d+\b/i.test(value) || value.includes('This hit has no stable imported occurrence identity'); }
function sha256(value: Uint8Array) { return createHash('sha256').update(value).digest('hex'); }
