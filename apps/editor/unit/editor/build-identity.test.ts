import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { getAppBuildIdentity } from '../../../../tooling/research/build-identity';

const temporaryRepositories: string[] = [];

function makeRepository() {
	const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'sibambo-build-identity-'));
	temporaryRepositories.push(repoRoot);
	const files: Record<string, string> = {
		'.gitignore': 'node_modules/\n**/.svelte-kit/\n**/build/\n**/dist/\ncoverage/\nplaywright-report/\ntest-results/\n.vercel/\n/private/\n',
		'package.json': JSON.stringify({ name: 'test-workspace', private: true, workspaces: ['apps/editor', 'packages/*'] }),
		'bun.lock': 'test lockfile\n',
		'tsconfig.json': '{"compilerOptions":{"strict":true}}\n',
		'packages/tsconfig.json': '{"compilerOptions":{"strict":true}}\n',
		'tooling/research/build-identity.ts': 'export const buildIdentitySource = true;\n',
		'apps/editor/package.json': JSON.stringify({ name: '@sibambo/editor', version: '0.1.0' }),
		'apps/editor/vite.config.ts': 'export default {};\n',
		'apps/editor/src/index.ts': 'export const editor = true;\n',
		'apps/editor/src/deleted.ts': 'export const deletedInput = true;\n',
		'packages/contracts/package.json': JSON.stringify({ name: '@sibambo/contracts', version: '0.1.0' }),
		'packages/contracts/src/index.ts': 'export type Contract = string;\n',
		'README.md': 'baseline\n'
	};
	for (const [relative, content] of Object.entries(files)) {
		const destination = path.join(repoRoot, relative);
		mkdirSync(path.dirname(destination), { recursive: true });
		writeFileSync(destination, content);
	}
	execFileSync('git', ['init', '--quiet'], { cwd: repoRoot });
	execFileSync('git', ['config', 'user.name', 'Build Identity Test'], { cwd: repoRoot });
	execFileSync('git', ['config', 'user.email', 'build-identity@example.invalid'], { cwd: repoRoot });
	execFileSync('git', ['add', '-A'], { cwd: repoRoot });
	execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: repoRoot });
	return { repoRoot, appRoot: path.join(repoRoot, 'apps/editor') };
}

function identity(repoRoot: string, appRoot: string) {
	return getAppBuildIdentity({ appName: 'editor', appRoot, repoRoot, packageNames: ['@sibambo/contracts'] });
}

afterEach(() => {
	for (const repoRoot of temporaryRepositories.splice(0)) rmSync(repoRoot, { recursive: true, force: true });
});

describe('Editor build identity working tree', () => {
	test('reports deleted source and build configuration plus untracked source and configuration as build inputs', () => {
		const { repoRoot, appRoot } = makeRepository();
		rmSync(path.join(appRoot, 'src/deleted.ts'));
		rmSync(path.join(appRoot, 'vite.config.ts'));
		const afterDelete = identity(repoRoot, appRoot);
		expect(afterDelete.dirty).toBe(true);
		expect(afterDelete.workingTree.buildInputModifiedPaths).toEqual(expect.arrayContaining([
			'apps/editor/src/deleted.ts', 'apps/editor/vite.config.ts'
		]));

		writeFileSync(path.join(appRoot, 'src/new-module.ts'), 'export const addedInput = true;\n');
		writeFileSync(path.join(appRoot, 'tsconfig.json'), '{}\n');
		const afterAdd = identity(repoRoot, appRoot);
		expect(afterAdd.dirty).toBe(true);
		expect(afterAdd.workingTree.buildInputUntrackedPaths).toEqual(expect.arrayContaining([
			'apps/editor/src/new-module.ts', 'apps/editor/tsconfig.json'
		]));
		expect(afterAdd.workingTree).toHaveProperty('otherModifiedPaths');
		expect(afterAdd.workingTree).toHaveProperty('otherUntrackedPaths');
		expect(afterAdd.workingTree).toHaveProperty('generatedOutputPaths');
	});

	test('classifies workspace TypeScript configs as inputs without changing the fingerprint closure', () => {
		const { repoRoot, appRoot } = makeRepository();
		const before = identity(repoRoot, appRoot);
		writeFileSync(path.join(repoRoot, 'tsconfig.json'), '{"compilerOptions":{"strict":false}}\n');
		writeFileSync(path.join(repoRoot, 'packages/tsconfig.json'), '{"compilerOptions":{"strict":false}}\n');

		const after = identity(repoRoot, appRoot);
		expect(after.dirty).toBe(true);
		expect(after.workingTree.buildInputModifiedPaths).toEqual(expect.arrayContaining([
			'tsconfig.json', 'packages/tsconfig.json'
		]));
		expect(after.sourceSha256).toBe(before.sourceSha256);
		expect(after.buildConfigSha256).toBe(before.buildConfigSha256);
	});

	test('keeps unrelated edits out of dirty and reports only allowlisted generated outputs', () => {
		const { repoRoot, appRoot } = makeRepository();
		writeFileSync(path.join(repoRoot, 'README.md'), 'documentation-only change\n');
		writeFileSync(path.join(appRoot, 'src/navigation.test.ts'), 'test-only source\n');
		mkdirSync(path.join(appRoot, 'build'), { recursive: true });
		writeFileSync(path.join(appRoot, 'build/worker.js'), 'generated\n');
		mkdirSync(path.join(repoRoot, 'private'), { recursive: true });
		writeFileSync(path.join(repoRoot, 'private/unrelated.bin'), 'ignored\n');

		const result = identity(repoRoot, appRoot);
		expect(result.dirty).toBe(false);
		expect(result.workingTree.otherModifiedPaths).toContain('README.md');
		expect(result.workingTree.otherUntrackedPaths).toContain('apps/editor/src/navigation.test.ts');
		expect(result.workingTree.generatedOutputPaths).toEqual(['apps/editor/build']);
	});
});
