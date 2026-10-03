import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { parseMaterials, validateActiveSemanticReferences, verifyFixturePayload } from './bomc-inventory.ts';

type Fixture = { id: string; locator: string; bytes: number; sha256: string };
const workspaceRoot = path.resolve(import.meta.dir, '../../..');
const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, 'fixtures.json'), 'utf8')) as { fixtures: Fixture[] };
const runnerUrl = new URL('./loader-baseline.mjs', import.meta.url).href;

function runnerProbe(source: string) {
	const script = `import { assertBuildIdentityUnchanged, assertFreshOutputDirectory, bootPollDelay, buildBootScenarioMatrix, buildModelScenarioMatrix, captureChooserEventEpoch, closeEnvironmentResources, enforceDeadline, evaluateBootAcceptance, evaluateModelAcceptance, isBootRequestEvidenceComplete, matchesReadyText, median, nearestRankPercentile, parseArgs, raceWithDeadline, summarizeBootTimingRows, summarizeDiagnosticCases, summarizeTimingRows, verifyFixtureBytes, verifyScenarioRows, workerTraceAudit, withNodeWatchdog } from ${JSON.stringify(runnerUrl)};\n${source}`;
	const result = spawnSync('node', ['--input-type=module', '-e', script], { cwd: path.resolve(import.meta.dir, '../..'), encoding: 'utf8' });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || `Node probe exited ${result.status}.`);
	return JSON.parse(result.stdout.trim());
}

function browserProbe(source: string) {
	const script = `import assert from 'node:assert/strict'; import { createServer } from 'node:http'; import { APPS, launchBenchmarkBrowser, makeContext, makeFrameProbe, makeWorkerDiagnosticProbe, makeWorkerNativeControlProbe, performExpectedRejection, performModelAttempt, performModelAttemptInContext } from ${JSON.stringify(runnerUrl)};\n${source}`;
	const result = spawnSync('node', ['--input-type=module', '-e', script], { cwd: path.resolve(import.meta.dir, '../..'), encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || `Browser probe exited ${result.status}.`);
	return JSON.parse(result.stdout.trim());
}

function rawMaterialsV2(options: { textureIndices?: number[]; types?: number[]; modes?: number[]; hls?: number[][]; hashBytes?: number[] } = {}) {
	const count = 3;
	const prefix = Buffer.alloc(8);
	prefix[0] = 2; prefix[1] = 1; prefix[2] = 1; prefix.writeUInt32LE(count, 4);
	const names = Buffer.from([0, 0, 0]);
	const displayNames = Buffer.from([0, 0, 0]);
	const rgba = Buffer.alloc(count * 4);
	const opacity = Buffer.alloc(count * 2);
	const textureIndices = Buffer.from(options.textureIndices ?? [0, 1, 0xff]);
	const dimensions = Buffer.alloc(count * 2 * 4);
	const materialTypes = Buffer.from(options.types ?? [2, 2, 1]);
	const modes = Buffer.from(options.modes ?? [1, 2, 0]);
	const hlsRows = options.hls ?? [[12.5, -0.25, 0.75], [-33.125, 0.5, -0.125], [1, 2, 3]];
	const hls = Buffer.alloc(count * 24);
	for (let index = 0; index < count; index += 1) for (let channel = 0; channel < 3; channel += 1) hls.writeDoubleLE(hlsRows[index][channel], index * 24 + channel * 8);
	const hashBytes = options.hashBytes ?? [0x11, 0x22, 0];
	const hashes = Buffer.alloc(count * 32);
	for (let index = 0; index < count; index += 1) hashes.fill(hashBytes[index], index * 32, (index + 1) * 32);
	return Buffer.concat([prefix, names, displayNames, rgba, opacity, textureIndices, dimensions, materialTypes, modes, hls, hashes]);
}

function rawMaterialsV1() {
	const prefix = Buffer.alloc(8);
	prefix[0] = 1; prefix[1] = 1; prefix[2] = 1; prefix.writeUInt32LE(1, 4);
	return Buffer.concat([prefix, Buffer.from([0, 0]), Buffer.alloc(4), Buffer.alloc(2), Buffer.from([0]), Buffer.alloc(8)]);
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

describe('BOMC MATERIALS v2 semantic inventory', () => {
	test('parses HLS and output hashes from separate blocks and zips three distinct rows', () => {
		const parsed = parseMaterials(rawMaterialsV2());
		expect(parsed.version).toBe(2);
		expect(parsed.semanticRecords).toHaveLength(3);
		expect(parsed.semanticRecords.map((row) => row.hls)).toEqual([
			[12.5, -0.25, 0.75], [-33.125, 0.5, -0.125], [1, 2, 3]
		]);
		expect(parsed.semanticRecords.map((row) => row.outputRgbaSha256)).toEqual([
			'11'.repeat(32), '22'.repeat(32), '00'.repeat(32)
		]);
		expect(parsed.activeSemanticMaterials.map((row) => row.materialIndex)).toEqual([0, 1]);
		const linked = validateActiveSemanticReferences(parsed as never, { textures: [
			{ media: 'png', width: 11, height: 7, encodedPayloadSha256: 'aa'.repeat(32) },
			{ media: 'webp', width: 5, height: 9, encodedPayloadSha256: 'bb'.repeat(32) }
		] } as never);
		expect(linked.map((row) => row.referencedTexture)).toEqual([
			{ media: 'png', width: 11, height: 7, encodedPayloadSha256: 'aa'.repeat(32) },
			{ media: 'webp', width: 5, height: 9, encodedPayloadSha256: 'bb'.repeat(32) }
		]);
	});

	test('keeps MATERIALS v1 inactive and rejects invalid active semantics and references', () => {
		expect(parseMaterials(rawMaterialsV1()).activeSemanticMaterials).toEqual([]);
		expect(() => parseMaterials(rawMaterialsV2({ hls: [[Number.NaN, 0, 0], [0, 0, 0], [0, 0, 0]] }))).toThrow(/non-finite/);
		expect(() => parseMaterials(rawMaterialsV2({ types: [1, 2, 1] }))).toThrow(/not type 2/);
		expect(() => parseMaterials(rawMaterialsV2({ modes: [3, 2, 0] }))).toThrow(/unsupported semantic mode/);
		expect(() => parseMaterials(rawMaterialsV2({ hashBytes: [0, 0x22, 0] }))).toThrow(/zero output hash/);
		const parsed = parseMaterials(rawMaterialsV2());
		expect(() => validateActiveSemanticReferences(parsed as never, null)).toThrow(/no texture table/);
		expect(() => validateActiveSemanticReferences(parsed as never, { textures: [{ media: 'png', width: 1, height: 1, encodedPayloadSha256: 'aa'.repeat(32) }] } as never)).toThrow(/invalid texture reference/);
		expect(() => validateActiveSemanticReferences(parsed as never, { textures: [
			{ media: 'gif', width: 1, height: 1, encodedPayloadSha256: 'aa'.repeat(32) },
			{ media: 'webp', width: 1, height: 1, encodedPayloadSha256: 'bb'.repeat(32) }
		] } as never)).toThrow(/unsupported semantic media/);
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
		const result = runnerProbe(`const rows = [{ status: 'ready', elapsedMs: 12, openOccurred: true, startedAtEpochMs: 1 }, { status: 'timeout', elapsedMs: 120000, openOccurred: true, startedAtEpochMs: 2 }, { status: 'failed', elapsedMs: 25, openOccurred: true, startedAtEpochMs: 3 }]; console.log(JSON.stringify({ summary: summarizeTimingRows(rows, 3), durations: rows.map((row) => row.elapsedMs) }));`);
		const summary = result.summary;
		expect(summary.completedRowCount).toBe(3);
		expect(summary.p50Ms).toBe(25);
		expect(summary.p95Ms).toBe(120_000);
		expect(summary.failedCount).toBe(2);
		expect(summary.timeoutCount).toBe(1);
		expect(summary.seriesPass).toBe(false);
		expect(result.durations).toEqual([12, 120_000, 25]);
	});

	test('nulls final model percentiles for missing duration, clock, or attempt rows', () => {
		const result = runnerProbe(`
			const valid = Array.from({length:10},(_,i)=>({status:'ready',elapsedMs:i+1,openOccurred:true,startedAtEpochMs:i+100}));
			const missingDuration = valid.map((row)=>({...row})); missingDuration[2].elapsedMs = null;
			const missingClock = valid.map((row)=>({...row})); missingClock[3].openOccurred = false; missingClock[3].startedAtEpochMs = null;
			const invalidDuration = valid.map((row)=>({...row})); invalidDuration[1].elapsedMs = Number.NaN; invalidDuration[2].elapsedMs = -1;
			const setupFailure = summarizeTimingRows([{status:'setup-error',elapsedMs:null,openOccurred:false,startedAtEpochMs:null,setupDurationMs:17}],1);
			console.log(JSON.stringify({missingDuration:summarizeTimingRows(missingDuration),missingClock:summarizeTimingRows(missingClock),missingAttempt:summarizeTimingRows(valid.slice(0,9)),invalidDuration:summarizeTimingRows(invalidDuration),setupFailure}));`);
		expect(result.missingDuration.p50Ms).toBeNull();
		expect(result.missingDuration.p95Ms).toBeNull();
		expect(result.missingDuration.invalidOrMissingDurationCount).toBe(1);
		expect(result.missingClock.p50Ms).toBeNull();
		expect(result.missingClock.missingOpenClockCount).toBe(1);
		expect(result.missingAttempt.p50Ms).toBeNull();
		expect(result.missingAttempt.completedRowCount).toBe(9);
		expect(result.invalidDuration.p50Ms).toBeNull();
		expect(result.invalidDuration.invalidOrMissingDurationCount).toBe(2);
		expect(result.setupFailure.p50Ms).toBeNull();
		expect(result.setupFailure.invalidOrMissingDurationCount).toBe(1);
		expect(result.setupFailure.missingOpenClockCount).toBe(1);
	});

	test('requires both boot navigation and chooser clocks and keeps a failed valid duration descriptive', () => {
		const result = runnerProbe(`
			const valid = Array.from({length:10},(_,i)=>({status:i===9?'failed':'ready',navigationStartedEpochMs:100+i*10,chooserEpochMs:105+i*10}));
			const missing = valid.map((row)=>({...row})); missing[2].chooserEpochMs = null;
			console.log(JSON.stringify({valid:summarizeBootTimingRows(valid),missing:summarizeBootTimingRows(missing)}));`);
		expect(result.valid.p50Ms).toBe(5);
		expect(result.valid.p95Ms).toBe(5);
		expect(result.valid.failedCount).toBe(1);
		expect(result.valid.seriesPass).toBe(false);
		expect(result.missing.p50Ms).toBeNull();
		expect(result.missing.missingNavigationOrChooserClockCount).toBe(1);
	});

	test('refuses zero or incomplete JavaScript response evidence for boot rows', () => {
		const result = runnerProbe(`const complete={chooserObserved:true,jsRequestCount:3,jsGzipUnknownBodyCount:0,jsHttpFailureCount:0,jsTimingFailureCount:0,jsPendingAtCutoffCount:0,jsResourceTimingFailureCount:0,missingResourceMatchCount:0,resourceMissingCaptureCount:0};const missingBody={...complete,jsGzipUnknownBodyCount:1};const missingStatus={...complete,jsHttpFailureCount:1};const missingTiming={...complete,jsTimingFailureCount:1};const noRequests={...complete,jsRequestCount:0};console.log(JSON.stringify({complete:isBootRequestEvidenceComplete(complete),missingBody:isBootRequestEvidenceComplete(missingBody),missingStatus:isBootRequestEvidenceComplete(missingStatus),missingTiming:isBootRequestEvidenceComplete(missingTiming),noRequests:isBootRequestEvidenceComplete(noRequests)}));`);
		expect(result.complete).toBe(true);
		expect(result.missingBody).toBe(false);
		expect(result.missingStatus).toBe(false);
		expect(result.missingTiming).toBe(false);
		expect(result.noRequests).toBe(false);
	});

	test('uses the filechooser callback clock and schedules 50ms ticks without adding a trailing sleep', () => {
		const result = runnerProbe(`const event={id:'native-chooser'};const captured=captureChooserEventEpoch(event,()=>100);const pollingSettleEpoch=153;console.log(JSON.stringify({sameEvent:captured.event===event,eventEpoch:captured.chooserEpochMs,pollingSettleEpoch,waitBeforeNextTick:bootPollDelay(100,145),noTrailingWait:bootPollDelay(100,155),nominalTick:bootPollDelay(100,120)}));`);
		expect(result.sameEvent).toBe(true);
		expect(result.eventEpoch).toBe(100);
		expect(result.eventEpoch).toBeLessThan(result.pollingSettleEpoch);
		expect(result.waitBeforeNextTick).toBe(5);
		expect(result.noTrailingWait).toBe(0);
		expect(result.nominalTick).toBe(30);
	});

	test('builds B0 rejection and B1/P1 timed-v2 matrices without omitting required rows', () => {
		const result = runnerProbe(`
			const fixtures = ${JSON.stringify(manifest.fixtures.map((fixture) => fixture.id))};
			const apps = ['editor','rooms','benchmark'];
			const b0 = buildModelScenarioMatrix('B0',apps,fixtures);
			const b1 = buildModelScenarioMatrix('B1',apps,fixtures);
			const p1 = buildModelScenarioMatrix('P1',apps,fixtures);
			const b0Rejected = b0.scenarios.filter((scenario)=>scenario.kind==='expected-rejection');
			const v2Timed = b1.scenarios.filter((scenario)=>scenario.fixtureId==='S2-new');
			console.log(JSON.stringify({b0:b0.expectedRowCount,b0Rejected:b0Rejected.length,b1:b1.expectedRowCount,p1:p1.expectedRowCount,v2Timed:v2Timed.length,primeCount:b1.expectedRowIds.filter((id)=>id.endsWith('-prime')).length}));`);
		expect(result.b0).toBe(264);
		expect(result.b0Rejected).toBe(12);
		expect(result.b1).toBe(504);
		expect(result.p1).toBe(504);
		expect(result.v2Timed).toBe(6);
		expect(result.primeCount).toBe(24);
	});

	test('declares exactly Editor desktop/mobile boot rows and refuses changed series identity', () => {
		const result = runnerProbe(`
			const editor=buildBootScenarioMatrix(['editor']);const order=buildBootScenarioMatrix(['benchmark','editor']).appIds;
			const identity={commit:'a'.repeat(40),dirty:false,sourceSha256:'b'.repeat(64)};const unchanged=assertBuildIdentityUnchanged(identity,{...identity},'editor','S2-jcm','after');let drift=false;try{assertBuildIdentityUnchanged(identity,{...identity,commit:'c'.repeat(40)},'editor','S2-jcm','after')}catch(error){drift=/identity changed/.test(String(error))}
			let watchdog=false;try{await withNodeWatchdog(()=>new Promise(resolve=>setTimeout(resolve,30)),1,'auxiliary probe')}catch(error){watchdog=/1ms Node watchdog/.test(String(error))}
			console.log(JSON.stringify({editorRows:editor.expectedRowCount,order,unchanged,drift,watchdog}));`);
		expect(result.editorRows).toBe(42);
		expect(result.order).toEqual(['editor', 'benchmark']);
		expect(result.unchanged).toBe(true);
		expect(result.drift).toBe(true);
		expect(result.watchdog).toBe(true);
	});

	test('attempts context cleanup even when environment page cleanup fails', () => {
		const result = runnerProbe(`const order=[]; const errors=await closeEnvironmentResources([{resource:{close:async()=>{order.push('page');throw new Error('page-close-failed')}},label:'page'},{resource:{close:async()=>{order.push('context')}},label:'context'}]); console.log(JSON.stringify({order,errors}));`);
		expect(result.order).toEqual(['page', 'context']);
		expect(result.errors).toEqual(['page-close-failed']);
	});

	test('fails the full model gate for any invalid rejection, warm prime, or missing scenario row', () => {
		const result = runnerProbe(`
			const fixtures=${JSON.stringify(manifest.fixtures.map((fixture)=>fixture.id))};const matrix=buildModelScenarioMatrix('B0',['editor'],fixtures);const rows=[];const summaries={};
			for(const scenario of matrix.scenarios){if(scenario.kind==='expected-rejection'){rows.push({id:scenario.attemptRowIds[0],status:'expected-rejection',rejectionMessageMatchesB0:true,firstValidFrame:null});continue;}if(scenario.primeRowId)rows.push({id:scenario.primeRowId,status:'prime-excluded',openOccurred:true,startedAtEpochMs:10,elapsedMs:20,firstValidFrame:{method:'drawArraysInstanced'}});for(const id of scenario.attemptRowIds)rows.push({id,status:'ready',elapsedMs:20,openOccurred:true,startedAtEpochMs:10,firstValidFrame:{method:'drawArraysInstanced'}});summaries[scenario.id]={seriesPass:true};}
			const good=evaluateModelAcceptance(matrix,rows,summaries);const badPrime=rows.map(row=>({...row}));badPrime.find(row=>row.status==='prime-excluded').status='timeout';const primeResult=evaluateModelAcceptance(matrix,badPrime,summaries);const badRejection=rows.map(row=>({...row}));badRejection.find(row=>row.status==='expected-rejection').rejectionMessageMatchesB0=false;const rejectionResult=evaluateModelAcceptance(matrix,badRejection,summaries);const missing=evaluateModelAcceptance(matrix,rows.slice(1),summaries);console.log(JSON.stringify({good:good.pass,goodRejections:good.allRejectionsPass,prime:primeResult.pass,rejection:rejectionResult.pass,missing:missing.matrixAudit.matrixComplete}));`);
		expect(result.good).toBe(true);
		expect(result.goodRejections).toBe(true);
		expect(result.prime).toBe(false);
		expect(result.rejection).toBe(false);
		expect(result.missing).toBe(false);
	});

	test('accepts v2 as timed B1 rows and fails a failed v2 load', () => {
		const result = runnerProbe(`
			const fixtures=${JSON.stringify(manifest.fixtures.map((fixture)=>fixture.id))};const matrix=buildModelScenarioMatrix('B1',['editor'],fixtures);const rows=[];const summaries={};
			for(const scenario of matrix.scenarios){if(scenario.primeRowId)rows.push({id:scenario.primeRowId,status:'prime-excluded',openOccurred:true,startedAtEpochMs:1,elapsedMs:10,firstValidFrame:{method:'drawArraysInstanced'}});for(const id of scenario.attemptRowIds)rows.push({id,status:'ready',elapsedMs:10,openOccurred:true,startedAtEpochMs:1,firstValidFrame:{method:'drawArraysInstanced'}});summaries[scenario.id]={seriesPass:true};}
			const good=evaluateModelAcceptance(matrix,rows,summaries);const failed=rows.map(row=>({...row}));failed.find(row=>row.id.includes('S2-new')&&row.status==='ready').status='failed';const failSummary={...summaries};failSummary['editor-S2-new-cold']={seriesPass:false};console.log(JSON.stringify({good:good.pass,rejections:good.allRejectionsPass,v2RowCount:rows.filter(row=>row.id.includes('-S2-new-')).length,failed:evaluateModelAcceptance(matrix,failed,failSummary).pass}));`);
		expect(result.good).toBe(true);
		expect(result.rejections).toBe(true);
		expect(result.v2RowCount).toBe(21);
		expect(result.failed).toBe(false);
	});

	test('boot completeness requires every row, every timing series, and valid excluded primes', () => {
		const result = runnerProbe(`const matrix=buildBootScenarioMatrix(['editor']);const rows=matrix.expectedRowIds.map((id,index)=>({id,status:id.endsWith('-prime')?'prime-excluded':'ready',clockValid:true,navigationStartedEpochMs:100+index,chooserEpochMs:150+index,bootInteractivityMs:50,jsGzipLevel9Bytes:123,jsRequestCount:1}));const summaries=Object.fromEntries(matrix.scenarios.map(scenario=>[scenario.id,{seriesPass:true}]));const good=evaluateBootAcceptance(matrix,rows,summaries);const badPrime=rows.map(row=>({...row}));badPrime.find(row=>row.status==='prime-excluded').jsGzipLevel9Bytes=null;const badTiming={...summaries,'editor-boot-desktop-cold':{seriesPass:false}};console.log(JSON.stringify({good:good.pass,expected:matrix.expectedRowCount,prime:evaluateBootAcceptance(matrix,badPrime,summaries).pass,timing:evaluateBootAcceptance(matrix,rows,badTiming).pass,missing:evaluateBootAcceptance(matrix,rows.slice(1),summaries).matrixAudit.matrixComplete}));`);
		expect(result.good).toBe(true);
		expect(result.expected).toBe(42);
		expect(result.prime).toBe(false);
		expect(result.timing).toBe(false);
		expect(result.missing).toBe(false);
	});

	test('sorts --apps selection into canonical app order and rejects empty, duplicate, and unknown IDs', () => {
		const result = runnerProbe(`
			const base=['--baseline','B0','--workspace-root','D:/workspace','--output','out','--editor-url','http://127.0.0.1:5175','--rooms-url','http://127.0.0.1:5174','--benchmark-url','http://127.0.0.1:5173'];
			const selected=parseArgs([...base,'--apps','benchmark,editor']).apps.map((app)=>app.id);
			const rejects=['','editor,editor','other'].map((apps)=>{try{parseArgs([...base,'--apps',apps]);return false}catch{return true}});
			console.log(JSON.stringify({selected,rejects}));`);
		expect(result.selected).toEqual(['editor', 'benchmark']);
		expect(result.rejects).toEqual([true, true, true]);
	});

	test('refuses to append a later run into a non-empty evidence directory', () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), 'bomc-loader-output-'));
		try {
			expect(() => runnerProbe(`assertFreshOutputDirectory(${JSON.stringify(directory)}); console.log(JSON.stringify({pass:true}));`)).not.toThrow();
			writeFileSync(path.join(directory, 'row.jsonl'), '{}\n');
			expect(() => runnerProbe(`assertFreshOutputDirectory(${JSON.stringify(directory)}); console.log(JSON.stringify({pass:true}));`)).toThrow(/non-empty output directory/);
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
});

describe('worker diagnostic acceptance contracts', () => {
	test('keeps diagnostic action/network trace without DOM snapshots or screencast frames', () => {
		const directory=mkdtempSync(path.join(os.tmpdir(),'bomc-minimal-trace-'));
		try {
			const result=browserProbe(`
				import {readFileSync} from 'node:fs';import {unzipSync,strFromU8} from 'fflate';
				const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(${JSON.stringify(`<main data-app="editor"><button class="empty-open" onclick="document.querySelector('input').click()">Open</button><input type="file" hidden onchange="document.querySelector('.empty-error').textContent='BOMC invalid: material section version.'"><div class="empty-error"></div></main>`)});});
				await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
				const browser=await launchBenchmarkBrowser();
				try {
					const row=await performModelAttempt({browser,app:APPS[0],fixture:{id:'trace-test',locator:'test.bomc',bytes:4,payloadBytes:Buffer.from([1,2,3,4])},baseUrl:'http://127.0.0.1:'+server.address().port,mode:'diagnostic-excluded',outputDir:${JSON.stringify(directory)},index:1,diagnostic:true,expectedOutcome:'error'});
					const entries=unzipSync(readFileSync(${JSON.stringify(directory)}+'/'+row.tracePath));
					const traceRows=Object.entries(entries).filter(([name])=>name.endsWith('.trace')).flatMap(([,bytes])=>strFromU8(bytes).trim().split('\\n').map(line=>JSON.parse(line)));
					console.log(JSON.stringify({status:row.status,cleanup:row.cleanupStatus,captureProfile:row.captureProfile,actions:traceRows.filter(item=>item.type==='before'||item.type==='after').length,dom:traceRows.filter(item=>item.type==='frame-snapshot').length,screencast:traceRows.filter(item=>item.type==='screencast-frame').length,network:Object.keys(entries).some(name=>name.endsWith('.network'))}));
				}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
			`);
			expect(result.status).toBe('error');
			expect(result.cleanup).toBe('complete');
			expect(result.actions).toBeGreaterThan(0);
			expect(result.network).toBe(true);
			expect(result.dom).toBe(0);
			expect(result.screencast).toBe(0);
			expect(result.captureProfile).toBe('actions-network-no-dom');
		}finally{rmSync(directory,{recursive:true,force:true});}
	},60_000);
	test('audits wrapped complete epochs without imposing cross-channel arrival order', () => {
		const result = runnerProbe(`
			const events=Array.from({length:71},(_,index)=>({phase:'other',type:'progress',epochMs:index}));
			events[68]={phase:'worker-pre-post',type:'complete',epochMs:1791010688106.7002};
			events[69]={phase:'main-receive',type:'complete',epochMs:1791010688190.9};
			events[70]={phase:'worker-post-return',type:'complete',epochMs:1791010688181.6};
			const actual=workerTraceAudit({diagnostic:{events}},'wrapped');
			const receiptBeforeReturn=workerTraceAudit({diagnostic:{events:[
				{phase:'worker-pre-post',type:'complete',epochMs:10},
				{phase:'main-receive',type:'complete',epochMs:15},
				{phase:'worker-post-return',type:'complete',epochMs:20}
			]}},'wrapped');
			console.log(JSON.stringify({actual,receiptBeforeReturn}));`);
		expect(result.actual.completePhasePositions).toEqual([68, 70, 69]);
		expect(result.actual.completePhaseEpochs).toEqual([1791010688106.7002, 1791010688181.6, 1791010688190.9]);
		expect(result.actual.completeLifecycle).toBe(true);
		expect(result.receiptBeforeReturn.completePhasePositions).toEqual([0, 2, 1]);
		expect(result.receiptBeforeReturn.completePhaseEpochs).toEqual([10, 20, 15]);
		expect(result.receiptBeforeReturn.completeLifecycle).toBe(true);
	});

	test('rejects missing or invalid wrapped phases and validates native receipt epochs', () => {
		const result = runnerProbe(`
			const pre={phase:'worker-pre-post',type:'complete',epochMs:10};
			const post={phase:'worker-post-return',type:'complete',epochMs:20};
			const receive={phase:'main-receive',type:'complete',epochMs:30};
			const audit=events=>workerTraceAudit({diagnostic:{events}},'wrapped').completeLifecycle;
			const native=events=>workerTraceAudit({diagnostic:{events}},'native').completeLifecycle;
			console.log(JSON.stringify({missingReturn:audit([pre,receive]),nonfiniteWorkerEpoch:audit([pre,{...post,epochMs:Number.NaN},receive]),nonfiniteReceiveEpoch:audit([pre,post,{...receive,epochMs:Number.POSITIVE_INFINITY}]),reversedWorkerEpochs:audit([{...pre,epochMs:21},{...post,epochMs:20},receive]),nativeGood:native([{phase:'native-main-receive',type:'complete',epochMs:40}]),nativeMissing:native([]),nativeNonfinite:native([{phase:'native-main-receive',type:'complete',epochMs:Number.NaN}])}));`);
		expect(result.missingReturn).toBe(false);
		expect(result.nonfiniteWorkerEpoch).toBe(false);
		expect(result.nonfiniteReceiveEpoch).toBe(false);
		expect(result.reversedWorkerEpochs).toBe(false);
		expect(result.nativeGood).toBe(true);
		expect(result.nativeMissing).toBe(false);
		expect(result.nativeNonfinite).toBe(false);
	});

	test('requires the bounded L-old row itself to pass in the diagnostic aggregate', () => {
		const result = runnerProbe(`
			const runtimeCounts={resultFacesLength:270,preparedRuntimeSceneGroupsLength:291,sourceCounts:{faces:300,materials:12}};
			const baseAcceptance={runtimeCountsCaptured:true,cleanupComplete:true,appReadyAndValidFrame:true};
			const makeCases=()=>[
				{id:'s2-native',appId:'editor',fixtureId:'S2-jcm',mode:'native',status:'ready',tracePath:'native.json',runtimeCounts,acceptance:{...baseAcceptance,pass:true}},
				{id:'s2-wrapped',appId:'editor',fixtureId:'S2-jcm',mode:'wrapped',status:'ready',tracePath:'wrapped.json',runtimeCounts,acceptance:{...baseAcceptance,pass:true}},
				{id:'l-old',appId:'editor',fixtureId:'L-old',mode:'wrapped',status:'timeout',tracePath:'l-old.json',runtimeCounts,workerTraceAudit:{matchedWorkerCount:1,unmatchedWorkers:[],importErrorCount:0},acceptance:{...baseAcceptance,pass:true,boundedLoldDiagnostic:true}},
				{id:'rooms-y-old',appId:'rooms',fixtureId:'Y-old',mode:'wrapped',status:'ready',tracePath:'rooms.json',runtimeCounts,acceptance:{...baseAcceptance,pass:true}}
			];
			const healthy=summarizeDiagnosticCases(makeCases());
			const importFailure=makeCases();importFailure[2].workerTraceAudit.importErrorCount=1;importFailure[2].acceptance.pass=false;
			const failedLoldRow=makeCases();failedLoldRow[2].acceptance.pass=false;
			const badImport=summarizeDiagnosticCases(importFailure);const badRow=summarizeDiagnosticCases(failedLoldRow);
			console.log(JSON.stringify({healthy:healthy.acceptance,importFailure:badImport.acceptance,failedLoldRow:badRow.acceptance}));`);
		expect(result.healthy.pass).toBe(true);
		expect(result.importFailure.lOldBoundedAndMatched).toBe(false);
		expect(result.importFailure.pass).toBe(false);
		expect(result.failedLoldRow.lOldBoundedAndMatched).toBe(false);
		expect(result.failedLoldRow.pass).toBe(false);
	});
});

describe('browser instrumentation contracts', () => {
	test('optional attempt observers do not block legacy cold, warm, or rejection file selection', () => {
		const result = browserProbe(`
			import { mkdtempSync, rmSync } from 'node:fs'; import os from 'node:os'; import path from 'node:path';
			const selectedByCase = {};
			const server = createServer((request, response) => {
				const url = new URL(request.url, 'http://127.0.0.1');
				if (url.pathname === '/selected') { const key = url.searchParams.get('case'); selectedByCase[key] = (selectedByCase[key] || 0) + 1; response.writeHead(204); response.end(); return; }
				if (url.pathname !== '/') { response.writeHead(404); response.end(); return; }
				response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
				response.end('<!doctype html><main data-app="editor"><button class="empty-open">Open</button><div class="editor-footer"><span class="footer-status">Waiting</span></div><div class="empty-error" role="alert"></div></main><script>const kind = new URL(location.href).searchParams.get("kind"); const key = new URL(location.href).searchParams.get("case"); document.querySelector("button.empty-open").addEventListener("click", () => { const input = document.createElement("input"); input.type = "file"; input.hidden = true; input.addEventListener("change", async () => { await fetch("/selected?case=" + encodeURIComponent(key)); document.querySelector("[role=alert]").textContent = kind === "rejection" ? "BOMC invalid: material section version." : "synthetic app-level failure"; }); document.body.append(input); input.click(); });</script>'); return;
			});
			await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
			const browser = await launchBenchmarkBrowser(); const root = mkdtempSync(path.join(os.tmpdir(), 'bomc-attempt-observer-'));
			const fixture = { id: 'S2-new', locator: 'synthetic/S2-new.bomc', bytes: 3, sha256: '00'.repeat(32), payloadBytes: Buffer.from('abc') };
			const results = {}; const eventTypes = {};
			async function run(key, kind, mode, observer) {
				const events = []; const onAttemptEvent = observer === 'sync' ? event => { events.push(event); } : null;
				const baseUrl = 'http://127.0.0.1:' + server.address().port + '/?case=' + encodeURIComponent(key) + '&kind=' + encodeURIComponent(kind);
				const options = { app: APPS.find(app => app.id === 'editor'), fixture, baseUrl, outputDir: root, scenarioRowId: key, onAttemptEvent };
				let row;
				if (kind === 'rejection') row = await performExpectedRejection({ browser, ...options });
				else if (mode === 'warm') { const { context } = await makeContext(browser, { cacheDisabled: false }); try { row = await performModelAttemptInContext({ ...options, context, browser, mode: 'warm', index: 1 }); } finally { await context.close(); } }
				else row = await performModelAttempt({ ...options, browser, mode: 'cold', index: 1 });
				results[key] = { status: row.status, outcomeText: row.outcomeText, observerError: row.observerError ?? null, cleanupStatus: row.cleanupStatus, rejectionMessageMatchesB0: row.rejectionMessageMatchesB0 ?? null };
				eventTypes[key] = events.map(event => event.type);
			}
			try {
				await run('cold-default', 'plain', 'cold', 'none'); await run('cold-sync', 'plain', 'cold', 'sync');
				await run('warm-default', 'plain', 'warm', 'none'); await run('warm-sync', 'plain', 'warm', 'sync');
				await run('rejection-default', 'rejection', 'cold', 'none'); await run('rejection-sync', 'rejection', 'cold', 'sync');
				for (const [key, callback] of [['observer-throw', () => { throw new Error('observer enqueue failed'); }], ['observer-promise', () => Promise.resolve()]]) {
					const row = await performModelAttempt({ browser, app: APPS.find(app => app.id === 'editor'), fixture, baseUrl: 'http://127.0.0.1:' + server.address().port + '/?case=' + key + '&kind=plain', outputDir: root, mode: 'cold', index: 1, scenarioRowId: key, onAttemptEvent: event => event.type === 'open' ? callback() : true });
					results[key] = { status: row.status, observerError: row.observerError ?? null, cleanupStatus: row.cleanupStatus };
				}
				console.log(JSON.stringify({ results, eventTypes, selectedByCase }));
			} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
		`);
		for (const key of ['cold-default', 'cold-sync', 'warm-default', 'warm-sync']) {
			expect(result.results[key].status).toBe('error');
			expect(result.results[key].observerError).toBeNull();
			expect(result.selectedByCase[key]).toBe(1);
		}
		for (const key of ['rejection-default', 'rejection-sync']) {
			expect(result.results[key].status).toBe('expected-rejection');
			expect(result.results[key].rejectionMessageMatchesB0).toBe(true);
			expect(result.selectedByCase[key]).toBe(1);
		}
		for (const key of ['cold-sync', 'warm-sync', 'rejection-sync']) expect(result.eventTypes[key]).toContain('open');
		for (const key of ['observer-throw', 'observer-promise']) {
			expect(result.results[key].status).toBe('harness-error-observer');
			expect(result.results[key].observerError).toBeTruthy();
			expect(result.results[key].cleanupStatus).toBe('complete');
			expect(result.selectedByCase[key] ?? 0).toBe(0);
		}
	});

	test('keeps the Rooms analysis worker native and rejects foreign, lookalike, and other-app exemptions', () => {
		const result = browserProbe(`
			const server=createServer((req,res)=>{
				if(req.url.includes('.js')) {res.writeHead(200,{'content-type':'text/javascript'});res.end("self.addEventListener('message',event=>{const buffer=event.data.buffer; self.postMessage({type:'result',byte:new Uint8Array(buffer)[0],buffer,name:self.name,url:import.meta.url},[buffer]);});");return;}
				res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>native secondary worker</title>');
			});
			await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
			const url='http://127.0.0.1:'+server.address().port;
			const browser=await launchBenchmarkBrowser(); const observations=[];
			try {for(const mode of ['wrapped','native']) for(const appId of ['rooms','editor',null]) {
				const context=await browser.newContext(); const page=await context.newPage(); const channel='secondary-'+mode+'-'+appId;
				await page.addInitScript(mode==='wrapped'?makeWorkerDiagnosticProbe(channel):makeWorkerNativeControlProbe(channel),{channel,appId});await page.goto(url);
				const observed=await page.evaluate(async({mode})=>{
					const probe=mode==='wrapped'?window.__loaderWorkerProbe:window.__loaderWorkerControlProbe;
					const secondaryUrl=location.origin+'/_app/immutable/workers/rooms-analysis.worker-test.js';
					const worker=new Worker(secondaryUrl,{type:'module',name:'native-analysis'});const buffer=new ArrayBuffer(4);new Uint8Array(buffer)[0]=73;
					const receipt=new Promise(resolve=>worker.addEventListener('message',event=>resolve(event.data),{once:true}));worker.postMessage({buffer},[buffer]);const detached=buffer.byteLength;const reply=await receipt;worker.terminate();
					const lookalike=new Worker('/_app/immutable/workers/rooms-analysis-extra.worker-test.js',{type:'module'});lookalike.terminate();
					try {new Worker('https://foreign.invalid/_app/immutable/workers/rooms-analysis.worker-test.js',{type:'module'});}catch{}
					return {detached,byte:reply.byte,returnedBytes:reply.buffer.byteLength,name:reply.name,url:reply.url,secondaryUrl,events:probe.events};
				},{mode});
				assert.equal(observed.detached,0);assert.equal(observed.byte,73);assert.equal(observed.returnedBytes,4);assert.equal(observed.name,'native-analysis');assert.equal(observed.url,observed.secondaryUrl);
				const known=observed.events.filter(event=>event.phase==='known-secondary-worker');const unknown=observed.events.filter(event=>event.phase===(mode==='wrapped'?'unmatched-worker':'native-unmatched-worker'));
				assert.equal(known.length,appId==='rooms'?1:0);assert.equal(unknown.length,appId==='rooms'?2:3);
				if(appId==='rooms'){assert.equal(known[0].workerKind,'rooms-analysis');assert.equal(known[0].url,observed.secondaryUrl);}
				assert.equal(observed.events.filter(event=>event.phase==='wrapped-worker'||event.phase==='native-worker').length,0);
				observations.push({mode,appId,known:known.length,unknown:unknown.length});await context.close();
			}}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
			console.log(JSON.stringify(observations));
		`);
		expect(result).toEqual([
			{mode:'wrapped',appId:'rooms',known:1,unknown:2}, {mode:'wrapped',appId:'editor',known:0,unknown:3}, {mode:'wrapped',appId:null,known:0,unknown:3},
			{mode:'native',appId:'rooms',known:1,unknown:2}, {mode:'native',appId:'editor',known:0,unknown:3}, {mode:'native',appId:null,known:0,unknown:3}
		]);
	}, 60_000);

	test('buffers worker messages FIFO until its delayed dynamic module import is ready', () => {
		const result = browserProbe(`
			const server = createServer((req,res)=>{
				if (req.url === '/e4-import.worker-race-test.js') { res.writeHead(200,{'content-type':'text/javascript'}); res.end("await new Promise(resolve=>setTimeout(resolve,200)); self.addEventListener('message',event=>{ if(event.data.type==='load') self.postMessage({type:'complete',order:'load',result:{counts:{sourceFaces:401,materials:12},faces:Array(5),preparedRuntimeScene:{groups:Array(7)},diagnostics:{}}}); else if(event.data.type==='missing-counts') self.postMessage({type:'complete',order:'missing-counts',result:{faces:Array(2),preparedRuntimeScene:{groups:Array(3)},diagnostics:{}}}); else if(event.data.type==='cancel') self.postMessage({type:'cancelled',order:'cancel'}); });"); return; }
				res.writeHead(200,{'content-type':'text/html'}); res.end("<!doctype html><div class='viewport'></div><script>const worker=new Worker('/e4-import.worker-race-test.js',{type:'module'});window.raceWorker=worker;window.raceReplies=new Promise(resolve=>{const rows=[];worker.addEventListener('message',event=>{rows.push(event.data);if(rows.length===2)resolve(rows);});});worker.postMessage({type:'load',buffer:new ArrayBuffer(8)});worker.postMessage({type:'cancel'});</script>");
			});
			await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const url='http://127.0.0.1:'+server.address().port+'/';
			const browser=await launchBenchmarkBrowser(); const context=await browser.newContext(); const page=await context.newPage(); const channel='worker-race-'+Date.now(); await page.addInitScript(makeWorkerDiagnosticProbe(channel),channel); await page.goto(url,{waitUntil:'load'});
			const replies=await page.evaluate(()=>Promise.race([window.raceReplies,new Promise((_,reject)=>setTimeout(()=>reject(new Error('worker replies timed out')),5000))]));
			const missingReply=await page.evaluate(()=>new Promise(resolve=>{const worker=window.raceWorker;const handler=event=>{if(event.data?.order==='missing-counts'){worker.removeEventListener('message',handler);resolve(event.data);}};worker.addEventListener('message',handler);worker.postMessage({type:'missing-counts'});}));
			await page.waitForFunction(()=>{const e=window.__loaderWorkerProbe.events;return e.filter(x=>x.phase==='worker-ingress-replayed').length===2&&e.filter(x=>x.phase==='worker-pre-post'&&x.type==='complete').length===2&&e.filter(x=>x.phase==='worker-post-return'&&x.type==='complete').length===2;},null,{timeout:5000});
			const events=await page.evaluate(()=>window.__loaderWorkerProbe.events); const queued=events.filter(x=>x.phase==='worker-ingress-queued'); const replayed=events.filter(x=>x.phase==='worker-ingress-replayed'); const prePost=events.filter(x=>x.phase==='worker-pre-post'); const postReturn=events.filter(x=>x.phase==='worker-post-return'); const received=events.filter(x=>x.phase==='main-receive');
			const completeGraphs=prePost.filter(x=>x.type==='complete').map(x=>x.graph.runtimeCounts); const fullResult=replies.find(x=>x.order==='load').result; assert.deepEqual(replies.map(x=>x.order),['load','cancel']); assert.equal(queued.length,2); assert.deepEqual(replayed.map(x=>x.type),['load','cancel']); assert.equal(prePost.filter(x=>x.type==='complete').length,2); assert.equal(prePost.filter(x=>x.type==='cancelled').length,1); assert.equal(postReturn.filter(x=>x.type==='complete').length,2); assert.equal(received.filter(x=>x.type==='complete').length,2); assert.deepEqual(completeGraphs[0],{resultFacesLength:5,preparedRuntimeSceneGroupsLength:7,sourceCounts:{sourceFaces:401,materials:12}}); assert.deepEqual(completeGraphs[1],{resultFacesLength:2,preparedRuntimeSceneGroupsLength:3,sourceCounts:null}); assert.deepEqual(fullResult.counts,{sourceFaces:401,materials:12}); assert.equal(fullResult.diagnostics.counts,undefined); assert.equal(missingReply.result.counts,undefined); assert.equal(events.filter(x=>x.phase==='wrapped-worker').length,1); assert.equal(events.filter(x=>x.phase==='worker-import-error').length,0);
			await context.close(); await browser.close(); await new Promise(resolve=>server.close(resolve)); console.log(JSON.stringify({queued:queued.length,replayed:replayed.map(x=>x.type),completeGraphs}));`);
		expect(result.queued).toBe(2);
		expect(result.replayed).toEqual(['load', 'cancel']);
		expect(result.completeGraphs[0]).toEqual({ resultFacesLength: 5, preparedRuntimeSceneGroupsLength: 7, sourceCounts: { sourceFaces: 401, materials: 12 } });
		expect(result.completeGraphs[1]).toEqual({ resultFacesLength: 2, preparedRuntimeSceneGroupsLength: 3, sourceCounts: null });
	});

	test('observes an actual WebGL2 instanced triangle and excludes invalid draw targets', () => {
		const result = browserProbe(`
			const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end("<!doctype html><div class='viewport'></div>");}); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const url='http://127.0.0.1:'+server.address().port+'/'; const browser=await launchBenchmarkBrowser();
			async function run(mode){const context=await browser.newContext();const page=await context.newPage();await page.addInitScript(makeFrameProbe());await page.goto(url);const value=await page.evaluate(async(mode)=>{const host=document.querySelector('.viewport');const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;canvas.style.width=mode==='zero-size'?'0px':'64px';canvas.style.height=mode==='zero-size'?'0px':'64px';host.append(canvas);const isWebgl2=!['angle','multi','multi-instanced','multi-invalid'].includes(mode);const gl=canvas.getContext(isWebgl2?'webgl2':'webgl',{antialias:false});if(!gl)throw new Error('WebGL context unavailable');
				const vs=gl.createShader(gl.VERTEX_SHADER);gl.shaderSource(vs,isWebgl2?'#version 300 es\\nin vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}':'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}');gl.compileShader(vs);if(!gl.getShaderParameter(vs,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(vs));const fs=gl.createShader(gl.FRAGMENT_SHADER);gl.shaderSource(fs,isWebgl2?'#version 300 es\\nprecision highp float;out vec4 color;void main(){color=vec4(0.0,1.0,0.0,1.0);}':'precision mediump float;void main(){gl_FragColor=vec4(0.0,1.0,0.0,1.0);}');gl.compileShader(fs);if(!gl.getShaderParameter(fs,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(fs));const program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));gl.useProgram(program);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,0,1]),gl.STATIC_DRAW);const loc=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
				if(mode==='zero')gl.drawArraysInstanced(gl.TRIANGLES,0,0,1);else if(mode==='angle'){const ext=gl.getExtension('ANGLE_instanced_arrays');if(!ext)throw new Error('ANGLE_instanced_arrays unavailable');ext.drawArraysInstancedANGLE(gl.TRIANGLES,0,3,1);}else if(mode==='multi'){const ext=gl.getExtension('WEBGL_multi_draw');if(!ext)throw new Error('WEBGL_multi_draw unavailable');ext.multiDrawArraysWEBGL(gl.TRIANGLES,new Int32Array([0]),0,new Int32Array([3]),0,1);}else if(mode==='multi-instanced'){const ext=gl.getExtension('WEBGL_multi_draw');if(!ext)throw new Error('WEBGL_multi_draw unavailable');ext.multiDrawArraysInstancedWEBGL(gl.TRIANGLES,new Int32Array([0]),0,new Int32Array([3]),0,new Int32Array([1]),0,1);}else if(mode==='multi-invalid'){const ext=gl.getExtension('WEBGL_multi_draw');if(!ext)throw new Error('WEBGL_multi_draw unavailable');ext.multiDrawArraysInstancedWEBGL(gl.TRIANGLES,new Int32Array([0,0]),0,new Int32Array([3,0]),0,new Int32Array([0,1]),0,2);}else gl.drawArraysInstanced(gl.TRIANGLES,0,3,1);const pixel=new Uint8Array(4);if(['instanced','angle','multi','multi-instanced','multi-invalid'].includes(mode))gl.readPixels(32,32,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);if(mode==='detached')canvas.remove();if(mode==='context-lost'){const lose=gl.getExtension('WEBGL_lose_context');if(!lose)throw new Error('WEBGL_lose_context unavailable');lose.loseContext();await new Promise(resolve=>setTimeout(resolve,50));}await new Promise(resolve=>requestAnimationFrame(()=>resolve()));return {pixel:[...pixel],lost:gl.isContextLost()};},mode);await page.waitForTimeout(50);const observation=await page.evaluate(()=>({frame:window.__loaderBaselineProbe.firstFrame,extensionHooks:window.__loaderBaselineProbe.extensionHooks}));await context.close();return {...observation,...value};}
			const positive=await run('instanced');const angle=await run('angle');const multi=await run('multi');const multiInstanced=await run('multi-instanced');const multiInvalid=await run('multi-invalid');const zero=await run('zero');const detached=await run('detached');const zeroSize=await run('zero-size');const contextLost=await run('context-lost');assert.equal(positive.frame?.method,'drawArraysInstanced');assert.deepEqual(positive.pixel,[0,255,0,255]);assert.equal(angle.frame?.method,'drawArraysInstancedANGLE');assert.deepEqual(angle.pixel,[0,255,0,255]);assert.equal(angle.extensionHooks['WebGLRenderingContext.ANGLE_instanced_arrays'],'observed');assert.equal(multi.frame?.method,'multiDrawArraysWEBGL');assert.deepEqual(multi.pixel,[0,255,0,255]);assert.equal(multi.extensionHooks['WebGLRenderingContext.WEBGL_multi_draw'],'observed');assert.equal(multiInstanced.frame?.method,'multiDrawArraysInstancedWEBGL');assert.deepEqual(multiInstanced.pixel,[0,255,0,255]);assert.equal(multiInvalid.frame,null);assert.equal(zero.frame,null);assert.equal(detached.frame,null);assert.equal(zeroSize.frame,null);assert.equal(contextLost.lost,true);assert.equal(contextLost.frame,null);await browser.close();await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify({method:positive.frame.method,pixel:positive.pixel,angle:angle.frame.method,anglePixel:angle.pixel,multi:multi.frame.method,multiPixel:multi.pixel,multiInstanced:multiInstanced.frame.method,multiInvalid:multiInvalid.frame,zero:zero.frame,detached:detached.frame,zeroSize:zeroSize.frame,contextLost:contextLost.frame}));`);
		expect(result.method).toBe('drawArraysInstanced');
		expect(result.pixel).toEqual([0, 255, 0, 255]);
		expect(result.angle).toBe('drawArraysInstancedANGLE');
		expect(result.anglePixel).toEqual([0, 255, 0, 255]);
		expect(result.multi).toBe('multiDrawArraysWEBGL');
		expect(result.multiPixel).toEqual([0, 255, 0, 255]);
		expect(result.multiInstanced).toBe('multiDrawArraysInstancedWEBGL');
		expect(result.multiInvalid).toBeNull();
		expect(result.zero).toBeNull();
		expect(result.detached).toBeNull();
		expect(result.zeroSize).toBeNull();
		expect(result.contextLost).toBeNull();
	});
});
