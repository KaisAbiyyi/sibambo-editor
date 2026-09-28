import { resolve } from 'node:path';

export type DataRoots = {
	repoRoot: string;
	dataRoot: string;
	captureRoot: string;
	evidenceRoot: string;
	fixtureRoot: string;
};

export type DataRootOptions = {
	repoRoot: string;
	env?: Record<string, string | undefined>;
};

/** Resolve existing research assets independently of the current app's working directory. */
export function resolveDataRoots({ repoRoot, env = process.env }: DataRootOptions): DataRoots {
	const root = resolve(repoRoot);
	const dataRoot = resolve(root, env.SIBAMBO_DATA_ROOT || 'skps');
	return {
		repoRoot: root,
		dataRoot,
		captureRoot: resolve(root, env.SIBAMBO_CAPTURE_ROOT || `${dataRoot}/model-eval-exports`),
		evidenceRoot: resolve(root, env.SIBAMBO_EVIDENCE_ROOT || 'docs/worklogs'),
		fixtureRoot: resolve(root, env.SIBAMBO_FIXTURE_ROOT || 'tests/fixtures')
	};
}
