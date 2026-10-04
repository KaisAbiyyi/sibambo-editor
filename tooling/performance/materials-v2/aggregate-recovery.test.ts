import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { aggregateRecoveryEvidence, type AggregateRecoveryInput } from './aggregate-recovery';

const sourceFiles = [
	'packages/e4-import/src/bomc-loader.ts',
	'packages/e4-import/src/semantic-colorize.ts',
	'packages/e4-import/src/image-pixel-codec.ts',
	'packages/e4-import/package.json',
	'bun.lock'
];
const pins = {
	'S1-new': { bytes: 2_428_754, sha256: 'd306fb89c0a59edf5ecdbcaf26d27e795e521cceb1c689e59958e1038932918c', materials: 50, sourceTextures: 15, active: 12, jpeg: 11, webp: 1 },
	'S2-new': { bytes: 2_319_634, sha256: 'df19a9f07df845661d065b98b221dbcfc53e9ec2c3efe7a11f434b7fcb0ac452', materials: 48, sourceTextures: 13, active: 10, jpeg: 10, webp: 0 },
	'I-new': { bytes: 28_765_513, sha256: '01bf898df9a8b377f4d48ea4825c51427f2e18dbded865144363d5642a235825', materials: 184, sourceTextures: 68, active: 17, jpeg: 13, webp: 4 },
	'Y-new': { bytes: 34_496_013, sha256: '5bca4efdf0ac4f502b810179d51e49defbbc63406e98bb1f7641db1fb1d14c6f', materials: 125, sourceTextures: 43, active: 15, jpeg: 14, webp: 1 }
} as const;
const titles = {
	'S1-new': 'texture-only semantic pixel proof S1-new',
	'S2-new': 'texture-only semantic pixel proof S2-new',
	'I-new': 'texture-only semantic pixel proof I-new',
	'Y-new': 'texture-only semantic pixel proof Y-new',
	'generated-png': 'generated PNG codec case preserves alpha-zero RGB and Ruby output bytes'
} as const;
const pngHash = 'png-rgba-hash';
const sourceIdentity = Object.fromEntries(sourceFiles.map((name) => [name, `sha-${name}`]));

describe('aggregateRecoveryEvidence', () => {
	it('aggregates all passed cases from attempt 01', () => {
		const input = buildInput([{ attempt: '01', ids: allCases(), passed: true }]);
		const result = aggregateRecoveryEvidence(input);
		expect(result.passed).toBe(true);
		expect(result.activeMaterialRows).toBe(54);
		expect(result.activeMediaCounts).toEqual({ PNG: 0, JPEG: 48, WebP: 6 });
		expect(result.selectedReceipts).toHaveLength(5);
	});

	it('combines passed rows split across immutable attempt directories', () => {
		const input = buildInput([
			{ attempt: '01', ids: ['S1-new', 'S2-new'], passed: true },
			{ attempt: '02', ids: ['I-new', 'Y-new', 'generated-png'], passed: true }
		]);
		const result = aggregateRecoveryEvidence(input);
		expect(result.passed).toBe(true);
		expect(result.selectedReceipts.map((receipt) => [receipt.fixtureId, receipt.attempt])).toEqual([
			['S1-new', '01'], ['S2-new', '01'], ['I-new', '02'], ['Y-new', '02'], ['generated-png', '02']
		]);
	});

	it('rejects a raw complete report when final reporter status failed', () => {
		const input = buildInput([{ attempt: '01', ids: allCases(), passed: true }]);
		input.attempts[0]!.reporter = reporter(allCases(), ['S1-new']);
		const result = aggregateRecoveryEvidence(input);
		expect(result.passed).toBe(false);
		expect(result.failures.some((failure) => failure.includes('S1-new: no final-status-passed reporter case'))).toBe(true);
	});

	it('rejects a skipped or missing generated-PNG final case', () => {
		const input = buildInput([{ attempt: '01', ids: ['S1-new', 'S2-new', 'I-new', 'Y-new'], passed: true }]);
		input.attempts[0]!.reporter!.suites![0]!.specs!.push({ title: titles['generated-png'], tests: [{ expectedStatus: 'passed', status: 'skipped', results: [{ status: 'skipped', retry: 0 }] }] });
		const result = aggregateRecoveryEvidence(input);
		expect(result.passed).toBe(false);
		expect(result.failures.some((failure) => failure.includes('generated-png: no final-status-passed reporter case'))).toBe(true);
	});

	it('rejects any selected report whose five-file source identity drifted', () => {
		const input = buildInput([{ attempt: '01', ids: allCases(), passed: true }]);
		input.attempts[0]!.rawReports['S2-new']!.sourceIdentity['packages/e4-import/src/bomc-loader.ts'] = 'different-source';
		const result = aggregateRecoveryEvidence(input);
		expect(result.passed).toBe(false);
		expect(result.failures.some((failure) => failure.includes('S2-new: proof sourceIdentity differs'))).toBe(true);
	});

	it('rejects executing a case again after it passed in attempt 01', () => {
		const input = buildInput([
			{ attempt: '01', ids: allCases(), passed: true },
			{ attempt: '02', ids: ['S1-new'], passed: false }
		]);
		const result = aggregateRecoveryEvidence(input);
		expect(result.passed).toBe(false);
		expect(result.failures.some((failure) => failure.includes('S1-new: successful attempt-01 case was executed again in attempt-02'))).toBe(true);
	});

	it('does not mutate the fixture reports while aggregating', () => {
		const input = buildInput([{ attempt: '01', ids: allCases(), passed: true }]);
		const before = structuredClone(input.attempts[0]!.rawReports);
		aggregateRecoveryEvidence(input);
		expect(input.attempts[0]!.rawReports).toEqual(before);
	});

	it('allows two pure --list imports without creating outputDir or JSON output', () => {
		const testDir = path.dirname(fileURLToPath(import.meta.url));
		const editorRoot = path.resolve(testDir, '../../..');
		const workspaceRoot = path.resolve(editorRoot, '..');
		const parent = path.join(workspaceRoot, 'docs/worklogs/BOMC-MATERIALS-V2-001');
		const priorMetadata = path.join(parent, '2026-10-04-implementation-run-001/oracle/metadata.json');
		const tempRoot = mkdtempSync(path.join(parent, '.aggregate-list-only-'));
		const oracleDir = path.join(tempRoot, 'oracle');
		const outputDir = path.join(tempRoot, 'pixel-playwright/attempt-02');
		let preserveFailureArtifacts = false;
		try {
			mkdirSync(oracleDir, { recursive: true });
			cpSync(priorMetadata, path.join(oracleDir, 'metadata.json'));
			const env = { ...process.env, SIBAMBO_M2_WORKLOG: tempRoot, SIBAMBO_M2_ATTEMPT: '02' };
			delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
			for (let index = 0; index < 2; index += 1) {
				const result = spawnSync(process.execPath, ['x', 'playwright', 'test', '--config', path.join(testDir, 'playwright.config.ts'), '--list'], {
					cwd: editorRoot, env, encoding: 'utf8', timeout: 30_000, windowsHide: true
				});
				if (result.error || result.status !== 0) {
					preserveFailureArtifacts = true;
					throw new Error(`--list invocation ${index + 1} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
				}
				if (existsSync(outputDir) || existsSync(path.join(outputDir, 'playwright-results.json'))) {
					preserveFailureArtifacts = true;
					throw new Error(`--list invocation ${index + 1} created outputDir or reporter JSON`);
				}
			}
		} finally {
			if (!preserveFailureArtifacts) rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});

function allCases() { return [...Object.keys(pins), 'generated-png']; }

function buildInput(invocations: Array<{ attempt: '01' | '02'; ids: string[]; passed: boolean }>): AggregateRecoveryInput {
	const fixtures = Object.entries(pins).map(([id, pin]) => {
		const materials = Array.from({ length: pin.materials }, (_, index) => {
			const active = index < pin.active;
			return {
				materialIndex: index,
				textureIndex: active ? 100 + index : null,
				activeSemantic: active,
				...(active ? { semantic: { outputRgbaSha256: `rgba-${id}-${index}` } } : {})
			};
		});
		return { id, bytes: pin.bytes, sha256: pin.sha256, materialVersion: 2, sourceTextureCount: pin.sourceTextures, activeSemanticCount: pin.active, materials };
	});
	const attempts = invocations.map(({ attempt, ids, passed }) => ({
		attempt,
		reporter: reporter(ids, passed ? [] : ids.filter((id) => id === 'S1-new')),
		rawReports: Object.fromEntries(ids.map((id) => [id, id === 'generated-png' ? pngReport() : textureReport(id as keyof typeof pins, fixtures.find((fixture) => fixture.id === id)!)]))
	}));
	return {
		metadata: {
			schemaVersion: 'bomc-materials-v2-ruby-oracle-v1',
			producer: { commit: 'producer-commit', sourceSha256: { 'bom_engine/bomc_decoder.rb': 'decoder-sha', 'bom_engine/bomc_sketchup_colorize.rb': 'color-sha' } },
			fixtureManifestSha256: 'manifest-sha',
			fixtures,
			activeSemanticMaterialCount: 54
		},
		vectorOracle: { caseCount: 1_408, pngCase: { expectedRgbaSha256: pngHash } },
		current: {
			fixtureManifestSha256: 'manifest-sha', producerCommit: 'producer-commit',
			producerSourceSha256: { 'bom_engine/bomc_decoder.rb': 'decoder-sha', 'bom_engine/bomc_sketchup_colorize.rb': 'color-sha' },
			sourceIdentity: structuredClone(sourceIdentity)
		},
		attempts
	};
}

function reporter(ids: string[], failedIds: string[]) {
	return {
		config: { projects: [{ retries: 0, repeatEach: 1 }] },
		suites: [{ specs: ids.map((id) => ({
			title: titles[id as keyof typeof titles],
			tests: [{ expectedStatus: 'passed', status: failedIds.includes(id) ? 'unexpected' : 'expected', results: [{ status: failedIds.includes(id) ? 'failed' : 'passed', retry: 0 }] }]
		})) }]
	};
}

function textureReport(fixtureId: keyof typeof pins, fixture: AggregateRecoveryInput['metadata']['fixtures'][number]) {
	const pin = pins[fixtureId];
	const active = fixture.materials.filter((material) => material.activeSemantic);
	const indices = active.map((material) => material.textureIndex!);
	const rows = active.map((material) => ({ materialIndex: material.materialIndex, textureIndex: material.textureIndex, expectedRgbaSha256: material.semantic!.outputRgbaSha256, actualRgbaSha256: material.semantic!.outputRgbaSha256, assetPath: `bomc/textures/semantic-${material.materialIndex}.png` }));
	const roundTripHash = `fixture-round-trip-${fixtureId}`;
	return {
		fixtureId, sourceIdentity: structuredClone(sourceIdentity), pageErrors: [], consoleErrors: [], wasmResponses: [{ status: 200, sameOrigin: true }], executionError: null,
		result: {
			status: 'complete', workerLifecycle: { created: true, terminated: true, listenersRemoved: true, terminalMessageCount: 1, terminalType: 'complete' }, rows,
			report: {
				fixtureId, sourceFileBytes: pin.bytes, sourceFileSha256: pin.sha256, materialVersion: 2, materialCount: pin.materials, sourceTextureCount: pin.sourceTextures,
				activeCount: pin.active, sourcePayloadsUnchanged: true, generatedAliasesSourceBlob: false, workerErrors: 0, geometryLoadedSections: [],
				activeMediaCounts: { PNG: 0, JPEG: pin.jpeg, WebP: pin.webp }, activeTextureIndices: indices,
				diagnostics: { activeCount: pin.active, verifiedCount: pin.active, baseDecodeCount: indices.length, maxLiveBaseFrames: 1, maxLiveOutputFrames: 1, maxMemoEntries: 8 },
				generatedPngRoundTrips: [{ passed: true, expectedRgbaSha256: roundTripHash, actualRgbaSha256: roundTripHash }],
				baseObservations: indices.map((textureIndex) => ({ textureIndex }))
			}
		}
	};
}

function pngReport() {
	return {
		fixtureId: 'generated-png', sourceIdentity: structuredClone(sourceIdentity), pageErrors: [], consoleErrors: [], wasmResponses: [{ status: 200, sameOrigin: true }], executionError: null,
		result: {
			status: 'complete', workerLifecycle: { created: true, terminated: true, listenersRemoved: true, terminalMessageCount: 1, terminalType: 'complete' },
			report: { fixtureId: 'generated-png', sourcePngRoundTripExact: true, generatedPngRoundTripExact: true, expectedRgbaSha256: pngHash, actualRgbaSha256: pngHash, workerErrors: 0 }
		}
	};
}
