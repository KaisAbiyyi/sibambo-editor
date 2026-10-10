import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
	existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAppBuildIdentity, type AppBuildIdentity } from '../research/build-identity';
import { BOMC_PROFILE_FIXTURE_PINS, resolveAllBomcProfileFixtures, resolveBomcProfileFixture, type BomcProfileFixturePin, type ResolvedBomcProfileFixture } from './bomc-profile-fixtures.js';

export type AcceleratedSuite = 'profiles' | 'current-cold' | 'current-semantic';
export type AcceleratedColdCycle = 'cold-01' | 'cold-02' | 'cold-03' | 'warm-01';
export type AcceleratedRuntime = {
	node: string;
	nodePath: string;
	bun: string;
	playwright: string;
	browser: 'chromium';
	browserVersion: string;
	backend: 'chromium-headless-webgl2';
};
export type AcceleratedBuildIdentity = Pick<AppBuildIdentity, 'commit' | 'dirty' | 'sourceSha256'>;
export type AcceleratedFileDigest = { path: string; bytes: number; sha256: string };
export type AcceleratedFixturePin = {
	id: string;
	bytes: number;
	sha256: string;
	path: string;
	realPath: string;
};
export type AcceleratedReferencePin = {
	id: 'current-input-oracle';
	bytes: number;
	sha256: string;
	path: string;
	realPath: string;
};
export type AcceleratedSourceIdentity = {
	testedHead: string;
	dirty: boolean;
	dirtyPaths: string[];
	sourceInventory: AcceleratedFileDigest[];
	utf8LfSourceInventory: AcceleratedFileDigest[];
	fixturePins: AcceleratedFixturePin[];
	referencePins: AcceleratedReferencePin[];
	buildIdentity: AcceleratedBuildIdentity;
	identitySha256: string;
};
export type AcceleratedCaseDefinition = {
	title: string;
	sidecarName: string;
	artifactNames: string[];
	requiredObservations: string[];
	requiredInputHashKeys: string[];
};
export type AcceleratedProofTicket = AcceleratedSourceIdentity & {
	schemaVersion: 'sibambo-accelerated-proof-v1';
	planId: 'EDITOR-ACCELERATED-001';
	planVersion: '1.1';
	runUUID: string;
	attempt: number;
	suite: AcceleratedSuite;
	cycle: AcceleratedColdCycle | null;
	runtime: AcceleratedRuntime;
	configPath: string;
	specPath: string;
	testTitles: string[];
	cases: AcceleratedCaseDefinition[];
	executionRoot: string;
	attemptRoot: string;
	outputDir: string;
	outputRootRealPath: string;
	reportFile: string;
	stdoutFile: string;
	stderrFile: string;
	ticketFile: string;
	finalReceiptFile: string;
	markerFiles: string[];
	caseSidecarNames: Array<{ title: string; name: string }>;
	cacheDir: string | null;
	cacheSourceReceipt: string | null;
	previousReceipt: string | null;
	nonce: string;
	claimedAtUtc: string;
};
export type AcceleratedDiscoveryContext = {
	discoveryOnly: true;
	planId: 'EDITOR-ACCELERATED-001';
	planVersion: '1.1';
	suite: AcceleratedSuite;
	cycle: AcceleratedColdCycle | null;
	configPath: string;
	specPath: string;
	testTitles: string[];
	cases: AcceleratedCaseDefinition[];
};
export type AcceleratedProofContext = AcceleratedProofTicket | AcceleratedDiscoveryContext;
export type AcceleratedCasePayload = {
	schemaVersion: 'sibambo-accelerated-case-v1';
	planId: 'EDITOR-ACCELERATED-001';
	planVersion: '1.1';
	runUUID: string;
	attempt: number;
	title: string;
	nonce: string;
	testedHead: string;
	identitySha256: string;
	buildIdentity: AcceleratedBuildIdentity;
	fixturePins: AcceleratedFixturePin[];
	referencePins: AcceleratedReferencePin[];
	inputHashes: Record<string, string>;
	observations: Record<string, boolean>;
	data: Record<string, unknown>;
};
export type AcceleratedFinalReceipt = {
	schemaVersion: 'sibambo-accelerated-final-v1';
	gate: 'passed' | 'failed' | 'blocked' | 'not-available';
	retryEligible: boolean;
	planId: 'EDITOR-ACCELERATED-001';
	planVersion: '1.1';
	suite: AcceleratedSuite;
	cycle: AcceleratedColdCycle | null;
	attempt: number;
	ticketSnapshot: AcceleratedProofTicket;
	child: { exitCode: number | null; signal: string | null };
	caseOutcomes: Array<Record<string, unknown>>;
	markerFiles: string[];
	sidecarFiles: string[];
	cleanup: { passed: boolean; details: unknown };
	identityAfter: AcceleratedSourceIdentity;
	errors: string[];
	setupFailureReason: string | null;
	completedAt: string;
};

export const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const workspaceRoot = path.resolve(editorRoot, '..');
export const acceleratedTopicRoot = path.join(workspaceRoot, 'docs', 'worklogs', 'EDITOR-ACCELERATED-001');
export const CURRENT_S2_PIN = {
	id: 'PROJECT SBOOST 2:EXACT', model: 'PROJECT SBOOST 2', bytes: 2_319_634,
	sha256: '7d84c2d96dd34913f0e3662ab6ca25579eb8c62397d4715279a9268628f5acd2'
} as const;
export const CURRENT_INPUT_ORACLE = {
	id: 'current-input-oracle' as const,
	path: path.join(workspaceRoot, 'docs', 'worklogs', 'ROOMS-RENDER-LEARNING-001', '2026-10-06-review-plan-001', 'current-input-oracle.json'),
	bytes: 129_436,
	sha256: '18601d92e9481b36e187cf02765862d7f0194fd0b3e235dafbca357435890f8f'
} as const;

const PLAN_ID = 'EDITOR-ACCELERATED-001' as const;
const PLAN_VERSION = '1.1' as const;
const sourceExtensions = /(?:\.d)?\.(?:ts|tsx|js|jsx|mjs|cjs|svelte|html|css|scss|json|md|mdx|ya?ml|toml|lock|rb|py|ps1|sh|svg|xml|txt)$/i;
const ignoredSourceSegments = new Set(['.git', 'node_modules', '.svelte-kit', '.vercel', 'build', 'coverage', 'dist', 'playwright-report', 'test-results']);
const packageNames = ['@sibambo/contracts', '@sibambo/e4-import', '@sibambo/provenance', '@sibambo/scene-runtime', '@sibambo/viewport', '@sibambo/bomc-document'];

export const ACCELERATED_CASE_TITLES = {
	currentCold: 'S2-current EXACT reaches first ready draw without a dev full reload',
	currentColdHydration: 'Open controls remain disabled until the client bindings are ready for S2-current',
	currentSemantic: 'S2-current semantic materials match the pinned Ruby oracle and retain the prior viewport on corrupt replacement'
} as const;

export function expectedEditorBuildIdentity(): AcceleratedBuildIdentity {
	const identity = getAppBuildIdentity({
		appName: 'editor', appRoot: path.join(editorRoot, 'apps', 'editor'), repoRoot: editorRoot, packageNames
	});
	return { commit: identity.commit, dirty: identity.dirty, sourceSha256: identity.sourceSha256 };
}

export function captureAcceleratedSourceIdentity(input: {
	fixtures: readonly (BomcProfileFixturePin | ResolvedBomcProfileFixture)[];
	references?: ReadonlyArray<{ id: 'current-input-oracle'; path: string; sha256: string }>;
	buildIdentity?: AcceleratedBuildIdentity;
}): AcceleratedSourceIdentity {
	const testedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: editorRoot, encoding: 'utf8' }).trim();
	if (!/^[a-f0-9]{40}$/i.test(testedHead)) throw new Error('Editor HEAD is not a full 40-character commit identity.');
	const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '-z'], { cwd: editorRoot, encoding: 'utf8' });
	const dirtyPaths = parseDirtyPaths(status);
	const { sourceInventory, utf8LfSourceInventory } = inventoryEditorSource();
	const fixturePins = input.fixtures.map(verifyFixturePin).sort((a, b) => compareCodeUnits(a.id, b.id));
	if (fixturePins.length === 0 || new Set(fixturePins.map((row) => row.id)).size !== fixturePins.length) throw new Error('Accelerated source identity requires distinct pinned fixtures.');
	const referencePins = (input.references ?? []).map(verifyReferencePin).sort((a, b) => compareCodeUnits(a.id, b.id));
	const buildIdentity = input.buildIdentity ?? expectedEditorBuildIdentity();
	validateBuildIdentity(buildIdentity, testedHead);
	const digestInput = {
		testedHead, dirtyPaths, sourceInventory, utf8LfSourceInventory, fixturePins, referencePins, buildIdentity
	};
	return {
		testedHead, dirty: dirtyPaths.length > 0, dirtyPaths, sourceInventory, utf8LfSourceInventory,
		fixturePins, referencePins, buildIdentity, identitySha256: sha256(canonicalJson(digestInput))
	};
}

export function acceleratedFixturesForSuite(suite: AcceleratedSuite): ResolvedBomcProfileFixture[] {
	if (suite === 'profiles') return resolveAllBomcProfileFixtures();
	const pin = BOMC_PROFILE_FIXTURE_PINS.find((candidate) => candidate.id === CURRENT_S2_PIN.id);
	if (!pin || pin.bytes !== CURRENT_S2_PIN.bytes || pin.sha256 !== CURRENT_S2_PIN.sha256) throw new Error('S2-current EXACT no longer matches the frozen C1 input pin.');
	return [resolveBomcProfileFixture(pin)];
}

export function acceleratedReferencesForSuite(suite: AcceleratedSuite) {
	return suite === 'current-semantic' ? [{ id: CURRENT_INPUT_ORACLE.id, path: CURRENT_INPUT_ORACLE.path, sha256: CURRENT_INPUT_ORACLE.sha256 }] as const : [];
}

export function acceleratedCaseDefinitions(suite: AcceleratedSuite, cycle: AcceleratedColdCycle | null, fixtureIds: readonly string[]): AcceleratedCaseDefinition[] {
	if (suite === 'profiles') return fixtureIds.map((id) => ({
		title: `${id} imports, draws, orbits, and picks in the Editor`, sidecarName: 'profile-case.json',
		artifactNames: ['before-orbit.png', 'after-orbit.png'],
		requiredObservations: ['fixtureIdentityMatched', 'buildIdentityMatched', 'workerCompletedOnce', 'ready', 'orbitPixelsChanged', 'zoomExtents', 'positivePick', 'noPageErrors', 'noConsoleErrors'],
		requiredInputHashKeys: [id]
	}));
	if (suite === 'current-cold') {
		const rows: AcceleratedCaseDefinition[] = [{
			title: ACCELERATED_CASE_TITLES.currentCold, sidecarName: 'cold-case.json', artifactNames: ['before-import.png', 'after-ready.png'],
			requiredObservations: ['fixtureIdentityMatched', 'buildIdentityMatched', 'oneFileSelection', 'oneWorkerRequest', 'workerCompletedOnce', 'positiveSceneTriangles', 'ready', 'orbitPixelsChanged', 'positivePick', 'noDevFullReload', 'noMainFrameNavigation', 'noPageErrors', 'noConsoleErrors'],
			requiredInputHashKeys: [CURRENT_S2_PIN.id]
		}];
		if (cycle === 'cold-01') rows.push({
			title: ACCELERATED_CASE_TITLES.currentColdHydration, sidecarName: 'hydration-case.json', artifactNames: [],
			requiredObservations: ['ssrNotReady', 'openControlsDisabled', 'fileInputDisabled', 'readyAfterHydration', 'openControlsEnabled', 'noFixtureRequest', 'noWorkerRequest', 'noPageErrors'],
			requiredInputHashKeys: []
		});
		return rows;
	}
	return [{
		title: ACCELERATED_CASE_TITLES.currentSemantic, sidecarName: 'semantic-case.json', artifactNames: ['semantic-before-corrupt.png', 'semantic-after-corrupt.png'],
		requiredObservations: ['fixtureIdentityMatched', 'oracleIdentityMatched', 'buildIdentityMatched', 'workerCompletedOnce', 'tenActiveSemanticMaterials', 'workerMetricsMatched', 'semanticPngsDecoded', 'semanticPngsSameOrigin', 'ready', 'corruptReplacementRejected', 'priorCanvasRetained', 'priorTitleRetained', 'priorPixelsRetained', 'noPageErrors', 'noConsoleErrors'],
		requiredInputHashKeys: [CURRENT_S2_PIN.id, 'current-input-oracle', 'S2-current-corrupt-replacement']
	}];
}

export function acceleratedSpecAndConfig(suite: AcceleratedSuite) {
	if (suite === 'profiles') return {
		specPath: path.join(editorRoot, 'apps', 'editor', 'tests', 'bomc-profile-compatibility.spec.ts'),
		configPath: path.join(editorRoot, 'apps', 'editor', 'playwright.profiles.config.ts')
	};
	if (suite === 'current-cold') return {
		specPath: path.join(editorRoot, 'tooling', 'testing', 'editor-current-cold-start.spec.ts'),
		configPath: path.join(editorRoot, 'tooling', 'testing', 'playwright.current-cold.config.ts')
	};
	return {
		specPath: path.join(editorRoot, 'tooling', 'testing', 'editor-current-semantic.spec.ts'),
		configPath: path.join(editorRoot, 'tooling', 'testing', 'playwright.current-semantic.config.ts')
	};
}

export function claimAcceleratedAttempt(input: {
	suite: AcceleratedSuite;
	executionRoot: string;
	attempt: number;
	runtime: AcceleratedRuntime;
	cycle?: AcceleratedColdCycle;
	cacheSourceReceipt?: string | null;
	previousReceipt?: string | null;
}): AcceleratedProofTicket {
	validateSuiteCycle(input.suite, input.cycle);
	validateRuntime(input.runtime);
	if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 2) throw new Error('Accelerated attempt must be 1 or 2; C1 permits one setup retry.');
	const topicReal = realpathSync(acceleratedTopicRoot);
	const executionRoot = path.resolve(input.executionRoot);
	assertStrictChild(topicReal, executionRoot, 'Accelerated execution root must be below the canonical topic root.');
	ensureSafeExistingAncestors(topicReal, executionRoot);
	const executionRootExists = existsSync(executionRoot);
	const fixtures = acceleratedFixturesForSuite(input.suite);
	const references = acceleratedReferencesForSuite(input.suite);
	const identity = captureAcceleratedSourceIdentity({ fixtures, references });
	const caseFixtureIds = fixtures.map((row) => row.id);
	const cases = acceleratedCaseDefinitions(input.suite, input.cycle ?? null, caseFixtureIds);
	const { configPath, specPath } = acceleratedSpecAndConfig(input.suite);
	const attemptRoot = path.join(executionRoot, input.suite, input.cycle ?? 'run', `attempt-${String(input.attempt).padStart(2, '0')}`);
	assertStrictChild(topicReal, attemptRoot, 'Accelerated attempt directory must be below the canonical topic root.');
	if (existsSync(attemptRoot)) throw new Error(`Accelerated attempt output may not be reused: ${attemptRoot}`);
	const { previousReceipt, cacheSourceReceipt, cacheDir } = validatePreviousReceipt({
		previousReceipt: input.previousReceipt ?? null, cacheSourceReceipt: input.cacheSourceReceipt ?? null,
		suite: input.suite, cycle: input.cycle ?? null, attempt: input.attempt,
		identity, runtime: input.runtime, executionRoot, attemptRoot
	});
	if (input.attempt === 1 && executionRootExists) throw new Error(`Accelerated run root may not be reused: ${executionRoot}`);
	if (input.attempt === 2 && !executionRootExists) throw new Error('Attempt 2 must use the same existing execution root as its recognized attempt 1 setup receipt.');
	createSafeDirectoryTree(topicReal, path.dirname(attemptRoot));
	createSafeDirectoryTree(topicReal, attemptRoot);
	const outputDir = path.join(attemptRoot, 'playwright-output');
	const reportsDir = path.join(attemptRoot, 'reports');
	const outcomesDir = path.join(attemptRoot, 'outcomes');
	createSafeDirectory(topicReal, outputDir);
	createSafeDirectory(topicReal, reportsDir);
	createSafeDirectory(topicReal, outcomesDir);
	const outputRootRealPath = realpathSync(outputDir);
	assertRealpathInside(topicReal, outputRootRealPath);
	let currentCacheDir: string | null = cacheDir;
	if (input.suite === 'current-cold' && input.cycle !== 'warm-01') {
		currentCacheDir = path.join(attemptRoot, 'vite-cache');
		if (existsSync(currentCacheDir)) throw new Error(`Fresh current-cold Vite cache already exists: ${currentCacheDir}`);
		createSafeDirectory(topicReal, currentCacheDir);
		if (readdirSync(currentCacheDir).length !== 0) throw new Error('Fresh Vite cache directory must be empty before the child starts.');
	}
	const runUUID = randomUUID();
	const nonce = randomUUID();
	const paths = cases;
	const markerFiles = paths.map((row) => path.join(outcomesDir, `${titleSlug(row.title)}.json`));
	const ticket: AcceleratedProofTicket = {
		...identity, schemaVersion: 'sibambo-accelerated-proof-v1', planId: PLAN_ID, planVersion: PLAN_VERSION,
		runUUID, attempt: input.attempt, suite: input.suite, cycle: input.cycle ?? null, runtime: input.runtime,
		configPath, specPath, testTitles: paths.map((row) => row.title), cases: paths,
		executionRoot, attemptRoot, outputDir, outputRootRealPath,
		reportFile: path.join(reportsDir, 'playwright-report.json'), stdoutFile: path.join(reportsDir, 'runner-stdout.log'),
		stderrFile: path.join(reportsDir, 'runner-stderr.log'), ticketFile: path.join(attemptRoot, 'run-ticket.json'),
		finalReceiptFile: path.join(attemptRoot, 'final-receipt.json'), markerFiles,
		caseSidecarNames: paths.map((row) => ({ title: row.title, name: row.sidecarName })),
		cacheDir: currentCacheDir, cacheSourceReceipt, previousReceipt, nonce, claimedAtUtc: new Date().toISOString()
	};
	writeFileSync(ticket.ticketFile, `${JSON.stringify(ticket, null, 2)}\n`, { flag: 'wx' });
	return ticket;
}

export function readAcceleratedContext(expectedSuite?: AcceleratedSuite): AcceleratedProofContext | null {
	if (process.env.SIBAMBO_ACCELERATED_DISCOVERY === '1') return null;
	const ticketPath = process.env.SIBAMBO_ACCELERATED_TICKET;
	if (!ticketPath) return null;
	if (!path.isAbsolute(ticketPath)) throw new Error('SIBAMBO_ACCELERATED_TICKET must be an absolute path.');
	if (lstatSync(ticketPath).isSymbolicLink() || !lstatSync(ticketPath).isFile()) throw new Error('Accelerated ticket must be a regular, non-linked file.');
	const realTicketPath = realpathSync(ticketPath);
	const ticket = readJson<AcceleratedProofTicket>(realTicketPath);
	validateTicketSchema(ticket);
	if (expectedSuite && ticket.suite !== expectedSuite) throw new Error(`Accelerated ticket suite ${ticket.suite} does not match ${expectedSuite}.`);
	if (process.env.SIBAMBO_ACCELERATED_NONCE !== ticket.nonce) throw new Error('Accelerated ticket nonce does not match the runner environment.');
	if (path.resolve(ticketPath) !== path.resolve(ticket.ticketFile)) throw new Error('Accelerated ticket path differs from the claimed ticket location.');
	if (path.resolve(process.env.SIBAMBO_ACCELERATED_RUN_ROOT ?? '') !== path.resolve(ticket.executionRoot)) throw new Error('Accelerated run root differs from the claimed ticket.');
	validateTicketPaths(ticket);
	const current = captureAcceleratedSourceIdentity({ fixtures: ticket.fixturePins.map(resolveTicketFixture), references: ticket.referencePins.map((row) => ({ id: row.id, path: row.realPath, sha256: row.sha256 })) });
	if (!sameAcceleratedIdentity(ticket, current)) throw new Error('Accelerated source, fixture, reference or build identity changed after the source seal.');
	return ticket;
}

export function createAcceleratedCasePayload(ticket: AcceleratedProofTicket, title: string, input: {
	inputHashes: Record<string, string>;
	observations: Record<string, boolean>;
	data?: Record<string, unknown>;
}): AcceleratedCasePayload {
	const definition = findCase(ticket, title);
	validateObservations(definition, input.observations, input.inputHashes);
	for (const [key, value] of Object.entries(input.inputHashes)) if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`Input hash ${key} must be a 64-character SHA-256.`);
	for (const required of definition.requiredInputHashKeys) if (!input.inputHashes[required]) throw new Error(`Required input hash is missing: ${required}`);
	return {
		schemaVersion: 'sibambo-accelerated-case-v1', planId: PLAN_ID, planVersion: PLAN_VERSION,
		runUUID: ticket.runUUID, attempt: ticket.attempt, title, nonce: ticket.nonce, testedHead: ticket.testedHead,
		identitySha256: ticket.identitySha256, buildIdentity: ticket.buildIdentity,
		fixturePins: ticket.fixturePins, referencePins: ticket.referencePins,
		inputHashes: input.inputHashes, observations: input.observations, data: input.data ?? {}
	};
}

export function recordAcceleratedCase(ticket: AcceleratedProofTicket, title: string, input: {
	sidecarPath: string;
	artifactPaths: readonly string[];
	payload: AcceleratedCasePayload;
}): string {
	const definition = findCase(ticket, title);
	if (input.payload.title !== title || input.payload.runUUID !== ticket.runUUID || input.payload.nonce !== ticket.nonce || input.payload.identitySha256 !== ticket.identitySha256) {
		throw new Error('Accelerated case payload does not belong to the current ticket.');
	}
	if (!sameBuildIdentity(input.payload.buildIdentity, ticket.buildIdentity)
		|| canonicalJson(input.payload.fixturePins) !== canonicalJson(ticket.fixturePins)
		|| canonicalJson(input.payload.referencePins) !== canonicalJson(ticket.referencePins)) {
		throw new Error('Accelerated case payload build, fixture or reference identity differs from the ticket.');
	}
	validateObservations(definition, input.payload.observations, input.payload.inputHashes);
	for (const fixture of ticket.fixturePins) if (input.payload.inputHashes[fixture.id] && input.payload.inputHashes[fixture.id] !== fixture.sha256) throw new Error(`Accelerated case input hash differs from the ticketed fixture: ${fixture.id}`);
	for (const reference of ticket.referencePins) if (input.payload.inputHashes[reference.id] && input.payload.inputHashes[reference.id] !== reference.sha256) throw new Error(`Accelerated case input hash differs from the ticketed reference: ${reference.id}`);
	const allowedHashes = new Set([...ticket.fixturePins.map((row) => row.id), ...ticket.referencePins.map((row) => row.id), 'S2-current-corrupt-replacement']);
	for (const key of Object.keys(input.payload.inputHashes)) if (!allowedHashes.has(key)) throw new Error(`Accelerated case contains an unrecognized input hash key: ${key}`);
	if (!existsSync(input.sidecarPath) || !lstatSync(input.sidecarPath).isFile() || lstatSync(input.sidecarPath).isSymbolicLink()) throw new Error(`Accelerated case sidecar is missing or linked: ${input.sidecarPath}`);
	assertRealpathInside(ticket.outputRootRealPath, input.sidecarPath);
	if (path.basename(input.sidecarPath) !== definition.sidecarName) throw new Error(`Accelerated case sidecar name differs from the ticket: ${title}`);
	const serialized = JSON.stringify(input.payload, null, 2);
	if (readFileSync(input.sidecarPath, 'utf8').trim() !== serialized) throw new Error(`Accelerated sidecar bytes do not match the ticketed case payload: ${title}`);
	if (input.artifactPaths.length !== definition.artifactNames.length) throw new Error(`Accelerated case artifact count differs from its ticket: ${title}`);
	const artifacts = input.artifactPaths.map((filePath) => {
		if (!existsSync(filePath) || !lstatSync(filePath).isFile() || lstatSync(filePath).isSymbolicLink()) throw new Error(`Accelerated case artifact is missing or linked: ${filePath}`);
		assertRealpathInside(ticket.outputRootRealPath, filePath);
		const name = path.basename(filePath);
		if (!definition.artifactNames.includes(name)) throw new Error(`Unexpected accelerated case artifact ${name} for ${title}.`);
		const bytes = readFileSync(filePath);
		return { name, path: path.resolve(filePath), bytes: bytes.byteLength, sha256: sha256(bytes) };
	}).sort((a, b) => compareCodeUnits(a.name, b.name));
	if (definition.artifactNames.some((name) => !artifacts.some((item) => item.name === name))) throw new Error(`Required accelerated artifact is missing: ${title}`);
	const markerPath = markerFor(ticket, title);
	const marker = {
		schemaVersion: 'sibambo-accelerated-outcome-v1', planId: PLAN_ID, planVersion: PLAN_VERSION,
		runUUID: ticket.runUUID, attempt: ticket.attempt, title, nonce: ticket.nonce, testedHead: ticket.testedHead,
		identitySha256: ticket.identitySha256, inputHashes: input.payload.inputHashes,
		observations: input.payload.observations, sidecar: { path: path.resolve(input.sidecarPath), bytes: readFileSync(input.sidecarPath).byteLength, sha256: sha256(readFileSync(input.sidecarPath)) },
		artifacts, recordedAtUtc: new Date().toISOString()
	};
	writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
	return markerPath;
}

export function finalizeAcceleratedAttempt(input: {
	ticket: AcceleratedProofTicket;
	report: AcceleratedPlaywrightReport | null;
	child: { exitCode: number | null; signal: string | null };
	cleanup: { passed: boolean; details: unknown };
	identityAfter: AcceleratedSourceIdentity;
	stdout?: string;
	stderr?: string;
}): AcceleratedFinalReceipt {
	const { ticket, report } = input;
	const errors: string[] = [];
	const caseOutcomes: Array<Record<string, unknown>> = [];
	const markerFiles = ticket.markerFiles.filter((filePath) => existsSync(filePath));
	const sidecarFiles: string[] = [];
	let setupFailureReason: string | null = null;
	let gate: AcceleratedFinalReceipt['gate'] = 'failed';
	let executedResultsCount = 0;
	if (!report) {
		gate = 'blocked';
		errors.push('Accelerated Playwright JSON report is missing or invalid.');
		setupFailureReason = classifyAcceleratedSetupFailure(input.stdout ?? '', input.stderr ?? '', input.child, markerFiles.length);
	} else {
		const specs = flattenReportSpecs(report.suites ?? []);
		executedResultsCount = specs.reduce((total, spec) => total + spec.tests.reduce((count, test) => count + test.results.length, 0), 0);
		const actualTitles = specs.map((row) => row.title);
		if (actualTitles.length === 0) errors.push('Zero mandatory accelerated cases executed.');
		if (actualTitles.join('\0') !== ticket.testTitles.join('\0')) errors.push(`Executed case list differs from the exact ticket: ${JSON.stringify(actualTitles)}.`);
		for (const title of ticket.testTitles) {
			const matching = specs.filter((row) => row.title === title);
			if (matching.length !== 1) { errors.push(`Expected one Playwright case titled ${title}; found ${matching.length}.`); continue; }
			const spec = matching[0]!;
			if (spec.tests.length !== 1) errors.push(`${title} ran in ${spec.tests.length} projects; expected exactly one.`);
			const test = spec.tests[0];
			const result = test?.results.length === 1 ? test.results[0] : undefined;
			if (test?.expectedStatus !== 'passed' || test.status !== 'expected' || !result || result.status !== 'passed' || result.retry !== 0 || !isEmptyErrors(result.errors)) {
				errors.push(`${title} did not complete once with status passed and retry index 0.`);
			}
			if (test && result) caseOutcomes.push({ title, expectedStatus: test.expectedStatus, status: test.status, resultStatus: result.status, retry: result.retry, errors: result.errors });
		}
		if (!isEmptyErrors(report.errors)) errors.push('Playwright runner-level errors are present.');
		if (executedResultsCount === 0) setupFailureReason = classifyAcceleratedSetupFailure(input.stdout ?? '', input.stderr ?? '', input.child, markerFiles.length);
	}
	if (markerFiles.length !== ticket.testTitles.length) errors.push(`Outcome marker count ${markerFiles.length} differs from mandatory case count ${ticket.testTitles.length}.`);
	const markerDirectory = path.dirname(ticket.markerFiles[0]!);
	if (existsSync(markerDirectory)) {
		const actualMarkerNames = readdirSync(markerDirectory).sort(compareCodeUnits);
		const expectedMarkerNames = ticket.markerFiles.map((filePath) => path.basename(filePath)).sort(compareCodeUnits);
		if (actualMarkerNames.join('\0') !== expectedMarkerNames.join('\0')) errors.push('Outcome directory contains missing or unexpected files.');
	}
	const markerTitles: string[] = [];
	for (const markerPath of markerFiles) {
		try {
			const marker = readJson<AcceleratedMarker>(markerPath);
			markerTitles.push(marker.title);
			const definition = findCase(ticket, marker.title);
			if (path.resolve(markerPath) !== path.resolve(markerFor(ticket, marker.title))) errors.push(`Outcome marker path is not the exact ticketed path: ${markerPath}`);
			if (marker.schemaVersion !== 'sibambo-accelerated-outcome-v1' || marker.planId !== PLAN_ID || marker.planVersion !== PLAN_VERSION
				|| marker.runUUID !== ticket.runUUID || marker.attempt !== ticket.attempt || marker.nonce !== ticket.nonce
				|| marker.testedHead !== ticket.testedHead || marker.identitySha256 !== ticket.identitySha256) errors.push(`Outcome marker identity differs from the claimed source: ${markerPath}`);
			validateObservations(definition, marker.observations, marker.inputHashes);
			for (const fixture of ticket.fixturePins) if (marker.inputHashes[fixture.id] && marker.inputHashes[fixture.id] !== fixture.sha256) errors.push(`${marker.title} input hash differs from its exact fixture pin.`);
			for (const reference of ticket.referencePins) if (marker.inputHashes[reference.id] && marker.inputHashes[reference.id] !== reference.sha256) errors.push(`${marker.title} input hash differs from its exact reference pin.`);
			const sidecarPath = path.resolve(marker.sidecar.path);
			assertRealpathInside(ticket.outputRootRealPath, sidecarPath);
			if (path.basename(sidecarPath) !== definition.sidecarName || !existsSync(sidecarPath) || !lstatSync(sidecarPath).isFile() || lstatSync(sidecarPath).isSymbolicLink()) {
				errors.push(`Required case sidecar is absent or not owned by Playwright output: ${sidecarPath}`);
			} else {
				const bytes = readFileSync(sidecarPath);
				if (bytes.byteLength !== marker.sidecar.bytes || sha256(bytes) !== marker.sidecar.sha256) errors.push(`Case sidecar digest differs from its marker: ${sidecarPath}`);
				const sidecar = JSON.parse(bytes.toString('utf8')) as AcceleratedCasePayload;
				if (sidecar.schemaVersion !== 'sibambo-accelerated-case-v1' || sidecar.planId !== PLAN_ID || sidecar.planVersion !== PLAN_VERSION
					|| sidecar.title !== marker.title || sidecar.runUUID !== ticket.runUUID || sidecar.nonce !== ticket.nonce
					|| sidecar.testedHead !== ticket.testedHead || sidecar.identitySha256 !== ticket.identitySha256
					|| !sameBuildIdentity(sidecar.buildIdentity, ticket.buildIdentity)
					|| canonicalJson(sidecar.fixturePins) !== canonicalJson(ticket.fixturePins)
					|| canonicalJson(sidecar.referencePins) !== canonicalJson(ticket.referencePins)
					|| canonicalJson(sidecar.inputHashes) !== canonicalJson(marker.inputHashes)
					|| canonicalJson(sidecar.observations) !== canonicalJson(marker.observations)) errors.push(`Case sidecar identity differs from its ticket: ${sidecarPath}`);
				sidecarFiles.push(sidecarPath);
			}
			if (marker.artifacts.length !== definition.artifactNames.length) errors.push(`${marker.title} artifact count differs from its ticket.`);
			for (const name of definition.artifactNames) {
				const artifact = marker.artifacts.find((row) => row.name === name);
				if (!artifact) { errors.push(`${marker.title} is missing required artifact ${name}.`); continue; }
				const artifactPath = path.resolve(artifact.path);
				assertRealpathInside(ticket.outputRootRealPath, artifactPath);
				if (!existsSync(artifactPath) || !lstatSync(artifactPath).isFile() || lstatSync(artifactPath).isSymbolicLink()) { errors.push(`Required artifact is absent: ${artifactPath}`); continue; }
				const bytes = readFileSync(artifactPath);
				if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) errors.push(`Required artifact digest differs from its marker: ${artifactPath}`);
				if (name.endsWith('.png') && !hasPngSignature(bytes)) errors.push(`Required PNG artifact is not a PNG file: ${artifactPath}`);
			}
			if (report) validateReportAttachments(report, marker, definition, ticket.outputRootRealPath, errors);
		} catch (error) {
			errors.push(`Outcome marker is invalid ${markerPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (markerTitles.length !== ticket.testTitles.length || [...markerTitles].sort(compareCodeUnits).join('\0') !== [...ticket.testTitles].sort(compareCodeUnits).join('\0')) errors.push('Outcome markers do not match the exact mandatory case set.');
	if (!sameAcceleratedIdentity(ticket, input.identityAfter)) errors.push('Source, build, fixture or reference identity changed during the accelerated proof.');
	if (input.child.exitCode !== 0 || input.child.signal !== null) errors.push(`Playwright child exit was not clean: exit=${input.child.exitCode}; signal=${input.child.signal}.`);
	if (!input.cleanup.passed) errors.push('Owned process tree or strict port cleanup did not pass.');
	if (report && errors.length === 0) gate = 'passed';
	if (!report && markerFiles.length === 0) setupFailureReason ??= classifyAcceleratedSetupFailure(input.stdout ?? '', input.stderr ?? '', input.child, markerFiles.length);
	const retryEligible = gate !== 'passed' && markerFiles.length === 0 && !!setupFailureReason && input.cleanup.passed && sameAcceleratedIdentity(ticket, input.identityAfter);
	return {
		schemaVersion: 'sibambo-accelerated-final-v1', gate, retryEligible, planId: PLAN_ID, planVersion: PLAN_VERSION,
		suite: ticket.suite, cycle: ticket.cycle, attempt: ticket.attempt, ticketSnapshot: ticket,
		child: input.child, caseOutcomes, markerFiles, sidecarFiles: sidecarFiles.sort(compareCodeUnits), cleanup: input.cleanup,
		identityAfter: input.identityAfter, errors, setupFailureReason, completedAt: new Date().toISOString()
	};
}

export function classifyAcceleratedSetupFailure(stdout: string, stderr: string, child: { exitCode: number | null; signal: string | null }, markerCount: number) {
	if (markerCount !== 0 || child.exitCode === 0 && child.signal === null) return null;
	const evidence = `${stdout}\n${stderr}`;
	const patterns: Array<[RegExp, string]> = [
		[/Error loading.*config|failed to load config|config.*import.*failed|cannot find module.*config/i, 'config-load-failure'],
		[/webServer.*(failed|timeout)|error while starting|failed to start.*server|EADDRINUSE|strict port/i, 'server-startup-failure'],
		[/browserType\.launch|failed to launch|executable does not exist|browser.*launch.*failed/i, 'browser-launch-failure'],
		[/page\.goto|navigation.*(failed|timeout)|net::ERR_[A-Z_]+|initial navigation/i, 'initial-navigation-failure']
	];
	return patterns.find(([pattern]) => pattern.test(evidence))?.[1] ?? null;
}

export function loadCurrentS2Oracle(reference: AcceleratedReferencePin) {
	if (reference.id !== CURRENT_INPUT_ORACLE.id || path.resolve(reference.realPath) !== path.resolve(CURRENT_INPUT_ORACLE.path)) throw new Error('Current S2 oracle path differs from the pinned C1 reference.');
	const bytes = readFileSync(reference.realPath);
	if (bytes.byteLength !== CURRENT_INPUT_ORACLE.bytes || bytes.byteLength !== reference.bytes || sha256(bytes) !== CURRENT_INPUT_ORACLE.sha256 || reference.sha256 !== CURRENT_INPUT_ORACLE.sha256) throw new Error('Current S2 oracle bytes differ from the pinned C1 reference.');
	const oracle = JSON.parse(bytes.toString('utf8')) as CurrentInputOracle;
	if (oracle.schemaVersion !== 'sibambo-rooms-current-input-oracle-v1'
		|| oracle.limits !== 'Offline metadata and texture-payload hash validation; no generated PNG, browser, UV fidelity, native installation or export certification') throw new Error('Current S2 oracle schema or declared evidence limits are invalid.');
	const fixture = oracle.fixtures.find((row) => row.id === 'S2-current');
	if (!fixture || fixture.bytes !== CURRENT_S2_PIN.bytes || fixture.sha256 !== CURRENT_S2_PIN.sha256 || fixture.materialVersion !== 2
		|| fixture.textureTableVersion !== 1 || fixture.sourceTextureCount !== 13 || fixture.activeSemanticCount !== 10 || fixture.materials.length !== 48) {
		throw new Error('Current S2 oracle fixture identity or section counts differ from the frozen pin.');
	}
	const active = fixture.materials.filter((row) => row.activeSemantic);
	if (active.length !== 10 || active.some((row, index) => !row.semantic || row.semantic.materialType !== 2
		|| ![1, 2].includes(row.semantic.colorizeMode) || !/^[a-f0-9]{64}$/i.test(row.semantic.outputRgbaSha256)
		|| row.materialIndex < 0 || row.materialIndex >= fixture.materials.length || (index > 0 && active[index - 1]!.materialIndex >= row.materialIndex))) {
		throw new Error('Current S2 oracle active semantic row set is malformed.');
	}
	return { oracle, fixture, active };
}

export function sameAcceleratedIdentity(left: AcceleratedSourceIdentity, right: AcceleratedSourceIdentity) {
	return left.testedHead === right.testedHead && left.dirty === right.dirty
		&& JSON.stringify(left.dirtyPaths) === JSON.stringify(right.dirtyPaths)
		&& left.identitySha256 === right.identitySha256
		&& sameBuildIdentity(left.buildIdentity, right.buildIdentity)
		&& canonicalJson(left.fixturePins) === canonicalJson(right.fixturePins)
		&& canonicalJson(left.referencePins) === canonicalJson(right.referencePins)
		&& canonicalJson(left.sourceInventory) === canonicalJson(right.sourceInventory)
		&& canonicalJson(left.utf8LfSourceInventory) === canonicalJson(right.utf8LfSourceInventory);
}

export function sameBuildIdentity(left: AcceleratedBuildIdentity, right: AcceleratedBuildIdentity) {
	return left.commit === right.commit && left.dirty === right.dirty && left.sourceSha256 === right.sourceSha256;
}

export function titleSlug(title: string) {
	return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortJsonValue(value));
}

export type AcceleratedPlaywrightReport = {
	suites?: Array<{ title?: string; specs?: AcceleratedPlaywrightSpec[]; suites?: AcceleratedPlaywrightReport['suites'] }>;
	errors?: unknown[] | null;
};
export type AcceleratedPlaywrightSpec = {
	title: string;
	tests: Array<{ expectedStatus?: string; status?: string; results: Array<{ status?: string; retry?: number; errors?: unknown; attachments?: Array<{ name?: string; contentType?: string; path?: string }> }> }>;
};

function inventoryEditorSource() {
	const listed = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: editorRoot, encoding: 'utf8' });
	const paths = listed.split(/\r?\n/).filter(Boolean).map((value) => value.replaceAll('\\', '/'))
		.filter((value) => sourceExtensions.test(value) && !value.split('/').some((segment) => ignoredSourceSegments.has(segment)))
		.sort(compareCodeUnits);
	const sourceInventory: AcceleratedFileDigest[] = [];
	const utf8LfSourceInventory: AcceleratedFileDigest[] = [];
	for (const relative of [...new Set(paths)]) {
		const absolute = path.resolve(editorRoot, relative);
		assertRealpathInside(editorRoot, absolute);
		const raw = readFileSync(absolute);
		const text = raw.toString('utf8');
		if (!Buffer.from(text, 'utf8').equals(raw)) continue;
		sourceInventory.push({ path: relative, bytes: raw.byteLength, sha256: sha256(raw) });
		const normalized = Buffer.from(text.replace(/\r\n?/g, '\n'), 'utf8');
		utf8LfSourceInventory.push({ path: relative, bytes: normalized.byteLength, sha256: sha256(normalized) });
	}
	return { sourceInventory, utf8LfSourceInventory };
}

function parseDirtyPaths(status: string) {
	const rows = status.split('\0').filter(Boolean);
	const paths: string[] = [];
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index]!;
		if (row.length < 4) continue;
		const state = row.slice(0, 2);
		paths.push(row.slice(3).replaceAll('\\', '/'));
		if (state.includes('R') || state.includes('C')) {
			const original = rows[index + 1];
			if (original) paths.push(original.replaceAll('\\', '/'));
			index += 1;
		}
	}
	return [...new Set(paths)].sort(compareCodeUnits);
}

function verifyFixturePin(value: BomcProfileFixturePin | ResolvedBomcProfileFixture): AcceleratedFixturePin {
	const canonical = BOMC_PROFILE_FIXTURE_PINS.find((row) => row.id === value.id);
	if (!canonical || canonical.bytes !== value.bytes || canonical.sha256 !== value.sha256) throw new Error(`Unrecognized or changed accelerated fixture pin: ${value.id}`);
	const resolved = resolveBomcProfileFixture(canonical);
	const bytes = readFileSync(resolved.realPath);
	if (bytes.byteLength !== canonical.bytes || sha256(bytes) !== canonical.sha256) throw new Error(`Accelerated fixture bytes differ from their exact pin: ${value.id}`);
	return { id: canonical.id, bytes: canonical.bytes, sha256: canonical.sha256, path: resolved.path, realPath: resolved.realPath };
}

function verifyReferencePin(value: { id: 'current-input-oracle'; path: string; sha256: string }): AcceleratedReferencePin {
	if (value.id !== CURRENT_INPUT_ORACLE.id || path.resolve(value.path) !== path.resolve(CURRENT_INPUT_ORACLE.path) || value.sha256 !== CURRENT_INPUT_ORACLE.sha256) throw new Error('Accelerated reference artifact does not match the pinned current-input oracle.');
	const realPath = realpathSync(value.path);
	if (path.resolve(realPath) !== path.resolve(CURRENT_INPUT_ORACLE.path)) throw new Error('Current-input oracle resolved through a different filesystem path.');
	const bytes = readFileSync(realPath);
	if (bytes.byteLength !== CURRENT_INPUT_ORACLE.bytes || sha256(bytes) !== CURRENT_INPUT_ORACLE.sha256) throw new Error('Current-input oracle bytes differ from the pinned reference digest.');
	return { id: value.id, bytes: bytes.byteLength, sha256: sha256(bytes), path: value.path, realPath };
}

function validateBuildIdentity(value: AcceleratedBuildIdentity, testedHead: string) {
	if (!value || value.commit !== testedHead || typeof value.dirty !== 'boolean' || !/^[a-f0-9]{64}$/i.test(value.sourceSha256)) throw new Error('Expected Editor build identity must match the sealed HEAD and contain a SHA-256.');
}

function validateRuntime(runtime: AcceleratedRuntime) {
	if (!runtime || !runtime.node || !path.isAbsolute(runtime.nodePath) || !runtime.bun || !runtime.playwright
		|| runtime.browser !== 'chromium' || !runtime.browserVersion || runtime.backend !== 'chromium-headless-webgl2') throw new Error('Accelerated runtime identity is incomplete or unsupported.');
}

function validateSuiteCycle(suite: AcceleratedSuite, cycle?: AcceleratedColdCycle) {
	if (suite === 'current-cold') {
		if (!cycle || !['cold-01', 'cold-02', 'cold-03', 'warm-01'].includes(cycle)) throw new Error('Current-cold requires cold-01, cold-02, cold-03 or warm-01.');
	} else if (cycle !== undefined) throw new Error('Only current-cold accepts a cold cycle.');
}

function validatePreviousReceipt(input: {
	previousReceipt: string | null; cacheSourceReceipt: string | null; suite: AcceleratedSuite; cycle: AcceleratedColdCycle | null; attempt: number;
	identity: AcceleratedSourceIdentity; runtime: AcceleratedRuntime; executionRoot: string; attemptRoot: string;
}) {
	const topicReal = realpathSync(acceleratedTopicRoot);
	let previousReceipt: string | null = null;
	let cacheSourceReceipt: string | null = null;
	let cacheDir: string | null = null;
	if (input.cycle === 'warm-01') {
		if (!input.cacheSourceReceipt) throw new Error('warm-01 requires the passed cold-03 cache receipt.');
		cacheSourceReceipt = path.resolve(input.cacheSourceReceipt);
		assertRegularFile(cacheSourceReceipt, topicReal, 'cold-03 cache receipt');
		const coldReceipt = readJson<AcceleratedFinalReceipt>(cacheSourceReceipt);
		const coldTicket = coldReceipt.ticketSnapshot;
		if (coldReceipt.schemaVersion !== 'sibambo-accelerated-final-v1' || coldReceipt.gate !== 'passed' || coldReceipt.suite !== 'current-cold' || coldReceipt.cycle !== 'cold-03'
			|| coldTicket.suite !== 'current-cold' || coldTicket.cycle !== 'cold-03' || !coldTicket.cacheDir || !existsSync(coldTicket.cacheDir)
			|| path.resolve(cacheSourceReceipt) !== path.resolve(coldTicket.finalReceiptFile)
			|| path.resolve(coldTicket.cacheDir) !== path.resolve(coldTicket.attemptRoot, 'vite-cache')
			|| lstatSync(coldTicket.cacheDir).isSymbolicLink() || !lstatSync(coldTicket.cacheDir).isDirectory()) {
			throw new Error('warm-01 requires an existing passed cold-03 cache receipt.');
		}
		if (!sameAcceleratedIdentity(coldTicket, input.identity) || canonicalJson(coldTicket.runtime) !== canonicalJson(input.runtime)) throw new Error('cold-03 source, input, oracle, build or runtime differs from warm-01.');
		assertRealpathInside(topicReal, coldTicket.cacheDir);
		cacheDir = coldTicket.cacheDir;
	} else if (input.cacheSourceReceipt) {
		throw new Error('A cold cache source receipt is accepted only for warm-01.');
	}
	if (input.previousReceipt) {
		previousReceipt = path.resolve(input.previousReceipt);
		assertRegularFile(previousReceipt, topicReal, 'setup retry receipt');
		const receipt = readJson<AcceleratedFinalReceipt>(previousReceipt);
		const prior = receipt.ticketSnapshot;
		if (receipt.schemaVersion !== 'sibambo-accelerated-final-v1' || receipt.gate === 'passed' || !receipt.retryEligible
			|| receipt.attempt !== 1 || input.attempt !== 2 || prior.attempt !== 1
			|| receipt.suite !== input.suite || receipt.cycle !== input.cycle
			|| prior.suite !== input.suite || prior.cycle !== input.cycle
			|| path.resolve(previousReceipt) !== path.resolve(prior.finalReceiptFile)
			|| receipt.markerFiles.length !== 0 || receipt.caseOutcomes.length !== 0 || !receipt.cleanup.passed) {
			throw new Error('Same-source retry requires one recognized pre-outcome setup failure from attempt 1.');
		}
		validateTicketSchema(prior);
		validateTicketPaths(prior);
		if (path.resolve(prior.executionRoot) !== path.resolve(input.executionRoot)
			|| path.resolve(prior.attemptRoot) !== path.resolve(input.executionRoot, input.suite, input.cycle ?? 'run', 'attempt-01')) {
			throw new Error('Same-source retry must use the original run root and its exact attempt-01 ticket.');
		}
		if (!sameAcceleratedIdentity(prior, input.identity) || canonicalJson(prior.runtime) !== canonicalJson(input.runtime)) throw new Error('Setup retry source, fixture, build or runtime identity changed.');
	} else if (input.attempt === 2) {
		throw new Error('Attempt 2 requires the exact recognized pre-outcome attempt 1 receipt.');
	}
	if (input.attempt === 1 && previousReceipt) throw new Error('Attempt 1 cannot consume a prior receipt.');
	return { previousReceipt, cacheSourceReceipt, cacheDir };
}

function validateTicketSchema(ticket: AcceleratedProofTicket) {
	if (!ticket || ticket.schemaVersion !== 'sibambo-accelerated-proof-v1' || ticket.planId !== PLAN_ID || ticket.planVersion !== PLAN_VERSION
		|| !Number.isSafeInteger(ticket.attempt) || ticket.attempt < 1 || !ticket.nonce || !ticket.runUUID || !/^[a-f0-9]{64}$/i.test(ticket.identitySha256)) throw new Error('Accelerated run ticket schema or plan identity is invalid.');
	if (ticket.testTitles.length !== ticket.cases.length || ticket.markerFiles.length !== ticket.testTitles.length) throw new Error('Accelerated run ticket case inventory is inconsistent.');
	if (!path.isAbsolute(ticket.executionRoot) || !path.isAbsolute(ticket.attemptRoot) || !path.isAbsolute(ticket.outputDir) || !path.isAbsolute(ticket.reportFile) || !path.isAbsolute(ticket.outputRootRealPath)) throw new Error('Accelerated ticket output paths must be absolute.');
	validateSuiteCycle(ticket.suite, ticket.cycle ?? undefined);
	const expectedPaths = acceleratedSpecAndConfig(ticket.suite);
	const expectedCases = acceleratedCaseDefinitions(ticket.suite, ticket.cycle, acceleratedFixturesForSuite(ticket.suite).map((row) => row.id));
	const expectedAttemptRoot = path.join(ticket.executionRoot, ticket.suite, ticket.cycle ?? 'run', `attempt-${String(ticket.attempt).padStart(2, '0')}`);
	if (path.resolve(ticket.configPath) !== path.resolve(expectedPaths.configPath) || path.resolve(ticket.specPath) !== path.resolve(expectedPaths.specPath)
		|| path.resolve(ticket.attemptRoot) !== path.resolve(expectedAttemptRoot)
		|| path.resolve(ticket.outputDir) !== path.join(expectedAttemptRoot, 'playwright-output')
		|| path.resolve(ticket.reportFile) !== path.join(expectedAttemptRoot, 'reports', 'playwright-report.json')
		|| path.resolve(ticket.ticketFile) !== path.join(expectedAttemptRoot, 'run-ticket.json')
		|| path.resolve(ticket.finalReceiptFile) !== path.join(expectedAttemptRoot, 'final-receipt.json')
		|| canonicalJson(ticket.cases) !== canonicalJson(expectedCases) || canonicalJson(ticket.testTitles) !== canonicalJson(expectedCases.map((row) => row.title))
		|| canonicalJson(ticket.caseSidecarNames) !== canonicalJson(expectedCases.map((row) => ({ title: row.title, name: row.sidecarName })))) {
		throw new Error('Accelerated ticket spec/config/case inventory differs from the frozen suite contract.');
	}
	const expectedMarkers = expectedCases.map((row) => path.join(expectedAttemptRoot, 'outcomes', `${titleSlug(row.title)}.json`));
	if (canonicalJson(ticket.markerFiles.map((value) => path.resolve(value))) !== canonicalJson(expectedMarkers.map((value) => path.resolve(value)))) throw new Error('Accelerated ticket marker paths differ from the frozen case inventory.');
	if (ticket.suite === 'current-cold') {
		if (!ticket.cacheDir || !path.isAbsolute(ticket.cacheDir)) throw new Error('Current-cold ticket is missing its absolute owned Vite cache path.');
		if (ticket.cycle === 'warm-01') {
			if (!ticket.cacheSourceReceipt || !path.isAbsolute(ticket.cacheSourceReceipt)) throw new Error('warm-01 ticket is missing the exact cold-03 cache receipt.');
			const topicReal = realpathSync(acceleratedTopicRoot);
			assertRegularFile(ticket.cacheSourceReceipt, topicReal, 'cold-03 cache receipt');
			const receipt = readJson<AcceleratedFinalReceipt>(ticket.cacheSourceReceipt);
			const coldTicket = receipt.ticketSnapshot;
			if (receipt.schemaVersion !== 'sibambo-accelerated-final-v1' || receipt.gate !== 'passed' || receipt.suite !== 'current-cold' || receipt.cycle !== 'cold-03'
				|| !receipt.cleanup.passed || receipt.markerFiles.length !== coldTicket.testTitles.length
				|| coldTicket.suite !== 'current-cold' || coldTicket.cycle !== 'cold-03'
				|| path.resolve(ticket.cacheSourceReceipt) !== path.resolve(coldTicket.finalReceiptFile)
				|| path.resolve(ticket.cacheDir) !== path.resolve(coldTicket.cacheDir ?? '')
				|| !sameAcceleratedIdentity(coldTicket, ticket) || canonicalJson(coldTicket.runtime) !== canonicalJson(ticket.runtime)) {
				throw new Error('warm-01 cache receipt does not contain a passed, identical cold-03 source/runtime/cache.');
			}
		} else if (path.resolve(ticket.cacheDir) !== path.resolve(expectedAttemptRoot, 'vite-cache') || ticket.cacheSourceReceipt !== null) {
			throw new Error('Cold cycle cache path must be its newly claimed empty attempt-local directory.');
		}
	} else if (ticket.cacheDir !== null || ticket.cacheSourceReceipt !== null) {
		throw new Error('Only current-cold tickets may claim a Vite cache directory or cache source receipt.');
	}
}

type AcceleratedMarker = {
	schemaVersion: string; planId: string; planVersion: string; runUUID: string; attempt: number; title: string; nonce: string;
	testedHead: string; identitySha256: string; inputHashes: Record<string, string>; observations: Record<string, boolean>;
	sidecar: { path: string; bytes: number; sha256: string };
	artifacts: Array<{ name: string; path: string; bytes: number; sha256: string }>;
};
type CurrentInputOracle = {
	schemaVersion: string; limits: string;
	fixtures: Array<{ id: string; bytes: number; sha256: string; materialVersion: number; textureTableVersion: number; sourceTextureCount: number; activeSemanticCount: number; materials: Array<{
		materialIndex: number; name: string | null; displayName: string | null; rgba: number[]; opacity: number; textureIndex: number | null;
		textureWidthM: number; textureHeightM: number; activeSemantic: boolean;
		semantic?: { materialType: number; colorizeMode: number; deltas: number[]; outputRgbaSha256: string };
	}> }>;
};

function resolveTicketFixture(pin: AcceleratedFixturePin): ResolvedBomcProfileFixture {
	const row = BOMC_PROFILE_FIXTURE_PINS.find((candidate) => candidate.id === pin.id);
	if (!row || row.bytes !== pin.bytes || row.sha256 !== pin.sha256) throw new Error(`Ticket fixture pin is not recognized: ${pin.id}`);
	const resolved = resolveBomcProfileFixture(row);
	if (path.resolve(resolved.realPath) !== path.resolve(pin.realPath)) throw new Error(`Ticket fixture realpath changed: ${pin.id}`);
	return resolved;
}

function validateObservations(definition: AcceleratedCaseDefinition, observations: Record<string, boolean>, inputHashes: Record<string, string>) {
	if (!observations || typeof observations !== 'object' || Array.isArray(observations)) throw new Error(`Case ${definition.title} must record named observations.`);
	for (const name of definition.requiredObservations) if (observations[name] !== true) throw new Error(`Required observation ${name} is absent or false for ${definition.title}.`);
	for (const name of definition.requiredInputHashKeys) if (typeof inputHashes[name] !== 'string' || !/^[a-f0-9]{64}$/i.test(inputHashes[name]!)) throw new Error(`Required input hash ${name} is absent or invalid for ${definition.title}.`);
}

function findCase(ticket: AcceleratedProofTicket, title: string) {
	const definition = ticket.cases.find((row) => row.title === title);
	if (!definition || ticket.testTitles.filter((row) => row === title).length !== 1) throw new Error(`Case title is not uniquely claimed by the accelerated ticket: ${title}`);
	return definition;
}

function markerFor(ticket: AcceleratedProofTicket, title: string) {
	const index = ticket.testTitles.indexOf(title);
	if (index < 0) throw new Error(`Case title is not in the accelerated ticket: ${title}`);
	return ticket.markerFiles[index]!;
}

function validateReportAttachments(report: AcceleratedPlaywrightReport, marker: AcceleratedMarker, definition: AcceleratedCaseDefinition, outputRootRealPath: string, errors: string[]) {
	const spec = flattenReportSpecs(report.suites ?? []).find((row) => row.title === marker.title);
	const attachments = spec?.tests[0]?.results[0]?.attachments ?? [];
	const expected = [definition.sidecarName, ...definition.artifactNames];
	for (const name of expected) {
		const expectedType = name.endsWith('.png') ? 'image/png' : 'application/json';
		const matches = attachments.filter((row) => row.name === name && row.contentType === expectedType);
		if (matches.length !== 1) { errors.push(`${marker.title} JSON report must attach ${name} exactly once.`); continue; }
		const attachedPath = matches[0]!.path;
		const retained = name === definition.sidecarName ? marker.sidecar : marker.artifacts.find((row) => row.name === name);
		if (!attachedPath || !retained) { errors.push(`${marker.title} report attachment ${name} has no retained evidence file.`); continue; }
		const resolvedAttachment = path.resolve(attachedPath);
		try {
			assertRealpathInside(outputRootRealPath, resolvedAttachment);
			const attachedStat = lstatSync(resolvedAttachment);
			if (!attachedStat.isFile() || attachedStat.isSymbolicLink()) throw new Error('report copy is not a regular owned file');
			const attachedBytes = readFileSync(resolvedAttachment);
			if (attachedBytes.byteLength !== retained.bytes || sha256(attachedBytes) !== retained.sha256) {
				throw new Error('report copy bytes or SHA-256 differ from the retained evidence file');
			}
		} catch (error) {
			errors.push(`${marker.title} report attachment ${name} does not preserve its retained content inside the ticket output: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function flattenReportSpecs(suites: NonNullable<AcceleratedPlaywrightReport['suites']>): AcceleratedPlaywrightSpec[] {
	const rows: AcceleratedPlaywrightSpec[] = [];
	for (const suite of suites) {
		if (suite.specs) rows.push(...suite.specs);
		if (suite.suites) rows.push(...flattenReportSpecs(suite.suites));
	}
	return rows;
}

function createSafeDirectory(root: string, target: string) {
	assertStrictChild(root, target, `Directory must be a strict child of ${root}.`);
	ensureSafeExistingAncestors(root, target);
	if (!existsSync(target)) mkdirSync(target, { recursive: false });
	if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) throw new Error(`Expected a real directory: ${target}`);
	assertRealpathInside(root, target);
}

function createSafeDirectoryTree(root: string, target: string) {
	const absoluteRoot = path.resolve(root);
	const absoluteTarget = path.resolve(target);
	assertStrictChild(absoluteRoot, absoluteTarget, `Directory tree must be a strict child of ${absoluteRoot}.`);
	ensureSafeExistingAncestors(absoluteRoot, absoluteTarget);
	const relative = path.relative(absoluteRoot, absoluteTarget);
	let cursor = absoluteRoot;
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		cursor = path.join(cursor, segment);
		if (!existsSync(cursor)) mkdirSync(cursor, { recursive: false });
		const stat = lstatSync(cursor);
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Expected a real directory: ${cursor}`);
		assertRealpathInside(absoluteRoot, cursor);
	}
}

function ensureSafeExistingAncestors(root: string, target: string) {
	const absoluteRoot = path.resolve(root);
	const absoluteTarget = path.resolve(target);
	assertStrictChild(absoluteRoot, absoluteTarget, `Path must be a strict child of ${absoluteRoot}.`);
	const relative = path.relative(absoluteRoot, absoluteTarget);
	let cursor = absoluteRoot;
	if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Canonical worklog root cannot be a link: ${cursor}`);
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		cursor = path.join(cursor, segment);
		if (!existsSync(cursor)) break;
		const stat = lstatSync(cursor);
		if (stat.isSymbolicLink()) throw new Error(`Proof path contains a link or junction: ${cursor}`);
	}
}

function assertStrictChild(root: string, target: string, message: string) {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(message);
}

function assertRealpathInside(root: string, target: string) {
	const rootReal = realpathSync(root);
	const targetReal = realpathSync(target);
	const relative = path.relative(rootReal, targetReal);
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Resolved proof path escapes its canonical root: ${target}`);
}

function assertRegularFile(target: string, root: string, label: string) {
	if (!existsSync(target) || lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile()) throw new Error(`${label} must be an existing regular file: ${target}`);
	assertRealpathInside(root, target);
}

function validateTicketPaths(ticket: AcceleratedProofTicket) {
	const topicReal = realpathSync(acceleratedTopicRoot);
	const ownedPaths = [ticket.executionRoot, ticket.attemptRoot, ticket.outputDir, path.dirname(ticket.reportFile), path.dirname(ticket.ticketFile), ticket.ticketFile, ticket.finalReceiptFile, ...ticket.markerFiles];
	if (ticket.cacheDir) ownedPaths.push(ticket.cacheDir);
	if (ticket.cacheSourceReceipt) ownedPaths.push(ticket.cacheSourceReceipt);
	for (const target of ownedPaths) {
		assertStrictChild(topicReal, target, `Ticket path escapes the canonical worklog root: ${target}`);
	}
	assertRealpathInside(topicReal, ticket.outputDir);
	assertRealpathInside(topicReal, path.dirname(ticket.reportFile));
	assertRealpathInside(topicReal, ticket.ticketFile);
	assertRealpathInside(topicReal, ticket.executionRoot);
	assertRealpathInside(topicReal, ticket.attemptRoot);
	if (ticket.cacheDir) {
		if (lstatSync(ticket.cacheDir).isSymbolicLink() || !lstatSync(ticket.cacheDir).isDirectory()) throw new Error('Ticketed Vite cache must be an existing real directory.');
		assertRealpathInside(topicReal, ticket.cacheDir);
	}
	if (ticket.cacheSourceReceipt) assertRegularFile(ticket.cacheSourceReceipt, topicReal, 'cold-03 cache receipt');
	if (realpathSync(ticket.outputDir) !== path.resolve(ticket.outputRootRealPath)) throw new Error('Ticketed Playwright output root realpath changed.');
}
function compareCodeUnits(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }
function sortJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJsonValue);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareCodeUnits(a, b)).map(([key, item]) => [key, sortJsonValue(item)]));
	return value;
}
function sha256(value: Uint8Array | string) { return createHash('sha256').update(value).digest('hex'); }
function readJson<T>(filePath: string): T { return JSON.parse(readFileSync(filePath, 'utf8')) as T; }
function isEmptyErrors(value: unknown) { return value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0; }
function hasPngSignature(value: Uint8Array) { return value.byteLength >= 8 && value[0] === 0x89 && value[1] === 0x50 && value[2] === 0x4e && value[3] === 0x47 && value[4] === 0x0d && value[5] === 0x0a && value[6] === 0x1a && value[7] === 0x0a; }
