import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { BomcDocument, deriveGraphBounds } from '../../../packages/bomc-document/src/document.ts';
import { readWebBomc } from '../../../packages/bomc-document/src/reader.ts';
import { BomcWriter } from '../../../packages/bomc-document/src/writer.ts';
import type { BomcGraph, CompressionMode } from '../../../packages/bomc-document/src/types.ts';
import {
	createColorGraph, createConcaveGraph, createEmptyGraph, createExtrusionNegativeGraph, createExtrusionPositiveGraph,
	createHiddenColorGraph, createHoleGraph, createInvisibleColorGraph, createNestedGraph, createOriginGraph,
	createPrecisionGraph, createSharedGraph, createWidthGraph
} from '../../../packages/bomc-document/src/test-fixtures/documents.ts';

const harnessRoot = path.dirname(fileURLToPath(import.meta.url));
const editorRoot = path.resolve(harnessRoot, '../../..');
const workspaceRoot = path.resolve(editorRoot, '..');
const rubyPath = 'C:/Ruby25-x64/bin/ruby.exe';
const oraclePath = path.join(harnessRoot, 'oracle.rb');
const fixtureFactories: ReadonlyArray<[string, () => BomcGraph]> = [
	['empty', createEmptyGraph], ['precision', createPrecisionGraph], ['origin', createOriginGraph], ['hole', createHoleGraph],
	['concave', createConcaveGraph], ['extrusion-positive', createExtrusionPositiveGraph], ['extrusion-negative', createExtrusionNegativeGraph],
	['shared', createSharedGraph], ['nested', createNestedGraph], ['color', createColorGraph], ['hidden-color', createHiddenColorGraph],
	['invisible-color', createInvisibleColorGraph], ['width', createWidthGraph]
];
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
const sourcePinFile = path.join(workspaceRoot, 'docs/worklogs/BOMC-WEB-WRITER-001/2026-10-05-plan-investigation/evidence.json');

function cliValue(name: string) {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}
function sha256(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }
function assertNested(root: string, child: string) {
	const relative = path.relative(path.resolve(root), path.resolve(child));
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Evidence path must be a child of ${root}.`);
}
function bytesHex(values: readonly number[]) {
	const buffer = new ArrayBuffer(values.length * 8);
	const view = new DataView(buffer);
	values.forEach((value, index) => view.setFloat64(index * 8, value, true));
	return [...new Uint8Array(buffer)].reduce((hex, value) => hex + value.toString(16).padStart(2, '0'), '');
}
function f64HexValues(values: readonly number[]) { return values.map((value) => bytesHex([value])); }
function faceArea(positions: readonly number[], triangles: readonly number[]) {
	let area = 0;
	for (let index = 0; index < triangles.length; index += 3) {
		const a = triangles[index]! * 3; const b = triangles[index + 1]! * 3; const c = triangles[index + 2]! * 3;
		const ux = positions[b]! - positions[a]!; const uy = positions[b + 1]! - positions[a + 1]!; const uz = positions[b + 2]! - positions[a + 2]!;
		const vx = positions[c]! - positions[a]!; const vy = positions[c + 1]! - positions[a + 1]!; const vz = positions[c + 2]! - positions[a + 2]!;
		area += Math.sqrt((uy * vz - uz * vy) ** 2 + (uz * vx - ux * vz) ** 2 + (ux * vy - uy * vx) ** 2) * 0.5;
	}
	return area;
}
function sorted<T extends { id: string }>(values: readonly T[], rootId?: string) {
	return [...values].sort((left, right) => left.id === rootId ? -1 : right.id === rootId ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
function expectedOracle(graphValue: BomcGraph, revision: number) {
	const document = BomcDocument.fromGraph(graphValue, revision);
	try {
		const graph = document.snapshot().graph;
		const materials = sorted(graph.materials);
		const definitions = sorted(graph.definitions, graph.rootDefinitionId);
		const meshes = sorted(graph.meshes);
		const instances = sorted(graph.instances, graph.rootInstanceId);
		const edgesFor = (mesh: BomcGraph['meshes'][number]) => {
			const edgeMap = new Map<string, [number, number]>();
			for (const face of mesh.faces) for (const ring of [face.outer, ...face.holes]) for (let index = 0; index < ring.length; index += 1) {
				const a = ring[index]!; const b = ring[(index + 1) % ring.length]!; const pair: [number, number] = a < b ? [a, b] : [b, a]; edgeMap.set(`${pair[0]}:${pair[1]}`, pair);
			}
			return [...edgeMap.values()].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
		};
		const faces = meshes.flatMap((mesh) => sorted(mesh.faces));
		const projection = {
			format: { name: 'BOMC', version: '1.2', profile: 'production' },
			source: { file_name: null, model_name: graph.name },
			coordinate_system: { units: 'm', handedness: 'right', up_axis: '+Z' },
			bounds: (() => { const bounds = deriveGraphBounds(graph); return { min: [...bounds.min], max: [...bounds.max] }; })(),
			authoring: {
				schema: 1, revision, document_id: graph.documentId,
				counts: [materials.length, definitions.length, meshes.length, faces.length, instances.length],
				ids: {
					materials: materials.map((item) => item.id), definitions: definitions.map((item) => item.id),
					meshes: meshes.map((item) => item.id), faces: faces.map((item) => item.id), instances: instances.map((item) => item.id)
				}
			},
			counts: {
				materials: materials.length, meshes: meshes.length, faces: faces.length, definitions: definitions.length,
				instances: instances.length, transforms: instances.length, edges: meshes.reduce((sum, mesh) => sum + edgesFor(mesh).length, 0)
			},
			materials: materials.map((item) => ({ id: item.id, name: item.name, display_name: item.displayName, rgba: [...item.rgba], opacity_u16: item.opacityU16, texture: null })),
			definitions: definitions.map((item) => ({ id: item.id, name: item.name, kind: item.kind, mesh_id: item.meshId })),
			meshes: meshes.map((mesh) => ({
				id: mesh.id, definition: mesh.definitionId, positions_f64le: f64HexValues(mesh.positions),
				faces: sorted(mesh.faces).map((face) => ({
					id: face.id, outer: [...face.outer], holes: face.holes.map((ring) => [...ring]), triangles: [...face.triangles],
					normal: f64HexValues(face.normal), surface: face.surfaceCode, hidden: face.hidden, role: face.roleCode,
					front_material: face.frontMaterialId, back_material: face.backMaterialId, label: face.label,
					area: faceArea(mesh.positions, face.triangles)
				})), edges: edgesFor(mesh)
			})),
			instances: instances.map((item) => ({
				id: item.id, name: item.name, kind: item.kind, owner: item.ownerDefinitionId,
				definition: item.definitionId, material: item.materialId, visible: item.visible,
				role: item.roleCode, label: item.label, matrix_f64le: f64HexValues(item.matrix)
			}))
		};
		return projection;
	} finally { document.dispose(); }
}

function verifyPinnedInputs() {
	const evidence = JSON.parse(readFileSync(sourcePinFile, 'utf8')) as { sourcePins: Array<{ Path: string; SHA256: string }> };
	if (evidence.sourcePins.length !== 9) throw new Error('The plan must provide exactly nine pinned reference files.');
	const results = evidence.sourcePins.map(({ Path: relativePath, SHA256 }) => {
		const absolute = path.join(workspaceRoot, relativePath.replaceAll('/', path.sep));
		const actual = sha256(readFileSync(absolute));
		if (actual !== SHA256) throw new Error(`Pinned reference changed: ${relativePath}`);
		return { path: relativePath, sha256: actual };
	});
	return results;
}

function runRubyOracle(filePath: string, row: Record<string, any>) {
	const startedAt = new Date().toISOString();
	const result = spawnSync(rubyPath, [oraclePath, filePath], { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
	row.rubyProcess = {
		startedAt, completedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal,
		stderr: result.stderr?.slice(0, 4000) ?? '', error: result.error?.message ?? null
	};
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Pinned Ruby decoder failed (${result.status}): ${result.stderr || result.stdout}`);
	const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
	row.rubyProcess.parsedOutput = true;
	return parsed;
}

function sourceIdentity() {
	return {
		gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: editorRoot, encoding: 'utf8' }).trim(),
		files: sourcePaths.map((relativePath) => ({ path: relativePath, sha256: sha256(readFileSync(path.join(editorRoot, relativePath))) }))
	};
}

async function run() {
	const worklogValue = cliValue('--worklog');
	if (!worklogValue || !path.isAbsolute(worklogValue)) throw new Error('Pass --worklog with a fresh absolute implementation-run directory.');
	const worklogRoot = path.resolve(worklogValue);
	assertNested(path.join(workspaceRoot, 'docs/worklogs/BOMC-WEB-WRITER-001'), worklogRoot);
	const outputRoot = path.join(worklogRoot, 'generated', 'interop');
	const manifestPath = path.join(worklogRoot, 'interop-run.json');
	const startedAt = new Date().toISOString();
	const cases: Array<Record<string, unknown>> = [];
	let stage = 'source-identity';
	let currentCase: { fixture: string; mode: string } | null = null;
	let identity: ReturnType<typeof sourceIdentity> | null = null;
	let pins: Array<{ path: string; sha256: string }> = [];
	let toolVersions: Record<string, string> = {};
	let result: Record<string, unknown>;
	try {
		identity = sourceIdentity();
		stage = 'reference-pins';
		pins = verifyPinnedInputs();
		stage = 'tool-versions';
		toolVersions = {
			bun: execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(),
			node: process.version,
			ruby: execFileSync(rubyPath, ['--version'], { encoding: 'utf8' }).trim(),
			fflate: JSON.parse(readFileSync(path.join(editorRoot, 'node_modules/fflate/package.json'), 'utf8')).version
		};
		if (existsSync(outputRoot) || existsSync(manifestPath)) throw new Error(`Preserving existing interop evidence at ${existsSync(outputRoot) ? outputRoot : manifestPath}`);
		stage = 'create-output-directory';
		mkdirSync(outputRoot, { recursive: true });
		for (const [fixtureName, factory] of fixtureFactories) {
			for (const mode of ['store-only', 'auto'] satisfies CompressionMode[]) {
				currentCase = { fixture: fixtureName, mode };
			const row: Record<string, any> = { ...currentCase, status: 'running', stage: 'create-document', startedAt: new Date().toISOString(), stageHistory: [{ name: 'create-document', startedAt: new Date().toISOString() }] };
				cases.push(row);
				const markStage = (value: string) => {
					const previous = row.stageHistory.at(-1);
					if (previous && !previous.completedAt) previous.completedAt = new Date().toISOString();
					row.stage = value;
					stage = `${fixtureName}/${mode}/${value}`;
					row.stageHistory.push({ name: value, startedAt: new Date().toISOString() });
				};
				let document: BomcDocument | null = null;
				let writer: BomcWriter | null = null;
				let restored: BomcDocument | null = null;
				try {
					const graph = factory();
					document = BomcDocument.fromGraph(graph, 7);
					writer = new BomcWriter(document, { compressionMode: mode });
					const writeStartedAt = new Date().toISOString();
					const writeStartedMs = performance.now();
					markStage('write');
					const output = await writer.write();
					const writeCompletedAt = new Date().toISOString();
					const writeDurationMs = Math.max(0, performance.now() - writeStartedMs);
					const filename = `${fixtureName}-${mode}.bomc`;
					const outputPath = path.join(outputRoot, filename);
					row.outputFile = filename;
					row.byteLength = output.bytes.byteLength;
					row.sha256 = output.sha256;
					row.sectionTypes = output.stats.encodedSectionTypes;
					markStage('save-output');
					writeFileSync(outputPath, output.bytes, { flag: 'wx' });
					const savedSha256 = sha256(readFileSync(outputPath));
					assert.equal(savedSha256, output.sha256, `${fixtureName}/${mode} saved artifact hash differs from the writer result`);
					row.savedSha256 = savedSha256;
					markStage('canonical-read');
					restored = await readWebBomc(output.bytes);
					assert.deepStrictEqual(restored.snapshot().graph, document.snapshot().graph, `${fixtureName}/${mode} TypeScript graph round-trip differs`);
					assert.equal(restored.snapshot().revision, 7, `${fixtureName}/${mode} revision changed`);
					markStage('ruby-oracle');
					const ruby = runRubyOracle(outputPath, row);
					const expected = expectedOracle(graph, 7);
					assert.deepStrictEqual({
						format: ruby.format, source: ruby.source, coordinate_system: ruby.coordinate_system, bounds: ruby.bounds, authoring: ruby.authoring,
						counts: ruby.counts, materials: ruby.materials, definitions: ruby.definitions, meshes: ruby.meshes, instances: ruby.instances
					}, expected, `${fixtureName}/${mode} independent Ruby projection differs from original graph`);
					markStage('complete');
					Object.assign(row, { status: 'passed', stage: 'complete', writeStartedAt, writeCompletedAt, writeDurationMs, rubyExit: 0, tsRoundTrip: 'passed', oracle: 'passed', completedAt: new Date().toISOString() });
				} finally {
					writer?.dispose();
					restored?.dispose();
					document?.dispose();
				}
				currentCase = null;
			}
		}
		stage = 'complete';
		result = {
			status: 'passed', planId: 'BOMC-WEB-WRITER-001', planVersion: '1.1', startedAt, completedAt: new Date().toISOString(),
			stage, identity, sourcePins: pins, toolVersions, requestedModes: ['store-only', 'auto'], actualModes: [...new Set(cases.map((row) => row.mode))],
			fixtureCount: fixtureFactories.length, writeCount: cases.length, cases, evidenceFiles: cases.map((row) => row.outputFile).filter(Boolean)
		};
	} catch (error) {
		if (currentCase) {
			const row = cases.at(-1);
			if (row) {
				const message = error instanceof Error ? error.message : String(error);
				const active = Array.isArray(row.stageHistory)
					? row.stageHistory.at(-1) as { completedAt?: string; status?: string; error?: string } | undefined
					: undefined;
				if (active && !active.completedAt) Object.assign(active, { completedAt: new Date().toISOString(), status: 'failed', error: message });
				Object.assign(row, { status: 'failed', failedStage: row.stage, completedAt: new Date().toISOString(), error: message });
			}
		}
		result = {
			status: 'failed', planId: 'BOMC-WEB-WRITER-001', planVersion: '1.1', startedAt, completedAt: new Date().toISOString(),
			stage, currentCase, identity, sourcePins: pins, toolVersions, requestedModes: ['store-only', 'auto'],
			cases, evidenceFiles: cases.map((row) => row.outputFile).filter(Boolean),
			failure: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
		};
	}
	writeFileSync(manifestPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
	if (result.status !== 'passed') throw new Error(`Interop gate failed; see ${manifestPath}.`);
	console.log(JSON.stringify({ manifest: manifestPath, outputRoot, cases: (result.cases as unknown[]).length, status: result.status }, null, 2));
}

await run();
