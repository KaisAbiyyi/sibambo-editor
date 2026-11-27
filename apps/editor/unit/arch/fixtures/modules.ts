/**
 * SIB-MCP-MODELING-001 v2.3 golden geometry fixtures G1…G9 (WP4 / CP4).
 * Units: metres, module-local, +Z up. Builders return plain ArchModule objects (schema-valid).
 */
import type { ArchModule } from '../../../src/lib/arch/schema';

type P = [number, number];
const T = 0.15, H = 2.7;
const room: P[] = [[0, 0], [4, 0], [4, 3], [0, 3]];

export const wall = (elementId: string, path: P[], extra: Record<string, unknown> = {}) => ({
	elementId, kind: 'wall' as const, path, thickness: T, height: H, baseElevation: 0, ...extra
});
const opening = (elementId: string, hostElementId: string, along: number, width: number, height: number, sillHeight: number, openingType: 'door' | 'window' | 'void', extra: Record<string, unknown> = {}) => ({
	elementId, kind: 'opening' as const, hostElementId, along, width, height, sillHeight, openingType, ...extra
});
const space = (elementId: string, name: string, seedPoint: P) => ({ elementId, kind: 'space' as const, name, seedPoint });

export function moduleOf(elements: ArchModule['elements'], id = 'test/ground'): ArchModule {
	return {
		schemaVersion: '2.0.0', moduleId: id, revision: 1,
		transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], materials: [], elements
	};
}

/** G1: four centre walls sharing endpoints. */
export const g1 = () => moduleOf([
	wall('w1', [[0, 0], [4, 0]]), wall('w2', [[4, 0], [4, 3]]), wall('w3', [[4, 3], [0, 3]]), wall('w4', [[0, 3], [0, 0]])
]);
/** G2: the same room as one closed wall. */
export const g2 = () => moduleOf([wall('loop', room, { closed: true })]);
/** G2 variants: reversed (clockwise) and rotated start of the same closed centre wall. */
export const g2Clockwise = () => moduleOf([wall('loop', [[0, 0], [0, 3], [4, 3], [4, 0]], { closed: true })]);
export const g2Rotated = () => moduleOf([wall('loop', [[4, 3], [0, 3], [0, 0], [4, 0]], { closed: true })]);
/** G3: `side:"right"` CCW inner path + space seed. */
export const g3 = () => moduleOf([wall('shell', room, { closed: true, side: 'right' }), space('sp', 'Room', [2, 1.5])]);
/** G4: G1 + partition and two seeds. */
export const g4 = () => moduleOf([
	...g1().elements, wall('part', [[2, 0], [2, 3]]), space('sa', 'A', [1, 1.5]), space('sb', 'B', [3, 1.5])
]);
/** G5: G1 + both partitions and four seeds. */
export const g5 = () => moduleOf([
	...g1().elements, wall('pv', [[2, 0], [2, 3]]), wall('ph', [[0, 1.5], [4, 1.5]]),
	space('s1', 'SW', [1, 0.75]), space('s2', 'SE', [3, 0.75]), space('s3', 'NW', [1, 2.25]), space('s4', 'NE', [3, 2.25])
]);
/** G6: L with thickness 0.15 / 0.25. */
export const g6 = () => moduleOf([wall('a', [[0, 0], [4, 0]]), wall('b', [[4, 0], [4, 3]], { thickness: 0.25 })]);
/** G7: acute corner of `degrees` between two centre walls from the origin. */
export const g7 = (degrees = 30) => moduleOf([
	wall('a', [[0, 0], [4, 0]]),
	wall('b', [[0, 0], [4 * Math.cos((degrees * Math.PI) / 180), 4 * Math.sin((degrees * Math.PI) / 180)]])
]);
/** G8: G3 + door (along 1.0, w 0.9, h 2.1) and window (along 2.5, w 1.0, h 1.2, sill 0.9) on the south wall. */
export const g8 = () => moduleOf([
	...g3().elements, opening('door', 'shell', 1.0, 0.9, 2.1, 0, 'door'), opening('win', 'shell', 2.5, 1.0, 1.2, 0.9, 'window')
]);
/** G9: north wall shortened by 0.02 at its east end (a gap between north and east walls). */
export const g9 = () => moduleOf([
	wall('w1', [[0, 0], [4, 0]]), wall('w2', [[4, 0], [4, 3]]), wall('w3', [[3.98, 3], [0, 3]]), wall('w4', [[0, 3], [0, 0]]),
	space('sp', 'Gap room', [2, 1.5])
]);
export { opening, space };
