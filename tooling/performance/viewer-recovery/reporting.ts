import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProofTicket, writeProofSidecar } from '../../testing/proof-run-contract';

const harnessRoot = path.dirname(fileURLToPath(import.meta.url));
export const editorRoot = path.resolve(harnessRoot, '../../..');
const worklogRoot = process.env.SIBAMBO_RECOVERY_WORKLOG;
const attempt = process.env.SIBAMBO_RECOVERY_ATTEMPT;
if (!worklogRoot || !path.isAbsolute(worklogRoot)) throw new Error('SIBAMBO_RECOVERY_WORKLOG must be an absolute path.');
if (attempt !== '01' && attempt !== '02') throw new Error('SIBAMBO_RECOVERY_ATTEMPT must be 01 or 02.');
export const recoveryAttemptRoot = path.join(path.resolve(worklogRoot), 'browser', `attempt-${attempt}`);

const sourcePaths = [
	'packages/viewport/src/camera-navigation.ts',
	'packages/viewport/src/navigation-surface-query.ts',
	'packages/viewport/src/prepared-navigation-input.ts',
	'packages/viewport/src/prepared-scene-viewport.ts',
	'packages/viewport/src/prepared-surface.ts',
	'packages/viewport/src/source-material-cache.ts',
	'packages/viewport/src/source-edge-style.ts',
	'packages/viewport/src/scene-visibility.ts',
	'packages/viewport/src/viewport-render-state.ts',
	'packages/scene-runtime/src/application-preparation.ts',
	'packages/scene-runtime/src/prepared-types.ts',
	'packages/scene-runtime/src/mirrored-instancing.ts',
	'packages/viewport/src/renderer-host.ts',
	'apps/editor/src/lib/e4-worker-client.ts',
	'apps/editor/src/lib/e4-import.worker.ts',
	'packages/e4-import/src/bomc-loader.ts',
	'packages/e4-import/src/worker-transfer.ts',
	'packages/e4-import/src/semantic-colorize.ts',
	'packages/e4-import/src/image-pixel-codec.ts',
	'tooling/performance/viewer-recovery/vite.config.ts',
	'tooling/performance/viewer-recovery/entry.ts',
	'tooling/performance/viewer-recovery/playwright.config.ts',
	'tooling/performance/viewer-recovery/tsconfig.json',
	'tooling/performance/viewer-recovery/vite-env.d.ts',
	'tooling/performance/viewer-recovery/navigation.spec.ts',
	'tooling/performance/viewer-recovery/door-visibility.spec.ts',
	'tooling/performance/viewer-recovery/mirrored-surfaces.spec.ts',
	'tooling/performance/viewer-recovery/reporting.ts',
	'tooling/performance/viewer-recovery/index.html',
	'tooling/testing/proof-run-contract.ts', 'tooling/testing/bomc-proof-runner.ts', 'tooling/testing/tsconfig.json'
];

export function captureSourceIdentity() {
	const files = sourcePaths.map((relativePath) => {
		const bytes = readFileSync(path.join(editorRoot, relativePath));
		return { path: relativePath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
	});
	const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: editorRoot, encoding: 'utf8' }).trim();
	const combinedSha256 = createHash('sha256').update(files.map((file) => `${file.path}\0${file.sha256}`).join('\n')).digest('hex');
	return { gitHead: head, files, combinedSha256 };
}

export function persistRecoveryReport(name: string, report: unknown) {
	const reports = path.join(recoveryAttemptRoot, 'reports');
	mkdirSync(reports, { recursive: true });
	const filePath = path.join(reports, `${name}.json`);
	writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
	if (process.env.SIBAMBO_PROOF_TICKET) {
		const row = report as Record<string, unknown>;
		if (typeof row.test !== 'string') throw new Error(`Recovery report ${name} has no selected test title.`);
		writeProofSidecar(readProofTicket('mirror'), row.test, {
			observedStatus: row.observedStatus ?? 'unknown', expectedStatus: row.expectedStatus ?? 'passed',
			stage: row.reachedStage ?? 'unknown', errors: row.errors ?? [], diagnosticReport: filePath
		});
	}
	return filePath;
}

export function percentile(values: number[], percentileValue: number) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1));
	return sorted[index] ?? null;
}
