import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
// @ts-expect-error The existing baseline exports this read-only helper from MJS without a declaration file.
import { readIsolationManifest } from '../loader-baseline-isolated.mjs';

const harnessRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(harnessRoot, '../../../..');
const editorRoot = path.join(workspaceRoot, 'sibambo-editor');
const manifestPath = path.join(editorRoot, 'tooling', 'performance', 'fixtures.json');
const worklogRoot = path.resolve(requireEnvironment('SIBAMBO_M2_WORKLOG'));
const attempt = requireEnvironment('SIBAMBO_M2_ATTEMPT');
if (!path.isAbsolute(process.env.SIBAMBO_M2_WORKLOG!)) throw new Error('SIBAMBO_M2_WORKLOG must be an absolute path.');
if (attempt !== '01' && attempt !== '02') throw new Error('SIBAMBO_M2_ATTEMPT must be 01 or 02.');
assertInside(workspaceRoot, worklogRoot);
assertInside(path.join(workspaceRoot, 'docs', 'worklogs', 'BOMC-MATERIALS-V2-001'), worklogRoot);
const manifestInfo = await readIsolationManifest(workspaceRoot, manifestPath);
const allowedFixtures = new Map<string, string>(manifestInfo.fixtures
	.filter((fixture: { id: string }) => ['S1-new', 'S2-new', 'I-new', 'Y-new'].includes(fixture.id))
	.map((fixture: { id: string; filePath: string }) => [fixture.id, fixture.filePath]));
if (allowedFixtures.size !== 4) throw new Error('The pinned manifest does not contain all four approved MATERIALS-v2 fixtures.');

const fixtureMiddleware: Plugin = {
	name: 'materials-v2-pinned-fixture-route',
	configureServer(server) {
		server.middlewares.use((request, response, next) => {
			const requestUrl = request.url || '';
			if (!requestUrl.startsWith('/__fixture__/')) return next();
			const fixtureId = requestUrl.slice('/__fixture__/'.length).split(/[?#]/, 1)[0];
			const filePath = allowedFixtures.get(fixtureId);
			if (request.method !== 'GET' || !filePath) {
				response.statusCode = 404;
				response.end('Not found');
				return;
			}
			response.statusCode = 200;
			response.setHeader('Content-Type', 'application/octet-stream');
			response.setHeader('Content-Length', String(statSync(filePath).size));
			createReadStream(filePath).on('error', () => {
				if (!response.headersSent) response.statusCode = 500;
				response.end('Fixture read failed');
			}).pipe(response);
		});
	}
};

export default defineConfig({
	root: harnessRoot,
	base: '/',
	plugins: [fixtureMiddleware],
	server: {
		host: '127.0.0.1', port: 5196, strictPort: true,
		fs: { allow: [workspaceRoot] }
	}
});

function requireEnvironment(name: string) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required for MATERIALS-v2 proof.`);
	return value;
}

function assertInside(root: string, target: string) {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Proof path must be a nested path inside ${root}.`);
	}
}
