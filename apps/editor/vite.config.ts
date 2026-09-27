import { sveltekit } from '@sveltejs/kit/vite';
import { getAppBuildIdentity } from '../../tooling/research/build-identity';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const identity = getAppBuildIdentity({ appName: 'editor', appRoot: process.cwd(), repoRoot, packageNames: ['@sibambo/contracts', '@sibambo/e4-import', '@sibambo/provenance', '@sibambo/scene-runtime', '@sibambo/viewport'] });

export default defineConfig({
	plugins: [sveltekit()],
	define: { __SIBAMBO_APP_BUILD__: JSON.stringify(identity) },
	server: { host: '127.0.0.1', port: 5175, strictPort: true }
});
