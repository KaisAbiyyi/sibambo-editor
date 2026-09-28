import { describe, expect, test } from 'bun:test';
import { resolveDataRoots } from './data-roots';

describe('resolveDataRoots', () => {
	test('keeps existing assets anchored at the workspace root regardless of app cwd', () => {
		const roots = resolveDataRoots({ repoRoot: 'D:/workspace/model-eval' });
		expect(roots.dataRoot).toBe('D:\\workspace\\model-eval\\skps');
		expect(roots.captureRoot).toBe('D:\\workspace\\model-eval\\skps\\model-eval-exports');
	});

	test('uses configured roots and resolves relative values against the workspace root', () => {
		const roots = resolveDataRoots({
			repoRoot: 'D:/workspace/model-eval',
			env: { SIBAMBO_DATA_ROOT: '../shared-models', SIBAMBO_EVIDENCE_ROOT: 'audit/logs' }
		});
		expect(roots.dataRoot).toBe('D:\\workspace\\shared-models');
		expect(roots.evidenceRoot).toBe('D:\\workspace\\model-eval\\audit\\logs');
	});

	test('resolves relative and absolute capture overrides against the explicit workspace root', () => {
		const relative = resolveDataRoots({ repoRoot: 'D:/workspace/model-eval', env: { SIBAMBO_CAPTURE_ROOT: 'skps/alternate-captures' } });
		const absolute = resolveDataRoots({ repoRoot: 'D:/workspace/model-eval', env: { SIBAMBO_CAPTURE_ROOT: 'E:/research/captures' } });
		expect(relative.captureRoot).toBe('D:\\workspace\\model-eval\\skps\\alternate-captures');
		expect(absolute.captureRoot).toBe('E:\\research\\captures');
	});
});
