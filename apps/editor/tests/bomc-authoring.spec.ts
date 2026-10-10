import { expect, test, type Download, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PerspectiveCamera, Vector3 } from 'three';
import type { BomcGraph } from '@sibambo/bomc-document';
import { readWebBomc } from '@sibambo/bomc-document/reader';
import type { AuthoringCommand } from '../src/lib/authoring/protocol';
import { cameraPresetPose, uprightCameraUp } from '../../../packages/viewport/src/camera-navigation';
import { SIBAMBO_CAMERA_DEFAULTS } from '../../../packages/viewport/src/renderer-defaults';
import { verifyDownloadedAuthoringBomc, type AuthoringInteropReport } from '../../../tooling/testing/authoring-interop';
import { BOMC_PROFILE_FIXTURE_PINS, resolveBomcProfileFixture } from '../../../tooling/testing/bomc-profile-fixtures';
import { buildAuthoringFaultFixtures, buildNonflatKernelBwebFixture, type AuthoringFaultFixture } from './helpers/authoring-fixtures';
import { installAuthoringWorkerProbe, type AuthoringWorkerProbe, type AuthoringWorkerReplyObservation } from './helpers/authoring-worker-probe';

type WorkerReply = Record<string, any>;
type AuthoringWriteReply = Extract<AuthoringWorkerReplyObservation, { event: 'RESULT'; requestType: 'WRITE' }>;

function isSavedWriteReply(reply: AuthoringWorkerReplyObservation, savedHash: string): reply is AuthoringWriteReply {
	return reply.event === 'RESULT' && reply.requestType === 'WRITE' && reply.result.sha256 === savedHash;
}

async function probe(page: Page) {
	return page.evaluate(() => window.__editorAuthoringWorkerProbe as AuthoringWorkerProbe);
}

function latestAuthoringWorker(observation: AuthoringWorkerProbe) {
	const matches = observation.workers.filter((worker) => worker.replies.some((reply) => reply.protocolVersion === 'sibambo-editor-authoring-1'));
	const current = matches.filter((worker) => worker.terminated === 0).at(-1) ?? matches.at(-1);
	if (!current) throw new Error('No production authoring worker was observed.');
	return current;
}

async function currentCheckpoint(page: Page) {
	return (await currentAuthoringResult(page)).checkpoint;
}

async function currentAuthoringResult(page: Page): Promise<WorkerReply> {
	const observation = await probe(page);
	const worker = observation.workers.filter((candidate) => candidate.terminated === 0
		&& candidate.replies.some((reply) => reply.event === 'RESULT' && reply.result?.checkpoint)).at(-1);
	if (!worker) throw new Error('The active production authoring worker has no acknowledged canonical checkpoint.');
	const replies = worker.replies.filter((reply) => reply.event === 'RESULT' && reply.protocolVersion === 'sibambo-editor-authoring-1') as WorkerReply[];
	const latest = replies.at(-1);
	if (!latest?.result?.checkpoint) throw new Error('The active authoring worker has no acknowledged canonical checkpoint.');
	return latest.result;
}

async function currentAuthoringEvidence(page: Page) {
	const observation = await probe(page);
	const worker = latestAuthoringWorker(observation);
	const result = await currentAuthoringResult(page);
	const usefulRequests = worker.requests.filter((request) => ['CREATE', 'OPEN', 'RESTORE_CHECKPOINT', 'COMMAND', 'UNDO', 'REDO', 'WRITE', 'ACK_DOWNLOAD', 'CLOSE'].includes(String(request.type)));
	const usefulReplies = worker.replies.filter((reply) => reply.protocolVersion === 'sibambo-editor-authoring-1').map((reply) => {
		const payload = reply.event === 'RESULT' ? reply.result as WorkerReply : undefined;
		const checkpoint = payload?.checkpoint;
		const written = payload?.kind === 'write' ? payload : undefined;
		return {
			event: reply.event,
			sessionId: reply.sessionId,
			requestId: reply.requestId,
			requestType: reply.requestType ?? null,
			resultKind: payload?.kind ?? null,
			dirty: payload?.dirty ?? null,
			canUndo: payload?.canUndo ?? null,
			canRedo: payload?.canRedo ?? null,
			revision: checkpoint?.snapshot?.revision ?? written?.revision ?? null,
			sequence: checkpoint?.sequence ?? null,
			writeId: written?.writeId ?? null,
			sha256: written?.sha256 ?? null,
			length: written?.length ?? null,
			error: reply.event === 'ERROR' ? reply.error ?? null : null
		};
	});
	return {
		title: await page.title(),
		footerStatus: await page.locator('.footer-status').innerText().catch(() => ''),
		toolContext: await page.locator('.tool-context').innerText().catch(() => ''),
		worker: { url: worker.url, terminated: worker.terminated, requests: usefulRequests, replies: usefulReplies },
		result
	};
}

async function verifyInterop(
	testInfo: TestInfo,
	variant: string,
	downloadPath: string,
	write: Awaited<ReturnType<typeof saveBomc>>,
	beforeSave: Awaited<ReturnType<typeof currentAuthoringEvidence>>,
	afterSave: Awaited<ReturnType<typeof currentAuthoringEvidence>>,
	actualReopen?: unknown
): Promise<AuthoringInteropReport> {
	const executionRoot = process.env.SIBAMBO_ACCELERATED_RUN_ROOT;
	if (!executionRoot) throw new Error('The authoring UI runner must provide SIBAMBO_ACCELERATED_RUN_ROOT.');
	const before = beforeSave.result.checkpoint;
	if (!before?.snapshot?.graph) throw new Error('The pre-save browser observation has no acknowledged canonical graph.');
	const checkpoint = afterSave.result.checkpoint;
	if (!checkpoint?.snapshot?.graph) throw new Error('The post-ACK browser observation has no canonical graph.');
	expect(beforeSave.result.dirty).toBe(true);
	expect(before.snapshot.revision).toBe(write.workerWrite.result.revision);
	expect(before.snapshot.graph).toStrictEqual(checkpoint.snapshot.graph);
	expect(checkpoint.snapshot.revision).toBe(before.snapshot.revision);
	expect(afterSave.result.checkpoint.history.undo).toStrictEqual(beforeSave.result.checkpoint.history.undo);
	expect(afterSave.result.checkpoint.history.redo).toStrictEqual(beforeSave.result.checkpoint.history.redo);
	expect(afterSave.result.dirty).toBe(false);
	expect(checkpoint.history.savedGraph).toStrictEqual(checkpoint.snapshot.graph);
	const ack = afterSave.worker.requests.find((request) => request.type === 'ACK_DOWNLOAD'
		&& (request.data as WorkerReply | undefined)?.writeId === write.workerWrite.result.writeId
		&& request.expectedRevision === write.workerWrite.result.revision);
	expect(ack, 'actual browser worker must receive the matching download ACK').toBeTruthy();
	expect(afterSave.worker.replies.some((reply) => reply.event === 'RESULT' && reply.requestType === 'ACK_DOWNLOAD'
		&& reply.sessionId === ack?.sessionId && reply.requestId === ack?.requestId && reply.revision === write.workerWrite.result.revision)).toBe(true);
	const report = await verifyDownloadedAuthoringBomc({
		downloadPath,
		expectedGraph: checkpoint.snapshot.graph,
		variant,
		executionRoot,
		authoringState: { beforeSave, afterSave, actualReopen, download: { sha256: write.sha256, bytes: write.bytes.byteLength, workerWrite: write.workerWrite.result } }
	});
	expect(report.input.sha256).toBe(write.sha256);
	expect(report.input.bytes).toBe(write.bytes.byteLength);
	await testInfo.attach(`authoring-interop-${variant}`, { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
	expect(report.status, `all frozen reader closures and the Ruby oracle must accept ${variant}`).toBe('passed');
	return report;
}

async function openFileMenu(page: Page) {
	await openMenu(page, 0);
}

async function openMenu(page: Page, index: number) {
	const menu = page.locator('.editor-menubar details.menu-root').nth(index);
	if (!(await menu.evaluate((element) => (element as HTMLDetailsElement).open))) await menu.locator('summary').click();
}

async function closeMenu(page: Page, index: number) {
	const menu = page.locator('.editor-menubar details.menu-root').nth(index);
	if (await menu.evaluate((element) => (element as HTMLDetailsElement).open)) await menu.locator('summary').click();
}

async function saveBomc(page: Page, target: string): Promise<{ download: Download; bytes: Buffer; sha256: string; workerWrite: WorkerReply }> {
	await openFileMenu(page);
	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: /Save BOMC/ }).click();
	const download = await downloadPromise;
	await download.saveAs(target);
	const bytes = await readFile(target);
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	await expect.poll(async () => {
		const next = await probe(page);
		return next.workers.some((worker) => worker.terminated === 0 && worker.replies.some((reply) =>
			reply.event === 'RESULT' && reply.requestType === 'WRITE' && reply.result?.sha256 === sha256 && reply.result?.length === bytes.byteLength));
	}).toBe(true);
	const after = await probe(page);
	const matchingWorker = [...after.workers].reverse().find((worker) => worker.terminated === 0 && worker.replies.some((reply) =>
		reply.event === 'RESULT' && reply.requestType === 'WRITE' && reply.result?.sha256 === sha256 && reply.result?.length === bytes.byteLength));
	if (!matchingWorker) throw new Error(`Downloaded BOMC (${bytes.byteLength} bytes, ${sha256}) did not match a live production worker WRITE result.`);
	const writes = matchingWorker.replies.filter((reply) => reply.event === 'RESULT' && reply.requestType === 'WRITE');
	const workerWrite = writes.find((reply) => reply.result?.sha256 === sha256 && reply.result?.length === bytes.byteLength);
	if (!workerWrite) throw new Error(`Downloaded BOMC (${bytes.byteLength} bytes, ${sha256}) did not match a production worker WRITE result.`);
	await expect.poll(async () => {
		const next = await probe(page);
		const worker = next.workers.find((candidate) => candidate.terminated === 0 && candidate.replies.some((reply) =>
			reply.event === 'RESULT' && reply.requestType === 'WRITE' && reply.result?.sha256 === sha256 && reply.result?.length === bytes.byteLength));
		return worker?.requests.some((request) => request.type === 'ACK_DOWNLOAD' && request.data?.writeId === workerWrite.result.writeId && request.expectedRevision === workerWrite.result.revision) ?? false;
	}).toBe(true);
	const acknowledgedObservation = await probe(page);
	const acknowledgedWorker = acknowledgedObservation.workers.find((candidate) => candidate.terminated === 0 && candidate.replies.some((reply) =>
		reply.event === 'RESULT' && reply.requestType === 'WRITE' && reply.result?.sha256 === sha256 && reply.result?.length === bytes.byteLength));
	if (!acknowledgedWorker) throw new Error('The worker that produced the matching WRITE result is no longer active before ACK verification.');
	const ackRequest = acknowledgedWorker.requests.find((request) => request.type === 'ACK_DOWNLOAD'
		&& request.data?.writeId === workerWrite.result.writeId
		&& request.expectedRevision === workerWrite.result.revision);
	if (!ackRequest) throw new Error('The matching production worker download ACK request was not observed.');
	await expect.poll(async () => latestAuthoringWorker(await probe(page)).replies.some((reply) =>
		reply.event === 'RESULT'
		&& reply.requestType === 'ACK_DOWNLOAD'
		&& reply.sessionId === ackRequest.sessionId
		&& reply.requestId === ackRequest.requestId
		&& reply.result?.checkpoint?.snapshot?.revision === workerWrite.result.revision
		&& reply.result?.dirty === false)).toBe(true);
	await expect(page.locator('.footer-status')).toContainText('Saved BOMC');
	await expect(page.getByRole('button', { name: /Save BOMC/ })).toBeEnabled();
	return { download, bytes, sha256, workerWrite };
}

async function createNew(page: Page) {
	const emptyAction = page.locator('.empty-workspace').getByRole('button', { name: 'New BOMC' });
	if (await emptyAction.isVisible().catch(() => false)) await emptyAction.click();
	else {
		await openFileMenu(page);
		await page.getByRole('button', { name: /^New/ }).click();
	}
	await expect(page.getByText('Writable BOMC', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.footer-status')).toContainText('Unsaved BOMC');
}

async function authoringCommands(page: Page): Promise<AuthoringCommand[]> {
	return page.evaluate(() => {
		const observation = window.__editorAuthoringWorkerProbe as AuthoringWorkerProbe;
		return observation.workers.flatMap((worker) => worker.requests)
			.filter((request) => request.protocolVersion === 'sibambo-editor-authoring-1' && request.type === 'COMMAND')
			.map((request) => request.data as AuthoringCommand);
	});
}

async function drawRectangle(page: Page, cellX: number, cellY: number, cellWidth: number, cellHeight: number) {
	const canvas = page.locator('.viewport canvas');
	const box = await canvas.boundingBox();
	if (!box) throw new Error('The production viewport canvas has no browser layout box.');
	const before = (await authoringCommands(page)).filter((command) => command.kind === 'CREATE_RECTANGLE').length;
	await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
	await page.mouse.click(box.x + box.width * cellX, box.y + box.height * cellY);
	await page.mouse.click(box.x + box.width * (cellX + cellWidth), box.y + box.height * (cellY + cellHeight));
	await expect.poll(async () => (await authoringCommands(page)).filter((command) => command.kind === 'CREATE_RECTANGLE').length, { timeout: 15_000 }).toBe(before + 1);
}

async function ensureTopView(page: Page) {
	await openMenu(page, 3);
	await page.getByRole('button', { name: 'Top', exact: true }).click();
	await closeMenu(page, 3);
	await expect(page.locator('.viewport canvas')).toBeVisible();
}

async function selectCanvasPoint(page: Page, xRatio: number, yRatio: number) {
	const box = await page.locator('.viewport canvas').boundingBox();
	if (!box) throw new Error('The production viewport canvas has no browser layout box.');
	await page.getByRole('button', { name: 'Select', exact: true }).click();
	await page.mouse.click(box.x + box.width * xRatio, box.y + box.height * yRatio);
}

function rectangleEntityId(graph: BomcGraph, sequence: number) {
	const entityId = `${graph.documentId}:rectangle:${sequence}`;
	const mesh = graph.meshes[0];
	if (!mesh?.faces.some((face) => {
		try {
			const label = JSON.parse(face.label ?? 'null');
			return label[0] === 'sibambo-editor-shape-v1' && label[1] === 'rectangle' && label[2] === entityId;
		} catch { return false; }
	})) throw new Error(`Canonical graph does not contain expected authored rectangle ${entityId}.`);
	return entityId;
}

function authoredRectangleEntityIds(graph: BomcGraph): string[] {
	const ids = new Set<string>();
	for (const mesh of graph.meshes) {
		for (const face of mesh.faces) {
			try {
				const label = JSON.parse(face.label ?? 'null');
				if (label[0] === 'sibambo-editor-shape-v1' && label[1] === 'rectangle' && typeof label[2] === 'string') ids.add(label[2]);
			} catch { /* non-authoring labels are outside this helper */ }
		}
	}
	return [...ids];
}

async function selectProjectedRectangle(page: Page, graph: BomcGraph, entityId: string) {
	const mesh = graph.meshes[0];
	if (!mesh) throw new Error('The actual reopened canonical graph has no root mesh.');
	const face = mesh.faces.find((candidate) => {
		try {
			const label = JSON.parse(candidate.label ?? 'null');
			return label[0] === 'sibambo-editor-shape-v1' && label[1] === 'rectangle' && label[2] === entityId;
		} catch { return false; }
	});
	if (!face || face.outer.length < 3) throw new Error(`The actual reopened canonical graph has no rectangle face for ${entityId}.`);
	const center = [0, 1, 2].map((axis) => face.outer.reduce((sum, vertex) => sum + mesh.positions[vertex * 3 + axis]!, 0) / face.outer.length) as [number, number, number];
	const bounds = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
	for (let offset = 0; offset < mesh.positions.length; offset += 3) {
		const [x, y, z] = mesh.positions.slice(offset, offset + 3);
		bounds.min.x = Math.min(bounds.min.x, x!); bounds.max.x = Math.max(bounds.max.x, x!);
		bounds.min.y = Math.min(bounds.min.y, y!); bounds.max.y = Math.max(bounds.max.y, y!);
		bounds.min.z = Math.min(bounds.min.z, z!); bounds.max.z = Math.max(bounds.max.z, z!);
	}
	const box = await page.locator('.viewport canvas').boundingBox();
	if (!box) throw new Error('The production viewport canvas has no browser layout box.');
	const pose = cameraPresetPose(bounds, 'top');
	const camera = new PerspectiveCamera(SIBAMBO_CAMERA_DEFAULTS.fov, box.width / box.height, SIBAMBO_CAMERA_DEFAULTS.near, SIBAMBO_CAMERA_DEFAULTS.far);
	camera.position.copy(pose.position);
	camera.up.copy(uprightCameraUp(pose));
	camera.lookAt(pose.target);
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld(true);
	const projected = new Vector3(...center).project(camera);
	if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || Math.abs(projected.x) >= 1 || Math.abs(projected.y) >= 1) {
		throw new Error(`Projected canonical rectangle ${entityId} is outside the fitted top view.`);
	}
	await page.getByRole('button', { name: 'Select', exact: true }).click();
	await page.mouse.click(box.x + (projected.x + 1) * box.width / 2, box.y + (1 - projected.y) * box.height / 2);
}

async function uploadBytes(page: Page, bytes: Uint8Array, name: string) {
	const input = page.locator('input[accept=".bomc,application/octet-stream"]');
	await input.setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
}

async function uploadPinnedS2(page: Page) {
	const pin = BOMC_PROFILE_FIXTURE_PINS.find((candidate) => candidate.id === 'PROJECT SBOOST 2:EXACT');
	if (!pin) throw new Error('The immutable S2-current EXACT fixture pin is absent.');
	const fixture = resolveBomcProfileFixture(pin);
	await page.locator('input[accept=".bomc,application/octet-stream"]').setInputFiles(fixture.realPath);
}

test.describe('canonical BOMC authoring through the real Editor page', () => {
	test.beforeEach(async ({ page }) => {
		await installAuthoringWorkerProbe(page);
		await page.goto('/?renderer=webgl2');
		await expect(page.locator('main[data-app="editor"]')).toHaveAttribute('data-editor-ready', 'true');
	});

	test('New downloads canonical bytes, reopens those bytes, then edits and downloads again', async ({ page }, testInfo) => {
		test.setTimeout(180_000);
		await createNew(page);
		const emptyPath = testInfo.outputPath('empty-authored.bomc');
		const emptyBeforeSave = await currentAuthoringEvidence(page);
		const emptyWrite = await saveBomc(page, emptyPath);
		const emptyDocument = await readWebBomc(new Uint8Array(emptyWrite.bytes));
		const emptySnapshot = emptyDocument.snapshot();
		expect(emptyWrite.bytes.byteLength).toBe(emptyWrite.workerWrite.result.length);
		expect(emptyWrite.sha256).toBe(emptyWrite.workerWrite.result.sha256);
		expect(emptySnapshot.graph.meshes).toEqual([]);
		expect(emptySnapshot.graph.materials).toEqual([]);
		expect(latestAuthoringWorker(await probe(page)).requests.some((request) => request.type === 'ACK_DOWNLOAD')).toBe(true);
		emptyDocument.dispose();
		await expect(page.locator('.footer-status')).toContainText('Saved BOMC');
		const emptyAfterSave = await currentAuthoringEvidence(page);

		await openFileMenu(page);
		await page.getByRole('button', { name: 'Close Model' }).click();
		await expect(page.locator('.empty-workspace')).toBeVisible();
		await uploadBytes(page, emptyWrite.bytes, 'empty-authored.bomc');
		await expect(page.getByText('Writable BOMC', { exact: true }).first()).toBeVisible({ timeout: 180_000 });
		const reopened = await currentCheckpoint(page);
		const reopenedEvidence = await currentAuthoringEvidence(page);
		expect(reopened.snapshot.graph.meshes).toEqual([]);
		expect(reopened.history.undo).toEqual([]);
		expect(reopened.history.redo).toEqual([]);
		expect(reopened.history.savedGraph).toStrictEqual(reopened.snapshot.graph);
		expect(reopenedEvidence.result.dirty).toBe(false);
		await verifyInterop(testInfo, 'empty-new', emptyPath, emptyWrite, emptyBeforeSave, emptyAfterSave, reopenedEvidence);
		await ensureTopView(page);
		await drawRectangle(page, 0.42, 0.42, 0.12, 0.11);
		await expect(page.locator('.footer-status')).toContainText('Unsaved BOMC');

		const followupPath = testInfo.outputPath('reopened-edited-authored.bomc');
		const followupBeforeSave = await currentAuthoringEvidence(page);
		const followup = await saveBomc(page, followupPath);
		const expected = await currentAuthoringEvidence(page);
		const restored = await readWebBomc(new Uint8Array(followup.bytes));
		try {
			expect(restored.snapshot().graph).toStrictEqual(expected.result.checkpoint.snapshot.graph);
			expect(followup.sha256).toBe(followup.workerWrite.result.sha256);
			expect(followup.bytes.byteLength).toBe(followup.workerWrite.result.length);
		} finally { restored.dispose(); }
		await expect(page.locator('.footer-status')).toContainText('Saved BOMC');
		await openFileMenu(page);
		await page.getByRole('button', { name: 'Close Model' }).click();
		await expect(page.locator('.empty-workspace')).toBeVisible();
		await uploadBytes(page, followup.bytes, 'reopened-edited-authored.bomc');
		await expect(page.getByText('Writable BOMC', { exact: true }).first()).toBeVisible({ timeout: 180_000 });
		const followupReopen = await currentAuthoringEvidence(page);
		expect(followupReopen.result.checkpoint.snapshot.graph).toStrictEqual(expected.result.checkpoint.snapshot.graph);
		expect(followupReopen.result.dirty).toBe(false);
		expect(followupReopen.result.checkpoint.history.undo).toEqual([]);
		expect(followupReopen.result.checkpoint.history.redo).toEqual([]);
		await verifyInterop(testInfo, 'reopened-edited', followupPath, followup, followupBeforeSave, expected, { sourceReopen: reopenedEvidence, downloadReopen: followupReopen });
	});

	test('failed download dispatch preserves the dirty checkpoint and allows a fresh save', async ({ page }, testInfo) => {
		test.setTimeout(90_000);
		await createNew(page);
		await ensureTopView(page);
		await drawRectangle(page, 0.38, 0.40, 0.12, 0.11);
		const beforeFailure = await currentAuthoringResult(page);
		await page.evaluate(() => {
			const prototype = HTMLAnchorElement.prototype as HTMLAnchorElement & { __originalClick?: HTMLAnchorElement['click'] };
			prototype.__originalClick = prototype.click;
			HTMLAnchorElement.prototype.click = function () {
				if (this.download.endsWith('.bomc')) throw new Error('Simulated BOMC download dispatch failure.');
				return prototype.__originalClick!.call(this);
			};
		});

		await openFileMenu(page);
		await page.getByRole('button', { name: /Save BOMC/ }).click();
		await expect(page.locator('.menu-status.menu-error').getByText('Simulated BOMC download dispatch failure.', { exact: true })).toBeVisible();
		await expect(page.locator('.footer-status')).toContainText('Unsaved BOMC');
		await expect(page.getByRole('button', { name: /Save BOMC/ })).toBeEnabled();
		const afterFailure = await currentAuthoringResult(page);
		expect(afterFailure.checkpoint.snapshot.graph).toStrictEqual(beforeFailure.checkpoint.snapshot.graph);
		expect(afterFailure.checkpoint.snapshot.revision).toBe(beforeFailure.checkpoint.snapshot.revision);
		expect(afterFailure.checkpoint.snapshot.tokens).toStrictEqual(Object.fromEntries(
			Object.keys(beforeFailure.checkpoint.snapshot.tokens).map((key) => [key, beforeFailure.checkpoint.snapshot.revision])
		));
		expect(afterFailure.checkpoint.sequence).toBe(beforeFailure.checkpoint.sequence);
		expect(afterFailure.checkpoint.history).toStrictEqual(beforeFailure.checkpoint.history);
		expect(afterFailure.dirty).toBe(true);
		const failedWorker = latestAuthoringWorker(await probe(page));
		expect(failedWorker.requests.some((request) => request.type === 'ACK_DOWNLOAD')).toBe(false);
		expect(failedWorker.requests.some((request) => request.type === 'RESTORE_CHECKPOINT')).toBe(true);

		await page.evaluate(() => {
			const prototype = HTMLAnchorElement.prototype as HTMLAnchorElement & { __originalClick?: HTMLAnchorElement['click'] };
			if (!prototype.__originalClick) throw new Error('The original browser download dispatch method was not retained.');
			HTMLAnchorElement.prototype.click = prototype.__originalClick;
			delete prototype.__originalClick;
		});
		const saved = await saveBomc(page, testInfo.outputPath('retry-after-download-dispatch-failure.bomc'));
		const reopened = await readWebBomc(new Uint8Array(saved.bytes));
		try { expect(reopened.snapshot().graph).toStrictEqual(beforeFailure.checkpoint.snapshot.graph); }
		finally { reopened.dispose(); }
		expect((await currentAuthoringResult(page)).dirty).toBe(false);
	});

	test('draws lexical IDs through ten, signed extrusion, history, camera and style without editing on navigation', async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		await createNew(page);
		await ensureTopView(page);
		const canvas = page.locator('.viewport canvas');
		const blankPixels = await canvas.screenshot();
		const grid = [
			[0.13, 0.20], [0.33, 0.20], [0.53, 0.20], [0.73, 0.20],
			[0.13, 0.43], [0.33, 0.43], [0.53, 0.43], [0.73, 0.43],
			[0.13, 0.66], [0.33, 0.66], [0.53, 0.66], [0.73, 0.66]
		] as const;
		for (const [x, y] of grid) await drawRectangle(page, x, y, 0.055, 0.045);
		const commandsBeforeExtrusion = await authoringCommands(page);
		const createCommands = commandsBeforeExtrusion.filter((command) => command.kind === 'CREATE_RECTANGLE');
		expect(createCommands).toHaveLength(12);
		const acknowledged = await currentCheckpoint(page);
		expect(acknowledged.snapshot.graph.meshes[0].faces.reduce((sum: number, face: { triangles: number[] }) => sum + face.triangles.length / 3, 0)).toBeGreaterThan(0);
		const entities = acknowledged.snapshot.graph.meshes.flatMap((mesh: { faces: Array<{ label: string | null }> }) => mesh.faces.map((face) => {
			try { return JSON.parse(face.label ?? 'null')?.[2] as string | undefined; } catch { return undefined; }
		})).filter(Boolean) as string[];
		expect(entities.some((id) => id.endsWith(':rectangle:9'))).toBe(true);
		expect(entities.some((id) => id.endsWith(':rectangle:10'))).toBe(true);
		expect(acknowledged.snapshot.graph.meshes[0].positions.some((value: number) => !Object.is(value, Math.fround(value)))).toBe(true);
		const drawnPixels = await canvas.screenshot();
		expect(drawnPixels.equals(blankPixels)).toBe(false);
		const revisionBeforeNavigation = acknowledged.snapshot.revision;

		const planarPath = testInfo.outputPath('twelve-rectangles-planar.bomc');
		const planarBeforeSave = await currentAuthoringEvidence(page);
		const planar = await saveBomc(page, planarPath);
		const planarAfterSave = await currentAuthoringEvidence(page);
		await openFileMenu(page);
		await page.getByRole('button', { name: 'Close Model' }).click();
		await expect(page.locator('.empty-workspace')).toBeVisible();
		await uploadBytes(page, planar.bytes, 'twelve-rectangles-planar-reopen.bomc');
		await expect(page.getByText('Writable BOMC', { exact: true }).first()).toBeVisible({ timeout: 180_000 });
		const planarReopen = await currentAuthoringEvidence(page);
		expect(planarReopen.result.checkpoint.snapshot.graph).toStrictEqual(planarAfterSave.result.checkpoint.snapshot.graph);
		expect(planarReopen.result.dirty).toBe(false);
		expect(planarReopen.result.checkpoint.history.savedGraph).toStrictEqual(planarReopen.result.checkpoint.snapshot.graph);
		expect(planarReopen.result.checkpoint.history.undo).toEqual([]);
		expect(planarReopen.result.checkpoint.history.redo).toEqual([]);
		await verifyInterop(testInfo, 'twelve-rectangles-planar', planarPath, planar, planarBeforeSave, planarAfterSave, planarReopen);

		const planarGraph = planarReopen.result.checkpoint.snapshot.graph as BomcGraph;
		const firstEntityId = rectangleEntityId(planarGraph, 1);
		const secondEntityId = rectangleEntityId(planarGraph, 2);
		await ensureTopView(page);
		await selectProjectedRectangle(page, planarGraph, firstEntityId);
		await page.getByRole('button', { name: 'Push/Pull', exact: true }).click();
		await page.getByLabel('Extrusion (m)').fill('2.7');
		await page.getByRole('button', { name: 'Commit', exact: true }).click();
		await expect.poll(async () => (await authoringCommands(page)).filter((command) => command.kind === 'EXTRUDE_RECTANGLE').length).toBe(1);
		const firstExtrusion = (await authoringCommands(page)).filter((command) => command.kind === 'EXTRUDE_RECTANGLE')[0]!;
		expect(firstExtrusion).toMatchObject({ entityId: firstEntityId, distance: 2.7 });

		await selectProjectedRectangle(page, planarGraph, secondEntityId);
		await page.getByRole('button', { name: 'Push/Pull', exact: true }).click();
		await page.getByLabel('Extrusion (m)').fill('-2.7');
		await page.getByRole('button', { name: 'Commit', exact: true }).click();
		await expect.poll(async () => (await authoringCommands(page)).filter((command) => command.kind === 'EXTRUDE_RECTANGLE').length).toBe(2);
		const extrudedCommands = (await authoringCommands(page)).filter((command) => command.kind === 'EXTRUDE_RECTANGLE');
		expect(extrudedCommands[1]).toMatchObject({ entityId: secondEntityId, distance: -2.7 });

		await page.keyboard.press('Control+z');
		await expect.poll(async () => latestAuthoringWorker(await probe(page)).requests.filter((request) => request.type === 'UNDO').length).toBe(1);
		await page.keyboard.press('Control+Shift+z');
		await expect.poll(async () => latestAuthoringWorker(await probe(page)).requests.filter((request) => request.type === 'REDO').length).toBe(1);
		const editedRevision = (await currentCheckpoint(page)).snapshot.revision;
		expect(editedRevision).toBeGreaterThan(revisionBeforeNavigation);

		const navigationShots: Buffer[] = [];
		const cameraTool = page.getByRole('button', { name: 'Orbit', exact: true });
		await cameraTool.click();
		let bounds = await canvas.boundingBox();
		if (!bounds) throw new Error('Viewport canvas layout is unavailable.');
		await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
		await page.mouse.down();
		await page.mouse.move(bounds.x + bounds.width * 0.57, bounds.y + bounds.height * 0.46, { steps: 8 });
		await page.mouse.up();
		navigationShots.push(await canvas.screenshot());
		await page.getByRole('button', { name: 'Pan', exact: true }).click();
		bounds = (await canvas.boundingBox())!;
		await page.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * 0.50);
		await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * 0.51, bounds.y + bounds.height * 0.53, { steps: 6 }); await page.mouse.up();
		navigationShots.push(await canvas.screenshot());
		await page.getByRole('button', { name: 'Zoom', exact: true }).click();
		bounds = (await canvas.boundingBox())!;
		await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
		await page.mouse.wheel(0, -240);
		navigationShots.push(await canvas.screenshot());
		for (const view of ['Top', 'Front', 'Iso'] as const) {
			await openMenu(page, 3);
			await page.getByRole('button', { name: view, exact: true }).click();
			navigationShots.push(await canvas.screenshot());
		}
		await closeMenu(page, 3);
		await page.getByRole('button', { name: 'Zoom Extents', exact: true }).click();
		navigationShots.push(await canvas.screenshot());
		await openMenu(page, 2);
		await page.getByLabel('Face Style').selectOption('wireframe');
		navigationShots.push(await canvas.screenshot());
		await page.getByLabel('Face Style').selectOption('shaded');
		await closeMenu(page, 2);
		await expect.poll(async () => (await currentCheckpoint(page)).snapshot.revision).toBe(editedRevision);
		const commandCountAfterNavigation = (await authoringCommands(page)).length;
		expect(commandCountAfterNavigation).toBe(commandsBeforeExtrusion.length + 2);
		for (const shot of navigationShots) expect(shot.equals(drawnPixels)).toBe(false);

		const outputPath = testInfo.outputPath('twelve-rectangles-signed-extrusions.bomc');
		const signedBeforeSave = await currentAuthoringEvidence(page);
		const saved = await saveBomc(page, outputPath);
		const expected = await currentAuthoringEvidence(page);
		const restored = await readWebBomc(new Uint8Array(saved.bytes));
		try {
			expect(restored.snapshot().graph).toStrictEqual(expected.result.checkpoint.snapshot.graph);
			expect(saved.sha256).toBe(saved.workerWrite.result.sha256);
		} finally { restored.dispose(); }
		await openFileMenu(page);
		await page.getByRole('button', { name: 'Close Model' }).click();
		await expect(page.locator('.empty-workspace')).toBeVisible();
		await uploadBytes(page, saved.bytes, 'twelve-rectangles-signed-history-reopen.bomc');
		await expect(page.getByText('Writable BOMC', { exact: true }).first()).toBeVisible({ timeout: 180_000 });
		const signedReopen = await currentAuthoringEvidence(page);
		expect(signedReopen.result.checkpoint.snapshot.graph).toStrictEqual(expected.result.checkpoint.snapshot.graph);
		expect(signedReopen.result.dirty).toBe(false);
		expect(signedReopen.result.checkpoint.history.savedGraph).toStrictEqual(signedReopen.result.checkpoint.snapshot.graph);
		expect(signedReopen.result.checkpoint.history.undo).toEqual([]);
		expect(signedReopen.result.checkpoint.history.redo).toEqual([]);
		await verifyInterop(testInfo, 'twelve-rectangles-signed-history', outputPath, saved, signedBeforeSave, expected, signedReopen);
	});

	test('keeps the dirty checkpoint on Cancel, opens New only after Save acknowledgment, and preserves edits after corrupt Open', async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		await createNew(page);
		await ensureTopView(page);
		await drawRectangle(page, 0.38, 0.40, 0.12, 0.11);
		const beforeCancel = await currentCheckpoint(page);
		const titleBeforeCancel = await page.title();
		await openFileMenu(page);
		await page.getByRole('button', { name: /^New/ }).click();
		const dialog = page.getByRole('dialog', { name: 'Save changes?' });
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(dialog).toHaveCount(0);
		expect(await page.title()).toBe(titleBeforeCancel);
		expect(await currentCheckpoint(page)).toStrictEqual(beforeCancel);
		await expect(page.locator('.footer-status')).toContainText('Unsaved BOMC');

		await openFileMenu(page);
		await page.getByRole('button', { name: /^New/ }).click();
		const previousDocumentId = beforeCancel.snapshot.graph.documentId;
		const transitionDownload = page.waitForEvent('download');
		await page.getByRole('dialog', { name: 'Save changes?' }).getByRole('button', { name: 'Save', exact: true }).click();
		const downloaded = await transitionDownload;
		const transitionPath = testInfo.outputPath('save-before-new.bomc');
		await downloaded.saveAs(transitionPath);
		const savedBytes = await readFile(transitionPath);
		const savedHash = createHash('sha256').update(savedBytes).digest('hex');
		const oldWorker = (await probe(page)).workers.find((worker) => worker.replies.some((reply) => isSavedWriteReply(reply, savedHash)));
		if (!oldWorker) throw new Error('The Save-before-New download has no matching production WRITE receipt.');
		const writeReply = oldWorker.replies.find((reply) => isSavedWriteReply(reply, savedHash));
		if (!writeReply) throw new Error('The Save-before-New download has no matching WRITE result.');
		await expect.poll(async () => oldWorker.requests.some((request) => request.type === 'ACK_DOWNLOAD'
			&& request.data?.writeId === writeReply.result?.writeId
			&& request.expectedRevision === writeReply.result?.revision)).toBe(true);
		const ackRequest = oldWorker.requests.find((request) => request.type === 'ACK_DOWNLOAD'
			&& request.data?.writeId === writeReply.result?.writeId
			&& request.expectedRevision === writeReply.result?.revision);
		if (!ackRequest) throw new Error('The Save-before-New download ACK request was not observed.');
		await expect.poll(async () => oldWorker.replies.some((reply) => reply.event === 'RESULT'
			&& reply.requestType === 'ACK_DOWNLOAD'
			&& reply.sessionId === ackRequest.sessionId
			&& reply.requestId === ackRequest.requestId
			&& reply.result?.checkpoint?.snapshot?.revision === writeReply.result?.revision
			&& reply.result?.dirty === false)).toBe(true);
		// The Save ACK is followed by the already-requested New transition; the active document is therefore the new dirty one here.
		const transitionDocument = await readWebBomc(new Uint8Array(savedBytes));
		try { expect(transitionDocument.snapshot().graph).toStrictEqual(beforeCancel.snapshot.graph); }
		finally { transitionDocument.dispose(); }
		await expect.poll(async () => (await currentAuthoringResult(page)).checkpoint.snapshot.graph.documentId).not.toBe(previousDocumentId);
		const newCheckpoint = await currentCheckpoint(page);
		expect(newCheckpoint.snapshot.graph.documentId).not.toBe(previousDocumentId);
		expect(newCheckpoint.snapshot.graph.meshes).toEqual([]);
		await ensureTopView(page);
		await drawRectangle(page, 0.38, 0.40, 0.10, 0.10);
		await openFileMenu(page);
		await page.getByRole('button', { name: 'Close Model' }).click();
		await expect(page.getByRole('dialog', { name: 'Save changes?' })).toBeVisible();
		await page.getByRole('dialog', { name: 'Save changes?' }).getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(page.getByText('Writable BOMC', { exact: true }).first()).toBeVisible();
		await openFileMenu(page);
		await page.getByRole('button', { name: 'Close Model' }).click();
		await page.getByRole('dialog', { name: 'Save changes?' }).getByRole('button', { name: 'Discard', exact: true }).click();
		await expect(page.locator('.empty-workspace')).toBeVisible();
		await createNew(page);

		// Create an actual supported BWEB output, then derive only the frozen malformed section-241 cases from those downloaded bytes.
		await ensureTopView(page);
		await drawRectangle(page, 0.41, 0.40, 0.10, 0.10);
		const seed = await saveBomc(page, testInfo.outputPath('corrupt-fixture-seed.bomc'));
		const faults = await buildAuthoringFaultFixtures(seed.bytes);
		const corrupt = faults.filter((fixture) => fixture.classification === 'reject');
		expect(corrupt.map((fixture) => fixture.id).sort()).toEqual(['section241-stored-crc', 'section241-truncated-bweb']);
		await drawRectangle(page, 0.61, 0.40, 0.10, 0.10);
		const exactDirtyBeforeOpenCancel = await currentCheckpoint(page);
		const exactTitleBeforeOpenCancel = await page.title();
		await uploadBytes(page, seed.bytes, 'valid-supported-open-cancel.bomc');
		await expect(page.getByRole('dialog', { name: 'Save changes?' })).toBeVisible();
		await page.getByRole('dialog', { name: 'Save changes?' }).getByRole('button', { name: 'Cancel', exact: true }).click();
		expect(await page.title()).toBe(exactTitleBeforeOpenCancel);
		expect(await currentCheckpoint(page)).toStrictEqual(exactDirtyBeforeOpenCancel);
			for (const [candidateIndex, candidate] of corrupt.entries()) {
				const exactDirtyBeforeOpen = await currentCheckpoint(page);
				const exactTitleBeforeOpen = await page.title();
				await uploadBytes(page, candidate.bytes, candidate.id + '.bomc');
			await expect(page.getByRole('dialog', { name: 'Save changes?' })).toBeVisible();
			await page.getByRole('dialog', { name: 'Save changes?' }).getByRole('button', { name: 'Discard', exact: true }).click();
			await expect(page.locator('.viewport-status.error-state')).toContainText(/invalid|truncated|section|BOMC|corrupt/i, { timeout: 180_000 });
				expect(await page.title()).toBe(exactTitleBeforeOpen);
				expect(await currentCheckpoint(page)).toStrictEqual(exactDirtyBeforeOpen);
				await expect(page.locator('.footer-status')).toContainText('Unsaved BOMC');

				// A rejected replacement must leave the restored controller usable. Prove a
				// new canonical edit, extrusion, actual Save bytes, and independent reopen.
				await ensureTopView(page);
				const createCountBefore = (await authoringCommands(page)).filter((command) => command.kind === 'CREATE_RECTANGLE').length;
				await drawRectangle(page, 0.24 + candidateIndex * 0.12, 0.62, 0.08, 0.07);
				await expect.poll(async () => (await currentCheckpoint(page)).snapshot.revision).toBe(exactDirtyBeforeOpen.snapshot.revision + 1);
				const postRollbackDraw = await currentCheckpoint(page);
				expect((await authoringCommands(page)).filter((command) => command.kind === 'CREATE_RECTANGLE')).toHaveLength(createCountBefore + 1);
				const beforeEntityIds = new Set(authoredRectangleEntityIds(exactDirtyBeforeOpen.snapshot.graph as BomcGraph));
				const addedEntityIds = authoredRectangleEntityIds(postRollbackDraw.snapshot.graph as BomcGraph).filter((entityId) => !beforeEntityIds.has(entityId));
				expect(addedEntityIds).toHaveLength(1);
				const newEntityId = addedEntityIds[0]!;
				await ensureTopView(page);
				await selectProjectedRectangle(page, postRollbackDraw.snapshot.graph as BomcGraph, newEntityId);
				const extrudeCountBefore = (await authoringCommands(page)).filter((command) => command.kind === 'EXTRUDE_RECTANGLE').length;
				await page.getByRole('button', { name: 'Push/Pull', exact: true }).click();
				await page.getByLabel('Extrusion (m)').fill(String(0.6 + candidateIndex * 0.2));
				await page.getByRole('button', { name: 'Commit', exact: true }).click();
				await expect.poll(async () => (await authoringCommands(page)).filter((command) => command.kind === 'EXTRUDE_RECTANGLE').length).toBe(extrudeCountBefore + 1);
				await expect.poll(async () => (await currentCheckpoint(page)).snapshot.revision).toBe(postRollbackDraw.snapshot.revision + 1);
				const expectedAfterRollbackEdit = await currentCheckpoint(page);
				const savedAfterRollback = await saveBomc(page, testInfo.outputPath(`${candidate.id}-rollback-edit.bomc`));
				const independentlyRead = await readWebBomc(new Uint8Array(savedAfterRollback.bytes));
				try { expect(independentlyRead.snapshot().graph).toStrictEqual(expectedAfterRollbackEdit.snapshot.graph); }
				finally { independentlyRead.dispose(); }
				await openFileMenu(page);
				await page.getByRole('button', { name: 'Close Model' }).click();
				await expect(page.locator('.empty-workspace')).toBeVisible();
				await uploadBytes(page, savedAfterRollback.bytes, `${candidate.id}-rollback-edit-reopen.bomc`);
				await expect(page.getByText('Writable BOMC', { exact: true }).first()).toBeVisible({ timeout: 180_000 });
				expect((await currentCheckpoint(page)).snapshot.graph).toStrictEqual(expectedAfterRollbackEdit.snapshot.graph);

				// Keep the next replacement attempt dirty so it traverses the same guarded
				// transition path instead of bypassing the Save/Discard/Cancel contract.
				if (candidateIndex < corrupt.length - 1) {
					await ensureTopView(page);
					await drawRectangle(page, 0.70, 0.62, 0.06, 0.06);
				}
			}
		});

	test('keeps the active authoring controller usable after an in-flight replacement is cancelled', async ({ page }, testInfo) => {
		test.setTimeout(180_000);
		await createNew(page);
		await ensureTopView(page);
		await drawRectangle(page, 0.40, 0.40, 0.10, 0.10);
		const seed = await saveBomc(page, testInfo.outputPath('cancelled-replacement-seed.bomc'));
		await ensureTopView(page);
		await drawRectangle(page, 0.60, 0.40, 0.09, 0.09);
		const retained = await currentCheckpoint(page);
		const retainedTitle = await page.title();
		const commandsBeforeCancel = (await authoringCommands(page)).filter((command) => command.kind === 'CREATE_RECTANGLE').length;

		await page.evaluate(() => window.__editorAuthoringWorkerFaultControl?.pauseNextRequest('OPEN'));
		await uploadBytes(page, seed.bytes, 'cancelled-in-flight-open.bomc');
		await expect(page.getByRole('dialog', { name: 'Save changes?' })).toBeVisible();
		await page.getByRole('dialog', { name: 'Save changes?' }).getByRole('button', { name: 'Discard', exact: true }).click();
		await expect.poll(async () => (await probe(page)).workers.some((worker) => worker.requests.some((request) => request.type === 'OPEN') && worker.terminated === 0)).toBe(true);
		const cancel = page.locator('.viewport-status').getByRole('button', { name: 'Cancel', exact: true });
		await expect(cancel).toBeVisible();
		await cancel.click();
		await expect(page.locator('.viewport-status.error-state')).toContainText(/cancelled/i);
		expect(await page.title()).toBe(retainedTitle);
		expect(await currentCheckpoint(page)).toStrictEqual(retained);

		await ensureTopView(page);
		await drawRectangle(page, 0.28, 0.64, 0.08, 0.07);
		await expect.poll(async () => (await authoringCommands(page)).filter((command) => command.kind === 'CREATE_RECTANGLE').length).toBe(commandsBeforeCancel + 1);
		await expect.poll(async () => (await currentCheckpoint(page)).snapshot.revision).toBe(retained.snapshot.revision + 1);
		const expected = await currentCheckpoint(page);
		const saved = await saveBomc(page, testInfo.outputPath('cancelled-replacement-continued.bomc'));
		const independent = await readWebBomc(new Uint8Array(saved.bytes));
		try { expect(independent.snapshot().graph).toStrictEqual(expected.snapshot.graph); }
		finally { independent.dispose(); }
		await openFileMenu(page);
		await page.getByRole('button', { name: 'Close Model' }).click();
		await expect(page.locator('.empty-workspace')).toBeVisible();
		await uploadBytes(page, saved.bytes, 'cancelled-replacement-continued-reopen.bomc');
		await expect(page.getByText('Writable BOMC', { exact: true }).first()).toBeVisible({ timeout: 180_000 });
		expect((await currentCheckpoint(page)).snapshot.graph).toStrictEqual(expected.snapshot.graph);
	});

	test('shows failed recovery read-only, retries the retained checkpoint, and closes during restore without resurrection', async ({ page }, testInfo) => {
		test.setTimeout(180_000);
		await createNew(page);
		await ensureTopView(page);
		await drawRectangle(page, 0.40, 0.40, 0.11, 0.10);
		const retained = await currentCheckpoint(page);
		const retainedTitle = await page.title();

		await page.evaluate(() => {
			const control = window.__editorAuthoringWorkerFaultControl;
			if (!control) throw new Error('Authoring worker fault control is unavailable.');
			control.failNextWorkerConstruction();
			if (!control.triggerLatestMessageError()) throw new Error('No live authoring worker was available for messageerror.');
		});
		const retry = page.getByRole('button', { name: 'Retry Restore', exact: true });
		await expect(retry).toBeVisible();
		await expect(page.locator('.viewport-status.error-state')).toContainText(/recovery failed|simulated restore worker construction failure/i);
		await expect(page.getByRole('button', { name: 'Rectangle', exact: true })).toBeDisabled();
		await openFileMenu(page);
		await expect(page.getByRole('button', { name: /Save BOMC/ })).toBeDisabled();
		await closeMenu(page, 0);
		expect(await page.title()).toBe(retainedTitle);
		await expect(page.locator('.footer-status')).toContainText('Unsaved BOMC');

		await retry.click();
		await expect(retry).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Rectangle', exact: true })).toBeEnabled();
		await expect.poll(async () => (await probe(page)).workers.some((worker) => worker.terminated === 0 && worker.replies.some((reply) => reply.event === 'RESULT' && reply.requestType === 'RESTORE_CHECKPOINT'))).toBe(true);
		const restored = await currentCheckpoint(page);
		expect(restored.snapshot.graph).toStrictEqual(retained.snapshot.graph);
		expect(restored.history).toStrictEqual(retained.history);
		expect(restored.sequence).toBe(retained.sequence);

		await ensureTopView(page);
		await drawRectangle(page, 0.62, 0.40, 0.09, 0.08);
		await expect.poll(async () => (await currentCheckpoint(page)).snapshot.revision).toBe(retained.snapshot.revision + 1);
		const edited = await currentCheckpoint(page);
		const saved = await saveBomc(page, testInfo.outputPath('recovery-retry-save.bomc'));
		const independent = await readWebBomc(new Uint8Array(saved.bytes));
		try { expect(independent.snapshot().graph).toStrictEqual(edited.snapshot.graph); }
		finally { independent.dispose(); }
		await openFileMenu(page);
		await page.getByRole('button', { name: 'Close Model' }).click();
		await expect(page.locator('.empty-workspace')).toBeVisible();
		await uploadBytes(page, saved.bytes, 'recovery-retry-reopen.bomc');
		await expect(page.getByText('Writable BOMC', { exact: true }).first()).toBeVisible({ timeout: 180_000 });
		expect((await currentCheckpoint(page)).snapshot.graph).toStrictEqual(edited.snapshot.graph);

		await ensureTopView(page);
		await drawRectangle(page, 0.30, 0.65, 0.07, 0.06);
		await page.evaluate(() => {
			const control = window.__editorAuthoringWorkerFaultControl;
			if (!control) throw new Error('Authoring worker fault control is unavailable.');
			control.pauseNextRequest('RESTORE_CHECKPOINT');
			if (!control.triggerLatestMessageError()) throw new Error('No live authoring worker was available for restore-close proof.');
		});
		await expect(page.locator('.viewport-status')).toContainText('Restoring the last acknowledged authoring checkpoint');
		await page.locator('.viewport-status').getByRole('button', { name: 'Close', exact: true }).click();
		const closeDialog = page.getByRole('dialog', { name: 'Save changes?' });
		await expect(closeDialog).toBeVisible();
		await expect(closeDialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
		await closeDialog.getByRole('button', { name: 'Discard', exact: true }).click();
		await expect(page.locator('.empty-workspace')).toBeVisible();
		await page.waitForTimeout(100);
		const afterClose = await probe(page);
		expect(afterClose.workers.filter((worker) => worker.terminated === 0 && (worker.requests.some((request) => request.protocolVersion === 'sibambo-editor-authoring-1') || worker.replies.some((reply) => reply.protocolVersion === 'sibambo-editor-authoring-1')))).toHaveLength(0);
	});

	test('keeps unsupported S2-current and BWEB capabilities in read-only viewer mode', async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		await uploadPinnedS2(page);
		await expect(page.locator('.tool-context')).toContainText('Viewer', { timeout: 240_000 });
		await openFileMenu(page);
		await expect(page.getByRole('button', { name: /Save BOMC/ })).toHaveCount(0);
		await expect(page.locator('.footer-status')).not.toBeEmpty();
		await openFileMenu(page);
		await page.getByRole('button', { name: 'Close Model' }).click();

		const nonflat = await buildNonflatKernelBwebFixture();
		const nonflatDocument = await readWebBomc(new Uint8Array(nonflat.bytes));
		try {
			const positions = nonflatDocument.snapshot().graph.meshes[0]!.positions;
			const heights = positions.filter((_value, index) => index % 3 === 1);
			expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.5);
		} finally { nonflatDocument.dispose(); }
		await uploadBytes(page, nonflat.bytes, 'valid-nonflat-kernel-bweb.bomc');
		await expect(page.locator('.tool-context')).toContainText('Viewer', { timeout: 180_000 });
		await openFileMenu(page);
		await expect(page.getByRole('button', { name: /Save BOMC/ })).toHaveCount(0);
		await openFileMenu(page);
		await page.getByRole('button', { name: 'Close Model' }).click();

		await createNew(page);
		const seed = await saveBomc(page, testInfo.outputPath('unsupported-fixture-seed.bomc'));
		expect((await currentAuthoringResult(page)).dirty).toBe(false);
		const faults = await buildAuthoringFaultFixtures(seed.bytes);
		for (const id of ['section241-missing', 'section241-nonmagic', 'section241-schema-2', 'section241-codec-2', 'section241-codec-3'] as const) {
			const unsupported = faults.find((fixture) => fixture.id === id);
			if (!unsupported) throw new Error(`The required unsupported fixture ${id} is absent.`);
			await uploadBytes(page, unsupported.bytes, `${id}.bomc`);
			await expect(page.locator('.tool-context')).toContainText('Viewer', { timeout: 180_000 });
			await openFileMenu(page);
			await expect(page.getByRole('button', { name: /Save BOMC/ })).toHaveCount(0);
			await openFileMenu(page);
			await page.getByRole('button', { name: 'Close Model' }).click();
		}
	});
});
