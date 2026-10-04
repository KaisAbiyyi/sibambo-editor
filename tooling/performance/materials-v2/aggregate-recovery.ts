import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturePins = {
	'S1-new': { bytes: 2_428_754, sha256: 'd306fb89c0a59edf5ecdbcaf26d27e795e521cceb1c689e59958e1038932918c', materials: 50, sourceTextures: 15, active: 12, jpeg: 11, webp: 1 },
	'S2-new': { bytes: 2_319_634, sha256: 'df19a9f07df845661d065b98b221dbcfc53e9ec2c3efe7a11f434b7fcb0ac452', materials: 48, sourceTextures: 13, active: 10, jpeg: 10, webp: 0 },
	'I-new': { bytes: 28_765_513, sha256: '01bf898df9a8b377f4d48ea4825c51427f2e18dbded865144363d5642a235825', materials: 184, sourceTextures: 68, active: 17, jpeg: 13, webp: 4 },
	'Y-new': { bytes: 34_496_013, sha256: '5bca4efdf0ac4f502b810179d51e49defbbc63406e98bb1f7641db1fb1d14c6f', materials: 125, sourceTextures: 43, active: 15, jpeg: 14, webp: 1 }
} as const;

const proofTitles = {
	'S1-new': 'texture-only semantic pixel proof S1-new',
	'S2-new': 'texture-only semantic pixel proof S2-new',
	'I-new': 'texture-only semantic pixel proof I-new',
	'Y-new': 'texture-only semantic pixel proof Y-new',
	'generated-png': 'generated PNG codec case preserves alpha-zero RGB and Ruby output bytes'
} as const;

const sourcePaths = [
	'packages/e4-import/src/bomc-loader.ts',
	'packages/e4-import/src/semantic-colorize.ts',
	'packages/e4-import/src/image-pixel-codec.ts',
	'packages/e4-import/package.json',
	'bun.lock'
] as const;

type OracleMaterial = {
	materialIndex: number;
	textureIndex: number | null;
	activeSemantic: boolean;
	semantic?: { outputRgbaSha256: string };
};
type OracleFixture = {
	id: keyof typeof fixturePins;
	bytes: number;
	sha256: string;
	materialVersion: number;
	sourceTextureCount: number;
	activeSemanticCount: number;
	materials: OracleMaterial[];
};
type OracleMetadata = {
	schemaVersion: string;
	producer: { commit: string; sourceSha256: Record<string, string> };
	fixtureManifestSha256: string;
	fixtures: OracleFixture[];
	activeSemanticMaterialCount: number;
};
type ProofReport = {
	fixtureId: string;
	sourceIdentity: Record<string, string>;
	result: any;
	pageErrors?: string[];
	consoleErrors?: string[];
	wasmResponses?: Array<{ status: number; sameOrigin: boolean }>;
	 executionError?: string | null;
};
type ReporterTest = { expectedStatus?: string; status?: string; results?: Array<{ status?: string; retry?: number }> };
type ReporterSpec = { title?: string; tests?: ReporterTest[] };
type ReporterSuite = { specs?: ReporterSpec[]; suites?: ReporterSuite[] };
type ReporterJson = { config?: { projects?: Array<{ retries?: number; repeatEach?: number }> }; suites?: ReporterSuite[] };
type AttemptEvidence = { attempt: '01' | '02'; reporter: ReporterJson | null; rawReports: Record<string, ProofReport | null> };
export type AggregateRecoveryInput = {
	metadata: OracleMetadata;
	vectorOracle: { caseCount: number; pngCase: { expectedRgbaSha256: string } };
	current: { fixtureManifestSha256: string; producerCommit: string; producerSourceSha256: Record<string, string>; sourceIdentity: Record<string, string> };
	attempts: AttemptEvidence[];
};

export type AggregateRecoveryResult = {
	gate: 'M2-PIXEL-recovery';
	passed: boolean;
	activeMaterialRows: number;
	activeMediaCounts: { PNG: number; JPEG: number; WebP: number };
	selectedReceipts: Array<{ fixtureId: string; attempt: '01' | '02'; testTitle: string; reporterStatus: string; sourceIdentity: Record<string, string> }>;
	failures: string[];
};

/** Pure report/reporter aggregation. It never launches a browser or reads/writes files. */
export function aggregateRecoveryEvidence(input: AggregateRecoveryInput): AggregateRecoveryResult {
	const failures: string[] = [];
	const activeMediaCounts = { PNG: 0, JPEG: 0, WebP: 0 };
	const selectedReceipts: AggregateRecoveryResult['selectedReceipts'] = [];
	const attempts = [...input.attempts].sort((a, b) => a.attempt.localeCompare(b.attempt));

	if (attempts.length < 1 || attempts.length > 2 || new Set(attempts.map((item) => item.attempt)).size !== attempts.length) {
		failures.push('attempt set must contain one or two unique invocations');
	}
	validateOracle(input, failures);
	for (const attempt of attempts) {
		if (!attempt.reporter) {
			failures.push(`attempt-${attempt.attempt}: missing Playwright JSON reporter`);
			continue;
		}
		const projects = attempt.reporter.config?.projects;
		if (!projects?.length || projects.some((project) => project.retries !== 0 || project.repeatEach !== 1)) {
			failures.push(`attempt-${attempt.attempt}: Playwright retries/repeatEach must be 0/1`);
		}
	}

	const selectedByFixture = new Map<string, { attempt: AttemptEvidence; raw: ProofReport; reporterStatus: string }>();
	const caseIds = [...Object.keys(fixturePins), 'generated-png'] as const;
	for (const fixtureId of caseIds) {
		const title = proofTitles[fixtureId];
		const observed = attempts.flatMap((attempt) => findReporterTests(attempt.reporter, title).map((test) => ({ attempt, test })));
		const executions = observed.filter(({ test }) => (test.results?.length ?? 0) > 0 && test.results?.some((result) => result.status !== 'skipped'));
		if (executions.length > 2) failures.push(`${fixtureId}: more than two actual data executions`);

		const eligibleByAttempt = attempts.flatMap((attempt) => findReporterTests(attempt.reporter, title)
			.filter((test) => isEligiblePassed(test, hasValidRetryConfig(attempt.reporter))
				&& test.results?.length === 1 && test.results[0]?.retry === 0)
			.map((test) => ({ attempt, test })));
		if (eligibleByAttempt.length > 1) failures.push(`${fixtureId}: duplicate passing proof cases across attempts`);
		const attempt01Passed = observed.some(({ attempt, test }) => attempt.attempt === '01' &&
			isEligiblePassed(test, hasValidRetryConfig(attempt.reporter)) && test.results?.[0]?.retry === 0);
		if (attempt01Passed && executions.some(({ attempt }) => attempt.attempt === '02')) {
			failures.push(`${fixtureId}: successful attempt-01 case was executed again in attempt-02`);
		}

		const selected = eligibleByAttempt[0];
		if (!selected) {
			failures.push(`${fixtureId}: no final-status-passed reporter case`);
			continue;
		}
		const raw = selected.attempt.rawReports[fixtureId];
		if (!raw) {
			failures.push(`${fixtureId}: missing original raw proof report for attempt-${selected.attempt.attempt}`);
			continue;
		}
		if (!sameRecord(raw.sourceIdentity, input.current.sourceIdentity, sourcePaths)) {
			failures.push(`${fixtureId}: proof sourceIdentity differs from current five-file source identity`);
			continue;
		}
		const caseFailures = fixtureId === 'generated-png'
			? validatePngReport(raw, input.vectorOracle.pngCase.expectedRgbaSha256)
			: validateTextureReport(raw, input.metadata.fixtures.find((fixture) => fixture.id === fixtureId)!, fixturePins[fixtureId]);
		if (caseFailures.length) {
			failures.push(...caseFailures.map((message) => `${fixtureId}: ${message}`));
			continue;
		}
		selectedByFixture.set(fixtureId, { attempt: selected.attempt, raw, reporterStatus: selected.test.status ?? 'missing' });
		selectedReceipts.push({ fixtureId, attempt: selected.attempt.attempt, testTitle: title, reporterStatus: selected.test.status ?? 'missing', sourceIdentity: raw.sourceIdentity });
		if (fixtureId !== 'generated-png') {
			const counts = raw.result.report.activeMediaCounts as { PNG: number; JPEG: number; WebP: number };
			activeMediaCounts.PNG += counts.PNG;
			activeMediaCounts.JPEG += counts.JPEG;
			activeMediaCounts.WebP += counts.WebP;
		}
	}

	const activeMaterialRows = [...selectedByFixture.keys()].filter((fixtureId) => fixtureId !== 'generated-png')
		.reduce((sum, fixtureId) => sum + fixturePins[fixtureId as keyof typeof fixturePins].active, 0);
	if (activeMaterialRows !== 54) failures.push(`active texture rows total ${activeMaterialRows}, expected 54`);
	if (activeMediaCounts.PNG !== 0 || activeMediaCounts.JPEG !== 48 || activeMediaCounts.WebP !== 6) {
		failures.push(`active media totals ${JSON.stringify(activeMediaCounts)}, expected PNG 0 / JPEG 48 / WebP 6`);
	}
	return { gate: 'M2-PIXEL-recovery', passed: failures.length === 0, activeMaterialRows, activeMediaCounts, selectedReceipts, failures };
}

function validateOracle(input: AggregateRecoveryInput, failures: string[]) {
	const { metadata, vectorOracle, current } = input;
	if (metadata.schemaVersion !== 'bomc-materials-v2-ruby-oracle-v1' || metadata.activeSemanticMaterialCount !== 54 || vectorOracle.caseCount !== 1_408) {
		failures.push('oracle metadata/vector identity is invalid');
	}
	if (metadata.fixtureManifestSha256 !== current.fixtureManifestSha256) failures.push('fixture manifest SHA-256 differs from oracle metadata');
	if (metadata.producer.commit !== current.producerCommit) failures.push('current producer commit differs from Ruby oracle provenance');
	for (const [relativePath, expectedHash] of Object.entries(metadata.producer.sourceSha256)) {
		if (current.producerSourceSha256[relativePath] !== expectedHash) failures.push(`producer oracle source hash differs: ${relativePath}`);
	}
	for (const [fixtureId, pin] of Object.entries(fixturePins)) {
		const fixture = metadata.fixtures.find((candidate) => candidate.id === fixtureId);
		if (!fixture || fixture.bytes !== pin.bytes || fixture.sha256 !== pin.sha256 || fixture.materials.length !== pin.materials ||
			fixture.sourceTextureCount !== pin.sourceTextures || fixture.activeSemanticCount !== pin.active || fixture.materialVersion !== 2) {
			failures.push(`Ruby metadata does not match the frozen ${fixtureId} inventory`);
		}
	}
	const activeCount = metadata.fixtures.reduce((sum, fixture) => sum + fixture.materials.filter((material) => material.activeSemantic).length, 0);
	if (activeCount !== 54) failures.push(`Ruby metadata accounts for ${activeCount} active rows, expected 54`);
	if (Object.keys(current.sourceIdentity).length !== sourcePaths.length || sourcePaths.some((file) => !current.sourceIdentity[file])) {
		failures.push('current sourceIdentity must contain exactly the five pinned semantic source files');
	}
}

function findReporterTests(reporter: ReporterJson | null, exactTitle: string): ReporterTest[] {
	const found: ReporterTest[] = [];
	const visit = (suite: ReporterSuite) => {
		for (const spec of suite.specs ?? []) if (spec.title === exactTitle) found.push(...(spec.tests ?? []));
		for (const child of suite.suites ?? []) visit(child);
	};
	for (const suite of reporter?.suites ?? []) visit(suite);
	return found;
}

function hasValidRetryConfig(reporter: ReporterJson | null) {
	const projects = reporter?.config?.projects;
	return !!projects?.length && projects.every((project) => project.retries === 0 && project.repeatEach === 1);
}

function isEligiblePassed(test: ReporterTest | undefined, configValid: boolean) {
	return configValid && test?.expectedStatus === 'passed' && test.status === 'expected' && test.results?.length === 1 &&
		test.results[0]?.status === 'passed' && test.results[0]?.retry === 0;
}

function validateTextureReport(raw: ProofReport, fixture: OracleFixture, pin: (typeof fixturePins)[keyof typeof fixturePins]) {
	const failures: string[] = [];
	const result = raw.result;
	const report = result?.report;
	if (raw.executionError || result?.status !== 'complete') failures.push('raw worker proof did not complete cleanly');
	if (!result?.workerLifecycle || result.workerLifecycle.created !== true || result.workerLifecycle.terminated !== true ||
		result.workerLifecycle.listenersRemoved !== true || result.workerLifecycle.terminalMessageCount !== 1 || result.workerLifecycle.terminalType !== 'complete') {
		failures.push('worker lifecycle is not one clean complete terminal');
	}
	const activeMaterials = fixture.materials.filter((material) => material.activeSemantic);
	const expectedIds = activeMaterials.map((material) => material.materialIndex).sort((a, b) => a - b);
	const rows = result?.rows;
	const rowIds = Array.isArray(rows) ? rows.map((row: any) => row.materialIndex).sort((a: number, b: number) => a - b) : [];
	if (!Array.isArray(rows) || rows.length !== pin.active || new Set(rowIds).size !== pin.active || JSON.stringify(rowIds) !== JSON.stringify(expectedIds)) {
		failures.push('active material rows do not exactly equal the oracle material IDs');
	}
	if (Array.isArray(rows)) {
		for (const row of rows) {
			const expectedMaterial = activeMaterials.find((material) => material.materialIndex === row.materialIndex);
			const expected = expectedMaterial?.semantic?.outputRgbaSha256;
			if (!expected || row.textureIndex !== expectedMaterial?.textureIndex || row.expectedRgbaSha256 !== expected || row.actualRgbaSha256 !== expected || !row.assetPath?.startsWith('bomc/textures/semantic-')) {
				failures.push(`material ${row.materialIndex} hash or generated semantic asset path differs from Ruby oracle`);
			}
		}
	}
	const expectedTextureIndices = [...new Set(activeMaterials.map((material) => material.textureIndex).filter((value): value is number => value !== null))].sort((a, b) => a - b);
	const reportActiveTextureIndices = Array.isArray(report?.activeTextureIndices) ? report.activeTextureIndices : [];
	if (JSON.stringify(reportActiveTextureIndices) !== JSON.stringify(expectedTextureIndices)) failures.push('active texture indices differ from the oracle texture set');
	if (!report || report.fixtureId !== fixture.id || report.sourceFileBytes !== pin.bytes || report.sourceFileSha256 !== pin.sha256 ||
		report.materialVersion !== 2 || report.materialCount !== pin.materials || report.sourceTextureCount !== pin.sourceTextures ||
		report.activeCount !== pin.active || report.sourcePayloadsUnchanged !== true || report.generatedAliasesSourceBlob !== false ||
		report.workerErrors !== 0 || !Array.isArray(report.geometryLoadedSections) || report.geometryLoadedSections.length !== 0) {
		failures.push('raw worker report does not match the pinned source/resource contract');
	}
	if (JSON.stringify(report?.activeMediaCounts) !== JSON.stringify({ PNG: 0, JPEG: pin.jpeg, WebP: pin.webp })) failures.push('active PNG/JPEG/WebP counts differ from the pinned fixture');
	if (report?.diagnostics?.activeCount !== pin.active || report.diagnostics.verifiedCount !== pin.active ||
		report.diagnostics.baseDecodeCount !== expectedTextureIndices.length || report.diagnostics.maxLiveBaseFrames !== 1 ||
		report.diagnostics.maxLiveOutputFrames !== 1 || typeof report.diagnostics.maxMemoEntries !== 'number' || report.diagnostics.maxMemoEntries < 0 || report.diagnostics.maxMemoEntries > 65_536) {
		failures.push('raw codec resource bounds or semantic verification counts differ');
	}
	const roundTrips = report?.generatedPngRoundTrips;
	if (!Array.isArray(roundTrips) || roundTrips.length === 0 || roundTrips.some((row: any) => row.passed !== true || row.expectedRgbaSha256 !== row.actualRgbaSha256)) {
		failures.push('generated PNG RGBA round-trip reports are missing or mismatched');
	}
	const observations = report?.baseObservations;
	const observedIndices = Array.isArray(observations) ? observations.map((row: any) => row.textureIndex) : [];
	if (JSON.stringify(observedIndices) !== JSON.stringify(expectedTextureIndices) || new Set(observedIndices).size !== expectedTextureIndices.length) {
		failures.push('base texture observations are not unique and in expected index order');
	}
	if ((raw.pageErrors?.length ?? 0) !== 0 || (raw.consoleErrors?.length ?? 0) !== 0 || (raw.wasmResponses?.length ?? 0) === 0 ||
		raw.wasmResponses?.some((item) => item.status !== 200 || item.sameOrigin !== true)) failures.push('browser errors or invalid/missing same-origin WASM responses were recorded');
	return failures;
}

function validatePngReport(raw: ProofReport, pngHash: string) {
	const failures: string[] = [];
	const result = raw.result;
	if (raw.executionError || result?.status !== 'complete') failures.push('generated-PNG worker proof did not complete cleanly');
	if (!result?.workerLifecycle || result.workerLifecycle.created !== true || result.workerLifecycle.terminated !== true ||
		result.workerLifecycle.listenersRemoved !== true || result.workerLifecycle.terminalMessageCount !== 1 || result.workerLifecycle.terminalType !== 'complete') {
		failures.push('generated-PNG worker lifecycle is not one clean complete terminal');
	}
	const report = result?.report;
	if (report?.fixtureId !== 'generated-png' || report.sourcePngRoundTripExact !== true || report.generatedPngRoundTripExact !== true ||
		report.expectedRgbaSha256 !== pngHash || report.actualRgbaSha256 !== pngHash || report.workerErrors !== 0) {
		failures.push('generated-PNG equality, alpha-zero RGB case, or worker-error assertion is missing');
	}
	if ((raw.pageErrors?.length ?? 0) !== 0 || (raw.consoleErrors?.length ?? 0) !== 0 || (raw.wasmResponses?.length ?? 0) === 0 ||
		raw.wasmResponses?.some((item) => item.status !== 200 || item.sameOrigin !== true)) failures.push('generated-PNG browser errors or invalid/missing same-origin WASM responses were recorded');
	return failures;
}

function sameRecord(actual: Record<string, string>, expected: Record<string, string>, keys: readonly string[]) {
	return keys.every((key) => actual?.[key] === expected[key]) && Object.keys(actual ?? {}).length === keys.length;
}

async function main() {
	if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2] ?? '')) {
		throw new Error('Usage: bun aggregate-recovery.ts <absolute M2 worklog>');
	}
	const worklogRoot = path.resolve(process.argv[2]);
	const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
	const workspaceRoot = path.resolve(editorRoot, '..');
	const producerRoot = path.join(workspaceRoot, 'bom_engine_plugin');
	const metadata = JSON.parse(readFileSync(path.join(worklogRoot, 'oracle', 'metadata.json'), 'utf8')) as OracleMetadata;
	const vectorOracle = JSON.parse(readFileSync(path.join(editorRoot, 'packages/e4-import/src/test-fixtures/semantic-colorize-ruby-v1.json'), 'utf8')) as AggregateRecoveryInput['vectorOracle'];
	const current = {
		fixtureManifestSha256: shaFile(path.join(editorRoot, 'tooling/performance/fixtures.json')),
		producerCommit: execFileSync('git', ['-C', producerRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
		producerSourceSha256: Object.fromEntries(Object.keys(metadata.producer.sourceSha256).map((relative) => [relative, shaFile(path.join(producerRoot, relative))])),
		sourceIdentity: Object.fromEntries(sourcePaths.map((relative) => [relative, shaFile(path.join(editorRoot, relative))]))
	};
	const attempts = (['01', '02'] as const).map((attempt) => {
		const outputDir = path.join(worklogRoot, 'pixel-playwright', `attempt-${attempt}`);
		const reporterPath = path.join(outputDir, 'playwright-results.json');
		const reporter = existsSync(reporterPath) ? JSON.parse(readFileSync(reporterPath, 'utf8')) as ReporterJson : null;
		const rawReports = Object.fromEntries([...Object.keys(fixturePins), 'generated-png'].map((fixtureId) => {
			const reportPath = path.join(outputDir, 'reports', `${fixtureId}.json`);
			return [fixtureId, existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) as ProofReport : null];
		}));
		return { attempt, reporter, rawReports };
	}).filter((attempt) => existsSync(path.join(worklogRoot, 'pixel-playwright', `attempt-${attempt.attempt}`)));
	const result = aggregateRecoveryEvidence({ metadata, vectorOracle, current, attempts });
	const aggregatePath = path.join(worklogRoot, 'aggregate-recovery.json');
	writeFileSync(aggregatePath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
	console.log(JSON.stringify({ aggregatePath, ...result }, null, 2));
	if (!result.passed) process.exitCode = 1;
}

function shaFile(filePath: string) { return createHash('sha256').update(readFileSync(filePath)).digest('hex'); }

if (import.meta.main) await main();
