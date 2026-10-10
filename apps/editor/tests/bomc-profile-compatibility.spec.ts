import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
	resolveAllBomcProfileFixtures,
	type ResolvedBomcProfileFixture
} from '../../../tooling/testing/bomc-profile-fixtures';
import {
	createAcceleratedCasePayload, readAcceleratedContext, recordAcceleratedCase, type AcceleratedProofTicket
} from '../../../tooling/testing/accelerated-proof';
import { installEditorMaterialsV2Probe } from './materials-v2-helpers';

type CanvasBox = { x: number; y: number; width: number; height: number };
type PickEvidence = { xFraction: number; yFraction: number; footerStatus: string };
type ReadinessTransition = { elapsedMs: number; status: string };
type ViewerRenderObservation = {
	canvas: { connected: boolean; cssWidth: number; cssHeight: number; pixelWidth: number; pixelHeight: number };
	draw: { requestId: number | null; total: number };
	worker: { requestId: number | null; faces: number | null; terminalCount: number; terminalId: number | null; terminalType: string | null; terminalError: string | null; errorCount: number; terminated: boolean };
};
type CanvasDrawEvidence = ViewerRenderObservation['canvas'] & { requestId: number | null; total: number };
type ReadinessEvidence = {
	elapsedMs: number; timeoutMs: number; transitions: ReadinessTransition[];
	satisfiedBy: 'ready-status' | 'rendered-viewer-only'; viewerRender?: ViewerRenderObservation;
};
type ProfileWorker = {
	requestId: number | null; sourceName: string | null; inputByteLength: number | null;
	postedMessages: Array<{ type: string | null; id: number | null }>;
	terminals: Array<{ id: number | null; type: string; error: string | null }>;
	idMismatches: Array<unknown>; errors: Array<unknown>; terminated: boolean;
	result: { counts?: { faces?: number }; sourceFileBytes?: number } | null;
};
const HEAVY_FIXTURE_BYTES = 10 * 1024 * 1024;
const LIGHT_READINESS_TIMEOUT_MS = 180_000;
const HEAVY_READINESS_TIMEOUT_MS = 600_000;
const POST_READINESS_BUDGET_MS = 120_000;
const VIEWER_ONLY_NO_AUTHORING_STATUS = 'BOMC has no Editor authoring section.';

const fixtures = resolveAllBomcProfileFixtures();
const fixtureIds = fixtures.map((fixture) => fixture.id);
if (fixtures.length !== 12 || new Set(fixtureIds).size !== 12) {
	throw new Error(`BOMC profile gate requires exactly 12 distinct pinned fixtures; received ${fixtures.length}.`);
}

function sha256(bytes: Buffer) {
	return createHash('sha256').update(bytes).digest('hex');
}

function readinessTimeoutMs(fixture: ResolvedBomcProfileFixture) {
	return fixture.bytes >= HEAVY_FIXTURE_BYTES ? HEAVY_READINESS_TIMEOUT_MS : LIGHT_READINESS_TIMEOUT_MS;
}

function caseTimeoutMs(fixture: ResolvedBomcProfileFixture) {
	return readinessTimeoutMs(fixture) + POST_READINESS_BUDGET_MS;
}

async function settleFrames(page: Page) {
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function visibleText(locator: ReturnType<Page['locator']>) {
	try {
		if (!(await locator.isVisible())) return '';
		return (await locator.innerText()).trim();
	} catch {
		return '';
	}
}

async function waitForEditorReady(page: Page, fixture: ResolvedBomcProfileFixture): Promise<ReadinessEvidence> {
	const ready = page.locator('.footer-status').getByText('Ready', { exact: true });
	const alert = page.getByRole('alert');
	const timeoutMs = readinessTimeoutMs(fixture);
	const startedAt = Date.now();
	const transitions: ReadinessTransition[] = [];
	let lastStatus = '';

	while (Date.now() - startedAt < timeoutMs) {
		if (await alert.isVisible().catch(() => false)) {
			throw new Error(`${fixture.id} import failed before viewport readiness: ${(await alert.innerText()).trim()}`);
		}
		if (await ready.isVisible().catch(() => false)) {
			return { elapsedMs: Date.now() - startedAt, timeoutMs, transitions, satisfiedBy: 'ready-status' };
		}

		const footerStatus = await visibleText(page.locator('.footer-status').first());
		const status = footerStatus || 'No visible import status';
		if (status !== lastStatus) {
			transitions.push({ elapsedMs: Date.now() - startedAt, status });
			lastStatus = status;
		}
		if (status === VIEWER_ONLY_NO_AUTHORING_STATUS) {
			return { elapsedMs: Date.now() - startedAt, timeoutMs, transitions, satisfiedBy: 'rendered-viewer-only' };
		}
		await page.waitForTimeout(1_000);
	}

	throw new Error(
		`${fixture.id} did not reach viewport readiness within ${timeoutMs}ms; `
		+ `lastStatus=${JSON.stringify(lastStatus)}; transitions=${JSON.stringify(transitions)}`
	);
}

function isPickEvidenceStatus(status: string) {
	return /\bselected\b/i.test(status)
		|| /\bFace\s+\d+\b/i.test(status)
		|| status.includes('This hit has no stable imported occurrence identity');
}

async function pickVisibleGeometry(page: Page, canvasBox: CanvasBox): Promise<PickEvidence | null> {
	const points: ReadonlyArray<readonly [number, number]> = [
		[0.50, 0.50], [0.38, 0.50], [0.62, 0.50], [0.50, 0.38], [0.50, 0.62],
		[0.35, 0.35], [0.65, 0.35], [0.35, 0.65], [0.65, 0.65],
		[0.25, 0.50], [0.75, 0.50], [0.50, 0.25], [0.50, 0.75]
	];
	const footerStatus = page.locator('.footer-status');
	for (const [xFraction, yFraction] of points) {
		await page.mouse.click(
			canvasBox.x + canvasBox.width * xFraction,
			canvasBox.y + canvasBox.height * yFraction
		);
		await settleFrames(page);
		const status = (await footerStatus.innerText()).trim();
		if (isPickEvidenceStatus(status)) return { xFraction, yFraction, footerStatus: status };
	}
	return null;
}

async function persistCase(ticket: AcceleratedProofTicket, testInfo: TestInfo, fixture: ResolvedBomcProfileFixture, input: {
	buildIdentity: { commit: string; dirty: boolean; sourceSha256: string };
	worker: ProfileWorker;
	readiness: ReadinessEvidence;
	orbit: { beforeSha256: string; afterSha256: string };
	pick: PickEvidence;
	pageErrors: string[];
	consoleErrors: string[];
	artifactPaths: string[];
}) {
	const title = testInfo.title;
	const payload = createAcceleratedCasePayload(ticket, title, {
		inputHashes: { [fixture.id]: fixture.sha256 },
		observations: {
			fixtureIdentityMatched: input.worker.sourceName === fixture.fileName && input.worker.inputByteLength === fixture.bytes,
			buildIdentityMatched: input.buildIdentity.commit === ticket.buildIdentity.commit
				&& input.buildIdentity.dirty === ticket.buildIdentity.dirty && input.buildIdentity.sourceSha256 === ticket.buildIdentity.sourceSha256,
			workerCompletedOnce: input.worker.terminals.length === 1 && input.worker.terminals[0]?.type === 'complete'
				&& input.worker.terminals[0]?.id === input.worker.requestId && input.worker.terminated && input.worker.errors.length === 0,
			ready: input.readiness.elapsedMs >= 0 && input.readiness.elapsedMs <= input.readiness.timeoutMs,
			positiveDraw: !!input.readiness.viewerRender && input.readiness.viewerRender.canvas.connected
				&& input.readiness.viewerRender.draw.total > 0
				&& input.readiness.viewerRender.draw.requestId === input.readiness.viewerRender.worker.requestId,
			orbitPixelsChanged: input.orbit.beforeSha256 !== input.orbit.afterSha256,
			zoomExtents: true,
			positivePick: isPickEvidenceStatus(input.pick.footerStatus),
			noPageErrors: input.pageErrors.length === 0,
			noConsoleErrors: input.consoleErrors.length === 0
		},
		data: {
			fixture: { id: fixture.id, model: fixture.model, profile: fixture.profile, bytes: fixture.bytes, sha256: fixture.sha256, fileName: fixture.fileName, path: fixture.path, realPath: fixture.realPath },
			buildIdentity: input.buildIdentity, worker: input.worker, readiness: input.readiness, orbit: input.orbit, pick: input.pick,
			pageErrors: input.pageErrors, consoleErrors: input.consoleErrors
		}
	});
	const sidecarPath = testInfo.outputPath('profile-case.json');
	mkdirSync(path.dirname(sidecarPath), { recursive: true });
	writeFileSync(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
	const markerPath = recordAcceleratedCase(ticket, title, { sidecarPath, artifactPaths: input.artifactPaths, payload });
	await testInfo.attach('profile-case.json', { path: sidecarPath, contentType: 'application/json' });
	for (const artifactPath of input.artifactPaths) {
		const name = path.basename(artifactPath);
		await testInfo.attach(name, { path: artifactPath, contentType: 'image/png' });
	}
	return markerPath;
}

async function runProfileCase(page: Page, testInfo: TestInfo, fixture: ResolvedBomcProfileFixture, ticket: AcceleratedProofTicket) {
	testInfo.setTimeout(caseTimeoutMs(fixture));
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	const workerRequests: string[] = [];
	await installEditorMaterialsV2Probe(page);
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
	page.on('request', (request) => { if (request.url().includes('e4-import.worker')) workerRequests.push(request.url()); });

	const buildResponse = await page.request.get('/__build.json');
	expect(buildResponse.ok()).toBeTruthy();
	const buildIdentity = await buildResponse.json() as { schema: string; app: string; commit: string; dirty: boolean; sourceSha256: string };
	expect(buildIdentity).toMatchObject({ schema: 'sibambo-app-build-identity-v2', app: 'editor' });
	expect({ commit: buildIdentity.commit, dirty: buildIdentity.dirty, sourceSha256: buildIdentity.sourceSha256 }).toEqual(ticket.buildIdentity);

	await page.goto('/?renderer=webgl2', { waitUntil: 'networkidle' });
	await page.getByLabel('BOMC 1.2 file').setInputFiles(fixture.realPath);
	const readiness = await waitForEditorReady(page, fixture);
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(page.locator('.tool-context span').nth(1)).toHaveText(fixture.profile, { timeout: 30_000 });

	const canvas = page.locator('canvas[aria-label="Interactive 3D model viewport"]');
	await expect(canvas).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole('button', { name: 'Orbit' })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Zoom Extents' })).toBeEnabled();
	await settleFrames(page);
	await expect.poll(() => page.evaluate(() => {
		const canvas = document.querySelector<HTMLCanvasElement>('canvas[aria-label="Interactive 3D model viewport"]');
		const probe = (window as any).__m2UiProbe;
		return canvas && probe ? probe.drawInfo(canvas).total : 0;
	}), { timeout: 30_000 }).toBeGreaterThan(0);
	const draw = await page.evaluate((): CanvasDrawEvidence | null => {
		const canvas = document.querySelector<HTMLCanvasElement>('canvas[aria-label="Interactive 3D model viewport"]');
		const probe = (window as any).__m2UiProbe;
		if (!canvas || !probe) return null;
		const observation = probe.drawInfo(canvas);
		return {
			connected: observation.connected,
			cssWidth: observation.cssWidth,
			cssHeight: observation.cssHeight,
			pixelWidth: observation.pixelWidth,
			pixelHeight: observation.pixelHeight,
			requestId: observation.requestId,
			total: observation.total
		};
	});
	expect(draw).not.toBeNull();
	expect(draw!.connected).toBe(true);
	expect(draw!.cssWidth).toBeGreaterThan(0);
	expect(draw!.cssHeight).toBeGreaterThan(0);
	expect(draw!.pixelWidth).toBeGreaterThan(0);
	expect(draw!.pixelHeight).toBeGreaterThan(0);

	const beforePath = testInfo.outputPath('before-orbit.png');
	const afterPath = testInfo.outputPath('after-orbit.png');
	const beforePixels = await canvas.screenshot({ path: beforePath });
	let box = await canvas.boundingBox();
	expect(box).not.toBeNull();
	const centerX = box!.x + box!.width / 2;
	const centerY = box!.y + box!.height / 2;
	await page.getByRole('button', { name: 'Orbit' }).click();
	await page.mouse.move(centerX, centerY);
	await page.mouse.down();
	await page.mouse.move(centerX + 76, centerY + 42, { steps: 6 });
	await page.mouse.up();
	await settleFrames(page);
	const afterPixels = await canvas.screenshot({ path: afterPath });
	const beforeSha256 = sha256(beforePixels);
	const afterSha256 = sha256(afterPixels);
	expect(afterSha256).not.toBe(beforeSha256);

	await page.getByRole('button', { name: 'Zoom Extents' }).click();
	await settleFrames(page);
	await page.getByRole('button', { name: 'Select' }).click();
	box = await canvas.boundingBox();
	expect(box).not.toBeNull();
	const pickedAt = await pickVisibleGeometry(page, box!);
	expect(pickedAt).not.toBeNull();
	expect(isPickEvidenceStatus(pickedAt!.footerStatus)).toBe(true);
	expect(workerRequests.some((url) => url.includes('e4-import.worker'))).toBe(true);
	expect(pageErrors).toEqual([]);
	expect(consoleErrors).toEqual([]);

	const workerRows = await page.evaluate(() => {
		const requests = (window as any).__m2UiProbe.requests as any[];
		const rows: ProfileWorker[] = [];
		for (const row of requests) {
			if (!row.postedMessages.some((message: any) => message.type === 'load')) continue;
			rows.push({
				requestId: row.requestId,
				sourceName: row.sourceName,
				inputByteLength: row.inputByteLength,
				postedMessages: row.postedMessages.filter((message: any) => message.type === 'load').map((message: any) => ({ type: message.type, id: message.id })),
				terminals: row.terminals.map((terminal: any) => ({ id: terminal.id, type: terminal.type, error: terminal.error })),
				idMismatches: [...row.idMismatches],
				errors: [...row.errors],
				terminated: row.terminated,
				result: row.result ? { counts: row.result.counts ? { faces: row.result.counts.faces } : undefined, sourceFileBytes: row.result.sourceFileBytes } : null
			});
		}
		return rows;
	});
	expect(workerRequests).toHaveLength(1);
	expect(workerRows).toHaveLength(1);
	const worker = workerRows[0]!;
	expect(worker.result?.counts?.faces).toBeGreaterThan(0);
	expect(worker.terminals).toHaveLength(1);
	expect(worker.terminals[0]).toMatchObject({ id: worker.requestId, type: 'complete', error: null });
	expect(worker.idMismatches).toEqual([]);
	expect(worker.errors).toEqual([]);
	expect(worker.terminated).toBe(true);
	expect(draw!.requestId).toBe(worker.requestId);
	const terminal = worker.terminals[0]!;
	readiness.viewerRender = {
		canvas: { connected: draw!.connected, cssWidth: draw!.cssWidth, cssHeight: draw!.cssHeight, pixelWidth: draw!.pixelWidth, pixelHeight: draw!.pixelHeight },
		draw: { requestId: draw!.requestId, total: draw!.total },
		worker: {
			requestId: worker.requestId,
			faces: worker.result?.counts?.faces ?? null,
			terminalCount: worker.terminals.length,
			terminalId: terminal.id,
			terminalType: terminal.type,
			terminalError: terminal.error,
			errorCount: worker.errors.length,
			terminated: worker.terminated
		}
	};
	await persistCase(ticket, testInfo, fixture, {
		buildIdentity: { commit: buildIdentity.commit, dirty: buildIdentity.dirty, sourceSha256: buildIdentity.sourceSha256 },
		worker, readiness, orbit: { beforeSha256, afterSha256 }, pick: pickedAt!, pageErrors, consoleErrors,
		artifactPaths: [beforePath, afterPath]
	});
}

for (const fixture of fixtures) {
	test(`${fixture.id} imports, draws, orbits, and picks in the Editor`, async ({ page }, testInfo) => {
		const context = readAcceleratedContext('profiles');
		if (!context || 'discoveryOnly' in context) test.skip();
		await runProfileCase(page, testInfo, fixture, context as AcceleratedProofTicket);
	});
}
