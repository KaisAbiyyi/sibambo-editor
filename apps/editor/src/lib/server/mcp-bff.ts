/**
 * SE-04 v1 BFF contract. The separate SE-03 service MUST enforce owner/project
 * authorization and explicit OAuth-bound grants. This proxy never asserts a grant.
 */
import { dev } from '$app/environment';
import { error, json, type RequestEvent } from '@sveltejs/kit';
import { sameIssuerEndpoint, safeIssuer, seal, unseal, token } from './mcp-oidc';

const SESSION = '__Host-se04_session';
const FLOW = '__Host-se04_oidc';
const browserCookie = { path: '/', httpOnly: true, secure: true, sameSite: 'lax' as const };
export type OwnerSession = { sub: string; accessToken: string; exp: number; csrf: string; issuer: string };
export type LoginFlow = { state: string; nonce: string; verifier: string; created: number; redirectUri: string };
export type GrantScope = 'read' | 'write';
export type OwnerRequest = { action: 'create' | 'withdraw' | 'mark-read' | 'mark-addressed'; projectId: string; requestId?: string; body?: string; moduleIds?: string[] };
export const noStore = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
export const respond = (value: unknown, status = 200) => json(value, { status, headers: noStore });

function key(): Buffer {
  const secret = process.env.SE04_SESSION_KEY ?? '';
  const decoded = Buffer.from(secret, 'base64url');
  if (decoded.length !== 32) throw error(503, 'MCP session is not configured');
  return decoded;
}
export function oidcConfig() {
  const issuer = process.env.SE04_AUTH_ISSUER ?? '';
  const clientId = process.env.SE04_AUTH_CLIENT_ID ?? '';
  const clientSecret = process.env.SE04_AUTH_CLIENT_SECRET ?? '';
  const audience = process.env.SE04_AUTH_AUDIENCE ?? '';
  try { safeIssuer(issuer); } catch { throw error(503, 'OIDC issuer is not configured'); }
  if (!clientId || !clientSecret || !audience || clientId.length > 256) throw error(503, 'OIDC BFF client is not configured');
  key();
  return { issuer, clientId, clientSecret, audience };
}
export function configured(): boolean {
  try { oidcConfig(); return true; } catch { return false; }
}
export function callbackUrl(event: RequestEvent): string {
  const origin = process.env.SE04_PUBLIC_ORIGIN ?? event.url.origin;
  if (!dev && !origin.startsWith('https://')) throw error(503, 'HTTPS origin required');
  const url = new URL(origin);
  if (url.pathname !== '/' || url.search || url.hash) throw error(503, 'Invalid public origin');
  return new URL('/api/mcp/callback', url).toString();
}
export async function discovery(issuer: string) {
  const path = issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
  const response = await fetch(path, { signal: AbortSignal.timeout(7000), headers: { accept: 'application/json' } });
  if (!response.ok) throw error(503, 'OIDC discovery unavailable');
  const obj = await response.json() as Record<string, unknown>;
  if (obj.issuer !== issuer || typeof obj.authorization_endpoint !== 'string' || typeof obj.token_endpoint !== 'string' || typeof obj.jwks_uri !== 'string')
    throw error(503, 'OIDC metadata mismatch');
  return {
    authorize: sameIssuerEndpoint(issuer, obj.authorization_endpoint),
    token: sameIssuerEndpoint(issuer, obj.token_endpoint),
    jwks: sameIssuerEndpoint(issuer, obj.jwks_uri)
  };
}
export function setFlow(event: RequestEvent, flow: LoginFlow) {
  event.cookies.set(FLOW, seal(flow, key()), { ...browserCookie, maxAge: 300 });
}
export function getFlow(event: RequestEvent): LoginFlow | null {
  const v = unseal<LoginFlow>(event.cookies.get(FLOW), key());
  return v && Date.now() - v.created < 300000 && v.created <= Date.now() + 5000 ? v : null;
}
export function clearFlow(event: RequestEvent) { event.cookies.delete(FLOW, { path: '/' }); }
export function setSession(event: RequestEvent, session: OwnerSession) {
  const sealed = seal(session, key());
  if (sealed.length > 3900) throw error(503, 'OIDC token exceeds cookie transport budget');
  event.cookies.set(SESSION, sealed, { ...browserCookie, maxAge: Math.min(3600, Math.max(1, session.exp - Math.floor(Date.now() / 1000))) });
}
export function clearSession(event: RequestEvent) { event.cookies.delete(SESSION, { path: '/' }); }
export function getSession(event: RequestEvent): OwnerSession | null {
  if (!configured()) return null;
  const v = unseal<OwnerSession>(event.cookies.get(SESSION), key());
  if (!v || !v.sub || !v.csrf || typeof v.accessToken !== 'string' || v.accessToken.length > 12000 ||
      v.issuer !== oidcConfig().issuer || v.exp <= Date.now() / 1000) return null;
  return v;
}
export function requireSession(event: RequestEvent): OwnerSession {
  const s = getSession(event);
  if (!s) throw error(401, 'Owner sign-in required');
  return s;
}
export function csrf(event: RequestEvent): OwnerSession {
  const s = requireSession(event);
  if (event.request.headers.get('origin') !== event.url.origin ||
      event.request.headers.get('x-se04-csrf') !== s.csrf) throw error(403, 'Invalid origin or CSRF');
  return s;
}
export function projectId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw error(400, 'Invalid project ID');
  return value;
}
export async function requestJson(event: RequestEvent): Promise<Record<string, unknown>> {
  if (Number(event.request.headers.get('content-length') ?? 0) > 8192) throw error(413, 'Request too large');
  const data = await event.request.text();
  if (data.length > 8192) throw error(413, 'Request too large');
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { throw error(400, 'Expected JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw error(400, 'Invalid request');
  return parsed as Record<string, unknown>;
}
function serviceBase(): string {
  const raw = process.env.SE04_SERVICE_BASE_URL ?? '';
  try {
    const value = new URL(raw);
    const isLoopback = value.hostname === '127.0.0.1' || value.hostname === 'localhost';
    if ((value.protocol !== 'https:' && !(dev && isLoopback && value.protocol === 'http:')) ||
        value.username || value.password || value.search || value.hash || value.pathname !== '/') throw Error();
    return value.origin;
  } catch { throw error(503, 'SE-03 service contract is not deployed'); }
}
export async function service(event: RequestEvent, session: OwnerSession, project: string, endpoint: string, method: 'GET' | 'POST', body?: unknown) {
  const safeProject = projectId(project);
  const url = serviceBase() + '/v1/projects/' + encodeURIComponent(safeProject) + '/owner/mcp' + endpoint;
  const r = await fetch(url, {
    method, redirect: 'manual', signal: AbortSignal.timeout(8000),
    headers: { authorization: 'Bearer ' + session.accessToken, accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    body: method === 'POST' ? JSON.stringify(body) : undefined
  }).catch(() => { throw error(503, 'MCP service unavailable'); });
  if (r.status === 401 || r.status === 403) throw error(r.status, 'Owner or project authorization denied');
  if (!r.ok) throw error(502, 'MCP service rejected request');
  const limit = endpoint === '/ticket' ? 32768 : 512 * 1024; // 50 × 4 KiB text plus bounded module IDs/typed metadata
  const reader = r.body?.getReader(), chunks: Uint8Array[] = []; let length = 0;
  if (reader) while (true) {
    const next = await reader.read(); if (next.done) break;
    length += next.value.byteLength;
    if (length > limit) { await reader.cancel(); throw error(502, 'MCP service response too large'); }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const raw = new TextDecoder().decode(bytes);
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw error(502, 'Invalid service response'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || (data as Record<string, unknown>).contract !== 'se04-owner-mcp-v1')
    throw error(502, 'Unsupported SE-03 MCP contract');
  const envelope = data as Record<string, unknown>;
  // P1-B: every service response is bound to the project that was requested. The BFF never
  // re-scopes an owner view: missing, non-string, malformed or different IDs fail closed (502)
  // before anything reaches the browser.
  if (typeof envelope.projectId !== 'string' || envelope.projectId !== safeProject)
    throw error(502, 'MCP service response project scope mismatch');
  return envelope;
}
/** Short-lived WebSocket tickets: generous token alphabet, bounded size, never URL-shaped. */
export const TICKET_PATTERN = /^[A-Za-z0-9._~-]{32,512}$/;
export const TICKET_MAX_TTL_MS = 30_000;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/**
 * P1-A: dedicated serializer for POST /api/mcp/ticket. Returns only the contract marker,
 * the requested project, the single-use ticket and its expiry. The ticket is request-scoped:
 * it is never logged, cached (no-store), set as a cookie or kept in module state; SE-03 is the
 * single-use enforcer. `service()` has already proven the project scope.
 */
export function ticketResponse(data: Record<string, unknown>, owner: OwnerSession, project: string, now = Date.now()) {
  const { ticket, ticketExpiresAt } = data;
  if (typeof ticket !== 'string' || !TICKET_PATTERN.test(ticket) ||
      (owner.accessToken && (ticket.includes(owner.accessToken) || owner.accessToken.includes(ticket))))
    throw error(502, 'MCP service returned an invalid WebSocket ticket');
  if (typeof ticketExpiresAt !== 'string' || !ISO_UTC.test(ticketExpiresAt))
    throw error(502, 'MCP service returned an invalid WebSocket ticket expiry');
  const expires = Date.parse(ticketExpiresAt);
  if (!Number.isFinite(expires) || expires <= now || expires - now > TICKET_MAX_TTL_MS)
    throw error(502, 'MCP service returned an out-of-range WebSocket ticket expiry');
  // Optional session binding: if SE-03 echoes the owner subject it must be this owner.
  if (Object.prototype.hasOwnProperty.call(data, 'subject') && data.subject !== owner.sub)
    throw error(502, 'MCP service ticket belongs to a different owner');
  return { contract: 'se04-owner-mcp-v1' as const, projectId: project, ticket, ticketExpiresAt };
}
export function expose(data: Record<string, unknown>) {
  // Explicit allowlist; a compromised service must not leak bearer/cookies via JSON.
  const fields = ['contract', 'phase', 'projectId', 'projectName', 'capabilities', 'grants', 'pending', 'writer', 'seenRevision', 'renderedRevision', 'paused', 'requests', 'error', 'epoch'];
  return Object.fromEntries(fields.filter(f => Object.prototype.hasOwnProperty.call(data, f)).map(f => [f, data[f]]));
}
export { token };
export async function disconnectOwner(session: OwnerSession) {
  if (!process.env.SE04_SERVICE_BASE_URL) return;
  const response = await fetch(serviceBase() + '/owner/v1/logout', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { authorization: 'Bearer ' + session.accessToken, 'content-type': 'application/json' }, body: '{}' });
  if (!response.ok) throw error(503, 'Owner channel disconnect unavailable');
}
export function draftWebSocketUrl(): string | undefined {
  const raw = process.env.SE05_DRAFT_WS_ORIGIN;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'wss:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*')) throw Error();
    return url.origin + '/draft';
  } catch { throw error(503, 'Draft WebSocket origin is invalid'); }
}
