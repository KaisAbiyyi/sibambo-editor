import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { callbackUrl, discovery, localDemo, oidcConfig, setFlow, startLocalSession, token } from '$lib/server/mcp-bff';
import { pkceChallenge } from '$lib/server/mcp-oidc';

export const GET: RequestHandler = async (event) => {
  if (localDemo()) { startLocalSession(event); throw redirect(303, '/?mcp=connected'); }
  const { issuer, clientId, audience } = oidcConfig();
  const metadata = await discovery(issuer);
  const flow = { state: token(), nonce: token(), verifier: token(48), created: Date.now(), redirectUri: callbackUrl(event) };
  setFlow(event, flow);
  const url = new URL(metadata.authorize);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', flow.redirectUri);
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('audience', audience);
  url.searchParams.set('state', flow.state);
  url.searchParams.set('nonce', flow.nonce);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', pkceChallenge(flow.verifier));
  throw redirect(302, url.toString());
};
