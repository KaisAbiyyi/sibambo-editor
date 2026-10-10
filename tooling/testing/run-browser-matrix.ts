import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedEditorBuildIdentity } from './accelerated-proof.js';
import { withRuntimeProofLease } from './runtime-proof-lease.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runId = process.argv[2];
const engine = process.argv[3];
if (!runId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw new Error('Pass a unique lowercase browser-matrix evidence label as the first argument.');
if (!['chrome', 'edge', 'firefox', 'webkit'].includes(engine ?? '')) throw new Error('Pass chrome, edge, firefox, or webkit as the second argument.');
const outputRoot = path.join(repoRoot, 'tooling', 'testing', 'results', runId, 'browser-matrix', engine!);
if (existsSync(outputRoot)) throw new Error(`Browser-matrix evidence root already exists; use a new label: ${outputRoot}`);
const executionTopicRoot = path.join(path.resolve(repoRoot, '..'), 'docs', 'worklogs', 'EDITOR-ACCELERATED-001');
if (!existsSync(executionTopicRoot)) mkdirSync(executionTopicRoot, { recursive: true });
if (lstatSync(executionTopicRoot).isSymbolicLink() || path.resolve(realpathSync(executionTopicRoot)) !== executionTopicRoot) {
	throw new Error(`Authoring execution worklog root cannot resolve through a link: ${executionTopicRoot}`);
}
const executionRoot = path.join(executionTopicRoot, `authoring-matrix-${runId}-${engine}`);
if (existsSync(executionRoot)) throw new Error(`Authoring matrix execution root already exists and will not be reused: ${executionRoot}`);

await withRuntimeProofLease(async (lease) => {
	mkdirSync(outputRoot, { recursive: true });
	mkdirSync(executionRoot);
	const receiptPath = path.join(outputRoot, 'run-root.json');
	const receipt = {
		schema: 'sibambo-editor-browser-matrix-run-root-v1', status: 'running', runId, engine,
		browser: engine === 'chrome' ? { name: 'chromium', channel: 'chrome' } : engine === 'edge' ? { name: 'chromium', channel: 'msedge' } : { name: engine },
		head: (await Bun.$`git -C ${repoRoot} rev-parse HEAD`.text()).trim(),
		buildIdentity: expectedEditorBuildIdentity(), outputRoot,
		runUUID: lease.record.runUUID, leasePath: lease.leasePath, ownerPID: lease.record.ownerPID,
		processCreationIdentity: lease.record.processCreationIdentity, repository: lease.record.repository,
		startedAt: new Date().toISOString()
	};
	writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
	console.info(`[Editor browser matrix] engine=${engine} label=${runId} leaseUUID=${lease.record.runUUID}`);
	let exitCode: number | null = null;
	let failure: string | null = null;
	try {
		const child = Bun.spawn([
			process.execPath, 'x', 'playwright', 'test', '--config', 'apps/editor/playwright.authoring-matrix.config.ts'
		], {
			cwd: repoRoot,
			env: { ...process.env, EDITOR_BROWSER_MATRIX_RUN_ID: runId, EDITOR_BROWSER_MATRIX_ENGINE: engine!, SIBAMBO_ACCELERATED_RUN_ROOT: executionRoot },
			stdio: ['inherit', 'inherit', 'inherit']
		});
		exitCode = await child.exited;
		process.exitCode = exitCode;
		return exitCode;
	} catch (error) {
		failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		throw error;
	} finally {
		writeFileSync(receiptPath, `${JSON.stringify({ ...receipt,
			status: failure ? 'runner-failed' : exitCode === 0 ? 'completed' : 'browser-proof-failed',
			exitCode, failure, completedAt: new Date().toISOString()
		}, null, 2)}\n`);
	}
}, {
	repository: repoRoot,
	onWaiting: (owner, waitedMs) => console.warn(`[Editor browser matrix] waiting ${waitedMs}ms for PID ${owner.ownerPID} (${owner.processCreationIdentity})`)
});
