import type { Handle } from '@sveltejs/kit';

/** Applies to the owner page and BFF responses; CSP nonces/hashes belong to SvelteKit. */
export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  // Preserve same-origin POST Origin headers for the strict CSRF check; suppress cross-origin referrers.
  response.headers.set('referrer-policy', 'same-origin');
  response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
};
