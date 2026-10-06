import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const harnessRoot = path.dirname(fileURLToPath(import.meta.url));
const editorRoot = path.resolve(harnessRoot, '../../..');

export default defineConfig({
	root: harnessRoot,
	base: '/',
	resolve: {
		alias: [
			{ find: '@sibambo/e4-import/bomc-loader', replacement: path.join(editorRoot, 'packages/e4-import/src/bomc-loader.ts') },
			{ find: '@sibambo/e4-import/worker-transfer', replacement: path.join(editorRoot, 'packages/e4-import/src/worker-transfer.ts') },
			{ find: '@sibambo/e4-import', replacement: path.join(editorRoot, 'packages/e4-import/src/index.ts') },
			{ find: '@sibambo/scene-runtime/types', replacement: path.join(editorRoot, 'packages/scene-runtime/src/prepared-types.ts') },
			{ find: '@sibambo/scene-runtime', replacement: path.join(editorRoot, 'packages/scene-runtime/src/index.ts') },
			{ find: '@sibambo/contracts/scene', replacement: path.join(editorRoot, 'packages/contracts/src/scene.ts') },
			{ find: '@sibambo/contracts', replacement: path.join(editorRoot, 'packages/contracts/src/index.ts') },
			{ find: '@sibambo/viewport', replacement: path.join(editorRoot, 'packages/viewport/src/index.ts') },
			{ find: '@sibambo/bomc-document/writer', replacement: path.join(editorRoot, 'packages/bomc-document/src/writer.ts') },
			{ find: '@sibambo/bomc-document/reader', replacement: path.join(editorRoot, 'packages/bomc-document/src/reader.ts') },
			{ find: '@sibambo/bomc-document/source-envelope', replacement: path.join(editorRoot, 'packages/bomc-document/src/source-envelope.ts') },
			{ find: '@sibambo/bomc-document/types', replacement: path.join(editorRoot, 'packages/bomc-document/src/types.ts') },
			{ find: '@sibambo/bomc-document', replacement: path.join(editorRoot, 'packages/bomc-document/src/index.ts') }
		]
	},
	server: { host: '127.0.0.1', port: 5201, strictPort: true, fs: { allow: [editorRoot, path.resolve(editorRoot, '..')] } }
});
