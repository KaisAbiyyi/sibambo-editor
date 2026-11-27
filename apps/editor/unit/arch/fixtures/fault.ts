/**
 * Fault injection for the geometry kernel (test-only).
 *
 * `faultyLoader(state)` loads a FRESH manifold-3d instance and, after its `setup()`, wraps every method of the real
 * instance prototypes of `Manifold` and `CrossSection` (embind instances do not inherit from the `Manifold.prototype`
 * that is visible from outside, and `setup()` itself adds methods such as `warpBatch`) plus the static functions, so that
 *  - the `failAt`-th OUTERMOST wrapped call throws `InjectedFault` (calls the library makes on itself while serving
 *    another call are not counted: failing inside its glue would strand its own temporaries, which is not our leak);
 *  - every Manifold/CrossSection an outermost call returns is registered as live, and `delete()` unregisters it.
 * The live set is the TRUE leak count, independent of the kernel's own bookkeeping (`Kernel.liveCount`).
 */
import Module from 'manifold-3d';

export class InjectedFault extends Error {
	constructor(readonly call: number, readonly method: string) {
		super(`injected fault at wrapped call ${call} (${method})`);
	}
}

export type FaultState = { failAt: number | null; calls: number; live: Set<object>; log: string[] };
export const newFaultState = (): FaultState => ({ failAt: null, calls: 0, live: new Set(), log: [] });

const NOT_COUNTED = new Set(['constructor', 'delete', 'deleteLater', 'isDeleted', 'isAliasOf', 'clone']);
const STATIC_SKIP = new Set(['length', 'name', 'prototype', 'extend', 'implement']);

export function faultyLoader(state: FaultState, hooks: { beforeSetup?: () => void } = {}) {
	return async () => {
		const wasm: any = await Module();
		let depth = 0;
		const instrument = () => {
			const sampleManifold = wasm.Manifold.cube(1);
			const sampleSection = wasm.CrossSection.ofPolygons([[[0, 0], [1, 0], [1, 1]]]);
			const protos: object[] = [Object.getPrototypeOf(sampleManifold), Object.getPrototypeOf(sampleSection)];
			let base: any = protos[0];
			while (base && !Object.prototype.hasOwnProperty.call(base, 'delete')) base = Object.getPrototypeOf(base);
			const deleter = base.delete as () => void;
			sampleManifold.delete();
			sampleSection.delete();

			const isHandle = (value: unknown) => !!value && typeof value === 'object' && protos.some((p) => p.isPrototypeOf(value as object));
			const register = (value: unknown) => {
				if (Array.isArray(value)) value.forEach(register);
				else if (isHandle(value)) state.live.add(value as object);
				return value;
			};
			const wrap = (label: string, fn: (...args: unknown[]) => unknown) =>
				function (this: unknown, ...args: unknown[]) {
					if (depth > 0) return fn.apply(this, args);
					state.calls++;
					if (state.failAt !== null && state.calls === state.failAt) {
						state.log.push(label);
						throw new InjectedFault(state.calls, label);
					}
					depth++;
					try {
						return register(fn.apply(this, args));
					} finally {
						depth--;
					}
				};
			for (const C of [wasm.Manifold, wasm.CrossSection] as any[]) {
				for (const name of Object.getOwnPropertyNames(C)) {
					if (NOT_COUNTED.has(name) || STATIC_SKIP.has(name) || typeof C[name] !== 'function') continue;
					C[name] = wrap(`${C.name}.${name}`, (C[name] as (...args: unknown[]) => unknown).bind(C));
				}
			}
			for (const proto of protos as any[]) {
				for (const name of Object.getOwnPropertyNames(proto)) {
					if (NOT_COUNTED.has(name) || typeof proto[name] !== 'function') continue;
					proto[name] = wrap(`${proto.constructor.name}#${name}`, proto[name] as (...args: unknown[]) => unknown);
				}
			}
			base.delete = function (this: object) {
				state.live.delete(this);
				return deleter.call(this);
			};
		};
		const setup = wasm.setup.bind(wasm);
		wasm.setup = () => {
			hooks.beforeSetup?.();
			const result = setup();
			instrument();
			return result;
		};
		return wasm;
	};
}
