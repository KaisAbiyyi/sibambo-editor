import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
// @ts-expect-error This accepted helper is an MJS-only module without declarations.
import { readIsolationManifest } from '../loader-baseline-isolated.mjs';
import { readProofTicket } from '../../testing/proof-run-contract';

const harnessRoot = path.dirname(fileURLToPath(import.meta.url));
const editorRoot = path.resolve(harnessRoot, '../../..');
const workspaceRoot = path.resolve(editorRoot, '..');
readProofTicket('mirror');

const manifestPath = path.join(editorRoot, 'tooling', 'performance', 'fixtures.json');
const manifestInfo = await readIsolationManifest(workspaceRoot, manifestPath);
const approvedIds = ['S1-new', 'S2-new', 'S2-jcm'];
const allowedFixtures = new Map<string, { filePath: string; bytes: number; sha256: string }>(manifestInfo.fixtures
	.filter((fixture: { id: string }) => approvedIds.includes(fixture.id))
	.map((fixture: { id: string; filePath: string; bytes: number; sha256: string }) => [fixture.id, fixture]));
if (allowedFixtures.size !== approvedIds.length) throw new Error('The pinned manifest must contain S1-new, S2-new and S2-jcm.');

const pinnedFixtureMiddleware: Plugin = {
	name: 'viewer-recovery-pinned-fixture-route',
	configureServer(server) {
		server.middlewares.use((request, response, next) => {
			const requestUrl = request.url || '';
			if (!requestUrl.startsWith('/__fixture__/')) return next();
			const fixtureId = requestUrl.slice('/__fixture__/'.length).split(/[?#]/, 1)[0];
			const fixture = allowedFixtures.get(fixtureId);
			if (request.method !== 'GET' || !fixture) {
				response.statusCode = 404;
				response.end('Not found');
				return;
			}
			response.statusCode = 200;
			response.setHeader('Content-Type', 'application/octet-stream');
			response.setHeader('Content-Length', String(fixture.bytes));
			response.setHeader('Cache-Control', 'no-store');
			createReadStream(fixture.filePath).on('error', () => {
				if (!response.headersSent) response.statusCode = 500;
				response.end('Fixture read failed');
			}).pipe(response);
		});
	}
};

export default defineConfig({
	root: harnessRoot,
	base: '/',
	plugins: [pinnedFixtureMiddleware],
	resolve: {
		alias: [
			{ find: '@sibambo/e4-import/bomc-loader', replacement: path.join(editorRoot, 'packages/e4-import/src/bomc-loader.ts') },
			{ find: '@sibambo/e4-import/worker-transfer', replacement: path.join(editorRoot, 'packages/e4-import/src/worker-transfer.ts') },
			{ find: '@sibambo/e4-import', replacement: path.join(editorRoot, 'packages/e4-import/src/index.ts') },
			{ find: '@sibambo/scene-runtime/types', replacement: path.join(editorRoot, 'packages/scene-runtime/src/prepared-types.ts') },
			{ find: '@sibambo/scene-runtime', replacement: path.join(editorRoot, 'packages/scene-runtime/src/index.ts') },
			{ find: '@sibambo/contracts/scene', replacement: path.join(editorRoot, 'packages/contracts/src/scene.ts') },
			{ find: '@sibambo/contracts', replacement: path.join(editorRoot, 'packages/contracts/src/index.ts') },
			{ find: '@sibambo/viewport', replacement: path.join(editorRoot, 'packages/viewport/src/index.ts') }
		]
	},
	server: { host: '127.0.0.1', port: 5197, strictPort: true, fs: { allow: [workspaceRoot] } }
});
