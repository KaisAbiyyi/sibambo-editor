import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type BomcProfile = 'EXACT' | 'RESEARCH' | 'VISUAL';
export type BomcProfileFixturePin = {
	id: string;
	model: string;
	folder: string;
	profile: BomcProfile;
	bytes: number;
	sha256: string;
	fileName: string;
};
export type ResolvedBomcProfileFixture = BomcProfileFixturePin & { path: string; realPath: string };

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const workspaceRoot = path.resolve(editorRoot, '..');
const fixtureRoot = path.join(workspaceRoot, 'skps', 'model-eval-exports');

const models = [
	{
		model: 'PROJECT SBOOST 1', folder: 'PROJECTSBOOST1__SIBAMBO-BOMC-v1.2.0__ALL-20261006-6132-1eq7jm',
		rows: [
			['EXACT', 2428770, 'b8d79c3ef2d0a94673c4d984d3b92d8576c6b39f60e972d6be1eaabf2dc91e74'],
			['RESEARCH', 1505018, '2134a67d245d1d977deb9ab2140fb728266dd83770420f678591ecd3976b5c58'],
			['VISUAL', 1430723, 'ce7a1671709389bac7b58ead93f91cca52964ce1daf5361da163bbb273470d2c']
		]
	},
	{
		model: 'PROJECT SBOOST 2', folder: 'PROJECTSBOOST2__SIBAMBO-BOMC-v1.2.0__ALL-20261006-5108-7ggxs1',
		rows: [
			['EXACT', 2319634, '7d84c2d96dd34913f0e3662ab6ca25579eb8c62397d4715279a9268628f5acd2'],
			['RESEARCH', 1362338, 'd12ba595a757a91c9b513356428dff7e45eaaac72b4e470a442aabc39d4821ea'],
			['VISUAL', 1288147, '6fb28ef5ec27074b3496a9dbac1e5f8fca08595e602946f1918eb713c01c9f4b']
		]
	},
	{
		model: 'presentation20', folder: 'presentation20__SIBAMBO-BOMC-v1.2.0__ALL-20261006-19324-10d2jz',
		rows: [
			['EXACT', 1157186, '3e3dc9c78b23f1fd4b89117db0b0143011b149f53ed31e5a4fa2fa8f5dddd63f'],
			['RESEARCH', 1164355, 'b0c8cef70dd5c7c2dc7a881a2ac6a69b32b6e2a8775812f089e3da87528a1925'],
			['VISUAL', 1107148, '157e5f1a3092cd68f3d04be85e094064172f5084643021ef870f7a02e782d63b']
		]
	},
	{
		model: 'RUMAH L', folder: 'RUMAHL__SIBAMBO-BOMC-v1.2.0__ALL-20261006-20412-s09fod',
		rows: [
			['EXACT', 18759206, 'dc6f6beaf3a241c2459f22eff516d0a532e072cd0e10cea1d73b5c27919eff4a'],
			['RESEARCH', 16099046, '3ae28cac8f6ddfad9821d13834d4b6855868ea8976da0176408e4ad36908d9ec'],
			['VISUAL', 14039598, 'd3e458d0859b484ec02ca48e9ed1388f78d73003cec0dbf661894ec3d9f3271b']
		]
	}
] as const;

export const BOMC_PROFILE_FIXTURE_PINS: BomcProfileFixturePin[] = models.flatMap(({ model, folder, rows }) => rows.map(([profile, bytes, sha256]) => ({
	id: `${model}:${profile}`,
	model,
	folder,
	profile: profile as BomcProfile,
	bytes,
	sha256,
	fileName: `${model}__SIBAMBO-BOMC-v1.2.0__${profile}.bomc`
})));

export function resolveBomcProfileFixture(pin: BomcProfileFixturePin): ResolvedBomcProfileFixture {
	if (!BOMC_PROFILE_FIXTURE_PINS.some((candidate) => candidate.id === pin.id && candidate.sha256 === pin.sha256 && candidate.bytes === pin.bytes)) {
		throw new Error(`Unrecognized BOMC profile fixture pin: ${pin.id}`);
	}
	const expectedPath = path.resolve(fixtureRoot, pin.folder, pin.fileName);
	assertInside(fixtureRoot, expectedPath);
	const realPath = realpathSync(expectedPath);
	assertInside(realpathSync(fixtureRoot), realPath);
	const stat = statSync(realPath);
	if (!stat.isFile() || stat.size !== pin.bytes) throw new Error(`BOMC profile fixture byte length differs from its pin: ${pin.id}`);
	const bytes = readFileSync(realPath);
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	if (sha256 !== pin.sha256) throw new Error(`BOMC profile fixture SHA-256 differs from its pin: ${pin.id}`);
	return { ...pin, path: expectedPath, realPath };
}

export function resolveAllBomcProfileFixtures(): ResolvedBomcProfileFixture[] {
	return BOMC_PROFILE_FIXTURE_PINS.map(resolveBomcProfileFixture);
}

function assertInside(root: string, target: string) {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`BOMC profile fixture path escapes its pinned export tree: ${target}`);
	}
}
