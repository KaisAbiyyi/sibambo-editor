import { sveltekit } from '@sveltejs/kit/vite';
import { getAppBuildIdentity } from '../../tooling/research/build-identity';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const identity = getAppBuildIdentity({ appName: 'editor', appRoot: process.cwd(), repoRoot, packageNames: ['@sibambo/contracts', '@sibambo/e4-import', '@sibambo/provenance', '@sibambo/scene-runtime', '@sibambo/viewport'] });

export default defineConfig({
	plugins: [sveltekit()],
	define: { __SIBAMBO_APP_BUILD__: JSON.stringify(identity) },
	optimizeDeps: {
		include: [
			'three',
			'three/webgpu',
			'three/addons/postprocessing/EffectComposer.js',
			'three/addons/postprocessing/OutputPass.js',
			'three/addons/postprocessing/RenderPass.js',
			'three/addons/postprocessing/SSAOPass.js',
			'three/examples/jsm/controls/OrbitControls.js',
			'@sibambo/e4-import > @jsquash/png/decode.js',
			'@sibambo/e4-import > @jsquash/png/encode.js',
			'@sibambo/e4-import > @jsquash/webp/decode.js'
		],
		holdUntilCrawlEnd: true
	},
	server: { host: '127.0.0.1', port: 5175, strictPort: true }
});
