import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
	existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, readdirSync, statSync, writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ProofTrack = 'mirror' | 'cold' | 'semantic' | 'writer';
export type ColdCycle = 'cold-01' | 'cold-02' | 'cold-03' | 'warm-01';
export type ProofAttempt = '01' | '02';
export type SourceIdentity = {
	testedHead: string;
	dirty: boolean;
	dirtyPaths: string[];
	sourceInventory: Array<{ path: string; bytes: number; sha256: string }>;
	fixturePins: Array<{ id: string; path: string; bytes: number; sha256: string }>;
	identitySha256: string;
};
export type ProofPaths = {
	track: ProofTrack;
	executionRoot: string;
	canonicalTopicRoot: string;
	claimRoot: string;
	outputDir: string;
	reportFile: string;
	finalGateFile: string;
	cacheDir: string | null;
	configPath: string;
	specPath: string;
	testTitles: string[];
	cycle: ColdCycle | 'stability' | null;
	attempt: ProofAttempt;
};
export type ProofTicket = SourceIdentity & ProofPaths & {
	schemaVersion: 'sibambo-proof-run-v1';
	planId: 'BOMC-PHASE2A-READINESS-001';
	planVersion: '1.1';
	nonce: string;
	repoRoot: string;
	runtime: { node: string; nodePath: string; bun: string; playwright: string };
	previousReceipt: string | null;
	requiredSidecars: string[];
};
export type DiscoveryContext = ProofPaths & {
	discoveryOnly: true;
	planId: 'BOMC-PHASE2A-READINESS-001';
	planVersion: '1.1';
	};
export type ReadProofContext = ProofTicket | DiscoveryContext;

const helperDir = path.dirname(fileURLToPath(import.meta.url));
export const editorRoot = path.resolve(helperDir, '../..');
export const workspaceRoot = path.resolve(editorRoot, '..');
const worklogRoot = path.join(workspaceRoot, 'docs', 'worklogs');
const planId = 'BOMC-PHASE2A-READINESS-001' as const;
const planVersion = '1.1' as const;
const commonSnapshotFile = path.join(worklogRoot, planId, '2026-10-06-implementation-run-001', 'common-source-snapshot.json');
const toolNodePath = 'C:/Users/kaisa/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe';

const testTitles: Record<ProofTrack, (cycle: ColdCycle | 'stability' | null) => string[]> = {
	mirror: () => [
		'mirror front/back rendering preserves source identity through filter and movement',
		'S2 mirrored door follows the raw ordinary renderer through orbit and zoom',
		'S1 mirrored preparation retains source data and disposes cleanly'
	],
	cold: (cycle) => cycle === 'cold-01'
		? ['one S2-new selection reaches first ready draw without a dev full reload', 'Open controls remain disabled until the client bindings are ready']
		: ['one S2-new selection reaches first ready draw without a dev full reload'],
	semantic: () => [
		'S2-new maps every active material and texture metric to its verified semantic PNG',
		'corrupt semantic replacement errors while the usable S2-jcm session stays mounted'
	],
	writer: () => [
		'writer output survives independent read and real viewport draw',
		'writer cancellation and disposal ignore late results',
		'writer cache is reused in a persistent browser worker'
	]
};

const topicByTrack: Record<ProofTrack, string> = {
	mirror: 'BOMC-VIEWER-RECOVERY-001',
	cold: 'BOMC-EDITOR-STABILITY-001',
	semantic: 'BOMC-EDITOR-STABILITY-001',
	writer: 'BOMC-WEB-WRITER-001'
};

const configByTrack: Record<ProofTrack, string> = {
	mirror: 'tooling/performance/viewer-recovery/playwright.config.ts',
	cold: 'apps/editor/playwright.dev.config.ts',
	semantic: 'apps/editor/playwright.stability.config.ts',
	writer: 'tooling/performance/bomc-writer/playwright.config.ts'
};

const specByTrack: Record<ProofTrack, string> = {
	mirror: 'tooling/performance/viewer-recovery/mirrored-surfaces.spec.ts',
	cold: 'tooling/testing/editor-dev-cold-start.spec.ts',
	semantic: 'apps/editor/tests/materials-v2.spec.ts',
	writer: 'tooling/performance/bomc-writer/proof.spec.ts'
};

const requiredSourcePins: Record<string, string> = {
	'bom_engine_plugin/bom_engine/bomc_format.rb': 'e3f5e74377cb3705843f496230551662f3a0e2e2fc459eb2ca3b86522ae40deb',
	'bom_engine_plugin/bom_engine/bomc_writer.rb': '89ca49f5c601659b261327f5cf2c80eace734802b9d0d7937e137e901f7de7e4',
	'bom_engine_plugin/bom_engine/bomc_decoder.rb': '56c47be4ceefb96d51d1fd73d1e618cc4515ce924fda5ea8f97df902c8cf59c6',
	'bom_engine_plugin/bom_engine/bomc_codecs.rb': 'd59de387880c2624f571c473d6a17c922e6615c0e957effc2f2df41cf21b1a3d',
	'bom_engine_plugin/bom_engine/bomc_encoding_contract.rb': 'e3af9cbd8a7bbf328dc26f1c44e501a5569e269bc7d064c5bc181a383fe762e4',
	'sibambo-editor/packages/e4-import/src/bomc-loader.ts': '095123e0fe397b3507e70d7d2088eb57830749d4b430c4e00fed4c369caf63e8',
	'sibambo-editor/packages/e4-import/src/container.ts': '706c5c48ae5cb8a9264081d7f01926be993718d295196f5ba264879e30d23cbb',
	'sibambo-editor/apps/editor/src/lib/editor/EditorSession.ts': 'a0b8b9b5e8593a372dd57b3b5b37b2197590ae2d54981c9abf7e9781507aee26',
	'sibambo-editor/apps/editor/src/lib/editor/geometry/editable-geometry.ts': 'afb1231e68e98d4715e403468ac1437c0fcba05000a5b987769ef9c9a5e0edd8'
};

const sourceDirs = [
	'apps/editor/src', 'apps/editor/tests',
	'packages/contracts/src', 'packages/e4-import/src', 'packages/provenance/src',
	'packages/scene-runtime/src', 'packages/viewport/src', 'packages/bomc-document/src',
	'packages/bomc-document/test-fixtures', 'tooling/testing',
	'tooling/performance/viewer-recovery', 'tooling/performance/bomc-writer'
];
const sourceFiles = [
	'package.json', 'bun.lock', 'tsconfig.json', 'packages/tsconfig.json',
	'apps/editor/package.json', 'apps/editor/tsconfig.json', 'apps/editor/svelte.config.js',
	'apps/editor/vite.config.ts', 'apps/editor/playwright.config.ts',
	'apps/editor/playwright.dev.config.ts', 'apps/editor/playwright.stability.config.ts'
];

export function resolveProofPaths(input: {
	track: ProofTrack; executionRoot: string; attempt: ProofAttempt;
	cycle?: ColdCycle | 'stability'; previousReceipt?: string | null
}): ProofPaths {
	assertTrack(input.track);
	if (input.attempt !== '01' && input.attempt !== '02') throw new Error('Proof attempt must be 01 or 02.');
	const cycle = input.track === 'cold' ? input.cycle : input.track === 'semantic' ? 'stability' : null;
	if (input.track === 'cold' && !['cold-01', 'cold-02', 'cold-03', 'warm-01'].includes(cycle ?? '')) throw new Error('Cold track requires one named cycle.');
	if (input.track === 'semantic' && input.cycle !== undefined && input.cycle !== 'stability') throw new Error('Semantic track cycle must be stability.');
	if ((input.track === 'mirror' || input.track === 'writer') && input.cycle !== undefined) throw new Error(`${input.track} track cannot use a cycle.`);
	if (!path.isAbsolute(input.executionRoot)) throw new Error('Execution root must be an absolute path.');
	const canonicalTopicRoot = path.join(worklogRoot, topicByTrack[input.track]);
	if (!existsSync(canonicalTopicRoot) || !statSync(canonicalTopicRoot).isDirectory()) throw new Error(`Canonical worklog topic is missing: ${canonicalTopicRoot}`);
	const canonicalReal = realpathSync(canonicalTopicRoot);
	const executionRoot = path.resolve(input.executionRoot);
	assertStrictChild(canonicalReal, executionRoot, 'Execution root must be a strict child of its canonical topic.');
	if (!existsSync(executionRoot) || !statSync(executionRoot).isDirectory()) throw new Error(`Execution root must already exist: ${executionRoot}`);
	assertRealpathInside(canonicalReal, executionRoot);
	let claimRoot: string;
	if (input.track === 'cold') claimRoot = path.join(executionRoot, 'dev', cycle!, `attempt-${input.attempt}`);
	else if (input.track === 'semantic') claimRoot = path.join(executionRoot, 'browser', 'stability', `attempt-${input.attempt}`);
	else claimRoot = path.join(executionRoot, 'browser', `attempt-${input.attempt}`);
	assertPotentialPathInside(canonicalReal, claimRoot);
	const outputDir = path.join(claimRoot, 'playwright-output');
	const reportFile = path.join(claimRoot, 'reports', 'playwright-report.json');
	const finalGateFile = path.join(claimRoot, 'final-gate.json');
	let cacheDir: string | null = null;
	if (input.track === 'cold') cacheDir = cycle === 'warm-01' ? null : path.join(claimRoot, 'cache');
	const selectedTitles = testTitles[input.track](cycle ?? null);
	return {
		track: input.track, executionRoot, canonicalTopicRoot: canonicalReal, claimRoot,
		outputDir, reportFile, finalGateFile, cacheDir,
		configPath: path.join(editorRoot, configByTrack[input.track]),
		specPath: path.join(editorRoot, specByTrack[input.track]),
		testTitles: selectedTitles, cycle: cycle ?? null, attempt: input.attempt
	};
}

export function captureSourceIdentity(): SourceIdentity {
	const paths = new Set<string>();
	for (const relativeDir of sourceDirs) {
		const absolute = path.join(editorRoot, relativeDir);
		if (!existsSync(absolute)) continue;
		for (const file of walkSourceFiles(absolute)) paths.add(path.relative(editorRoot, file));
	}
	for (const relativePath of sourceFiles) if (existsSync(path.join(editorRoot, relativePath))) paths.add(relativePath);
	for (const relativePath of Object.keys(requiredSourcePins)) paths.add(path.relative(editorRoot, path.resolve(workspaceRoot, relativePath)));
	const fixtureManifestPath = path.join(editorRoot, 'tooling', 'performance', 'fixtures.json');
	if (!existsSync(fixtureManifestPath)) throw new Error('Pinned BOMC fixture manifest is missing.');
	paths.add(path.relative(editorRoot, fixtureManifestPath));
	const inventory = [...paths].sort().map((relativePath) => {
		const absolute = path.resolve(editorRoot, relativePath);
		const bytes = readFileSync(absolute);
		return { path: relativePath.replaceAll(path.sep, '/'), bytes: bytes.byteLength, sha256: sha256(bytes) };
	});
	const inventoryByPath = new Map(inventory.map((row) => [row.path, row]));
	for (const [relativePath, expectedSha] of Object.entries(requiredSourcePins)) {
		const editorRelative = path.relative(editorRoot, path.resolve(workspaceRoot, relativePath)).replaceAll(path.sep, '/');
		const row = inventoryByPath.get(editorRelative);
		if (!row || row.sha256 !== expectedSha) throw new Error(`Required source pin changed: ${relativePath}`);
	}
	const fixtures = fixtureIdentities(fixtureManifestPath);
	const dirtyOutput = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: editorRoot, encoding: 'utf8' });
	const dirtyPaths = dirtyOutput.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3)).sort();
	const testedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: editorRoot, encoding: 'utf8' }).trim();
	const digestInput = JSON.stringify({ testedHead, dirtyPaths, inventory, fixtures });
	return { testedHead, dirty: dirtyPaths.length > 0, dirtyPaths, sourceInventory: inventory, fixturePins: fixtures, identitySha256: sha256(digestInput) };
}

export function claimProofAttempt(input: {
	track: ProofTrack; executionRoot: string; attempt: ProofAttempt;
	cycle?: ColdCycle | 'stability'; previousReceipt?: string | null; runtime: ProofTicket['runtime']; requireCommonSnapshot?: boolean
}): ProofTicket {
	const paths = resolveProofPaths(input);
	const identity = captureSourceIdentity();
	if (input.requireCommonSnapshot) validateSealedSourceSnapshot(identity);
	else validateCommonSourceSnapshot(identity);
	let previousReceipt: string | null = null;
	if (input.attempt === '02') {
		const attemptOne = resolveProofPaths({ ...input, attempt: '01' });
		const receipt = input.previousReceipt ? path.resolve(input.previousReceipt) : attemptOne.finalGateFile;
		if (receipt !== attemptOne.finalGateFile) throw new Error('Attempt-02 receipt must be the attempt-01 final receipt in this execution root.');
		const previous = readJson<FinalGateReceipt>(receipt);
		if (!previous.retryEligible || previous.gate === 'passed' || previous.ticketSnapshot.identitySha256 !== identity.identitySha256 || !sameRuntime(previous.ticketSnapshot.runtime, input.runtime)) {
			throw new Error('Attempt-02 requires a setup-only attempt-01 failure with identical source, fixtures, and runtime.');
		}
		previousReceipt = receipt;
	}
	if (input.track === 'cold' && paths.cycle === 'warm-01') {
		if (!input.previousReceipt) throw new Error('warm-01 requires the passed cold-03 final receipt.');
		const receiptPath = path.resolve(input.previousReceipt);
		const expectedCold = resolveProofPaths({ track: 'cold', executionRoot: paths.executionRoot, attempt: '01', cycle: 'cold-03' });
		if (receiptPath !== expectedCold.finalGateFile) throw new Error('warm-01 receipt must be the cold-03 final receipt in this execution root.');
		const previous = readJson<FinalGateReceipt>(receiptPath);
		if (previous.gate !== 'passed' || previous.ticketSnapshot.track !== 'cold' || previous.ticketSnapshot.cycle !== 'cold-03' || previous.ticketSnapshot.cacheDir !== path.join(expectedCold.claimRoot, 'cache') || !existsSync(previous.ticketSnapshot.cacheDir)) {
			throw new Error('warm-01 requires the existing cache from a passed cold-03 run.');
		}
		if (!sameIdentity(previous.ticketSnapshot, identity) || !sameRuntime(previous.ticketSnapshot.runtime, input.runtime)) throw new Error('cold-03 source/fixture/runtime identity differs from warm-01.');
		paths.cacheDir = previous.ticketSnapshot.cacheDir;
		previousReceipt = receiptPath;
	}
	const parent = path.dirname(paths.claimRoot);
	mkdirWithin(paths.canonicalTopicRoot, parent);
	assertRealpathInside(paths.canonicalTopicRoot, parent);
	if (input.track === 'cold' && paths.cycle !== 'warm-01' && existsSync(paths.cacheDir!)) throw new Error(`Fresh cold cache must not exist at claim time: ${paths.cacheDir}`);
	const claim = {
		...paths,
		schemaVersion: 'sibambo-proof-run-v1' as const,
		planId, planVersion,
		nonce: randomUUID(),
		repoRoot: editorRoot,
		...identity,
		runtime: input.runtime,
		previousReceipt,
		requiredSidecars: paths.testTitles.map((title) => path.join(paths.claimRoot, 'reports', 'cases', `${titleSlug(title)}.json`))
	} satisfies ProofTicket;
	mkdirSync(paths.claimRoot, { recursive: false });
	assertRealpathInside(paths.canonicalTopicRoot, paths.claimRoot);
	mkdirSync(path.dirname(claim.reportFile), { recursive: true });
	writeFileSync(path.join(paths.claimRoot, 'run-ticket.json'), `${JSON.stringify(claim, null, 2)}\n`, { flag: 'wx' });
	return claim;
}

export function readProofTicket(expectedTrack?: ProofTrack): ReadProofContext {
	const env = process.env;
	if (env.SIBAMBO_PROOF_DISCOVERY === '1') {
		if (env.SIBAMBO_PROOF_TICKET) throw new Error('Discovery must not receive a run ticket.');
		const track = expectedTrack ?? inferTrack(env);
		if (expectedTrack && inferTrack(env) !== expectedTrack) throw new Error(`Discovery environment does not match ${expectedTrack}.`);
		const resolved = resolveProofPaths({ track, executionRoot: requiredTrackRoot(track, env), attempt: requiredAttempt(track, env), cycle: requiredCycle(track, env) });
		validateSealedSourceSnapshot();
		return { ...resolved, discoveryOnly: true, planId, planVersion };
	}
	const ticketPath = env.SIBAMBO_PROOF_TICKET;
	if (!ticketPath || !path.isAbsolute(ticketPath)) throw new Error('SIBAMBO_PROOF_TICKET must be an absolute path.');
	const ticket = readJson<ProofTicket>(ticketPath);
	if (ticket.schemaVersion !== 'sibambo-proof-run-v1' || ticket.planId !== planId || ticket.planVersion !== planVersion) throw new Error('Proof ticket schema or governing plan identity is invalid.');
	if (path.resolve(ticket.repoRoot) !== path.resolve(editorRoot)) throw new Error('Proof ticket repository root is invalid.');
	if (expectedTrack && ticket.track !== expectedTrack) throw new Error(`Proof ticket track ${ticket.track} does not match ${expectedTrack}.`);
	if (env.SIBAMBO_PROOF_NONCE !== ticket.nonce) throw new Error('Proof ticket nonce does not match the runner environment.');
	const paths = resolveProofPaths({ track: ticket.track, executionRoot: ticket.executionRoot, attempt: ticket.attempt, cycle: ticket.cycle ?? undefined });
	for (const key of ['canonicalTopicRoot', 'claimRoot', 'outputDir', 'reportFile', 'finalGateFile', 'configPath', 'specPath'] as const) {
		if (path.resolve(ticket[key]) !== path.resolve(paths[key])) throw new Error(`Proof ticket ${key} does not match its validated path.`);
	}
	for (const target of [paths.claimRoot, paths.outputDir, path.dirname(paths.reportFile), path.dirname(paths.finalGateFile), ...(paths.cacheDir ? [paths.cacheDir] : [])]) {
		assertPotentialPathInside(paths.canonicalTopicRoot, target);
	}
	if (path.resolve(ticketPath) !== path.join(paths.claimRoot, 'run-ticket.json')) throw new Error('Proof ticket file is outside the claimed attempt.');
	if (ticket.testTitles.join('\0') !== paths.testTitles.join('\0')) throw new Error('Proof ticket selected test titles changed.');
	const expectedSidecars = paths.testTitles.map((title) => path.join(paths.claimRoot, 'reports', 'cases', `${titleSlug(title)}.json`));
	if (!Array.isArray(ticket.requiredSidecars) || ticket.requiredSidecars.length !== expectedSidecars.length
		|| ticket.requiredSidecars.some((file, index) => typeof file !== 'string' || path.resolve(file) !== path.resolve(expectedSidecars[index]!))) {
		throw new Error('Proof ticket required sidecars do not match its selected cases.');
	}
	for (const sidecar of expectedSidecars) assertPotentialPathInside(paths.canonicalTopicRoot, sidecar);
	if (requiredTrackRoot(ticket.track, env) !== ticket.executionRoot || requiredAttempt(ticket.track, env) !== ticket.attempt || (requiredCycle(ticket.track, env) ?? null) !== ticket.cycle) throw new Error('Legacy config environment does not match the immutable ticket.');
	validateTicketCache(ticket, paths);
	const current = captureSourceIdentity();
	validateSealedSourceSnapshot(current);
	if (!sameIdentity(ticket, current)) throw new Error('Current source or fixture identity differs from the frozen proof ticket.');
	return ticket;
}

export function markProofOutcome(context: ReadProofContext, title: string): string {
	if ('discoveryOnly' in context) throw new Error('Discovery cannot mark test outcomes.');
	if (!context.testTitles.includes(title)) throw new Error(`Outcome title is not selected by this ticket: ${title}`);
	const markerDir = path.join(context.claimRoot, 'outcomes');
	mkdirSync(markerDir, { recursive: true });
	assertRealpathInside(context.canonicalTopicRoot, markerDir);
	const filePath = path.join(markerDir, `${titleSlug(title)}.json`);
	const marker = { planId, planVersion, title, nonce: context.nonce, testedHead: context.testedHead, identitySha256: context.identitySha256, recordedAt: new Date().toISOString() };
	writeFileSync(filePath, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
	return filePath;
}

export function writeProofSidecar(context: ReadProofContext, title: string, data: Record<string, unknown>): string {
	if ('discoveryOnly' in context) throw new Error('Discovery cannot write proof sidecars.');
	if (!context.testTitles.includes(title)) throw new Error(`Sidecar title is not selected by this ticket: ${title}`);
	const filePath = context.requiredSidecars[context.testTitles.indexOf(title)];
	if (!filePath) throw new Error(`Ticket has no sidecar path for ${title}`);
	mkdirSync(path.dirname(filePath), { recursive: true });
	assertRealpathInside(context.canonicalTopicRoot, path.dirname(filePath));
	const payload = { ...data, planId, planVersion, title, nonce: context.nonce, testedHead: context.testedHead, identitySha256: context.identitySha256 };
	writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
	return filePath;
}

export function evaluateFinalGate(input: {
	ticket: ProofTicket;
	report: PlaywrightReport | null;
	child: { exitCode: number | null; signal: string | null };
	cleanup: { passed: boolean; details: unknown };
	currentIdentity: SourceIdentity;
	markerFiles: string[];
	sidecarFiles: string[];
	setupFailureReason?: string | null;
}): FinalGateReceipt {
	const errors: string[] = [];
	const report = input.report;
	let gate: 'passed' | 'failed' | 'blocked' = 'failed';
	const caseOutcomes: Array<{ title: string; expectedStatus?: string; testStatus?: string; resultStatus?: string; retry?: number; errors?: unknown }> = [];
	if (!report) {
		gate = 'blocked';
		errors.push('Final Playwright JSON report is missing or corrupt.');
	} else {
		const specs = flattenSpecs(report.suites ?? []);
		const actualTitles = specs.map((spec) => spec.title);
		if (actualTitles.join('\0') !== input.ticket.testTitles.join('\0')) errors.push(`Selected case order/count differs: ${JSON.stringify(actualTitles)}`);
		for (const title of input.ticket.testTitles) {
			const matches = specs.filter((spec) => spec.title === title);
			if (matches.length !== 1) { errors.push(`Expected exactly one selected spec titled ${title}; found ${matches.length}.`); continue; }
			const spec = matches[0]!;
			if (spec.tests.length !== 1) errors.push(`${title} did not run in exactly one project/test.`);
			const test = spec.tests[0];
			if (!test) continue;
			if (test.expectedStatus !== 'passed') errors.push(`${title} expectedStatus is ${test.expectedStatus}.`);
			if (test.status !== 'expected') errors.push(`${title} final test status is ${test.status}.`);
			if (test.results.length !== 1) errors.push(`${title} has ${test.results.length} results; expected one.`);
			const result = test.results[0];
			if (result) {
				if (result.status !== 'passed') errors.push(`${title} result status is ${result.status}.`);
				if (result.retry !== 0) errors.push(`${title} retry index is ${result.retry}.`);
				if (!emptyErrors(result.errors)) errors.push(`${title} result contains errors.`);
				caseOutcomes.push({ title, expectedStatus: test.expectedStatus, testStatus: test.status, resultStatus: result.status, retry: result.retry, errors: result.errors });
			}
		}
		if (!emptyErrors(report.errors)) errors.push('Playwright runner-level errors are present.');
	}
	const markers: Array<{ title: string; planId?: string; planVersion?: string; testedHead?: string; nonce: string; identitySha256: string }> = [];
	for (const file of input.markerFiles) {
		try {
			const marker = readJson<{ title: string; nonce: string; identitySha256: string }>(file);
			markers.push(marker);
			if (path.basename(file) !== `${titleSlug(marker.title)}.json`) errors.push(`Outcome marker filename does not match its selected title: ${file}`);
		}
		catch (error) { errors.push(`Outcome marker is unreadable: ${file} (${error instanceof Error ? error.message : String(error)}).`); }
	}
	const markerTitles = markers.map((marker) => marker.title).sort();
	if (markerTitles.length !== input.ticket.testTitles.length || markerTitles.join('\0') !== [...input.ticket.testTitles].sort().join('\0')) errors.push('Outcome markers do not match the exact selected tests.');
	if (markers.some((marker) => marker.planId !== input.ticket.planId || marker.planVersion !== input.ticket.planVersion || marker.testedHead !== input.ticket.testedHead || marker.nonce !== input.ticket.nonce || marker.identitySha256 !== input.ticket.identitySha256)) errors.push('An outcome marker belongs to another plan/ticket/source snapshot.');
	if (!sameIdentity(input.ticket, input.currentIdentity)) errors.push('Source or fixture identity changed after the run ticket was claimed.');
	const actualSidecars = new Set(input.sidecarFiles.map((file) => path.resolve(file)));
	for (const required of input.ticket.requiredSidecars) if (!actualSidecars.has(path.resolve(required))) errors.push(`Required per-test sidecar is missing: ${required}`);
	if (actualSidecars.size !== input.ticket.requiredSidecars.length || input.sidecarFiles.length !== input.ticket.requiredSidecars.length) errors.push('Per-test sidecar inventory differs from the exact selected cases.');
	for (let index = 0; index < input.ticket.requiredSidecars.length; index += 1) {
		const required = input.ticket.requiredSidecars[index]!;
		if (!actualSidecars.has(path.resolve(required))) continue;
		try {
			const sidecar = readJson<Record<string, unknown>>(required);
			const title = input.ticket.testTitles[index]!;
			if (sidecar.planId !== input.ticket.planId || sidecar.planVersion !== input.ticket.planVersion || sidecar.title !== title
				|| sidecar.nonce !== input.ticket.nonce || sidecar.testedHead !== input.ticket.testedHead || sidecar.identitySha256 !== input.ticket.identitySha256) {
				errors.push(`Per-test sidecar identity differs from its claimed ticket: ${required}`);
			}
			if (sidecar.observedStatus !== 'passed' || sidecar.expectedStatus !== 'passed' || typeof sidecar.stage !== 'string' || !sidecar.stage
				|| !Array.isArray(sidecar.errors) || sidecar.errors.length !== 0) errors.push(`Per-test sidecar does not report an error-free expected pass: ${required}`);
		} catch (error) {
			errors.push(`Per-test sidecar is unreadable: ${required} (${error instanceof Error ? error.message : String(error)}).`);
		}
	}
	if (input.child.exitCode !== 0 || input.child.signal) errors.push(`Playwright child did not exit cleanly: exit=${input.child.exitCode}, signal=${input.child.signal}.`);
	if (!input.cleanup.passed) errors.push('Owned browser/server process or port cleanup did not pass.');
	if (report && errors.length === 0) gate = 'passed';
	const retryEligible = gate !== 'passed' && input.markerFiles.length === 0 && !!input.setupFailureReason && input.cleanup.passed && sameIdentity(input.ticket, input.currentIdentity);
	return {
		schemaVersion: 'sibambo-proof-final-gate-v1', gate, retryEligible,
		planId, planVersion, track: input.ticket.track, cycle: input.ticket.cycle,
		attempt: input.ticket.attempt, ticketSnapshot: input.ticket,
		child: input.child, caseOutcomes, errors, setupFailureReason: input.setupFailureReason ?? null,
		markerFiles: input.markerFiles, sidecarFiles: input.sidecarFiles,
		cleanup: input.cleanup, limits: ['A passing synthetic writer case does not qualify complex imported-model round trips.', 'Responsiveness remains unproven when no frame is observed during a write interval.'],
		completedAt: new Date().toISOString()
	};
}

export type FinalGateReceipt = {
	schemaVersion: 'sibambo-proof-final-gate-v1'; gate: 'passed' | 'failed' | 'blocked'; retryEligible: boolean;
	planId: string; planVersion: string; track: ProofTrack; cycle: ColdCycle | 'stability' | null; attempt: ProofAttempt;
	ticketSnapshot: ProofTicket; child: { exitCode: number | null; signal: string | null };
	caseOutcomes: Array<Record<string, unknown>>; errors: string[]; setupFailureReason: string | null;
	markerFiles: string[]; sidecarFiles: string[]; cleanup: { passed: boolean; details: unknown };
	limits: string[]; completedAt: string;
};

export type PlaywrightReport = {
	suites?: Array<{ title?: string; specs?: PlaywrightSpec[]; suites?: PlaywrightReport['suites'] }>;
	errors?: unknown[] | null;
};
export type PlaywrightSpec = { title: string; tests: Array<{ expectedStatus?: string; status?: string; results: Array<{ status?: string; retry?: number; errors?: unknown; attachments?: Array<{ name?: string; contentType?: string; body?: string; path?: string }> }> }> };

export function parsePlaywrightReportJson(value: string): PlaywrightReport | null {
	try { return JSON.parse(value) as PlaywrightReport; }
	catch { return null; }
}

export function titleSlug(title: string) {
	return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function setupFailureReason(stdout: string, stderr: string, report: PlaywrightReport | null, markerCount: number) {
	if (markerCount !== 0) return null;
	const evidence = `${stdout}\n${stderr}\n${JSON.stringify(report ?? {})}`;
	const patterns: Array<[RegExp, string]> = [
		[/Error loading.*config|failed to load config|config.*import.*failed|cannot find module.*config/i, 'config-load-failure'],
		[/webServer.*(failed|timeout)|error while starting|failed to start.*server|EADDRINUSE|strict port/i, 'server-startup-failure'],
		[/browserType\.launch|failed to launch|executable doesn't exist|browser.*launch.*failed/i, 'browser-launch-failure'],
		[/page\.goto|navigation.*(failed|timeout)|net::ERR_[A-Z_]+|ERR_NETWORK_IO_SUSPENDED|initial navigation/i, 'initial-navigation-failure']
	];
	return patterns.find(([pattern]) => pattern.test(evidence))?.[1] ?? null;
}

export function expectedTitles(track: ProofTrack, cycle: ColdCycle | 'stability' | null) {
	return [...testTitles[track](cycle)];
}

export function collectExecutionRootFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const target = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) files.push(target);
			else if (entry.isDirectory()) walk(target);
			else if (entry.isFile()) files.push(target);
		}
	};
	walk(root);
	return files.sort();
}

export function inventoryFiles(files: string[]) {
	return files.map((file) => {
		const stat = lstatSync(file);
		const contents = stat.isSymbolicLink() ? `symlink:${readlinkSync(file)}` : readFileSync(file);
		return { path: file, sha256: sha256(contents) };
	});
}

export function sameIdentity(left: Pick<SourceIdentity, 'testedHead' | 'dirty' | 'dirtyPaths' | 'sourceInventory' | 'fixturePins' | 'identitySha256'>, right: Pick<SourceIdentity, 'testedHead' | 'dirty' | 'dirtyPaths' | 'sourceInventory' | 'fixturePins' | 'identitySha256'>) {
	return left.identitySha256 === right.identitySha256
		&& left.testedHead === right.testedHead
		&& left.dirty === right.dirty
		&& JSON.stringify(left.dirtyPaths) === JSON.stringify(right.dirtyPaths)
		&& JSON.stringify(left.sourceInventory) === JSON.stringify(right.sourceInventory)
		&& JSON.stringify(left.fixturePins) === JSON.stringify(right.fixturePins);
}

export function sameRuntime(left: ProofTicket['runtime'], right: ProofTicket['runtime']) {
	return left.node === right.node && path.resolve(left.nodePath) === path.resolve(right.nodePath) && left.bun === right.bun && left.playwright === right.playwright;
}

export function validateSealedSourceSnapshot(identity = captureSourceIdentity()) {
	if (!existsSync(commonSnapshotFile)) throw new Error(`The frozen common source snapshot is missing: ${commonSnapshotFile}`);
	const sealed = readJson<SourceIdentity>(commonSnapshotFile);
	if (!sameIdentity(sealed, identity)) throw new Error('Current source/fixture inventory differs from the sealed common readiness snapshot.');
}

function validateCommonSourceSnapshot(identity: SourceIdentity) {
	if (existsSync(commonSnapshotFile)) validateSealedSourceSnapshot(identity);
}

function validateTicketCache(ticket: ProofTicket, paths: ProofPaths) {
	if (ticket.track !== 'cold') {
		if (ticket.cacheDir !== null) throw new Error('Non-cold tickets cannot claim a Vite cache.');
		return;
	}
	if (ticket.cycle === 'warm-01') {
		if (!ticket.cacheDir || !ticket.previousReceipt || !existsSync(ticket.cacheDir)) throw new Error('Warm ticket does not reuse an existing cold cache.');
		assertStrictChild(ticket.executionRoot, ticket.cacheDir, 'Warm cache must be inside this execution root.');
		assertRealpathInside(paths.canonicalTopicRoot, ticket.cacheDir);
	} else if (ticket.cacheDir !== paths.cacheDir) {
		throw new Error('Fresh cold ticket cache path is invalid.');
	}
}

function requiredTrackRoot(track: ProofTrack, env: NodeJS.ProcessEnv) {
	const value = track === 'mirror' ? env.SIBAMBO_RECOVERY_WORKLOG
		: track === 'writer' ? env.SIBAMBO_WRITER_WORKLOG : env.SIBAMBO_STABILITY_RUN;
	if (!value || !path.isAbsolute(value)) throw new Error(`The ${track} execution root environment variable must be absolute.`);
	return path.resolve(value);
}

function requiredAttempt(track: ProofTrack, env: NodeJS.ProcessEnv): ProofAttempt {
	const value = track === 'mirror' ? env.SIBAMBO_RECOVERY_ATTEMPT : track === 'writer' ? env.SIBAMBO_WRITER_ATTEMPT : env.SIBAMBO_PROOF_ATTEMPT ?? '01';
	if (value !== '01' && value !== '02') throw new Error(`The ${track} attempt must be 01 or 02.`);
	return value;
}

function requiredCycle(track: ProofTrack, env: NodeJS.ProcessEnv): ColdCycle | 'stability' | undefined {
	if (track === 'mirror' || track === 'writer') return undefined;
	const value = env.SIBAMBO_STABILITY_CYCLE ?? (track === 'semantic' ? 'stability' : undefined);
	if (track === 'semantic') {
		if (value !== 'stability') throw new Error('Semantic track requires the stability cycle marker.');
		return 'stability';
	}
	if (value !== 'cold-01' && value !== 'cold-02' && value !== 'cold-03' && value !== 'warm-01') throw new Error('Cold track requires a named cycle.');
	return value;
}

function inferTrack(env: NodeJS.ProcessEnv): ProofTrack {
	if (env.SIBAMBO_RECOVERY_WORKLOG) return 'mirror';
	if (env.SIBAMBO_WRITER_WORKLOG) return 'writer';
	if (env.SIBAMBO_STABILITY_CYCLE === 'stability') return 'semantic';
	if (env.SIBAMBO_STABILITY_RUN) return 'cold';
	throw new Error('Cannot infer proof track from the discovery environment.');
}

function assertTrack(value: string): asserts value is ProofTrack {
	if (value !== 'mirror' && value !== 'cold' && value !== 'semantic' && value !== 'writer') throw new Error(`Unknown proof track: ${value}`);
}

function fixtureIdentities(manifestPath: string) {
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { schemaVersion?: string; fixtures?: Array<{ id: string; locator: string; bytes: number; sha256: string }> };
	if (manifest.schemaVersion !== 'bomc-loader-fixture-manifest-v1' || !manifest.fixtures) throw new Error('BOMC fixture manifest schema is not the pinned version.');
	return ['S1-new', 'S2-new', 'S2-jcm'].map((id) => {
		const row = manifest.fixtures!.find((fixture) => fixture.id === id);
		if (!row) throw new Error(`Required browser fixture is not in the manifest: ${id}`);
		const absolute = path.resolve(workspaceRoot, row.locator);
		const relative = path.relative(workspaceRoot, absolute);
		if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Fixture path escapes the workspace: ${id}`);
		const bytes = readFileSync(absolute);
		const actualSha = sha256(bytes);
		if (bytes.byteLength !== row.bytes || actualSha !== row.sha256) throw new Error(`Pinned fixture identity mismatch: ${id}`);
		return { id, path: path.relative(editorRoot, absolute).replaceAll(path.sep, '/'), bytes: bytes.byteLength, sha256: actualSha };
	});
}

function walkSourceFiles(directory: string): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const target = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) results.push(...walkSourceFiles(target));
		else if (entry.isFile() && /\.(?:ts|tsx|js|mjs|cjs|svelte|html|css|json|md|d\.ts|rb)$/i.test(entry.name)) results.push(target);
	}
	return results;
}

function mkdirWithin(root: string, target: string) {
	assertPotentialPathInside(root, target);
	mkdirSync(target, { recursive: true });
	assertRealpathInside(root, target);
}

function assertPotentialPathInside(root: string, target: string) {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Path must be a strict child of ${root}.`);
	let ancestor = path.resolve(target);
	while (!existsSync(ancestor)) {
		const parent = path.dirname(ancestor);
		if (parent === ancestor) throw new Error(`No existing ancestor for ${target}.`);
		ancestor = parent;
	}
	assertRealpathInside(root, ancestor);
}

function assertStrictChild(root: string, target: string, message: string) {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(message);
}

function assertRealpathInside(root: string, target: string) {
	const rootReal = realpathSync(root);
	const targetReal = realpathSync(target);
	const relative = path.relative(rootReal, targetReal);
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Resolved path escapes its canonical worklog root: ${target}`);
}

function flattenSpecs(suites: NonNullable<PlaywrightReport['suites']>): PlaywrightSpec[] {
	const rows: PlaywrightSpec[] = [];
	for (const suite of suites) {
		if (suite.specs) rows.push(...suite.specs);
		if (suite.suites) rows.push(...flattenSpecs(suite.suites));
	}
	return rows;
}

function emptyErrors(value: unknown) {
	return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function readJson<T>(filePath: string): T {
	return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function sha256(value: Uint8Array | string) {
	return createHash('sha256').update(value).digest('hex');
}
