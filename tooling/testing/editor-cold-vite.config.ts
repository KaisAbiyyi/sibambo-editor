import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import appConfig from '../../apps/editor/vite.config';
import { readProofTicket } from './proof-run-contract';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/editor');
const proof = readProofTicket('cold');
const cacheDir = proof.cacheDir;
if (!cacheDir) throw new Error('Cold Vite requires the immutable ticket cache path.');

export default mergeConfig(appConfig, {
	root: editorRoot,
	cacheDir,
	server: { host: '127.0.0.1', port: 5198, strictPort: true }
});
