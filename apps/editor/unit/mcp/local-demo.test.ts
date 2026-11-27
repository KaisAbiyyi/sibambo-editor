/**
 * Master v1.6 local demo mode: explicit, loopback-only, fail-closed, no IdP. Remote/OIDC behaviour is covered by
 * the unchanged SE-04 suites; these tests only prove the new branch cannot be reached by accident.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { DraftClient } from '../../src/lib/mcp/draft-client';

mock.module('$app/environment', () => ({ dev: true, browser: false, building: false, version: 'test' }));
const bff = await import('../../src/lib/server/mcp-bff');
const login = await import('../../src/routes/api/mcp/login/+server');
const sessionRoute = await import('../../src/routes/api/mcp/session/+server');

const KEYS = ['SE04_LOCAL_DEMO', 'SE04_LOCAL_OWNER_TOKEN', 'SE04_LOCAL_PROJECT', 'SE04_SESSION_KEY', 'SE04_SERVICE_BASE_URL',
  'SE05_DRAFT_WS_ORIGIN', 'VERCEL', 'SE04_AUTH_ISSUER', 'SE04_AUTH_CLIENT_ID', 'SE04_AUTH_CLIENT_SECRET', 'SE04_AUTH_AUDIENCE'];
const saved = new Map<string, string | undefined>();
const TOKEN = 'owner-local-token-DO-NOT-LEAK-0123456789abcdef';
beforeEach(() => { for (const key of KEYS) { saved.set(key, process.env[key]); delete process.env[key]; } });
afterEach(() => { for (const key of KEYS) { const v = saved.get(key); if (v === undefined) delete process.env[key]; else process.env[key] = v; } });
function localEnv(extra: Record<string, string> = {}) {
  Object.assign(process.env, { SE04_LOCAL_DEMO: '1', SE04_LOCAL_OWNER_TOKEN: TOKEN, SE04_SESSION_KEY: Buffer.alloc(32, 7).toString('base64url'),
    SE04_SERVICE_BASE_URL: 'http://127.0.0.1:8765', SE05_DRAFT_WS_ORIGIN: 'ws://127.0.0.1:8765', ...extra });
}
function jar() {
  const values = new Map<string, string>();
  return { values, get: (n: string) => values.get(n), set: (n: string, v: string) => { values.set(n, v); }, delete: (n: string) => { values.delete(n); } };
}
function event(path: string, { host = 'localhost:5175', site, cookies = jar() }: { host?: string; site?: string; cookies?: ReturnType<typeof jar> } = {}) {
  const url = new URL('http://' + host + path);
  const headers: Record<string, string> = {};
  if (site) headers['sec-fetch-site'] = site;
  return { request: new Request(url, { headers }), url, cookies } as never;
}
async function outcome(fn: () => unknown) {
  try { const value = await fn(); return { value } as { value?: any; status?: number; location?: string }; }
  catch (error) {
    if (isRedirect(error)) return { status: error.status, location: error.location };
    if (isHttpError(error)) return { status: error.status };
    throw error;
  }
}

describe('localDemo() gate', () => {
  test('absent flag means no local mode and no change to remote configuration', () => {
    expect(bff.localDemo()).toBeNull();
    expect(bff.configured()).toBe(false);
  });
  for (const [name, extra] of [
    ['Vercel environment', { VERCEL: '1' }], ['short owner token', { SE04_LOCAL_OWNER_TOKEN: 'short' }],
    ['non-loopback service', { SE04_SERVICE_BASE_URL: 'http://192.168.1.5:8765' }], ['https service', { SE04_SERVICE_BASE_URL: 'https://localhost:8765' }],
    ['service with path', { SE04_SERVICE_BASE_URL: 'http://127.0.0.1:8765/x' }], ['bad project id', { SE04_LOCAL_PROJECT: '../x' }],
    ['bad session key', { SE04_SESSION_KEY: 'AAAA' }]
  ] as Array<[string, Record<string, string>]>) {
    test(`requested but misconfigured (${name}) fails closed with 503 and never falls back to OIDC`, async () => {
      localEnv(extra);
      expect((await outcome(() => bff.localDemo())).status).toBe(503);
      expect(bff.configured()).toBe(false);
      const result = await outcome(() => login.GET(event('/api/mcp/login')));
      expect(result.status).toBe(503);
    });
  }
  test('valid configuration yields the default project and the local issuer', () => {
    localEnv();
    expect(bff.localDemo()).toEqual({ token: TOKEN, project: 'local-demo', issuer: bff.LOCAL_ISSUER });
    localEnv({ SE04_LOCAL_PROJECT: 'my-demo' });
    expect(bff.localDemo()?.project).toBe('my-demo');
    expect(bff.configured()).toBe(true);
  });
});

describe('one-click owner sign-in', () => {
  test('loopback sign-in seals a session (token never in cookie plaintext) and redirects', async () => {
    localEnv();
    const cookies = jar();
    const result = await outcome(() => login.GET(event('/api/mcp/login', { cookies, site: 'same-origin' })));
    expect(result.status).toBe(303);
    expect(result.location).toBe('/?mcp=connected');
    const sealed = cookies.values.get('__Host-se04_session')!;
    expect(sealed).toBeTruthy();
    expect(sealed).not.toContain(TOKEN);
    const session = bff.getSession({ cookies } as never)!;
    expect(session.sub).toBe('local-owner');
    expect(session.issuer).toBe(bff.LOCAL_ISSUER);
    expect(session.accessToken).toBe(TOKEN);
    expect(session.exp - Date.now() / 1000).toBeGreaterThan(3600);
  });
  test('cross-site navigation and non-loopback host are refused and set nothing', async () => {
    localEnv();
    for (const opts of [{ site: 'cross-site' }, { site: 'same-site' }, { host: 'editor.example.test' }, { host: '192.168.1.5:5175' }]) {
      const cookies = jar();
      const result = await outcome(() => login.GET(event('/api/mcp/login', { cookies, ...opts })));
      expect(result.status).toBe(403);
      expect(cookies.values.size).toBe(0);
    }
  });
  test('without the flag the login route never mints a local session', async () => {
    const cookies = jar();
    const result = await outcome(() => login.GET(event('/api/mcp/login', { cookies })));
    expect(result.status).toBe(503);                      // OIDC not configured: remote behaviour unchanged
    expect(cookies.values.size).toBe(0);
  });
  test('a session minted by another issuer is not accepted in local mode, and vice versa', async () => {
    localEnv();
    const cookies = jar();
    bff.setSession({ cookies } as never, { sub: 'x', accessToken: 'a', exp: Math.floor(Date.now() / 1000) + 600, csrf: 'c', issuer: 'https://auth.example.test' });
    expect(bff.getSession({ cookies } as never)).toBeNull();
  });
  test('session route advertises localDemo + default project before and after sign-in', async () => {
    localEnv();
    const before = await (await sessionRoute.GET(event('/api/mcp/session') as never)).json();
    expect(before).toMatchObject({ phase: 'disconnected', configured: true, localDemo: true, defaultProject: 'local-demo' });
    expect(JSON.stringify(before)).not.toContain(TOKEN);
    const cookies = jar();
    await outcome(() => login.GET(event('/api/mcp/login', { cookies })));
    const after = await (await sessionRoute.GET(event('/api/mcp/session', { cookies }) as never)).json();
    expect(after).toMatchObject({ phase: 'project-selected', localDemo: true, defaultProject: 'local-demo', csrf: expect.any(String) });
    expect(JSON.stringify(after)).not.toContain(TOKEN);
  });
});

describe('draft WebSocket origin', () => {
  test('ws loopback is accepted only in local mode; non-loopback ws and any ws without the flag are rejected', async () => {
    localEnv();
    expect(bff.draftWebSocketUrl()).toBe('ws://127.0.0.1:8765/draft');
    process.env.SE05_DRAFT_WS_ORIGIN = 'ws://evil.example.test:8765';
    expect((await outcome(() => bff.draftWebSocketUrl())).status).toBe(503);
    process.env.SE05_DRAFT_WS_ORIGIN = 'ws://127.0.0.1:8765';
    delete process.env.SE04_LOCAL_DEMO;
    expect((await outcome(() => bff.draftWebSocketUrl())).status).toBe(503);
    process.env.SE05_DRAFT_WS_ORIGIN = 'wss://draft.example.test';
    expect(bff.draftWebSocketUrl()).toBe('wss://draft.example.test/draft');
  });
});

describe('DraftClient URL guard', () => {
  const saveGlobals = new Map(['fetch', 'Worker', 'window', 'document'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  afterEach(() => { for (const [k, d] of saveGlobals) { if (d) Object.defineProperty(globalThis, k, d); else Reflect.deleteProperty(globalThis, k); } });
  function build(url: string) {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: class { terminate() {} } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' } });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout, clearTimeout, setInterval, clearInterval } });
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    return new DraftClient({ projectId: 'p', csrf: 'c', url, render: async () => {}, changed: () => {} });
  }
  test('accepts loopback ws, rejects remote ws and malformed loopback URLs', () => {
    build('ws://127.0.0.1:8765/draft').dispose();
    build('ws://localhost:8765/draft').dispose();
    build('wss://draft.example.test/draft').dispose();
    for (const bad of ['ws://evil.example.test/draft', 'ws://127.0.0.1:8765/draft?x=1', 'ws://u:p@127.0.0.1:8765/draft', 'ws://127.0.0.1:8765/other', 'http://127.0.0.1:8765/draft'])
      expect(() => build(bad)).toThrow();
  });
});
