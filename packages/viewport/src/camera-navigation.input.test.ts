import { describe, expect, test } from 'bun:test';
import { MOUSE } from 'three';
import {
	applyNavigationShortcutToControls,
	handleNavigationShortcut,
	middleMouseAction,
	orbitControlsMouseAction,
	resolvePointerNavigationAction
} from './camera-navigation.js';

function keyInput(key: string, code: string, modifiers: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey'>> = {}) {
	let prevented = false;
	const event = {
		key,
		code,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		...modifiers,
		preventDefault: () => { prevented = true; }
	} as KeyboardEvent;
	return { event, wasPrevented: () => prevented };
}

describe('shared viewport navigation input policy', () => {
	test('routes H/P to pan and O/R/Space to orbit from keyboard events', () => {
		const cases = [
			['h', 'KeyH', 'pan'],
			['P', 'KeyP', 'pan'],
			['o', 'KeyO', 'orbit'],
			['R', 'KeyR', 'orbit'],
			[' ', 'Space', 'orbit']
		] as const;

		for (const [key, code, expected] of cases) {
			const { event, wasPrevented } = keyInput(key, code);
			const actions: string[] = [];
			expect(handleNavigationShortcut(event, (action) => actions.push(action))).toBe(true);
			expect(actions).toEqual([expected]);
			expect(wasPrevented()).toBe(true);
		}
	});

	test('leaves modified shortcuts, non-navigation keys, and rejected targets untouched', () => {
		for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
			const { event, wasPrevented } = keyInput('p', 'KeyP', modifiers);
			const actions: string[] = [];
			expect(handleNavigationShortcut(event, (action) => actions.push(action))).toBe(false);
			expect(actions).toEqual([]);
			expect(wasPrevented()).toBe(false);
		}

		const { event, wasPrevented } = keyInput('x', 'KeyX');
		expect(handleNavigationShortcut(event, () => { throw new Error('unexpected navigation action'); })).toBe(false);
		expect(handleNavigationShortcut(keyInput('h', 'KeyH').event, () => { throw new Error('rejected input should not navigate'); }, false)).toBe(false);
		expect(wasPrevented()).toBe(false);
	});

	test('shares middle, Shift+middle, and combined-button drag routing', () => {
		expect(resolvePointerNavigationAction(new Set([1]), false, 'orbit')).toBe('orbit');
		expect(resolvePointerNavigationAction(new Set([1]), true, 'orbit')).toBe('pan');
		expect(resolvePointerNavigationAction(new Set([0, 1]), false, 'orbit')).toBe('pan');
		expect(resolvePointerNavigationAction(new Set([0]), false, 'pan')).toBe('pan');
		expect(resolvePointerNavigationAction(new Set([2]), false, 'orbit')).toBeNull();
	});

	test('maps shared tools to OrbitControls while retaining its Shift+middle modifier branch', () => {
		expect(orbitControlsMouseAction('orbit')).toBe(MOUSE.ROTATE);
		expect(orbitControlsMouseAction('pan')).toBe(MOUSE.PAN);
		expect(middleMouseAction()).toBe(MOUSE.ROTATE);
	});

	test('applies H/P and orbit shortcuts to the actual primary-button mapping', () => {
		const controls = { mouseButtons: { LEFT: MOUSE.ROTATE } };
		const panInput = keyInput('h', 'KeyH');
		expect(applyNavigationShortcutToControls(panInput.event, controls)).toBe(true);
		expect(controls.mouseButtons.LEFT).toBe(MOUSE.PAN);
		expect(panInput.wasPrevented()).toBe(true);

		const orbitInput = keyInput('r', 'KeyR');
		expect(applyNavigationShortcutToControls(orbitInput.event, controls)).toBe(true);
		expect(controls.mouseButtons.LEFT).toBe(MOUSE.ROTATE);
	});
});
