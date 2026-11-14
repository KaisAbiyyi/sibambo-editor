import node from '@sveltejs/adapter-node';
import vercel from '@sveltejs/adapter-vercel';

const adapter = process.env.VERCEL ? vercel : node;

// Build-time allowlist only. No caller URL, wildcard, ticket or bearer belongs in CSP.
const connectSources = ['self'];
if (process.env.SE05_DRAFT_WS_ORIGIN) {
	let origin;
	try {
		const url = new URL(process.env.SE05_DRAFT_WS_ORIGIN);
		const loopbackWs = process.env.SIBAMBO_LOCAL_DEMO === '1' && url.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
		if ((url.protocol !== 'wss:' && !loopbackWs) || !url.hostname || url.hostname.includes('*') ||
			url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
			!([url.origin, url.origin + '/'].includes(process.env.SE05_DRAFT_WS_ORIGIN))) throw Error();
		origin = url.origin;
	} catch {
		throw new Error('SE05_DRAFT_WS_ORIGIN must be one exact WSS origin');
	}
	connectSources.push(origin);
}

export default {
	kit: {
		adapter: adapter(),
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				// Existing PNG/WebP codecs compile WASM; JavaScript eval remains forbidden.
				'script-src': ['self', 'wasm-unsafe-eval'],
				// Existing Svelte transitions and viewport style attributes require inline styles.
				'style-src': ['self', 'unsafe-inline'],
				'img-src': ['self', 'blob:', 'data:'],
				'worker-src': ['self'],
				'connect-src': connectSources,
				'frame-ancestors': ['none'],
				'object-src': ['none'],
				'base-uri': ['self']
			}
		}
	}
};
