import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// This workspace-level verifier lives outside apps/editor, where the Bun
// workspace link is installed. Resolve the same package source modules
// directly so the independent reader remains executable from this harness.
import { readWebBomc } from '../../packages/bomc-document/src/reader.js';
import type { BomcGraph } from '../../packages/bomc-document/src/types.js';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspaceRoot = path.resolve(editorRoot, '..');
const closureRunRoot = path.join(
	workspaceRoot,
	'docs',
	'worklogs',
	'BOMC-EDITOR-NEXT-001',
	'2026-10-07-implementation-run-001'
);
const readerClosureRoot = path.join(closureRunRoot, 'reader-closures');
const rubyClosureRoot = path.join(closureRunRoot, 'ruby-oracle-closure');
const closureManifestPath = path.join(closureRunRoot, 'E0-source-closures.json');
const rubyExecutable = 'C:/Ruby25-x64/bin/ruby.exe';
const expectedReaders = [
	{ id: 'editor', commit: '3a9d660f172adf6ff80b539a5fb1efe817c5a3a6' },
	{ id: 'rooms', commit: '5bcb3a70a9432226dad1f638b5c72f31ba5b46da' },
	{ id: 'benchmark', commit: '18056f98a9838355105d67783a622418b79acb8e' }
] as const;
const THREE_IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

type GateStatus = 'passed' | 'failed' | 'blocked';
type Mismatch = { path: string; expected: unknown; actual: unknown };
type ReaderPin = typeof expectedReaders[number];
type ReaderClosureManifest = {
	id: string;
	commit: string;
	files: Array<{ path: string; bytes: number; sha256: string }>;
	externalDependencyClosure: Array<{ name: string; resolved: string }>;
};
type RubyOracleManifest = {
	oracleScript: { path: string; bytes: number; sha256: string };
	files: Array<{ path: string; bytes: number; sha256: string }>;
};

export type VerifyDownloadedAuthoringBomcInput = {
	/** Path returned by the browser download event; this helper never writes a replacement input. */
	downloadPath: string;
	expectedGraph: BomcGraph;
	variant: string;
	/** Existing, unique proof attempt directory under docs/worklogs/EDITOR-ACCELERATED-001/. */
	executionRoot: string;
	/** Browser-observed pre/post ACK state and reopen observations for this actual download. */
	authoringState?: unknown;
};

export type AuthoringInteropReport = {
	schemaVersion: 'sibambo-editor-authoring-interop-v1';
	variant: string;
	status: GateStatus;
	input: { sourcePath: string; retainedPath: string; bytes: number; sha256: string };
	authoringStateEvidencePath: string | null;
	canonical: { status: GateStatus; revision: number | null; mismatches: Mismatch[]; evidencePath: string | null };
	readerClosures: Array<{
		id: ReaderPin['id'];
		commit: string;
		status: GateStatus;
		closureCompleteness: 'complete' | 'mismatch' | 'unavailable';
		dependencyPins: Array<{ name: string; expected: string; actual: string | null; status: GateStatus }>;
		exitCode: number | null;
		stdoutPath: string | null;
		stderrPath: string | null;
		projectionPath: string | null;
		mismatches: Mismatch[];
		error?: string;
	}>;
	rubyOracle: {
		commit: string | null;
		status: GateStatus;
		closureCompleteness: 'complete' | 'mismatch' | 'unavailable';
		executable: string;
		executionRoot: string | null;
		inputPath: string | null;
		exitCode: number | null;
		stdoutPath: string | null;
		stderrPath: string | null;
		mismatches: Mismatch[];
		error?: string;
	};
	closureManifestPath: string;
	closureManifestSha256: string | null;
	createdAt: string;
	limits: string[];
};

/**
 * Independently checks an actual browser download against the canonical reader,
 * three immutable app-reader closures, and the pinned Ruby decoder.  Every
 * attempt owns a fresh evidence directory and keeps the input and raw outputs.
 */
export async function verifyDownloadedAuthoringBomc(input: VerifyDownloadedAuthoringBomcInput): Promise<AuthoringInteropReport> {
	validateVariant(input.variant);
	const executionRoot = resolveOwnedExecutionRoot(input.executionRoot);
	const attemptRoot = createAttemptRoot(executionRoot, input.variant);
	const reportPath = path.join(attemptRoot, 'interop-report.json');
	const inputInfo = readActualDownload(input.downloadPath);
	const retainedInputPath = path.join(attemptRoot, 'browser-download.bomc');
	writeFileSync(retainedInputPath, inputInfo.bytes, { flag: 'wx' });
	const retainedInput = {
		sourcePath: inputInfo.sourcePath,
		retainedPath: retainedInputPath,
		bytes: inputInfo.bytes.byteLength,
		sha256: sha256(inputInfo.bytes)
	};
	const closureManifest = loadClosureManifest(attemptRoot);
	const expectedGraphEvidencePath = path.join(attemptRoot, 'expected-graph.f64.json');
	writeJsonExclusive(expectedGraphEvidencePath, exactEvidence(input.expectedGraph));

	const report: AuthoringInteropReport = {
		schemaVersion: 'sibambo-editor-authoring-interop-v1',
		variant: input.variant,
		status: 'blocked',
		input: retainedInput,
		authoringStateEvidencePath: null,
		canonical: { status: 'blocked', revision: null, mismatches: [], evidencePath: null },
		readerClosures: [],
		rubyOracle: {
			commit: null,
			status: 'blocked',
			closureCompleteness: 'unavailable',
			executable: rubyExecutable,
			executionRoot: null,
			inputPath: null,
			exitCode: null,
			stdoutPath: null,
			stderrPath: null,
			mismatches: []
		},
		closureManifestPath: closureManifestPath,
		closureManifestSha256: closureManifest?.sha256 ?? null,
		createdAt: new Date().toISOString(),
		limits: [
			'Legacy readers are compared through their public import projection; exact Float64 graph, BWEB IDs, rings and triangles are compared by the independent Ruby decoder.',
			'No native SketchUp model creation, install, visual fidelity or certification is performed.'
		]
	};

	try {
		const canonicalDocument = await readWebBomc(new Uint8Array(inputInfo.bytes));
		try {
			const snapshot = canonicalDocument.snapshot();
			const actualGraph = snapshot.graph;
			const mismatches = compareExact(input.expectedGraph, actualGraph);
			const evidencePath = path.join(attemptRoot, 'canonical-read.f64.json');
			report.canonical = {
				status: mismatches.length === 0 ? 'passed' : 'failed',
				revision: snapshot.revision,
				mismatches,
				evidencePath
			};
			writeJsonExclusive(evidencePath, exactEvidence({ revision: snapshot.revision, graph: actualGraph }));
		} finally {
			canonicalDocument.dispose();
		}
	} catch (error) {
		report.canonical = {
			status: 'failed', revision: null,
			mismatches: [{ path: '$', expected: 'a readable web-core-v1 authoring BOMC', actual: errorMessage(error) }],
			evidencePath: null
		};
	}

	for (const pin of expectedReaders) {
	report.readerClosures.push(await runPinnedReader(pin, input.expectedGraph, retainedInputPath, attemptRoot, closureManifest));
	}
	report.rubyOracle = await runPinnedRubyOracle(input.expectedGraph, retainedInputPath, retainedInput.sha256, attemptRoot, closureManifest);
	if (input.authoringState !== undefined) {
		report.authoringStateEvidencePath = path.join(attemptRoot, 'browser-authoring-state.f64.json');
		writeJsonExclusive(report.authoringStateEvidencePath, exactEvidence(input.authoringState));
	}

	const gateStatuses = [report.canonical.status, ...report.readerClosures.map((reader) => reader.status), report.rubyOracle.status];
	report.status = gateStatuses.includes('failed') ? 'failed' : gateStatuses.includes('blocked') ? 'blocked' : 'passed';
	writeJsonExclusive(reportPath, report);
	return report;
}

function validateVariant(variant: string) {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(variant)) throw new Error('variant must be a short filesystem-safe identifier.');
}

function resolveOwnedExecutionRoot(value: string) {
	const allowedRoot = path.resolve(workspaceRoot, 'docs', 'worklogs', 'EDITOR-ACCELERATED-001');
	const resolved = path.resolve(value);
	if (!isWithin(allowedRoot, resolved) || resolved === allowedRoot) {
		throw new Error(`executionRoot must be an existing unique child of ${allowedRoot}.`);
	}
	if (!existsSync(resolved) || lstatSync(resolved).isSymbolicLink()) throw new Error(`executionRoot must exist and cannot be a symbolic link: ${resolved}`);
	const real = realpathSync(resolved);
	if (path.resolve(real) !== resolved) throw new Error(`executionRoot resolves through a link: ${resolved}`);
	return resolved;
}

function createAttemptRoot(executionRoot: string, variant: string) {
	const parent = path.join(executionRoot, 'authoring-interop');
	if (!existsSync(parent)) mkdirSync(parent);
	if (lstatSync(parent).isSymbolicLink() || path.resolve(realpathSync(parent)) !== parent) throw new Error(`Interop output directory resolves through a link: ${parent}`);
	const attempt = path.join(parent, `${variant}-${randomUUID()}`);
	mkdirSync(attempt);
	return attempt;
}

function readActualDownload(downloadPath: string) {
	const resolved = path.resolve(downloadPath);
	if (!existsSync(resolved) || lstatSync(resolved).isSymbolicLink() || !lstatSync(resolved).isFile()) {
		throw new Error(`Browser download path must name an existing regular file: ${resolved}`);
	}
	const sourcePath = realpathSync(resolved);
	return { sourcePath, bytes: readFileSync(sourcePath) };
}

function loadClosureManifest(attemptRoot: string): { value: any; sha256: string } | null {
	if (!existsSync(closureManifestPath) || lstatSync(closureManifestPath).isSymbolicLink()) return null;
	const bytes = readFileSync(closureManifestPath);
	let value: any;
	try { value = JSON.parse(bytes.toString('utf8')); }
	catch { return null; }
	if (value.schemaVersion !== 'sibambo-editor-next-source-closures-v1' || value.planId !== 'BOMC-EDITOR-NEXT-001' || value.planVersion !== '1.1') return null;
	const copiedManifest = path.join(attemptRoot, 'E0-source-closures.json');
	writeFileSync(copiedManifest, bytes, { flag: 'wx' });
	return { value, sha256: sha256(bytes) };
}

async function runPinnedReader(
	pin: ReaderPin,
	expectedGraph: BomcGraph,
	inputPath: string,
	attemptRoot: string,
	closureManifest: { value: any; sha256: string } | null
): Promise<AuthoringInteropReport['readerClosures'][number]> {
	const manifest = closureManifest?.value.readerClosures?.find((row: ReaderClosureManifest) => row.id === pin.id) as ReaderClosureManifest | undefined;
	const base = {
		id: pin.id,
		commit: pin.commit,
		status: 'blocked' as GateStatus,
		closureCompleteness: 'unavailable' as 'complete' | 'mismatch' | 'unavailable',
		dependencyPins: [] as AuthoringInteropReport['readerClosures'][number]['dependencyPins'],
		exitCode: null as number | null,
		stdoutPath: null as string | null,
		stderrPath: null as string | null,
		projectionPath: null as string | null,
		mismatches: [] as Mismatch[],
		error: undefined as string | undefined
	};
	if (!manifest || manifest.commit !== pin.commit || !Array.isArray(manifest.files) || !Array.isArray(manifest.externalDependencyClosure)) {
		base.error = `Pinned ${pin.id} closure manifest is missing or disagrees with commit ${pin.commit}.`;
		return base;
	}
	const sourceRoot = path.join(readerClosureRoot, pin.id);
	let validation: ReturnType<typeof validateAndCopyClosure>;
	try { validation = validateAndCopyClosure(sourceRoot, manifest.files, path.join(attemptRoot, 'reader-closures', pin.id)); }
	catch (error) {
		base.closureCompleteness = 'mismatch';
		base.error = `Pinned ${pin.id} closure inventory could not be read: ${errorMessage(error)}`;
		return base;
	}
	base.closureCompleteness = validation.status;
	if (validation.status !== 'complete') {
		base.error = validation.error;
		return base;
	}
	const runRoot = path.join(attemptRoot, 'reader-runs', pin.id);
	mkdirSync(runRoot, { recursive: true });
	const dependencyStatus = linkReaderDependencies(runRoot, path.join(attemptRoot, 'reader-closures', pin.id), manifest.externalDependencyClosure);
	base.dependencyPins = dependencyStatus.rows;
	if (dependencyStatus.status !== 'passed') {
		base.error = dependencyStatus.error;
		return base;
	}
	const probePath = path.join(runRoot, 'reader-runner.ts');
	writeFileSync(probePath, readerProbeSource, { flag: 'wx' });
	const outputPath = path.join(runRoot, 'reader-projection.json');
	const result = spawnSync('bun', ['run', probePath], {
		cwd: runRoot,
		encoding: 'utf8',
		timeout: 120_000,
		maxBuffer: 32 * 1024 * 1024,
		env: { ...process.env, BOMC_INTEROP_INPUT: inputPath, BOMC_INTEROP_OUTPUT: outputPath, BOMC_INTEROP_READER: pin.id }
	});
	base.exitCode = result.status;
	base.stdoutPath = path.join(runRoot, 'stdout.txt');
	base.stderrPath = path.join(runRoot, 'stderr.txt');
	writeFileSync(base.stdoutPath, result.stdout ?? '', { flag: 'wx' });
	writeFileSync(base.stderrPath, result.stderr ?? '', { flag: 'wx' });
	if (result.error || result.status !== 0 || !existsSync(outputPath)) {
		base.status = result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'blocked' : 'failed';
		base.error = result.error ? errorMessage(result.error) : `Pinned reader exited ${result.status} without a projection file.`;
		return base;
	}
	base.projectionPath = outputPath;
	try {
		const projection = JSON.parse(readFileSync(outputPath, 'utf8'));
		base.mismatches = compareReaderProjection(expectedGraph, projection);
		base.status = base.mismatches.length === 0 ? 'passed' : 'failed';
	} catch (error) {
		base.status = 'failed';
		base.error = `Could not validate reader projection: ${errorMessage(error)}`;
	}
	return base;
}

async function runPinnedRubyOracle(
	expectedGraph: BomcGraph,
	inputPath: string,
	inputSha256: string,
	attemptRoot: string,
	closureManifest: { value: any; sha256: string } | null
): Promise<AuthoringInteropReport['rubyOracle']> {
	const manifest = closureManifest?.value.rubyOracleClosure as RubyOracleManifest | undefined;
	const base: AuthoringInteropReport['rubyOracle'] = {
		commit: closureManifest?.value.rubyOracleClosure?.oracleEditorCommit ?? null,
		status: 'blocked',
		closureCompleteness: 'unavailable',
		executable: rubyExecutable,
		executionRoot: null,
		inputPath: null,
		exitCode: null,
		stdoutPath: null,
		stderrPath: null,
		mismatches: []
	};
	if (!manifest || !manifest.oracleScript || !Array.isArray(manifest.files)) {
		base.error = 'Pinned Ruby oracle closure manifest is missing.';
		return base;
	}
	const files = [...manifest.files, manifest.oracleScript];
	const sourceRoot = rubyClosureRoot;
	const shortEvidenceParent = path.join(workspaceRoot, 'docs', 'worklogs', '.authoring-interop');
	mkdirSync(shortEvidenceParent, { recursive: true });
	if (lstatSync(shortEvidenceParent).isSymbolicLink() || path.resolve(realpathSync(shortEvidenceParent)) !== shortEvidenceParent) {
		base.closureCompleteness = 'mismatch';
		base.error = `Short-path Ruby evidence directory resolves through a link: ${shortEvidenceParent}`;
		return base;
	}
	const shortRunRoot = path.join(shortEvidenceParent, randomUUID());
	mkdirSync(shortRunRoot);
	const copiedRoot = path.join(shortRunRoot, 'closure');
	let validation: ReturnType<typeof validateAndCopyClosure>;
	try { validation = validateAndCopyClosure(sourceRoot, files, copiedRoot, {
		allowUnlisted: false, sourcePrefixes: ['bom_engine_plugin', 'editor'], preserveSourcePrefix: true
	}); }
	catch (error) {
		base.closureCompleteness = 'mismatch';
		base.error = `Pinned Ruby closure inventory could not be read: ${errorMessage(error)}`;
		return base;
	}
	base.closureCompleteness = validation.status;
	if (validation.status !== 'complete') {
		base.error = validation.error;
		return base;
	}
	if (!existsSync(rubyExecutable) || lstatSync(rubyExecutable).isSymbolicLink()) {
		base.error = `Pinned Ruby executable is unavailable: ${rubyExecutable}`;
		return base;
	}
	const shortInputPath = path.join(shortRunRoot, 'input.bomc');
	copyFileSync(inputPath, shortInputPath);
	if (sha256(readFileSync(shortInputPath)) !== inputSha256) {
		base.closureCompleteness = 'mismatch';
		base.error = 'Short-path Ruby input copy does not match the actual browser download SHA-256.';
		return base;
	}
	const oraclePath = path.join(copiedRoot, 'editor', ...manifest.oracleScript.path.split('/'));
	base.executionRoot = shortRunRoot;
	base.inputPath = shortInputPath;
	base.stdoutPath = path.join(attemptRoot, 'ruby-oracle.stdout.json');
	base.stderrPath = path.join(attemptRoot, 'ruby-oracle.stderr.txt');
	const result = spawnSync(rubyExecutable, [oraclePath, shortInputPath], {
		cwd: copiedRoot,
		encoding: 'utf8',
		timeout: 120_000,
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true
	});
	base.exitCode = result.status;
	writeFileSync(base.stdoutPath, result.stdout ?? '', { flag: 'wx' });
	writeFileSync(base.stderrPath, result.stderr ?? '', { flag: 'wx' });
	if (result.error || result.status !== 0) {
		base.status = result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'blocked' : 'failed';
		base.error = result.error ? errorMessage(result.error) : `Pinned Ruby oracle exited ${result.status}.`;
		return base;
	}
	try {
		const output = JSON.parse(result.stdout ?? '');
		base.mismatches = compareRubyGraph(expectedGraph, output, inputSha256);
		base.status = base.mismatches.length === 0 ? 'passed' : 'failed';
	} catch (error) {
		base.status = 'failed';
		base.error = `Could not validate Ruby oracle output: ${errorMessage(error)}`;
	}
	return base;
}

function validateAndCopyClosure(
	sourceRoot: string,
	files: Array<{ path: string; bytes: number; sha256: string }>,
	destinationRoot: string,
	options: { allowUnlisted?: boolean; sourcePrefixes?: readonly string[]; preserveSourcePrefix?: boolean } = {}
) {
	if (!existsSync(sourceRoot) || lstatSync(sourceRoot).isSymbolicLink()) return { status: 'unavailable' as const, error: `Pinned closure source is missing or linked: ${sourceRoot}` };
	const expected = new Map<string, { bytes: number; sha256: string }>();
	for (const row of files) {
		if (!safeManifestPath(row.path) || expected.has(row.path)) return { status: 'mismatch' as const, error: `Pinned closure manifest contains an unsafe or duplicate path: ${row.path}` };
		expected.set(row.path, row);
	}
	const actualPaths = enumerateFiles(sourceRoot);
	const actualSet = new Set(actualPaths);
	const sourcePaths = new Map<string, string>();
	for (const relative of expected.keys()) {
		const candidates = [relative, ...(options.sourcePrefixes ?? []).map((prefix) => `${prefix}/${relative}`)];
		const matches = candidates.filter((candidate) => actualSet.has(candidate));
		if (matches.length !== 1) {
			return { status: 'mismatch' as const, error: matches.length === 0
				? `Pinned closure file is missing or linked: ${relative}`
				: `Pinned closure file has ambiguous source roots: ${relative}` };
		}
		sourcePaths.set(relative, matches[0]!);
	}
	const expectedSourcePaths = new Set(sourcePaths.values());
	if (!options.allowUnlisted && (actualPaths.length !== expectedSourcePaths.size || actualPaths.some((entry) => !expectedSourcePaths.has(entry)))) {
		return { status: 'mismatch' as const, error: `Pinned closure inventory differs (expected ${expected.size}, found ${actualPaths.length}).` };
	}
	for (const [relative, pin] of expected) {
		const sourceRelative = sourcePaths.get(relative)!;
		const sourcePath = path.join(sourceRoot, ...sourceRelative.split('/'));
		if (!existsSync(sourcePath) || lstatSync(sourcePath).isSymbolicLink()) {
			return { status: 'mismatch' as const, error: `Pinned closure file is missing or linked: ${relative}` };
		}
		const bytes = readFileSync(sourcePath);
		if (bytes.byteLength !== pin.bytes || sha256(bytes) !== pin.sha256) {
			return { status: 'mismatch' as const, error: `Pinned closure file disagrees with its preserved byte/hash row: ${relative}` };
		}
	}
	mkdirSync(destinationRoot, { recursive: true });
	for (const relative of expected.keys()) {
		const sourceRelative = sourcePaths.get(relative)!;
		const sourcePath = path.join(sourceRoot, ...sourceRelative.split('/'));
		const destinationRelative = options.preserveSourcePrefix ? sourceRelative : relative;
		const destinationPath = path.join(destinationRoot, ...destinationRelative.split('/'));
		mkdirSync(path.dirname(destinationPath), { recursive: true });
		copyFileSync(sourcePath, destinationPath);
	}
	return { status: 'complete' as const, error: undefined };
}

function enumerateFiles(root: string): string[] {
	const files: string[] = [];
	const visit = (directory: string, relative: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
			const childPath = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Pinned closure contains a symbolic link: ${childRelative}`);
			if (entry.isDirectory()) visit(childPath, childRelative);
			else if (entry.isFile()) files.push(childRelative);
			else throw new Error(`Pinned closure contains a non-file entry: ${childRelative}`);
		}
	};
	visit(root, '');
	return files.sort();
}

function linkReaderDependencies(
	runRoot: string,
	readerSourceRoot: string,
	pins: Array<{ name: string; resolved: string }>
) {
	const nodeModules = path.join(runRoot, 'node_modules');
	mkdirSync(path.join(nodeModules, '@sibambo'), { recursive: true });
	const packageFolders = ['contracts', 'e4-import', 'scene-runtime', 'viewport', 'provenance'];
	for (const folder of packageFolders) {
		symlinkSync(path.join(readerSourceRoot, 'packages', folder), path.join(nodeModules, '@sibambo', folder), 'junction');
	}
	const rows: AuthoringInteropReport['readerClosures'][number]['dependencyPins'] = [];
	for (const pin of pins) {
		const installedPaths = resolvePinnedPackagePaths(pin.name);
		let actual: string | null = null;
		let status: GateStatus = 'blocked';
		const candidates = installedPaths.map((installedPath) => {
			try {
				const realPath = realpathSync(installedPath);
				const packageJson = JSON.parse(readFileSync(path.join(realPath, 'package.json'), 'utf8'));
				if (packageJson.name !== pin.name || typeof packageJson.version !== 'string') return null;
				return { realPath, actual: `${packageJson.name}@${packageJson.version}` };
			} catch { return null; }
		}).filter((candidate): candidate is { realPath: string; actual: string } => candidate !== null);
		const selected = candidates.find((candidate) => candidate.actual === pin.resolved) ?? candidates[0];
		actual = selected?.actual ?? null;
		status = actual === pin.resolved ? 'passed' : 'blocked';
		if (status === 'passed' && selected) {
			const destination = path.join(nodeModules, ...pin.name.split('/'));
			mkdirSync(path.dirname(destination), { recursive: true });
			symlinkSync(selected.realPath, destination, 'junction');
		}
		rows.push({ name: pin.name, expected: pin.resolved, actual, status });
	}
	// The imported reader packages resolve from their copied source paths. Link the
	// run's exact, verified dependency tree at that source root as well as beside
	// the generated runner so both resolution origins see the same pinned modules.
	symlinkSync(nodeModules, path.join(readerSourceRoot, 'node_modules'), 'junction');
	const failed = rows.some((row) => row.status === 'failed');
	const blocked = rows.some((row) => row.status === 'blocked');
	return {
		rows,
		status: failed ? 'failed' as const : blocked ? 'blocked' as const : 'passed' as const,
		error: blocked ? 'One or more frozen external dependency versions are unavailable or differ from the manifest.' : undefined
	};
}

function resolvePinnedPackagePaths(packageName: string) {
	const packageParts = packageName.split('/');
	const packageRoots = [
		path.join(editorRoot, 'node_modules'),
		path.join(editorRoot, 'packages', 'e4-import', 'node_modules')
	];
	const paths = packageRoots.map((root) => path.join(root, ...packageParts));
	const bunStore = path.join(editorRoot, 'node_modules', '.bun');
	if (existsSync(bunStore) && !lstatSync(bunStore).isSymbolicLink()) {
		for (const entry of readdirSync(bunStore, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			paths.push(path.join(bunStore, entry.name, 'node_modules', ...packageParts));
		}
	}
	return [...new Set(paths)].filter((candidate) => existsSync(candidate));
}

function compareReaderProjection(graph: BomcGraph, projection: any): Mismatch[] {
	const mismatches: Mismatch[] = [];
	const expectedCounts = {
		materials: graph.materials.length,
		tags: 0,
		meshes: graph.meshes.length,
		faces: graph.meshes.reduce((sum, mesh) => sum + mesh.faces.length, 0),
		definitions: graph.definitions.length,
		instances: graph.instances.length
	};
	for (const [key, value] of Object.entries(expectedCounts)) addProjectionMismatch(mismatches, `counts.${key}`, value, projection.counts?.[key]);
	const expectedRows = expectedReaderFaces(graph);
	const actualRows = new Map<number, any>();
	for (const row of projection.faces ?? []) {
		if (!Number.isSafeInteger(row.sourceFaceIndex) || actualRows.has(row.sourceFaceIndex)) {
			mismatches.push({ path: `faces.sourceFaceIndex[${String(row.sourceFaceIndex)}]`, expected: 'one unique source face index', actual: row.sourceFaceIndex });
			continue;
		}
		actualRows.set(row.sourceFaceIndex, row);
	}
	for (const [index, expected] of expectedRows) {
		const actual = actualRows.get(index);
		if (!actual) {
			mismatches.push({ path: `faces[${index}]`, expected: expected.label, actual: null });
			continue;
		}
		addProjectionMismatch(mismatches, `faces[${index}].semanticLabel`, expected.label, actual.semanticLabel);
		addProjectionMismatch(mismatches, `faces[${index}].name`, expected.label, actual.name);
		addProjectionMismatch(mismatches, `faces[${index}].vertices`, expected.vertices, actual.vertices);
		addProjectionMismatch(mismatches, `faces[${index}].holes`, expected.holes, actual.holes);
		addProjectionMismatch(mismatches, `faces[${index}].normal`, expected.normal, actual.normal);
	}
	for (const [index, actual] of actualRows) {
		if (!expectedRows.has(index)) mismatches.push({ path: `faces[${index}]`, expected: null, actual: actual.semanticLabel });
	}
	const graphMaterial = graph.materials[0];
	if (graphMaterial) {
		const runtimeMaterial = (projection.materials ?? []).find((row: any) => row.index === 0);
		if (!runtimeMaterial) mismatches.push({ path: 'materials[0]', expected: graphMaterial.id, actual: null });
		else {
			addProjectionMismatch(mismatches, 'materials[0].name', graphMaterial.displayName ?? graphMaterial.name, runtimeMaterial.name);
			addProjectionMismatch(mismatches, 'materials[0].baseColorRgba', graphMaterial.rgba.map((value) => value / 255), runtimeMaterial.baseColorRgba);
			addProjectionMismatch(mismatches, 'materials[0].opacity', graphMaterial.opacityU16 / 65535, runtimeMaterial.opacity);
		}
	}
	const expectedTriangleSets = expectedReaderTriangles(graph);
	const actualTriangleSets = new Map<number, Set<string>>();
	for (const triangle of projection.triangles ?? []) {
		const set = actualTriangleSets.get(triangle.sourceFaceIndex) ?? new Set<string>();
		set.add(triangle.key);
		actualTriangleSets.set(triangle.sourceFaceIndex, set);
	}
	for (const [index, expected] of expectedTriangleSets) {
		const actual = actualTriangleSets.get(index);
		addProjectionMismatch(mismatches, `triangles[${index}]`, [...expected].sort(), actual ? [...actual].sort() : null);
	}
	for (const index of actualTriangleSets.keys()) {
		if (!expectedTriangleSets.has(index)) mismatches.push({ path: `triangles[${index}]`, expected: null, actual: [...actualTriangleSets.get(index)!] });
	}
	const root = graph.instances.find((instance) => instance.id === graph.rootInstanceId);
	if (!root || !sameNumberArray(root.matrix, THREE_IDENTITY)) {
		mismatches.push({ path: 'rootTransform.expected', expected: THREE_IDENTITY, actual: root?.matrix ?? null });
	}
	for (const [groupIndex, group] of (projection.groups ?? []).entries()) {
		for (let occurrence = 0; occurrence + 16 <= group.matrices.length; occurrence += 16) {
			const matrix = group.matrices.slice(occurrence, occurrence + 16);
			if (!sameNumberArray(matrix, THREE_IDENTITY)) mismatches.push({ path: `groups[${groupIndex}].matrices[${occurrence / 16}]`, expected: THREE_IDENTITY, actual: matrix });
		}
	}
	return mismatches;
}

function expectedReaderFaces(graph: BomcGraph) {
	const output = new Map<number, { label: string | null; vertices: number[][]; holes: number[][][]; normal: number[] }>();
	let globalIndex = 0;
	for (const mesh of graph.meshes) {
		for (const face of mesh.faces) {
			const role = face.roleCode;
			const effectiveSurface = face.surfaceCode || semanticRoleSurface(role);
			const points = face.outer.map((vertex) => projectPoint(mesh.positions, vertex));
			const holes = face.holes.map((ring) => ring.map((vertex) => projectPoint(mesh.positions, vertex)));
			const area = polygonArea(points) - holes.reduce((sum, ring) => sum + polygonArea(ring), 0);
			if (!face.hidden && ![14, 15, 16, 17, 18].includes(role) && isAnalyticalSurface(effectiveSurface) && points.length >= 3 && area >= 0.35) {
				output.set(globalIndex, {
					label: face.label,
					vertices: points,
					holes,
					normal: [face.normal[0], face.normal[2], -face.normal[1]].map(Math.fround)
				});
			}
			globalIndex += 1;
		}
	}
	return output;
}

function expectedReaderTriangles(graph: BomcGraph) {
	const output = new Map<number, Set<string>>();
	let globalIndex = 0;
	for (const mesh of graph.meshes) {
		for (const face of mesh.faces) {
			const triangles = new Set<string>();
			for (let offset = 0; offset + 2 < face.triangles.length; offset += 3) {
				const values: number[] = [];
				for (const vertex of face.triangles.slice(offset, offset + 3)) values.push(...projectPoint(mesh.positions, vertex));
				triangles.add(triangleKey(values));
			}
			output.set(globalIndex, triangles);
			globalIndex += 1;
		}
	}
	return output;
}

function compareRubyGraph(graph: BomcGraph, output: any, expectedSha256: string): Mismatch[] {
	const mismatches: Mismatch[] = [];
	addMismatch(mismatches, 'source_sha256', expectedSha256, output.source_sha256);
	addMismatch(mismatches, 'authoring.schema', 1, output.authoring?.schema);
	addMismatch(mismatches, 'authoring.document_id', graph.documentId, output.authoring?.document_id);
	const expectedCounts = {
		materials: graph.materials.length,
		meshes: graph.meshes.length,
		faces: graph.meshes.reduce((sum, mesh) => sum + mesh.faces.length, 0),
		definitions: graph.definitions.length,
		instances: graph.instances.length,
		transforms: new Set(graph.instances.map((instance) => numberArrayKey(instance.matrix))).size,
		edges: visualEdgeCount(graph)
	};
	for (const [key, value] of Object.entries(expectedCounts)) addMismatch(mismatches, `counts.${key}`, value, output.counts?.[key]);
	const expectedMaterial = graph.materials.map((row) => ({
		id: row.id, name: row.name, displayName: row.displayName, rgba: [...row.rgba], opacityU16: row.opacityU16
	}));
	const actualMaterial = (output.materials ?? []).map((row: any) => ({
		id: row.id, name: row.name, displayName: row.display_name, rgba: row.rgba, opacityU16: row.opacity_u16
	}));
	addMismatch(mismatches, 'materials', expectedMaterial, actualMaterial);
	const expectedDefinitions = graph.definitions.map((row) => ({ id: row.id, name: row.name, kind: row.kind, meshId: row.meshId }));
	const actualDefinitions = (output.definitions ?? []).map((row: any) => ({ id: row.id, name: row.name, kind: row.kind, meshId: row.mesh_id }));
	addMismatch(mismatches, 'definitions', expectedDefinitions, actualDefinitions);
	const expectedMeshes = graph.meshes.map((mesh) => ({
		id: mesh.id,
		definition: mesh.definitionId,
		positions_f64le: mesh.positions.map(numberF64LE),
		faces: mesh.faces.map((face) => ({
			id: face.id,
			outer: [...face.outer],
			holes: face.holes.map((ring) => [...ring]),
			triangles: [...face.triangles],
			normal: face.normal.map(numberF64LE),
			surface: face.surfaceCode,
			hidden: face.hidden,
			role: face.roleCode,
			front_material: face.frontMaterialId,
			back_material: face.backMaterialId,
			label: face.label
		}))
	}));
	const actualMeshes = (output.meshes ?? []).map((mesh: any) => ({
		id: mesh.id,
		definition: mesh.definition,
		positions_f64le: mesh.positions_f64le,
		faces: (mesh.faces ?? []).map((face: any) => ({
			id: face.id, outer: face.outer, holes: face.holes, triangles: face.triangles, normal: face.normal,
			surface: face.surface, hidden: face.hidden, role: face.role,
			front_material: face.front_material, back_material: face.back_material, label: face.label
		}))
	}));
	addMismatch(mismatches, 'meshes', expectedMeshes, actualMeshes);
	const expectedInstances = graph.instances.map((row) => ({
		id: row.id, name: row.name, kind: row.kind, owner: row.ownerDefinitionId, definition: row.definitionId,
		material: row.materialId, visible: row.visible, role: row.roleCode, label: row.label,
		matrix_f64le: row.matrix.map(numberF64LE)
	}));
	const actualInstances = (output.instances ?? []).map((row: any) => ({
		id: row.id, name: row.name, kind: row.kind, owner: row.owner, definition: row.definition,
		material: row.material, visible: row.visible, role: row.role, label: row.label, matrix_f64le: row.matrix_f64le
	}));
	addMismatch(mismatches, 'instances', expectedInstances, actualInstances);
	const ids = output.authoring?.ids ?? {};
	addMismatch(mismatches, 'authoring.ids.materials', graph.materials.map((row) => row.id), ids.materials);
	addMismatch(mismatches, 'authoring.ids.definitions', graph.definitions.map((row) => row.id), ids.definitions);
	addMismatch(mismatches, 'authoring.ids.meshes', graph.meshes.map((row) => row.id), ids.meshes);
	addMismatch(mismatches, 'authoring.ids.faces', graph.meshes.flatMap((mesh) => mesh.faces.map((face) => face.id)), ids.faces);
	addMismatch(mismatches, 'authoring.ids.instances', graph.instances.map((row) => row.id), ids.instances);
	return mismatches;
}

function visualEdgeCount(graph: BomcGraph) {
	let count = 0;
	for (const mesh of graph.meshes) {
		const edges = new Set<string>();
		for (const face of mesh.faces) for (const ring of [face.outer, ...face.holes]) {
			for (let index = 0; index < ring.length; index += 1) {
				const left = ring[index]!;
				const right = ring[(index + 1) % ring.length]!;
				edges.add(left < right ? `${left}:${right}` : `${right}:${left}`);
			}
		}
		count += edges.size;
	}
	return count;
}

function projectPoint(positions: readonly number[], vertex: number) {
	return [Math.fround(positions[vertex * 3]!), Math.fround(positions[vertex * 3 + 2]!), Math.fround(-positions[vertex * 3 + 1]!)];
}

function polygonArea(points: readonly number[][]) {
	if (points.length < 3) return 0;
	let x = 0, y = 0, z = 0;
	for (let index = 0; index < points.length; index += 1) {
		const current = points[index]!;
		const next = points[(index + 1) % points.length]!;
		x += (current[1]! - next[1]!) * (current[2]! + next[2]!);
		y += (current[2]! - next[2]!) * (current[0]! + next[0]!);
		z += (current[0]! - next[0]!) * (current[1]! + next[1]!);
	}
	return Math.hypot(x, y, z) * 0.5;
}

function semanticRoleSurface(role: number) {
	return role >= 1 && role <= 4 ? role : role === 5 ? 7 : role === 6 ? 8 : role === 7 ? 9 : role === 9 ? 11 : role === 10 ? 12 : role === 11 ? 13 : role === 12 ? 14 : role === 13 ? 15 : role === 19 || role === 20 ? 13 : role >= 21 && role <= 23 ? 1 : 0;
}

function isAnalyticalSurface(code: number) { return code === 0 || code >= 1 && code <= 9 || code === 11; }

function triangleKey(values: readonly number[]) { return values.map(numberF32LE).join(':'); }

function numberF32LE(value: number) {
	const bytes = new ArrayBuffer(4);
	new DataView(bytes).setFloat32(0, value, true);
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function numberF64LE(value: number) {
	const bytes = new ArrayBuffer(8);
	new DataView(bytes).setFloat64(0, value, true);
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function numberArrayKey(values: readonly number[]) { return values.map(numberF64LE).join(''); }

function exactEvidence(value: unknown): unknown {
	if (typeof value === 'number') return { $f64le: numberF64LE(value) };
	if (Array.isArray(value)) return value.map(exactEvidence);
	if (value && typeof value === 'object') {
		if (value instanceof DataView) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), exactEvidence);
		if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>, exactEvidence);
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, exactEvidence((value as Record<string, unknown>)[key])]));
	}
	return value;
}

function compareExact(expected: unknown, actual: unknown, root = '$'): Mismatch[] {
	const mismatches: Mismatch[] = [];
	const visit = (left: any, right: any, at: string) => {
		if (typeof left === 'number' || typeof right === 'number') {
			if (!Object.is(left, right)) mismatches.push({ path: at, expected: left, actual: right });
			return;
		}
		if (Array.isArray(left) || Array.isArray(right)) {
			if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
				mismatches.push({ path: at, expected: left, actual: right });
				return;
			}
			for (let index = 0; index < left.length; index += 1) visit(left[index], right[index], `${at}[${index}]`);
			return;
		}
		if (left && typeof left === 'object' || right && typeof right === 'object') {
			if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
				mismatches.push({ path: at, expected: left, actual: right });
				return;
			}
			const leftKeys = Object.keys(left).sort();
			const rightKeys = Object.keys(right).sort();
			if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) {
				mismatches.push({ path: `${at}.$keys`, expected: leftKeys, actual: rightKeys });
				return;
			}
			for (const key of leftKeys) visit(left[key], right[key], `${at}.${key}`);
			return;
		}
		if (!Object.is(left, right)) mismatches.push({ path: at, expected: left, actual: right });
	};
	visit(expected, actual, root);
	return mismatches;
}

function compareProjectionExact(expected: unknown, actual: unknown, root: string): Mismatch[] {
	const mismatches: Mismatch[] = [];
	const visit = (left: any, right: any, at: string) => {
		if (typeof left === 'number' || typeof right === 'number') {
			// Renderer-facing reader projections may canonicalize -0 to +0. Keep every
			// other numeric comparison exact; canonical BOMC and Ruby checks use Object.is.
			if (left !== right) mismatches.push({ path: at, expected: left, actual: right });
			return;
		}
		if (Array.isArray(left) || Array.isArray(right)) {
			if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
				mismatches.push({ path: at, expected: left, actual: right });
				return;
			}
			for (let index = 0; index < left.length; index += 1) visit(left[index], right[index], `${at}[${index}]`);
			return;
		}
		if (left && typeof left === 'object' || right && typeof right === 'object') {
			if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
				mismatches.push({ path: at, expected: left, actual: right });
				return;
			}
			const leftKeys = Object.keys(left).sort();
			const rightKeys = Object.keys(right).sort();
			if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) {
				mismatches.push({ path: `${at}.$keys`, expected: leftKeys, actual: rightKeys });
				return;
			}
			for (const key of leftKeys) visit(left[key], right[key], `${at}.${key}`);
			return;
		}
		if (!Object.is(left, right)) mismatches.push({ path: at, expected: left, actual: right });
	};
	visit(expected, actual, root);
	return mismatches;
}

function addMismatch(target: Mismatch[], at: string, expected: unknown, actual: unknown) {
	const found = compareExact(expected, actual, at);
	if (found.length) target.push(...found.slice(0, 100 - target.length));
}

function addProjectionMismatch(target: Mismatch[], at: string, expected: unknown, actual: unknown) {
	const found = compareProjectionExact(expected, actual, at);
	if (found.length) target.push(...found.slice(0, 100 - target.length));
}

function sameNumberArray(left: readonly number[], right: readonly number[]) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function safeManifestPath(value: string) {
	return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !path.posix.isAbsolute(value)
		&& value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function isWithin(root: string, candidate: string) {
	const relative = path.relative(root, candidate);
	return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sha256(value: Uint8Array) { return createHash('sha256').update(value).digest('hex'); }

function writeJsonExclusive(filePath: string, value: unknown) {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

const readerProbeSource = String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
import { BomcLoader } from '@sibambo/e4-import';

const inputPath = process.env.BOMC_INTEROP_INPUT;
const outputPath = process.env.BOMC_INTEROP_OUTPUT;
if (!inputPath || !outputPath) throw new Error('Interop input/output path is missing.');
const source = readFileSync(inputPath);
const bytes = new Uint8Array(source.byteLength);
bytes.set(source);
const result = await new BomcLoader().load(bytes.buffer, 'browser-download.bomc', { prepareSolid: false });
const scene = result.preparedRuntimeScene;
const meshes = new Map(scene.meshes.map((mesh) => [mesh.sourceMeshIndex, mesh]));
const triangles = [];
for (const group of scene.groups) {

	const mesh = meshes.get(group.sourceMeshIndex);
	if (!mesh) throw new Error('Prepared runtime group has no matching source mesh.');
	const sourceFaces = group.sourceFaceIndicesByTriangle;
	if (!sourceFaces || sourceFaces.length !== group.indices.length / 3) throw new Error('Prepared runtime group did not retain source-face triangle ownership.');
	for (let offset = 0, triangleIndex = 0; offset + 2 < group.indices.length; offset += 3, triangleIndex += 1) {
		const vertices = [group.indices[offset], group.indices[offset + 1], group.indices[offset + 2]];
		const coordinates = vertices.flatMap((vertex) => Array.from(mesh.positions.slice(vertex * 3, vertex * 3 + 3)));
		const bytes = new ArrayBuffer(4);
		const key = coordinates.map((value) => {
			new DataView(bytes).setFloat32(0, value, true);
			return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
		}).join(':');
		triangles.push({ sourceFaceIndex: sourceFaces[triangleIndex], key });
	}
}
const output = {
	reader: process.env.BOMC_INTEROP_READER,
	counts: result.counts,
	faces: result.faces.map((face) => ({
		id: face.id,
		name: face.name,
		sourceFaceIndex: face.sourceFaceIndex,
		semanticLabel: face.semanticLabel ?? null,
		vertices: face.vertices.map((point) => [Math.fround(point.x), Math.fround(point.y), Math.fround(point.z)]),
		holes: face.holes.map((ring) => ring.map((point) => [Math.fround(point.x), Math.fround(point.y), Math.fround(point.z)])),
		normal: [Math.fround(face.normal.x), Math.fround(face.normal.y), Math.fround(face.normal.z)]
	})),
	materials: result.appearance.materials.map((material) => ({
		index: material.index,
		id: material.id,
		name: material.name ?? null,
		baseColorRgba: material.baseColorRgba ?? null,
		opacity: material.opacity
	})),
	triangles,
	groups: scene.groups.map((group) => ({
		sourceMeshIndex: group.sourceMeshIndex,
		definitionIndex: group.definitionIndex,
		occurrenceInstanceIds: group.occurrenceInstanceIds ?? [],
		matrices: Array.from(group.matrices)
	}))
};
writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ reader: output.reader, counts: output.counts, faces: output.faces.length, triangles: output.triangles.length }));
`;
