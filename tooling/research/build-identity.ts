import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export type AppBuildIdentity = {
	schema: 'sibambo-app-build-identity-v2';
	app: string;
	version: string;
	commit: string;
	dirty: boolean;
	workingTree: {
		buildInputModifiedPaths: string[];
		buildInputUntrackedPaths: string[];
		otherModifiedPaths: string[];
		otherUntrackedPaths: string[];
		generatedOutputPaths: string[];
	};
	fingerprintScheme: 'sibambo-app-closure-sha256-v1';
	sourceSha256: string;
	buildConfigSha256: string;
	lockfileSha256: string | null;
	policySha256: string | null;
	dataManifestSha256: string | null;
	packageClosure: Array<{ name: string; version: string; manifestSha256: string }>;
	capturedAt: string;
};

const isSourceTest = (file: string) => /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(file);

type GitStatusEntry = { status: string; file: string };

function parsePorcelainStatus(output: string): GitStatusEntry[] {
	const records = output.split('\0');
	const entries: GitStatusEntry[] = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record.length < 4) continue;
		const status = record.slice(0, 2);
		entries.push({ status, file: record.slice(3).replaceAll('\\', '/') });
		if (status.includes('R') || status.includes('C')) {
			const originalPath = records[index + 1];
			if (originalPath) entries.push({ status, file: originalPath.replaceAll('\\', '/') });
			index += 1;
		}
	}
	return entries;
}

const generatedOutputNames = ['.svelte-kit', '.vercel', 'build', 'coverage', 'dist', 'node_modules', 'playwright-report', 'test-results'];

function generatedOutputAllowlist(repoRoot: string, appRoot: string, packageRoots: string[]): Set<string> {
	const roots = [repoRoot, appRoot, ...packageRoots];
	const paths = new Set<string>();
	for (const root of roots) {
		for (const name of generatedOutputNames) paths.add(path.relative(repoRoot, path.join(root, name)).replaceAll('\\', '/'));
	}
	return paths;
}

function knownGeneratedOutput(file: string, allowlist: ReadonlySet<string>): string | null {
	const normalized = file.replaceAll('\\', '/').replace(/\/+$/, '');
	for (const root of allowlist) {
		if (normalized === root || normalized.startsWith(`${root}/`)) return root;
	}
	return null;
}

/** Fingerprint one app and its declared internal package closure without hashing unrelated domains. */
export function getAppBuildIdentity(options: {
	appName: string;
	appRoot: string;
	repoRoot: string;
	packageNames: string[];
}): AppBuildIdentity {
	const appRoot = path.resolve(options.appRoot);
	const repoRoot = path.resolve(options.repoRoot);
	const appManifest = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as { version: string };
	const closure: Array<{ name: string; version: string; manifestSha256: string }> = [];
	const sourceRoots: string[] = [];
	const exactBuildInputPaths = new Set<string>();
	const roots: Array<{ label: string; path: string; manifest: string }> = [{
		label: path.relative(repoRoot, appRoot).replaceAll('\\', '/'),
		path: path.join(appRoot, 'src'),
		manifest: path.join(appRoot, 'package.json')
	}];
	for (const name of [...new Set(options.packageNames)].sort()) {
		const packageRoot = path.join(repoRoot, 'packages', name.replace(/^@sibambo\//, ''));
		const manifestPath = path.join(packageRoot, 'package.json');
		const manifestBytes = readFileSync(manifestPath);
		const manifest = JSON.parse(manifestBytes.toString('utf8')) as { name: string; version: string };
		closure.push({ name: manifest.name, version: manifest.version, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex') });
		roots.push({ label: path.relative(repoRoot, packageRoot).replaceAll('\\', '/'), path: path.join(packageRoot, 'src'), manifest: manifestPath });
	}
	const fingerprint = createHash('sha256');
	const buildConfigFingerprint = createHash('sha256');
	const addFile = (file: string, label: string) => {
		fingerprint.update(label.replaceAll('\\', '/')).update('\0').update(readFileSync(file)).update('\0');
	};
	const addBuildConfig = (file: string, label: string) => {
		buildConfigFingerprint.update(label.replaceAll('\\', '/')).update('\0').update(readFileSync(file)).update('\0');
	};
	const configNames = ['svelte.config.js', 'vite.config.ts', 'tsconfig.json', 'playwright.config.ts'];
	for (const root of roots) {
		sourceRoots.push(path.resolve(root.path));
		exactBuildInputPaths.add(path.relative(repoRoot, root.manifest).replaceAll('\\', '/'));
		for (const name of configNames) exactBuildInputPaths.add(path.relative(repoRoot, path.join(path.dirname(root.manifest), name)).replaceAll('\\', '/'));
		addFile(root.manifest, path.relative(repoRoot, root.manifest));
		if (path.resolve(root.manifest) === path.join(appRoot, 'package.json')) {
			addBuildConfig(root.manifest, path.relative(repoRoot, root.manifest));
		}
		if (statSync(root.path).isDirectory()) {
			const walk = (directory: string) => {
				for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
					const absolute = path.join(directory, entry.name);
					if (entry.isDirectory()) walk(absolute);
					else if (entry.isFile()) {
						const relative = path.relative(root.path, absolute).replaceAll('\\', '/');
						if (!isSourceTest(relative)) addFile(absolute, `${root.label}/src/${relative}`);
					}
				}
			};
			walk(root.path);
		}
		for (const name of configNames) {
			const file = path.join(path.dirname(root.manifest), name);
			try {
				const label = path.relative(repoRoot, file);
				addFile(file, label);
				if (path.dirname(root.manifest) === appRoot) addBuildConfig(file, label);
			} catch { /* package configs are optional */ }
		}
	}
	const workspaceManifest = path.join(repoRoot, 'package.json');
	const lockfile = path.join(repoRoot, 'bun.lock');
	const buildIdentitySource = path.join(repoRoot, 'tooling/research/build-identity.ts');
	for (const file of [
		workspaceManifest,
		lockfile,
		buildIdentitySource,
		path.join(repoRoot, 'tsconfig.json'),
		path.join(repoRoot, 'packages/tsconfig.json'),
		path.join(repoRoot, 'packages/provenance/src/policies/e4-v1.ts'),
		path.join(appRoot, 'src/lib/server/research-catalog.json')
	]) {
		exactBuildInputPaths.add(path.relative(repoRoot, file).replaceAll('\\', '/'));
	}
	addFile(workspaceManifest, 'package.json');
	addFile(lockfile, 'bun.lock');
	addFile(buildIdentitySource, 'tooling/research/build-identity.ts');
	addBuildConfig(workspaceManifest, 'package.json');
	addBuildConfig(lockfile, 'bun.lock');
	addBuildConfig(buildIdentitySource, 'tooling/research/build-identity.ts');
	const policyPath = path.join(repoRoot, 'packages/provenance/src/policies/e4-v1.ts');
	const dataManifestPath = path.join(appRoot, 'src/lib/server/research-catalog.json');
	const policySha256 = statSync(policyPath, { throwIfNoEntry: false })?.isFile()
		? createHash('sha256').update(readFileSync(policyPath)).digest('hex') : null;
	const dataManifestSha256 = statSync(dataManifestPath, { throwIfNoEntry: false })?.isFile()
		? createHash('sha256').update(readFileSync(dataManifestPath)).digest('hex') : null;
	const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
	const statusEntries = parsePorcelainStatus(execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '-z'], { cwd: repoRoot, encoding: 'utf8' }));
	const generatedAllowlist = generatedOutputAllowlist(repoRoot, appRoot, roots.slice(1).map((root) => path.dirname(root.manifest)));
	const isGeneratedOutput = (file: string) => knownGeneratedOutput(file, generatedAllowlist) !== null;
	const isBuildInput = (file: string) => {
		if (isGeneratedOutput(file)) return false;
		const absolute = path.resolve(repoRoot, file);
		if (exactBuildInputPaths.has(file)) return true;
		for (const sourceRoot of sourceRoots) {
			const relative = path.relative(sourceRoot, absolute).replaceAll('\\', '/');
			if (relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative) && !isSourceTest(relative)) return true;
		}
		return false;
	};
	const trackedPaths = statusEntries.filter(({ status, file }) => status !== '??' && !isGeneratedOutput(file)).map(({ file }) => file);
	const untrackedPaths = statusEntries.filter(({ status, file }) => status === '??' && !isGeneratedOutput(file)).map(({ file }) => file);
	const uniqueSorted = (paths: string[]) => [...new Set(paths)].sort();
	const workingTree = {
		buildInputModifiedPaths: uniqueSorted(trackedPaths.filter(isBuildInput)),
		buildInputUntrackedPaths: uniqueSorted(untrackedPaths.filter(isBuildInput)),
		otherModifiedPaths: uniqueSorted(trackedPaths.filter((file) => !isBuildInput(file))),
		otherUntrackedPaths: uniqueSorted(untrackedPaths.filter((file) => !isBuildInput(file))),
		generatedOutputPaths: [] as string[]
	};
	const ignoredEntries = parsePorcelainStatus(execFileSync('git', ['status', '--porcelain=v1', '--ignored=matching', '--untracked-files=normal', '-z'], { cwd: repoRoot, encoding: 'utf8' }));
	workingTree.generatedOutputPaths = uniqueSorted([...statusEntries, ...ignoredEntries]
		.map(({ file }) => knownGeneratedOutput(file, generatedAllowlist))
		.filter((file): file is string => file !== null));
	const dirty = workingTree.buildInputModifiedPaths.length > 0 || workingTree.buildInputUntrackedPaths.length > 0;
	const lock = readFileSync(path.join(repoRoot, 'bun.lock'));
	return {
		schema: 'sibambo-app-build-identity-v2',
		app: options.appName,
		version: appManifest.version,
		commit,
		dirty,
		workingTree,
		fingerprintScheme: 'sibambo-app-closure-sha256-v1',
		sourceSha256: fingerprint.digest('hex'),
		buildConfigSha256: buildConfigFingerprint.digest('hex'),
		lockfileSha256: createHash('sha256').update(lock).digest('hex'),
		policySha256,
		dataManifestSha256,
		packageClosure: closure,
		capturedAt: new Date().toISOString()
	};
}
