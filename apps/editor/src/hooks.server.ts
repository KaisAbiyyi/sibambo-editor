import type { Handle } from '@sveltejs/kit';

/** Applies to the owner page and BFF responses; CSP nonces/hashes belong to SvelteKit. */
export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
};
