import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withRuntimeProofLease } from './runtime-proof-lease.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runId = process.argv[2];
if (!runId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw new Error('Pass a lowercase evidence label as the first argument.');
const userTestArgs = process.argv.slice(3);
const explicitConfig = userTestArgs.some((arg) => arg === '--config' || arg.startsWith('--config='));
const resultDir = path.join(repoRoot, 'tooling', 'testing', 'results', runId, 'authoring-performance');
if (existsSync(resultDir) && readdirSync(resultDir).length > 0) throw new Error(`Evidence directory already contains files: ${resultDir}`);

await withRuntimeProofLease(async (lease) => {
	console.info(`[Editor authoring performance] label=${runId} leaseUUID=${lease.record.runUUID}`);
	const child = Bun.spawn([
		process.execPath,
		'x',
		'playwright',
		'test',
		...(explicitConfig ? [] : ['--config', 'apps/editor/playwright.authoring-performance.config.ts', '--project', 'editor-authoring-performance']),
		...userTestArgs
	], {
		cwd: repoRoot,
		env: { ...process.env, EDITOR_AUTHORING_RUN_ID: runId },
		stdio: ['inherit', 'inherit', 'inherit']
	});
	process.exitCode = await child.exited;
	return process.exitCode;
}, {
	repository: repoRoot,
	onWaiting: (owner, waitedMs) => console.warn(`[Editor authoring performance] waiting ${waitedMs}ms for PID ${owner.ownerPID} (${owner.processCreationIdentity})`)
});
