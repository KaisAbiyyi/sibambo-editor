import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { verifyFixturePayload } from './bomc-inventory.ts';

type Fixture = { id: string; locator: string; bytes: number; sha256: string };
const workspaceRoot = path.resolve(import.meta.dir, '../../..');
const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, 'fixtures.json'), 'utf8')) as { fixtures: Fixture[] };
const runnerUrl = new URL('./loader-baseline.mjs', import.meta.url).href;

function runnerProbe(source: string) {
	const script = `import { enforceDeadline, matchesReadyText, median, nearestRankPercentile, raceWithDeadline, summarizeTimingRows, verifyFixtureBytes } from ${JSON.stringify(runnerUrl)};\n${source}`;
	const result = spawnSync('node', ['--input-type=module', '-e', script], { cwd: path.resolve(import.meta.dir, '../..'), encoding: 'utf8' });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || `Node probe exited ${result.status}.`);
	return JSON.parse(result.stdout.trim());
}

describe('pinned BOMC baseline fixtures', () => {
	test('resolves and verifies all eight frozen paths, sizes, and SHA-256 values', () => {
		expect(manifest.fixtures).toHaveLength(8);
		for (const fixture of manifest.fixtures) {
			const target = path.resolve(workspaceRoot, fixture.locator);
			expect(path.relative(workspaceRoot, target).startsWith('..')).toBe(false);
			const bytes = readFileSync(target);
			expect(verifyFixturePayload(fixture, bytes)).toBe(fixture.sha256);
		}
	});

	test('rejects a one-byte mutation before any inventory or browser run', () => {
		const fixture = manifest.fixtures[0];
		const source = readFileSync(path.resolve(workspaceRoot, fixture.locator));
		const copy = Buffer.from(source);
		copy[copy.length - 1] ^= 0x01;
		expect(() => verifyFixturePayload(fixture, copy)).toThrow(/SHA-256/);
		const runnerResult = runnerProbe(`const fixture = { id: 'small', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }; const valid = Buffer.from('abc'); const changed = Buffer.from('abd'); const validHash = verifyFixtureBytes(fixture, valid); let mismatch = false; try { verifyFixtureBytes(fixture, changed); } catch (error) { mismatch = /SHA-256/.test(String(error)); } console.log(JSON.stringify({ validHash, mismatch }));`);
		expect(runnerResult.validHash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		expect(runnerResult.mismatch).toBe(true);
	});
});

describe('baseline percentile contract', () => {
	test('does not treat import progress text as app-ready', () => {
		const result = runnerProbe(`console.log(JSON.stringify({ editorProgress: matchesReadyText('Import data ready; preparing the viewport', '^Ready$'), editorReady: matchesReadyText('Ready', '^Ready$'), roomsProgress: matchesReadyText('Model ready; preparing viewport', '^Viewport ready'), roomsReady: matchesReadyText('Viewport ready; room decisions are stored with this artifact hash.', '^Viewport ready'), benchmarkProgress: matchesReadyText('Model data ready; preparing renderer', '^Renderer ready'), benchmarkReady: matchesReadyText('Renderer ready · Not saved', '^Renderer ready') }));`);
		expect(result.editorProgress).toBe(false);
		expect(result.editorReady).toBe(true);
		expect(result.roomsProgress).toBe(false);
		expect(result.roomsReady).toBe(true);
		expect(result.benchmarkProgress).toBe(false);
		expect(result.benchmarkReady).toBe(true);
	});

	test('enforces the 120-second deadline from the recorded Open timestamp', () => {
		const result = runnerProbe(`const onTime = enforceDeadline({ kind: 'ready', text: 'Ready' }, 119999); const late = enforceDeadline({ kind: 'ready', text: 'Ready' }, 123190); console.log(JSON.stringify({ onTime, late }));`);
		expect(result.onTime.kind).toBe('ready');
		expect(result.onTime.elapsedMs).toBe(119_999);
		expect(result.late.kind).toBe('timeout');
		expect(result.late.elapsedMs).toBe(120_000);
		expect(result.late.lateOutcome.kind).toBe('ready');
		expect(result.late.lateOutcome.observedElapsedMs).toBe(123_190);
	});

	test('fires the Node watchdog when a renderer-side outcome promise is stalled', () => {
		const result = runnerProbe(`const timeout = await raceWithDeadline(new Promise((resolve) => setTimeout(() => resolve('late'), 25)), 1); const immediate = await raceWithDeadline(Promise.resolve('ready'), 100); console.log(JSON.stringify({ timeout, immediate }));`);
		expect(result.timeout.kind).toBe('timeout');
		expect(result.immediate.kind).toBe('result');
		expect(result.immediate.value).toBe('ready');
	});

	test('uses median with an averaged middle pair and nearest-rank P95', () => {
		const result = runnerProbe(`console.log(JSON.stringify({ median: median([30, 10, 20, 40]), p95: nearestRankPercentile(Array.from({ length: 20 }, (_, index) => index + 1), 0.95) }));`);
		expect(result.median).toBe(25);
		expect(result.p95).toBe(19);
	});

	test('retains failed and deadline rows in timing denominators and fails the series', () => {
		const result = runnerProbe(`const rows = [{ status: 'ready', elapsedMs: 12 }, { status: 'timeout', elapsedMs: 120000 }, { status: 'failed', elapsedMs: 25 }]; console.log(JSON.stringify({ summary: summarizeTimingRows(rows, 3), durations: rows.map((row) => row.elapsedMs) }));`);
		const summary = result.summary;
		expect(summary.attemptCount).toBe(3);
		expect(summary.p50Ms).toBe(25);
		expect(summary.p95Ms).toBe(120_000);
		expect(summary.failedCount).toBe(2);
		expect(summary.timeoutCount).toBe(1);
		expect(summary.seriesPass).toBe(false);
		expect(result.durations).toEqual([12, 120_000, 25]);
	});
});
