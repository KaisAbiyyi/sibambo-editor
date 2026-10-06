import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { BomcDocument } from '../../../packages/bomc-document/src/document.ts';
import { readWebBomc } from '../../../packages/bomc-document/src/reader.ts';
import { BomcWriter } from '../../../packages/bomc-document/src/writer.ts';
import type { BomcGraph, Instance } from '../../../packages/bomc-document/src/types.ts';
import { createFacesBenchmarkGraph, createInstancesBenchmarkGraph } from '../../../packages/bomc-document/src/test-fixtures/documents.ts';

const harnessRoot = path.dirname(fileURLToPath(import.meta.url));
const editorRoot = path.resolve(harnessRoot, '../../..');
const workspaceRoot = path.resolve(editorRoot, '..');
const oraclePath = path.join(harnessRoot, 'oracle.rb');
const rubyPath = 'C:/Ruby25-x64/bin/ruby.exe';
const SCENARIO_BUDGET_MS = 180_000;
const cases = [
	{ name: 'B-FACES', create: createFacesBenchmarkGraph },
	{ name: 'B-INSTANCES', create: createInstancesBenchmarkGraph }
] as const;
const sourcePaths = [
	'package.json', 'bun.lock', 'packages/tsconfig.json', 'packages/bomc-document/package.json', 'packages/bomc-document/tsconfig.json', 'packages/bomc-document/README.md',
	'packages/bomc-document/src/index.ts', 'packages/bomc-document/src/types.ts', 'packages/bomc-document/src/document.ts',
	'packages/bomc-document/src/binary.ts', 'packages/bomc-document/src/section-codec.ts', 'packages/bomc-document/src/writer.ts',
	'packages/bomc-document/src/reader.ts', 'packages/bomc-document/src/source-envelope.ts', 'packages/bomc-document/src/test-fixtures/documents.ts',
	'packages/bomc-document/src/binary.test.ts', 'packages/bomc-document/src/document.test.ts', 'packages/bomc-document/src/roundtrip.test.ts',
	'packages/bomc-document/src/writer-cache.test.ts', 'packages/bomc-document/src/source-envelope.test.ts', 'packages/bomc-document/src/consumer-compatibility.test.ts',
	'tooling/performance/bomc-writer/index.html', 'tooling/performance/bomc-writer/entry.ts', 'tooling/performance/bomc-writer/writer.worker.ts',
	'tooling/performance/bomc-writer/oracle.rb', 'tooling/performance/bomc-writer/interop.ts', 'tooling/performance/bomc-writer/benchmark.ts',
	'tooling/performance/bomc-writer/proof.spec.ts', 'tooling/performance/bomc-writer/playwright.config.ts',
	'tooling/performance/bomc-writer/vite.config.ts', 'tooling/performance/bomc-writer/tsconfig.json'
];

function cliValue(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
function sha256(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }
function sourceIdentity() {
	return {
		gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: editorRoot, encoding: 'utf8' }).trim(),
		files: sourcePaths.map((relativePath) => ({ path: relativePath, sha256: sha256(readFileSync(path.join(editorRoot, relativePath))) }))
	};
}
function assertNested(root: string, child: string) {
	const relative = path.relative(path.resolve(root), path.resolve(child));
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Evidence path must be a child of ${root}.`);
}
function median(values: number[]) {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
function stageSummary(rows: Array<Record<string, any>>) {
	const keys = ['constructionMs', 'wallMs', 'validationMs', 'encodeMs', 'compressMs', 'assemblyMs', 'hashMs', 'totalMs', 'rawBytes', 'storedBytes', 'totalBytes', 'cacheBytes', 'knownPeakBinaryBytes'];
	return Object.fromEntries(keys.map((key) => {
		const values = rows.map((row) => {
			const value = row[key] as number | Record<string, number>;
			return typeof value === 'number' ? value : Object.values(value).reduce((sum, bytes) => sum + bytes, 0);
		});
		return [key, { median: median(values), worst: Math.max(...values), samples: values }];
	}));
}
function matricesOf(snapshot: BomcGraph) { return snapshot.instances.map((instance) => ({ id: instance.id, matrix: [...instance.matrix] })); }
function cloneArrayBuffer(bytes: Uint8Array) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; }
type ScenarioBudget = { name: string; startedAtMs: number; deadlineMs: number };
function remainingBudget(budget: ScenarioBudget, phase: string) {
	const remaining = Math.floor(budget.deadlineMs - performance.now());
	if (remaining <= 0) throw new Error(`${budget.name} exceeded its ${SCENARIO_BUDGET_MS}ms scenario budget before ${phase}; elapsed ${Math.round(performance.now() - budget.startedAtMs)}ms.`);
	return remaining;
}
function checkBudget(budget: ScenarioBudget, phase: string) { remainingBudget(budget, phase); }
async function writeWithinBudget(writer: BomcWriter, budget: ScenarioBudget, phase: string) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), remainingBudget(budget, phase));
	try {
		const output = await writer.write({ signal: controller.signal });
		checkBudget(budget, `completion of ${phase}`);
		return output;
	} catch (error) {
		if (controller.signal.aborted) throw new Error(`${budget.name} exceeded its ${SCENARIO_BUDGET_MS}ms scenario budget during ${phase}.`, { cause: error });
		throw error;
	} finally { clearTimeout(timeout); }
}
function oracle(filePath: string, budget: ScenarioBudget, processReport: Record<string, unknown>) {
	const startedAt = new Date().toISOString();
	const started = Date.now();
	const timeout = Math.min(60_000, remainingBudget(budget, 'Ruby oracle start'));
	const result = spawnSync(rubyPath, [oraclePath, filePath, 'summary'], { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
	Object.assign(processReport, { startedAt, completedAt: new Date().toISOString(), elapsedMs: Date.now() - started, exitCode: result.status, signal: result.signal, stderr: result.stderr?.slice(0, 4000) ?? '', error: result.error?.message ?? null });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Ruby benchmark sample failed after ${Date.now() - started}ms (${result.status}): ${result.stderr || result.stdout}`);
	checkBudget(budget, 'Ruby oracle completion');
	processReport.outputParsed = true;
	return JSON.parse(result.stdout) as Record<string, any>;
}
function firstLastProjection(graph: BomcGraph) {
	const meshes = [...graph.meshes].sort((left, right) => left.id.localeCompare(right.id));
	const faces = meshes.flatMap((mesh) => [...mesh.faces].sort((left, right) => left.id.localeCompare(right.id)));
	const instances = [...graph.instances].sort((left, right) => left.id === graph.rootInstanceId ? -1 : right.id === graph.rootInstanceId ? 1 : left.id.localeCompare(right.id));
	const scalarHex = (values: readonly number[]) => {
		const data = new ArrayBuffer(values.length * 8); const view = new DataView(data);
		values.forEach((value, index) => view.setFloat64(index * 8, value, true));
		return [...new Uint8Array(data)].map((value) => value.toString(16).padStart(2, '0')).join('');
	};
	const vectorHex = (values: readonly number[]) => values.map((value) => scalarHex([value]));
	const faceProjection = (face: (typeof faces)[number]) => ({ id: face.id, outer: [...face.outer], holes: face.holes.map((row) => [...row]), triangles: [...face.triangles], normal: vectorHex(face.normal), surface: face.surfaceCode, hidden: face.hidden, role: face.roleCode });
	const instanceProjection = (instance: Instance) => ({
		id: instance.id, name: instance.name, kind: instance.kind,
		owner: instance.ownerDefinitionId, definition: instance.definitionId, visible: instance.visible, matrix_f64le: vectorHex(instance.matrix)
	});
	const definitionCount = graph.definitions.length;
	return {
		counts: { materials: graph.materials.length, meshes: graph.meshes.length, faces: faces.length, definitions: definitionCount, instances: instances.length, transforms: instances.length, edges: graph.meshes.reduce((sum, mesh) => sum + mesh.faces.reduce((local, face) => local + face.outer.length + face.holes.reduce((holeSum, ring) => holeSum + ring.length, 0), 0), 0) },
		first_position_f64le: meshes[0] ? scalarHex([meshes[0]!.positions[0]!]).slice(0, 16) : null,
		last_position_f64le: meshes.at(-1) ? scalarHex([meshes.at(-1)!.positions.at(-1)!]).slice(0, 16) : null,
		first_face: faces[0] ? faceProjection(faces[0]) : null, last_face: faces.at(-1) ? faceProjection(faces.at(-1)!) : null,
		first_instance: instances[0] ? instanceProjection(instances[0]) : null, last_instance: instances.at(-1) ? instanceProjection(instances.at(-1)!) : null
	};
}


async function verifyOutput(bytes: Uint8Array, expected: BomcGraph, revision: number, context: string, runRuby: boolean, budget: ScenarioBudget, sample: Record<string, any>, sampleOutput: string) {
	checkBudget(budget, `${context} canonical read`);
	const restored = await readWebBomc(bytes);
	assert.deepStrictEqual(restored.snapshot().graph, expected, `${context} graph differs after independent canonical read`);
	assert.equal(restored.snapshot().revision, revision, `${context} revision changed`);
	checkBudget(budget, `${context} canonical read completion`);
	const sourceHash = sha256(bytes);
	let rubyProof: string | 'not-run-this-repetition' = 'not-run-this-repetition';
	const rubyProcess: Record<string, unknown> = { status: runRuby ? 'pending' : 'not-run-this-repetition' };
	const expectedCounts = firstLastProjection(expected).counts;
	try {
		if (runRuby) {
			const projection = firstLastProjection(expected);
			const temporaryRoot = process.env.SIBAMBO_WRITER_TEMPORARY;
			if (!temporaryRoot || !path.isAbsolute(temporaryRoot) || !existsSync(temporaryRoot)) throw new Error('SIBAMBO_WRITER_TEMPORARY must be a pre-created absolute temporary directory.');
			const samplePath = path.join(temporaryRoot, `${context.replaceAll(/[^a-z0-9-]/gi, '-')}-${sourceHash}.bomc`);
			writeFileSync(samplePath, new Uint8Array(cloneArrayBuffer(bytes)), { flag: 'wx' });
			rubyProcess.status = 'running';
			sample[sampleOutput].rubyProcess = rubyProcess;
			const independent = oracle(samplePath, budget, rubyProcess);
			assert.deepStrictEqual(independent.counts, expectedCounts, `${context} Ruby graph counts differ`);
			for (const key of ['first_position_f64le', 'last_position_f64le', 'first_face', 'last_face', 'first_instance', 'last_instance'] as const) {
				assert.deepStrictEqual(independent[key], projection[key], `${context} Ruby ${key} sample differs`);
			}
			rubyProof = 'passed';
		}
		checkBudget(budget, `${context} verification completion`);
		return { hash: sourceHash, revision, canonicalRead: 'passed', independentRubySample: rubyProof, rubyProcess, counts: expectedCounts };
	} finally { restored.dispose(); }
}

async function run() {
	const worklogValue = cliValue('--worklog');
	if (!worklogValue || !path.isAbsolute(worklogValue)) throw new Error('Pass --worklog with a fresh absolute implementation-run directory.');
	const worklogRoot = path.resolve(worklogValue);
	assertNested(path.join(workspaceRoot, 'docs/worklogs/BOMC-WEB-WRITER-001'), worklogRoot);
	const outputRoot = path.join(worklogRoot, 'benchmark');
	const temporaryRoot = path.join(outputRoot, 'ruby-samples');
	const startedAt = new Date().toISOString();
	let identity: ReturnType<typeof sourceIdentity> | null = null;
	const scenarioReports: Array<Record<string, any>> = [];
	let activeScenario: Record<string, any> | null = null;
	let activeSample: Record<string, any> | null = null;
	let activePhase = 'preflight';
	let toolVersions: Record<string, string> = {};
	let report: Record<string, unknown>;
	try {
		identity = sourceIdentity();
		if (existsSync(outputRoot) || existsSync(path.join(outputRoot, 'benchmark-report.json'))) throw new Error(`Preserving existing benchmark evidence at ${outputRoot}`);
		mkdirSync(temporaryRoot, { recursive: true });
		process.env.SIBAMBO_WRITER_TEMPORARY = temporaryRoot;
		activePhase = 'tool-versions';
		toolVersions = {
			bun: execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(), node: process.version,
			ruby: execFileSync(rubyPath, ['--version'], { encoding: 'utf8' }).trim(),
			fflate: JSON.parse(readFileSync(path.join(editorRoot, 'node_modules/fflate/package.json'), 'utf8')).version
		};
		for (const scenario of cases) {
			const scenarioStartedAtMs = performance.now();
			const budget: ScenarioBudget = { name: scenario.name, startedAtMs: scenarioStartedAtMs, deadlineMs: scenarioStartedAtMs + SCENARIO_BUDGET_MS };
			const rows: Array<Record<string, any>> = [];
			activeScenario = { name: scenario.name, budgetMs: SCENARIO_BUDGET_MS, startedAt: new Date().toISOString(), startedAtMs: scenarioStartedAtMs, status: 'running', samples: rows };
			scenarioReports.push(activeScenario);
			for (let repetition = 0; repetition < 5; repetition += 1) {
				activePhase = `${scenario.name}/repetition-${repetition + 1}/start`;
				checkBudget(budget, `repetition ${repetition + 1} start`);
				const sample: Record<string, any> = { repetition: repetition + 1, status: 'running' };
				rows.push(sample);
				activeSample = sample;
				activeScenario.currentRepetition = repetition + 1;
				const constructionStarted = performance.now();
				activePhase = `${scenario.name}/repetition-${repetition + 1}/construction`;
				const graph = scenario.create();
				const document = BomcDocument.fromGraph(graph);
				let storeWriter: BomcWriter | null = null;
				let autoWriter: BomcWriter | null = null;
				try {
				const constructionMs = performance.now() - constructionStarted;
				sample.constructionMs = constructionMs;
				checkBudget(budget, `repetition ${repetition + 1} post-construction`);
				const initialGraph = document.snapshot().graph;
				storeWriter = new BomcWriter(document, { compressionMode: 'store-only' });
				activePhase = `${scenario.name}/repetition-${repetition + 1}/store`;
				const storeStarted = performance.now();
				const store = await writeWithinBudget(storeWriter, budget, `repetition ${repetition + 1} STORE write`);
				const storeWallMs = performance.now() - storeStarted;
				sample.store = { wallMs: storeWallMs, sha256: store.sha256, byteLength: store.bytes.byteLength, stats: store.stats, stage: 'written' };
				activePhase = `${scenario.name}/repetition-${repetition + 1}/store-verification`;
				const storeCheck = await verifyOutput(store.bytes, initialGraph, 0, `${scenario.name}-r${repetition + 1}-store`, repetition === 0, budget, sample, 'store');
				sample.store = { ...sample.store, proof: storeCheck, stage: 'verified' };
				autoWriter = new BomcWriter(document, { compressionMode: 'auto' });
				activePhase = `${scenario.name}/repetition-${repetition + 1}/cold-auto`;
				const autoStarted = performance.now();
				const cold = await writeWithinBudget(autoWriter, budget, `repetition ${repetition + 1} cold AUTO write`);
				const coldWallMs = performance.now() - autoStarted;
				sample.coldAuto = { wallMs: coldWallMs, sha256: cold.sha256, byteLength: cold.bytes.byteLength, stats: cold.stats, stage: 'written' };
				activePhase = `${scenario.name}/repetition-${repetition + 1}/cold-auto-verification`;
				const coldCheck = await verifyOutput(cold.bytes, initialGraph, 0, `${scenario.name}-r${repetition + 1}-cold`, repetition === 0, budget, sample, 'coldAuto');
				sample.coldAuto = { ...sample.coldAuto, proof: coldCheck, stage: 'verified' };
				const warmStarted = performance.now();
				activePhase = `${scenario.name}/repetition-${repetition + 1}/warm-auto`;
				const warm = await writeWithinBudget(autoWriter, budget, `repetition ${repetition + 1} warm AUTO write`);
				const warmWallMs = performance.now() - warmStarted;
				sample.warmAuto = { wallMs: warmWallMs, sha256: warm.sha256, byteLength: warm.bytes.byteLength, stats: warm.stats, stage: 'written' };
				activePhase = `${scenario.name}/repetition-${repetition + 1}/warm-auto-verification`;
				const warmCheck = await verifyOutput(warm.bytes, initialGraph, 0, `${scenario.name}-r${repetition + 1}-warm`, repetition === 0, budget, sample, 'warmAuto');
				sample.warmAuto = { ...sample.warmAuto, proof: warmCheck, stage: 'verified' };
				assert.equal(warm.sha256, cold.sha256, `${scenario.name} warm hash changed`);
				assert.deepStrictEqual(warm.bytes, cold.bytes, `${scenario.name} warm bytes changed`);
				assert.deepStrictEqual(warm.stats.encodedSectionTypes, []);
				assert.deepStrictEqual(warm.stats.compressionAttemptTypes, []);
				assert.equal(warm.stats.hashMs, 0);
				assert.equal(warm.stats.encodeMs, 0);
				assert.equal(warm.stats.compressMs, 0);
				assert.deepStrictEqual(warm.stats.reusedSectionTypes, [...cold.stats.encodedSectionTypes]);
				const transformTarget = [...initialGraph.instances].filter((instance) => instance.kind !== 'root').sort((left, right) => left.id.localeCompare(right.id))[0];
				if (!transformTarget) throw new Error(`${scenario.name} has no child instance for its locked transform-only edit.`);
				const movedMatrix = [...transformTarget.matrix]; movedMatrix[12] = movedMatrix[12]! + 0.25;
				document.transact([{ type: 'put-instance', value: { ...transformTarget, matrix: movedMatrix } }]);
				const changedGraph = document.snapshot().graph;
				const beforeInstances = matricesOf(initialGraph);
				const afterInstances = matricesOf(changedGraph);
				assert.equal(changedGraph.instances.length, initialGraph.instances.length);
				assert.equal(afterInstances.filter((instance, index) => JSON.stringify(instance.matrix) !== JSON.stringify(beforeInstances[index]!.matrix)).length, 1);
				const transformStarted = performance.now();
				activePhase = `${scenario.name}/repetition-${repetition + 1}/transform-only`;
				const transform = await writeWithinBudget(autoWriter, budget, `repetition ${repetition + 1} transform-only write`);
				const transformWallMs = performance.now() - transformStarted;
				sample.transformOnly = { wallMs: transformWallMs, sha256: transform.sha256, byteLength: transform.bytes.byteLength, stats: transform.stats, changedInstanceId: transformTarget.id, stage: 'written' };
				activePhase = `${scenario.name}/repetition-${repetition + 1}/transform-only-verification`;
				const transformCheck = await verifyOutput(transform.bytes, changedGraph, 1, `${scenario.name}-r${repetition + 1}-transform`, repetition === 0, budget, sample, 'transformOnly');
				sample.transformOnly = { ...sample.transformOnly, proof: transformCheck, stage: 'verified' };
				assert.deepStrictEqual(transform.stats.encodedSectionTypes, [1, 13, 241], `${scenario.name} transform-only encoded set differs`);
				const allOutputTypes = Object.keys(cold.stats.rawSectionBytes).map(Number).sort((left, right) => left - right);
				assert.deepStrictEqual(transform.stats.reusedSectionTypes, allOutputTypes.filter((type) => ![1, 13, 241].includes(type)), `${scenario.name} transform-only reuse set differs`);
				const unchangedTypes = allOutputTypes.filter((type) => ![1, 13, 241].includes(type));
				for (const type of unchangedTypes) assert.equal(transform.stats.storedSectionBytes[type], cold.stats.storedSectionBytes[type], `${scenario.name} section ${type} stored bytes changed`);
				assert.equal(cold.bytes.byteLength <= store.bytes.byteLength, true, `${scenario.name} auto output exceeded STORE size`);
				Object.assign(sample, {
					constructionMs,
					store: { wallMs: storeWallMs, stats: store.stats, proof: storeCheck, sha256: store.sha256, byteLength: store.bytes.byteLength, stage: 'verified' },
					coldAuto: { wallMs: coldWallMs, stats: cold.stats, proof: coldCheck, sha256: cold.sha256, byteLength: cold.bytes.byteLength, stage: 'verified' },
					warmAuto: { wallMs: warmWallMs, stats: warm.stats, proof: warmCheck, sha256: warm.sha256, byteLength: warm.bytes.byteLength, stage: 'verified' },
					transformOnly: { wallMs: transformWallMs, stats: transform.stats, proof: transformCheck, sha256: transform.sha256, byteLength: transform.bytes.byteLength, changedInstanceId: transformTarget.id, stage: 'verified' }
				});
				} finally {
					storeWriter?.dispose();
					autoWriter?.dispose();
					document.dispose();
				}
				checkBudget(budget, `repetition ${repetition + 1} completion`);
				sample.status = 'passed';
				sample.completedAt = new Date().toISOString();
				activeScenario.completedSamples = rows.length;
				activeSample = null;
			}
			const storeRows = rows.map((row) => ({ constructionMs: row.constructionMs, wallMs: row.store.wallMs, ...row.store.stats, rawBytes: row.store.stats.rawSectionBytes, storedBytes: row.store.stats.storedSectionBytes }));
			const coldRows = rows.map((row) => ({ constructionMs: row.constructionMs, wallMs: row.coldAuto.wallMs, ...row.coldAuto.stats, rawBytes: row.coldAuto.stats.rawSectionBytes, storedBytes: row.coldAuto.stats.storedSectionBytes }));
			const warmRows = rows.map((row) => ({ constructionMs: row.constructionMs, wallMs: row.warmAuto.wallMs, ...row.warmAuto.stats, rawBytes: row.warmAuto.stats.rawSectionBytes, storedBytes: row.warmAuto.stats.storedSectionBytes }));
			const transformRows = rows.map((row) => ({ constructionMs: row.constructionMs, wallMs: row.transformOnly.wallMs, ...row.transformOnly.stats, rawBytes: row.transformOnly.stats.rawSectionBytes, storedBytes: row.transformOnly.stats.storedSectionBytes }));
			const sizeGate = rows.every((row) => row.coldAuto.stats.totalBytes < row.store.stats.totalBytes);
			if (!sizeGate) throw new Error(`${scenario.name} AUTO output is not strictly smaller than STORE for every measured sample.`);
			const coldMedian = median(rows.map((row) => row.coldAuto.wallMs));
			const warmMedian = median(rows.map((row) => row.warmAuto.wallMs));
			Object.assign(activeScenario, {
				status: 'passed', budgetMs: SCENARIO_BUDGET_MS, elapsedMs: Math.round(performance.now() - scenarioStartedAtMs), completedAt: new Date().toISOString(), repetitions: rows.length, hardGates: { autoStrictlySmallerThanStoreEverySample: sizeGate, warmStructuralReuse: true, transformOnlyStructuralReuse: true },
				timingBenefit: warmMedian > coldMedian * 1.1 ? 'UNPROVEN: warm median exceeds cold-auto median by more than 10%' : 'not disproven by the 10% comparison',
				stageSummary: { store: stageSummary(storeRows), coldAuto: stageSummary(coldRows), warmAuto: stageSummary(warmRows), transformOnly: stageSummary(transformRows) }, samples: rows
			});
			activeScenario = null;
		}
		report = {
			status: 'passed', planId: 'BOMC-WEB-WRITER-001', planVersion: '1.1', startedAt, completedAt: new Date().toISOString(),
			identity, toolVersions,
			fixtureConstructionOutsideWriteTiming: true, rubyOracleSamples: 'first and last face/instance plus counts for every first-repetition output', scenarios: scenarioReports,
			nonClaims: ['timings do not demonstrate real imported-model save speed', 'knownPeakBinaryBytes excludes graph heap and runtime/library scratch', 'zero browser responsiveness evidence is collected by this Node benchmark']
		};
	} catch (error) {
		const failure = error instanceof Error ? { name: error.name, message: error.message } : String(error);
		if (activeSample) Object.assign(activeSample, { status: 'failed', failedPhase: activePhase, completedAt: new Date().toISOString(), error: failure });
		if (activeScenario) Object.assign(activeScenario, { status: 'failed', failedPhase: activePhase, elapsedMs: Math.round(performance.now() - Number(activeScenario.startedAtMs ?? performance.now())), completedAt: new Date().toISOString(), error: failure });
		report = {
			status: 'failed', planId: 'BOMC-WEB-WRITER-001', planVersion: '1.1', startedAt, completedAt: new Date().toISOString(),
			identity, toolVersions, scenarios: scenarioReports, failedPhase: activePhase,
			failure: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
		};
	}
	const reportPath = path.join(outputRoot, 'benchmark-report.json');
	writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
	if (report.status !== 'passed') throw new Error(`Benchmark gate failed; see ${reportPath}.`);
	console.log(JSON.stringify({ report: reportPath, scenarios: 2, status: report.status }, null, 2));
}

await run();
