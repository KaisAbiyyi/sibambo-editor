import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import appConfig from '../../apps/editor/vite.config';
import { readAcceleratedContext } from './accelerated-proof';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const context = readAcceleratedContext('current-cold');
if (!context || 'discoveryOnly' in context) throw new Error('Current-cold Vite requires a claimed accelerated ticket.');
if (!context.cacheDir) throw new Error('Current-cold Vite requires the claimed owned cache directory.');

export default mergeConfig(appConfig, {
	root: path.join(repoRoot, 'apps', 'editor'),
	cacheDir: context.cacheDir,
	server: { host: '127.0.0.1', port: 5198, strictPort: true }
});
