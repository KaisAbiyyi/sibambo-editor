import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { callbackUrl, clearFlow, discovery, getFlow, oidcConfig, setSession, token } from '$lib/server/mcp-bff';
import { verifyIdToken } from '$lib/server/mcp-oidc';

export const GET: RequestHandler = async (event) => {
  const flow = getFlow(event);
  clearFlow(event); // one-shot state, including failures
  if (!flow || event.url.searchParams.get('state') !== flow.state ||
      event.url.searchParams.has('error') || flow.redirectUri !== callbackUrl(event)) throw error(403, 'Invalid or expired OAuth transaction');
  const code = event.url.searchParams.get('code');
  if (!code || code.length > 2048) throw error(400, 'Missing authorization code');
  const { issuer, clientId, clientSecret } = oidcConfig();
  const metadata = await discovery(issuer);
  const tokenResponse = await fetch(metadata.token, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(7000),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: flow.redirectUri,
      client_id: clientId, client_secret: clientSecret, code_verifier: flow.verifier })
  });
  if (!tokenResponse.ok) throw error(401, 'OIDC code exchange rejected');
  const data = await tokenResponse.json() as Record<string, unknown>;
  if (typeof data.id_token !== 'string' || typeof data.access_token !== 'string' ||
      data.token_type !== 'Bearer' || typeof data.expires_in !== 'number' || data.expires_in <= 0) throw error(401, 'Invalid OIDC token response');
  const keysResponse = await fetch(metadata.jwks, { signal: AbortSignal.timeout(7000) });
  if (!keysResponse.ok) throw error(503, 'JWKS unavailable');
  const jwks = await keysResponse.json();
  let claims;
  try { claims = await verifyIdToken(data.id_token, issuer, clientId, flow.nonce, jwks); }
  catch { throw error(401, 'OIDC identity verification failed'); }
  setSession(event, { sub: claims.sub, issuer, accessToken: data.access_token,
    exp: Math.min(claims.exp, Math.floor(Date.now() / 1000) + Math.min(data.expires_in, 3600)), csrf: token() });
  throw redirect(303, '/?mcp=connected');
};
