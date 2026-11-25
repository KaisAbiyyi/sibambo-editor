import { expect } from 'bun:test';
import { graphsEqual } from '../../../src/lib/authoring/history.js';
import type { AgentHarness } from './agent-harness.js';

/** Invariant 9: the read left graph, revision, sequence, both history stacks and the pending download untouched. */
export function expectUntouched(harness: AgentHarness, before: ReturnType<AgentHarness['state']>): void {
	const after = harness.state();
	expect(after.identity).toBe(before.identity);
	expect(graphsEqual(after.graph, before.graph)).toBe(true);
	expect(after.revision).toBe(before.revision);
	expect(after.sequence).toBe(before.sequence);
	expect(after.issued).toBe(before.issued);
	expect(after.undo.length).toBe(before.undo.length);
	expect(after.redo.length).toBe(before.redo.length);
	after.undo.forEach((entry, index) => expect(entry).toBe(before.undo[index]!));
	after.redo.forEach((entry, index) => expect(entry).toBe(before.redo[index]!));
}
