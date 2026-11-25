/** SIB-MCP-MODELING-001 WP8 — mixed scenes for the perception goldens (T-P*). */
import type { ArchModule } from '../../../src/lib/arch/schema.js';
import { newDocument, type AgentHarness } from './agent-harness.js';
import { moduleOf, opening, space, wall } from './modules.js';

type P = [number, number];
const L: P[] = [[0, 0], [8, 0], [8, 4], [4, 4], [4, 7], [0, 7]];

/** L-shaped house: one closed shell (body outside), two partitions, three rooms, three doors, two windows, one slab. */
export const lHouse = (): ArchModule => ({
	...moduleOf(
		[
			wall('shell', L, { closed: true, side: 'right' }),
			wall('part-a', [[4, 0], [4, 4]]),
			wall('part-b', [[0, 4], [4, 4]]),
			opening('front', 'shell', 1, 0.9, 2.1, 0, 'door'),
			opening('door-a', 'part-a', 1.5, 0.8, 2.1, 0, 'door', { swing: { hinge: 'end', side: 'right' } }),
			opening('door-b', 'part-b', 1.5, 0.8, 2.1, 0, 'door'),
			opening('win-e', 'shell', 9.2, 1.2, 1.2, 0.9, 'window'),
			opening('win-w', 'shell', 24, 1.2, 1.2, 0.9, 'window'),
			{ elementId: 'floor', kind: 'slab', outline: L, holes: [], thickness: 0.15, topElevation: 0 },
			space('living', 'Ruang tamu', [2, 2]),
			space('bed-1', 'Kamar 1', [6, 2]),
			space('bed-2', 'Kamar 2', [2, 5.5])
		],
		'house/ground'
	),
	name: 'Lantai dasar'
});

const rectangle = (x0: number, y0: number, x1: number, y1: number) => ({
	kind: 'CREATE_RECTANGLE',
	// Authoring space is Y-up: world Z-up (x, y, 0) is (x, 0, -y).
	points: [[x0, 0, -y0], [x1, 0, -y0], [x1, 0, -y1], [x0, 0, -y1]],
	normal: [0, 1, 0]
});

/** A grouped box at world x[x0,x0+1] y[0,1] z[0,height], made with the agent's own freeform tool. Returns the group id. */
export async function freeformBox(harness: AgentHarness, name: string, x0: number, height: number): Promise<string> {
	await harness.ok('model_ops', { ops: [{ command: rectangle(x0, 0, x0 + 1, 1) }] });
	await harness.ok('model_ops', { ops: [{ command: { kind: 'PUSH_PULL_FACE', faceId: harness.meshOf(null).faces[0]!.id, distance: height } }] });
	const selection = harness.meshOf(null).faces.map((f) => ({ type: 'face', id: f.id }));
	const grouped = await harness.ok('model_ops', { ops: [{ action: { type: 'group', selection, containerKind: 'group', name } }] });
	return grouped.entityIds[0];
}

/** T-P1: L-house + one tagged freeform group + one loose rectangle (the group is made while the root mesh is empty). */
export async function mixedScene(): Promise<{ harness: AgentHarness; container: string; group: string }> {
	const harness = await newDocument();
	await harness.addModule(lHouse());
	const group = await freeformBox(harness, 'Meja "kayu"', 10, 0.5);
	await harness.owner({ type: 'tag-create', name: 'Perabot' });
	await harness.owner({ type: 'tag-assign', instanceIds: [group], tagId: harness.rootLabel().organization.tags[0].id });
	await harness.owner({ type: 'raw', command: rectangle(12, 0, 13, 1) });
	return { harness, container: harness.containerOf('house/ground'), group };
}
