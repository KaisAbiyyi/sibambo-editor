/**
 * Review remediation, finding 1 (SIB-MCP-MODELING-001 WP3): the page's AgentHost `accept`
 * must report the real viewport projection outcome. Previously it was acceptAuthoringResult,
 * which ignores refreshAuthoringProjection()'s result and returns true, so a projection
 * failure after a committed agent write reached the agent as an ordinary success.
 * The page component cannot be mounted in Bun, so this checks the wiring in source, as
 * unit/editor/editor-foundation-policy.test.ts does for another +page.svelte contract.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const route = readFileSync(fileURLToPath(new URL('../../src/routes/+page.svelte', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

describe('+page.svelte agent accept wiring', () => {
	test('AgentHost accept returns the applyAuthoringResult outcome, not the boolean acceptAuthoringResult', () => {
		expect(route).toMatch(/new AgentHost<AuthoringClient>\(\{[\s\S]*?accept:\s*\(client,\s*acknowledged,\s*token\)\s*=>\s*applyAuthoringResult\(client,\s*acknowledged,\s*token as number\),/);
		expect(route).not.toMatch(/accept:\s*\(client,\s*acknowledged,\s*token\)\s*=>\s*acceptAuthoringResult\(/);
	});

	test('applyAuthoringResult reports stale before touching state and the projection result after applying the checkpoint', () => {
		const body = route.match(/function applyAuthoringResult\([^)]*\): AuthoringApplyOutcome \{([\s\S]*?)\n\t\}/)?.[1] ?? '';
		expect(body).toMatch(/^\s*if \(request !== generation \|\| client !== authoringClient \|\| mode !== 'authoring'\) return 'stale';/);
		expect(body.indexOf('authoringCheckpoint = acknowledged.checkpoint;')).toBeGreaterThan(0);
		expect(body.trimEnd()).toMatch(/return refreshAuthoringProjection\(false\) \? 'rendered' : 'render-failed';$/);
		expect(body.indexOf('authoringCheckpoint = acknowledged.checkpoint;')).toBeLessThan(body.indexOf('refreshAuthoringProjection(false)'));
	});

	test('owner paths keep the previous acceptAuthoringResult meaning (applied unless stale)', () => {
		expect(route).toMatch(/function acceptAuthoringResult\(client: AuthoringClient, acknowledged: AuthoringResult, request = generation\) \{\n\t\treturn applyAuthoringResult\(client, acknowledged, request\) !== 'stale';\n\t\}/);
	});
});
