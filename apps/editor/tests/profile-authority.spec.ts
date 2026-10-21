import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { E4_PROVENANCE_POLICY_V1 } from '@sibambo/provenance/policies/e4-v1';
import { readFile } from 'node:fs/promises';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { BomcWriter } from '@sibambo/bomc-document/writer';
import { readWebBomc } from '@sibambo/bomc-document/reader';
import { buildRectangleEdit } from '../src/lib/authoring/geometry';
import { buildAuthoringFaultFixtures, withEncodingProfile } from './helpers/authoring-fixtures';
import { installAuthoringWorkerProbe } from './helpers/authoring-worker-probe';

async function seed() {
	const document = BomcDocument.create({ documentId: 'f1m-profile-authority', name: 'Profile authority fixture' });
	const writer = new BomcWriter(document, { compressionMode: 'store-only' });
	try {
		document.transact(buildRectangleEdit(document.snapshot().graph, 'f1m-profile-authority:rectangle:1', [0, 0, 0], [2, 0, 3]).forward);
		return { bytes: Buffer.from((await writer.write()).bytes), graph: document.snapshot().graph };
	} finally { writer.dispose(); document.dispose(); }
}

async function fileMenu(page: Page) {
	const menu = page.locator('.editor-menubar details.menu-root').first();
	if (!(await menu.evaluate(element => (element as HTMLDetailsElement).open))) await menu.locator('summary').click();
}

async function open(page: Page, bytes: Buffer, name = 'profile.bomc') {
	await page.getByLabel('BOMC 1.2 file', { exact: true }).setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
}

test.beforeEach(async ({ page }) => {
	await installAuthoringWorkerProbe(page);
	await page.goto('/?renderer=webgl2');
	await expect(page.locator('main[data-app="editor"]')).toHaveAttribute('data-editor-ready', 'true');
});

// All inputs here are synthetic BWEB outputs; these are cloud browser regressions, not native fidelity evidence.
for (const [profile, label] of [[3, 'Visual preview only'], [2, 'Legacy Research read-only']] as const) {
	test(`${label} remains view-only even when its graph has a supported BWEB authoring section`, async ({ page }) => {
		const input = await seed();
		await open(page, await withEncodingProfile(input.bytes, profile));
		await expect(page.locator('.tool-context')).toContainText(label, { timeout: 30_000 });
		await expect(page.locator('.viewport canvas')).toBeVisible();
		await expect(page.locator('.footer-status')).toContainText(label, { timeout: 30_000 });
		await fileMenu(page);
		await expect(page.getByRole('button', { name: /Save BOMC/ })).toHaveCount(0);
		const authoringOpens = await page.evaluate(() => window.__editorAuthoringWorkerProbe!.workers.flatMap(worker => worker.requests).filter(request => request.type === 'OPEN'));
		expect(authoringOpens).toEqual([]);
		await page.keyboard.press('Escape');
		await page.keyboard.press('Control+s');
		const writes = await page.evaluate(() => window.__editorAuthoringWorkerProbe!.workers.flatMap(worker => worker.requests).filter(request => request.type === 'WRITE'));
		expect(writes).toEqual([]);
	});
}

test('Exact supported graph saves and reopens the actual browser download as clean authoritative geometry', async ({ page }, testInfo) => {
	const input = await seed();
	await open(page, input.bytes, 'exact.bomc');
	await expect(page.locator('.tool-context')).toContainText('Writable BOMC', { timeout: 30_000 });
	await expect(page.locator('.footer-status')).toContainText('Saved BOMC');
	await fileMenu(page);
	const downloaded = page.waitForEvent('download');
	await page.getByRole('button', { name: /Save BOMC/ }).click();
	const download = await downloaded;
	const target = testInfo.outputPath('exact-saved.bomc');
	await download.saveAs(target);
	const bytes = await readFile(target);
	const restored = await readWebBomc(bytes);
	try { expect(restored.snapshot().graph).toEqual(input.graph); }
	finally { restored.dispose(); }
	await expect(page.locator('.footer-status')).toContainText('Saved BOMC');
	await open(page, bytes, 'exact-reopened.bomc');
	await expect(page.locator('.tool-context')).toContainText('Writable BOMC', { timeout: 30_000 });
	await expect(page.locator('.footer-status')).toContainText('Saved BOMC');
	const latest = await page.evaluate(() => window.__editorAuthoringWorkerProbe!.workers.filter(worker => worker.terminated === 0).flatMap(worker => worker.replies).filter(reply => reply.event === 'RESULT' && reply.requestType === 'OPEN').at(-1));
	expect(latest?.event === 'RESULT' && latest.result.kind === 'authoring' ? latest.result.checkpoint.snapshot.graph : null).toEqual(input.graph);
});

test('failed admission, provenance, BWEB and changed reread preserve the dirty document, history and camera', async ({ page }, testInfo) => {
	test.setTimeout(90_000);
	const input = await seed();
	await open(page, input.bytes, 'active-exact.bomc');
	await expect(page.locator('.tool-context')).toContainText('Writable BOMC', { timeout: 30_000 });
	const viewMenu = page.locator('.editor-menubar details.menu-root').nth(3);
	await viewMenu.locator('summary').click();
	await page.getByRole('button', { name: 'Top', exact: true }).click();
	if (await viewMenu.evaluate(element => (element as HTMLDetailsElement).open)) await viewMenu.locator('summary').click();
	const checkpoint = async () => page.evaluate(() => window.__editorAuthoringWorkerProbe!.workers.filter(worker => worker.terminated === 0).flatMap(worker => worker.replies).filter(reply => reply.event === 'RESULT' && reply.result?.checkpoint).at(-1));
	const canvas = page.locator('.viewport canvas');
	const box = await canvas.boundingBox();
	if (!box) throw new Error('Missing production canvas.');
	for (const x of [0.15, 0.7]) {
		const before = await checkpoint();
		await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
		await page.mouse.click(box.x + box.width * x, box.y + box.height * 0.3);
		await page.mouse.click(box.x + box.width * (x + 0.08), box.y + box.height * 0.4);
		await expect.poll(async () => JSON.stringify(await checkpoint())).not.toBe(JSON.stringify(before));
	}
	await page.getByRole('button', { name: 'Select', exact: true }).click();
	await page.keyboard.press('Control+z');
	await expect.poll(async () => { const result = await checkpoint(); return result?.event === 'RESULT' ? result.result.checkpoint?.history.redo.length : undefined; }).toBe(1);
	await expect(page.locator('.footer-status')).toContainText('Unsaved BOMC');
	const before = await checkpoint();
	const title = await page.title();
	await page.mouse.move(5, 5);
	await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
	// Error toasts overlay the canvas element; compare the model pixels with those toasts hidden.
	const camera = createHash('sha256').update(await canvas.screenshot({ style: '.viewport-status { visibility: hidden !important; }', path: testInfo.outputPath('before-failures.png') })).digest('hex');
	const faults = await buildAuthoringFaultFixtures(input.bytes);
	const malformedBweb = faults.find(fault => fault.id === 'section241-truncated-bweb')!;
	const wrongProfile = {
		schema: 'sibambo-research-provenance-v1', engine: 'e4',
		artifact: { sha256: createHash('sha256').update(input.bytes).digest('hex'), bytes: input.bytes.length, format: 'bomc-1.2', profile: 'visual' },
		producer: { label: 'Synthetic mismatched fixture', sourceTreeSha256: E4_PROVENANCE_POLICY_V1.producer.sourceTreeSha256![0] },
		model: { id: 'synthetic-mismatch' },
		capture: { id: 'synthetic-mismatch', exportedAt: '2026-10-21T00:00:00Z', evidence: 'Synthetic cloud negative case.', method: 'operator-attested' }
	};
	for (const failure of [
		{ name: 'malformed.bomc', bytes: Buffer.from([1, 2, 3]), sidecar: undefined, message: /Editor accepts BOMC 1.2 only/ },
		{ name: 'wrong-profile.bomc', bytes: input.bytes, sidecar: wrongProfile, message: /BOMC encoding profile does not match/ },
		{ name: 'malformed-bweb.bomc', bytes: malformedBweb.bytes, sidecar: undefined, message: /BWEB|authoring|truncated/i }
	]) {
		if (failure.sidecar) await page.getByLabel('Provenance JSON for next model').setInputFiles({ name: 'wrong-profile.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(failure.sidecar)) });
		await open(page, failure.bytes, failure.name);
		await page.getByRole('dialog', { name: 'Save changes?' }).getByRole('button', { name: 'Discard', exact: true }).click();
		await expect(page.getByRole('status')).toContainText(failure.message);
		expect(await checkpoint()).toEqual(before);
		expect(await page.title()).toBe(title);
		await expect(page.locator('.footer-status')).toContainText('Unsaved BOMC');
		expect(createHash('sha256').update(await canvas.screenshot({ style: '.viewport-status { visibility: hidden !important; }', path: testInfo.outputPath('after-' + failure.name + '.png') })).digest('hex')).toBe(camera);
	}
	const changed = await withEncodingProfile(input.bytes, 3);
	await page.evaluate(({ changedBytes }) => {
		const original = File.prototype.arrayBuffer;
		const reads = new WeakMap<File, number>();
		File.prototype.arrayBuffer = async function () {
			const count = (reads.get(this) ?? 0) + 1;
			reads.set(this, count);
			if (this.name === 'changed-on-reread.bomc' && count > 1) return Uint8Array.from(changedBytes).buffer;
			return original.call(this);
		};
	}, { changedBytes: [...changed] });
	await open(page, input.bytes, 'changed-on-reread.bomc');
	await page.getByRole('dialog', { name: 'Save changes?' }).getByRole('button', { name: 'Discard', exact: true }).click();
	await expect(page.getByText('BOMC artifact changed after admission; the current document is preserved.', { exact: true })).toBeVisible();
	expect(await checkpoint()).toEqual(before);
	expect(await page.title()).toBe(title);
	await expect(page.locator('.footer-status')).toContainText('Unsaved BOMC');
	await expect(page.locator('.tool-context')).toContainText('Writable BOMC', { timeout: 30_000 });
	expect(createHash('sha256').update(await canvas.screenshot({ style: '.viewport-status { visibility: hidden !important; }', path: testInfo.outputPath('after-reread.png') })).digest('hex')).toBe(camera);
});
