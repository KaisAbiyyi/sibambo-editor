import { describe, expect, it } from 'bun:test';
import type { SceneProfile } from '@sibambo/contracts';
import { SceneVisibilityIndex } from '../../viewport/src/scene-visibility';
import { resolveBomcSceneNodeVisibility } from './bomc-loader';

describe('resolveBomcSceneNodeVisibility', () => {
	it('keeps a base-hidden node hidden when the authored scene has no node override', () => {
		const hidden = resolveBomcSceneNodeVisibility([{ visible: false }], [], []);
		const compiled = compile([0], hidden, [0], []);
		expect(hidden).toEqual([0]);
		// The cutter's tag is explicitly visible, but its base-hidden instance remains hidden.
		expect(compiled).toEqual([0]);
	});

	it('allows an authored visible override to reveal a base-hidden node', () => {
		const hidden = resolveBomcSceneNodeVisibility([{ visible: false }], [0], []);
		expect(hidden).toEqual([]);
		expect(compile([0], hidden, [0], [])).toEqual([1]);
	});

	it('keeps explicit hidden authoritative when hidden and visible lists conflict', () => {
		const hidden = resolveBomcSceneNodeVisibility([{ visible: true }], [0], [0]);
		expect(hidden).toEqual([0]);
		expect(compile([0], hidden, [0], [])).toEqual([0]);
	});

	it('deduplicates and sorts the effective hidden set without mutating source arrays', () => {
		const instances = Object.freeze([{ visible: false }, { visible: true }, { visible: false }, { visible: true }]);
		const visible = Object.freeze([0, 0]);
		const hidden = Object.freeze([3, 1, 3]);
		const before = { instances: structuredClone(instances), visible: [...visible], hidden: [...hidden] };
		const effective = resolveBomcSceneNodeVisibility(instances, visible, hidden);
		expect(effective).toEqual([1, 2, 3]);
		expect({ instances, visible: [...visible], hidden: [...hidden] }).toEqual(before);
	});

	it('does not let an explicit child reveal defeat a hidden ancestor or hidden tag', () => {
		const hidden = resolveBomcSceneNodeVisibility([{ visible: true }, { visible: false }, { visible: true }], [2], []);
		expect(compile([0, 1, 2], hidden, [0], [])).toEqual([1, 0, 0]);
		expect(compile([0], [], [], [0])).toEqual([0]);
	});
});

function compile(instanceIndices: number[], hiddenNodeIndices: number[], visibleTagIndices: number[], hiddenTagIndices: number[]) {
	const profile = {
		visibility: { visibleNodeIndices: [], hiddenNodeIndices, visibleTagIndices, hiddenTagIndices },
		storesTagVisibility: true
	} as unknown as SceneProfile;
	const hierarchy = {
		parentIndices: new Int32Array(instanceIndices.map((_, index) => index - 1)),
		instanceIndices: new Uint32Array(instanceIndices),
		tagIndices: new Uint32Array(instanceIndices.map(() => 0))
	};
	return [...new SceneVisibilityIndex(profile).compileOccurrenceVisibility(hierarchy as any)];
}
