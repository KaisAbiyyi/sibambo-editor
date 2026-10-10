import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

type WorkloadReport = {
	viewport: { width: number; height: number; devicePixelRatio: number; backend: string; pixelRatio: number };
	entities: { rectangles: number; extrusions: number; finalRevision: number; finalSequence: number };
	commands: { count: number; p95DispatchToAckMs: number | null; p95AckToRenderMs: number | null; timings: Array<{ kind: string; dispatchToAckMs: number; ackToRenderMs: number; revision: number; sequence: number }> };
	writes: {
		firstBytes: number; firstSha256: string; firstWorkerMs: number; firstBlobConstructionMs: number; firstBlobBytes: number;
		writeDurationMs: number; framesDuringWrite: number; frameDuringWriteStatus: string; cameraDuringWriteStatus: string;
		frameIntervalsMs: number[]; idleOrbitFrameIntervalsMs: number[];
		idleOrbitP95Ms: number | null; writeOrbitP95Ms: number | null; warmWriteRoundTripMs: number; warmWorkerMs: number;
		warmSha256: string; warmBytes: number; warmReusedSectionTypes: number[]; warmCacheBytes: number; roundTripGraphEqual: boolean;
	};
	positivePixels: number;
	longTasks: { supported: boolean; events: Array<{ startTime: number; durationMs: number }>; overlappingWrite: Array<{ startTime: number; durationMs: number }> };
};

type RecoveryReport = { failedCommandRejected: boolean; exactGraph: boolean; exactHistory: boolean; exactIdentity: boolean; isRestoring: boolean; restoreError: string | null };
type AbortRecoveryReport = { writeProgressObserved: boolean; writeRejected: boolean; exactGraph: boolean; exactHistory: boolean; exactIdentity: boolean; isRestoring: boolean; restoreError: string | null };

declare global {
	interface Window {
			__editorAuthoringPerformanceHarness: {
			runWorkload: () => Promise<WorkloadReport>;
			runCrashRecovery: () => Promise<RecoveryReport>;
			runAbortRecovery: () => Promise<AbortRecoveryReport>;
			lastWorkloadEvidence: () => Record<string, unknown> | null;
		};
	}
}

async function callHarness<T>(page: Page, method: 'runWorkload' | 'runCrashRecovery' | 'runAbortRecovery'): Promise<T> {
	return page.evaluate(async (name) => await window.__editorAuthoringPerformanceHarness[name](), method) as Promise<T>;
}

function median(values: number[]) {
	const sorted = [...values].sort((left, right) => left - right);
	if (sorted.length === 0) return null;
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

test('five sequential real worker/projection runs retain raw per-action and write evidence', async ({ page }, testInfo) => {
	const reports: WorkloadReport[] = [];
	let failure: string | null = null;
	try {
		await page.goto('/');
		for (let run = 0; run < 5; run += 1) {
			const report = await callHarness<WorkloadReport>(page, 'runWorkload');
			reports.push(report);
			expect(report.viewport).toMatchObject({ width: 1440, height: 900, devicePixelRatio: 1, backend: 'webgl2', pixelRatio: 1 });
			expect(report.entities.rectangles).toBe(100);
			expect(report.entities.extrusions).toBe(100);
			expect(report.commands.count).toBe(200);
			expect(report.commands.timings).toHaveLength(200);
			expect(report.commands.p95DispatchToAckMs).not.toBeNull();
			expect(report.commands.p95DispatchToAckMs!).toBeLessThanOrEqual(200);
			expect(report.commands.p95AckToRenderMs).not.toBeNull();
			expect(report.writes.firstBytes).toBeGreaterThan(0);
			expect(report.writes.firstSha256).toMatch(/^[0-9a-f]{64}$/);
			expect(Number.isFinite(report.writes.firstBlobConstructionMs)).toBe(true);
			expect(report.writes.firstBlobConstructionMs).toBeGreaterThanOrEqual(0);
			expect(report.writes.firstBlobBytes).toBe(report.writes.firstBytes);
			expect(report.writes.warmBytes).toBe(report.writes.firstBytes);
			expect(report.writes.warmSha256).toBe(report.writes.firstSha256);
			expect(report.writes.warmReusedSectionTypes.length).toBeGreaterThan(0);
			expect(report.writes.warmCacheBytes).toBeGreaterThan(0);
			expect(report.writes.roundTripGraphEqual).toBe(true);
			expect(report.positivePixels).toBeGreaterThan(100);
			expect(report.longTasks.supported).toBe(true);
			expect(report.longTasks.events.every((event) => Number.isFinite(event.startTime) && Number.isFinite(event.durationMs))).toBe(true);
			expect(report.longTasks.overlappingWrite.every((event) => Number.isFinite(event.startTime) && Number.isFinite(event.durationMs))).toBe(true);
			expect(report.longTasks.overlappingWrite.every((event) => event.durationMs <= 50), 'Main-thread long task overlapped worker serialization/compression.').toBe(true);

			const idleFrameMedian = median(report.writes.idleOrbitFrameIntervalsMs);
			if (idleFrameMedian !== null && report.writes.writeDurationMs >= 2 * idleFrameMedian) {
				expect(report.writes.frameDuringWriteStatus).toBe('observed');
				expect(report.writes.framesDuringWrite).toBeGreaterThan(0);
				expect(report.writes.cameraDuringWriteStatus).toBe('measured');
				expect(report.writes.writeOrbitP95Ms).not.toBeNull();
				expect(report.writes.idleOrbitP95Ms).not.toBeNull();
				expect(report.writes.writeOrbitP95Ms!).toBeLessThanOrEqual(report.writes.idleOrbitP95Ms! * 1.1 + 4);
			} else {
				expect(report.writes.frameDuringWriteStatus).toBe('not-measurable-short-write');
				expect(report.writes.cameraDuringWriteStatus).toBe('not-measurable-short-write');
			}
		}
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		throw error;
	} finally {
		const activeRun = await page.evaluate(() => window.__editorAuthoringPerformanceHarness.lastWorkloadEvidence()).catch(() => null);
		const raw = JSON.stringify({ schema: 'sibambo-editor-authoring-performance-v1', status: failure ? 'failed' : 'complete', failure, runs: reports, activeRun }, null, 2);
		const rawPath = testInfo.outputPath('authoring-performance-five-run-raw.json');
		await mkdir(path.dirname(rawPath), { recursive: true });
		await writeFile(rawPath, raw, 'utf8');
		await testInfo.attach('authoring-performance-five-run-raw.json', {
			body: Buffer.from(raw),
			contentType: 'application/json'
		});
	}
});

test('an active writer abort restores the last acknowledged graph and history', async ({ page }, testInfo) => {
	await page.goto('/');
	const result = await callHarness<AbortRecoveryReport>(page, 'runAbortRecovery');
	await testInfo.attach('authoring-write-abort-recovery.json', { body: Buffer.from(JSON.stringify(result, null, 2)), contentType: 'application/json' });
	expect(result.writeProgressObserved).toBe(true);
	expect(result.writeRejected).toBe(true);
	expect(result.exactGraph).toBe(true);
	expect(result.exactHistory).toBe(true);
	expect(result.exactIdentity).toBe(true);
	expect(result.isRestoring).toBe(false);
	expect(result.restoreError).toBeNull();
});

test('a real worker error after an acknowledged edit restores exact graph and history', async ({ page }, testInfo) => {
	await page.goto('/');
	const result = await callHarness<RecoveryReport>(page, 'runCrashRecovery');
	await testInfo.attach('authoring-worker-crash-recovery.json', { body: Buffer.from(JSON.stringify(result, null, 2)), contentType: 'application/json' });
	expect(result.failedCommandRejected).toBe(true);
	expect(result.exactGraph).toBe(true);
	expect(result.exactHistory).toBe(true);
	expect(result.exactIdentity).toBe(true);
	expect(result.isRestoring).toBe(false);
	expect(result.restoreError).toBeNull();
});
