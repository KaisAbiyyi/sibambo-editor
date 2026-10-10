import path from 'node:path';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withRuntimeProofLease } from './runtime-proof-lease.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runId = process.argv[2];
if (!runId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw new Error('Pass a unique lowercase authoring evidence label as the first argument.');
const outputDir = path.join(repoRoot, 'tooling', 'testing', 'results', runId, 'authoring-ui');
if (existsSync(outputDir)) throw new Error(`Authoring UI evidence output already exists and will not be reused: ${outputDir}`);
const workspaceRoot = path.resolve(repoRoot, '..');
const executionTopicRoot = path.join(workspaceRoot, 'docs', 'worklogs', 'EDITOR-ACCELERATED-001');
if (!existsSync(executionTopicRoot)) mkdirSync(executionTopicRoot, { recursive: true });
if (lstatSync(executionTopicRoot).isSymbolicLink() || path.resolve(realpathSync(executionTopicRoot)) !== executionTopicRoot) {
	throw new Error(`Authoring execution worklog root cannot resolve through a link: ${executionTopicRoot}`);
}
const executionRoot = path.join(executionTopicRoot, `authoring-${runId}`);

await withRuntimeProofLease(async (lease) => {
	mkdirSync(executionRoot);
	console.info(`[Editor authoring UI] label=${runId} leaseUUID=${lease.record.runUUID}`);
	const child = Bun.spawn([process.execPath, 'x', 'playwright', 'test', '--config', 'apps/editor/playwright.authoring.config.ts', '--project', 'editor-authoring-chromium'], {
		cwd: repoRoot,
		env: { ...process.env, EDITOR_AUTHORING_E2E_RUN_ID: runId, SIBAMBO_ACCELERATED_RUN_ROOT: executionRoot },
		stdio: ['inherit', 'inherit', 'inherit']
	});
	process.exitCode = await child.exited;
	return process.exitCode;
}, {
	repository: repoRoot,
	onWaiting: (owner, waitedMs) => console.warn(`[Editor authoring UI] waiting ${waitedMs}ms for PID ${owner.ownerPID} (${owner.processCreationIdentity})`)
});
