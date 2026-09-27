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
	const dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: repoRoot, encoding: 'utf8' }).trim());
	const lock = readFileSync(path.join(repoRoot, 'bun.lock'));
	return {
		schema: 'sibambo-app-build-identity-v2',
		app: options.appName,
		version: appManifest.version,
		commit,
		dirty,
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
