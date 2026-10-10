import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const source = (relativePath: string) => path.join(repoRoot, relativePath);

export default defineConfig({
	root: here,
	resolve: {
		alias: [
			{ find: '@sibambo/bomc-document/document', replacement: source('packages/bomc-document/src/document.ts') },
			{ find: '@sibambo/bomc-document/reader', replacement: source('packages/bomc-document/src/reader.ts') },
			{ find: '@sibambo/bomc-document/writer', replacement: source('packages/bomc-document/src/writer.ts') },
			{ find: '@sibambo/bomc-document/types', replacement: source('packages/bomc-document/src/types.ts') },
			{ find: '@sibambo/bomc-document', replacement: source('packages/bomc-document/src/index.ts') },
			{ find: '@sibambo/contracts/scene', replacement: source('packages/contracts/src/scene.ts') },
			{ find: '@sibambo/contracts', replacement: source('packages/contracts/src/index.ts') },
			{ find: '@sibambo/scene-runtime/types', replacement: source('packages/scene-runtime/src/prepared-types.ts') },
			{ find: '@sibambo/scene-runtime', replacement: source('packages/scene-runtime/src/index.ts') },
			{ find: '@sibambo/viewport/material-state', replacement: source('packages/viewport/src/material-state.ts') },
			{ find: '@sibambo/viewport', replacement: source('packages/viewport/src/index.ts') }
		]
	},
	optimizeDeps: {
		include: [
			'three',
			'three/addons/postprocessing/EffectComposer.js',
			'three/addons/postprocessing/OutputPass.js',
			'three/addons/postprocessing/RenderPass.js',
			'three/addons/postprocessing/SSAOPass.js',
			'three/examples/jsm/controls/OrbitControls.js'
		]
	},
	server: { host: '127.0.0.1', port: 5206, strictPort: true, fs: { allow: [repoRoot] } }
});
