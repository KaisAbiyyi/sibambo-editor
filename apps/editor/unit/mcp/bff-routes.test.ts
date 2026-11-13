/**
 * SE-04 route-level regression suite. Exercises the real SvelteKit `+server.ts` handlers and
 * the real BFF module against a MOCKED SE-03 backend (loopback Bun.serve). This is the trust
 * boundary the browser-level Playwright mocks cannot reach. No real IdP, agent or tunnel.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { isHttpError } from '@sveltejs/kit';

mock.module('$app/environment', () => ({ dev: true, browser: false, building: false, version: 'test' }));

type Upstream = { method: string; path: string; authorization: string | null; body: string };
type Responder = (request: Request, path: string) => Response | Promise<Response>;

const ISSUER = 'https://auth.example.test';
const ACCESS_TOKEN = 'bearer-access-token-DO-NOT-LEAK-0123456789';
const CSRF = 'csrf-nonce-0123456789';
const ORIGIN = 'https://editor.example.test';
const A = 'project-a', B = 'project-b';
const NOW = () => Date.now();
const iso = (offsetMs: number) => new Date(NOW() + offsetMs).toISOString();
const TICKET = 'tkt_' + 'AbCdEfGh01234567'.repeat(3);

let upstream: Upstream[] = [];
let responder: Responder = () => new Response('{}', { status: 500 });
let server: ReturnType<typeof Bun.serve>;

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const envelope = (project: string, extra: Record<string, unknown> = {}) => ({ contract: 'se04-owner-mcp-v1', projectId: project, ...extra });

const bff = await (async () => {
  process.env.SE04_AUTH_ISSUER = ISSUER;
  process.env.SE04_AUTH_CLIENT_ID = 'se04-web';
  process.env.SE04_AUTH_CLIENT_SECRET = 'confidential-client-secret';
  process.env.SE04_AUTH_AUDIENCE = 'https://mcp.example.test';
  process.env.SE04_SESSION_KEY = Buffer.alloc(32, 9).toString('base64url');
  return import('../../src/lib/server/mcp-bff');
})();
const routes = {
  ticket: await import('../../src/routes/api/mcp/ticket/+server'),
  session: await import('../../src/routes/api/mcp/session/+server'),
  grants: await import('../../src/routes/api/mcp/grants/+server'),
  pause: await import('../../src/routes/api/mcp/pause/+server'),
  requests: await import('../../src/routes/api/mcp/requests/+server')
};

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      upstream.push({ method: request.method, path: url.pathname, authorization: request.headers.get('authorization'), body: await request.clone().text() });
      return responder(request, url.pathname);
    }
  });
  process.env.SE04_SERVICE_BASE_URL = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => { upstream = []; responder = () => new Response('{}', { status: 500 }); });

type Jar = ReturnType<typeof makeJar>;
function makeJar(initial: Map<string, string> = new Map()) {
  const writes: string[] = [];
  return {
    values: initial, writes,
    get: (name: string) => initial.get(name),
    set: (name: string, value: string) => { writes.push(name); initial.set(name, value); },
    delete: (name: string) => { initial.delete(name); }
  };
}
function signedInJar(overrides: Record<string, unknown> = {}): Jar {
  const jar = makeJar();
  bff.setSession({ cookies: jar } as never, {
    sub: 'auth0|owner', accessToken: ACCESS_TOKEN, exp: Math.floor(NOW() / 1000) + 3600, csrf: CSRF, issuer: ISSUER, ...overrides
  });
  jar.writes.length = 0;
  return jar;
}
type Options = { method?: 'GET' | 'POST'; query?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; jar?: Jar; csrf?: string | null; origin?: string | null };
function event(path: string, opts: Options = {}) {
  const method = opts.method ?? 'POST';
  const url = new URL(ORIGIN + path + (opts.query ?? ''));
  const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (method === 'POST') headers['content-type'] = 'application/json';
  if (opts.csrf !== null && method === 'POST') headers['x-se04-csrf'] = opts.csrf ?? CSRF;
  const jar = opts.jar ?? signedInJar();
  const request = new Request(url, { method, headers, body: method === 'POST' ? (opts.rawBody ?? JSON.stringify(opts.body ?? {})) : undefined });
  return { request, url, cookies: jar, jar } as never;
}
type Result = { status: number; text: string; headers: Headers; body: any; message?: string };
async function run(handler: (e: never) => Promise<Response> | Response, ev: never): Promise<Result> {
  try {
    const response = await handler(ev);
    const text = await response.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* keep null */ }
    return { status: response.status, text, headers: response.headers, body };
  } catch (error) {
    if (isHttpError(error)) return { status: error.status, text: '', headers: new Headers(), body: null, message: error.body.message };
    throw error;
  }
}
const postTicket = (project: string = A, opts: Options = {}) => run(routes.ticket.POST as never, event('/api/mcp/ticket', { ...opts, body: opts.body ?? { projectId: project } }));
const validTicketBody = (extra: Record<string, unknown> = {}) => envelope(A, { ticket: TICKET, ticketExpiresAt: iso(15_000), ...extra });

describe('P1-A: /api/mcp/ticket returns the validated single-use WebSocket ticket', () => {
  test('valid upstream ticket is delivered once, minimal, no-store, with no bearer and no persistence', async () => {
    responder = () => json(validTicketBody());
    const jar = signedInJar();
    const result = await postTicket(A, { jar });
    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual(['contract', 'projectId', 'ticket', 'ticketExpiresAt']);
    expect(result.body).toEqual({ contract: 'se04-owner-mcp-v1', projectId: A, ticket: TICKET, ticketExpiresAt: expect.any(String) });
    expect(result.text.split(TICKET).length - 1).toBe(1);
    expect(result.text).not.toContain(ACCESS_TOKEN);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.headers.get('set-cookie')).toBeNull();
    expect(jar.writes).toEqual([]);
    expect([...jar.values.values()].some(v => v.includes(TICKET))).toBe(false);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]).toMatchObject({ method: 'POST', path: `/v1/projects/${A}/owner/mcp/ticket`, authorization: 'Bearer ' + ACCESS_TOKEN, body: '{}' });
  });
  test('extra upstream fields (bearer, refresh token, wss URL, nested objects) are never forwarded', async () => {
    responder = () => json(validTicketBody({
      accessToken: 'upstream-access', refresh_token: 'upstream-refresh', url: 'wss://mcp.example.test/ws?ticket=' + TICKET,
      grants: [{ id: 'g' }], session: { cookie: 'x' }, subject: 'auth0|owner'
    }));
    const result = await postTicket();
    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual(['contract', 'projectId', 'ticket', 'ticketExpiresAt']);
    for (const leaked of ['upstream-access', 'upstream-refresh', 'wss://', 'cookie']) expect(result.text).not.toContain(leaked);
  });
  test('every call mints a fresh upstream ticket; BFF caches nothing between calls', async () => {
    let n = 0;
    responder = () => json(validTicketBody({ ticket: 'ticket-' + (++n) + '-' + 'Z'.repeat(40) }));
    const first = await postTicket(), second = await postTicket();
    expect(first.body.ticket).toStartWith('ticket-1-');
    expect(second.body.ticket).toStartWith('ticket-2-');
    expect(upstream).toHaveLength(2);
    expect(second.text).not.toContain('ticket-1-');
  });
  const badTickets: Array<[string, unknown]> = [
    ['missing', undefined], ['null', null], ['number', 12345678901234567890123456789012], ['array', [TICKET]], ['object', { v: TICKET }],
    ['empty', ''], ['31 chars (too short)', 'a'.repeat(31)], ['513 chars (oversized)', 'a'.repeat(513)],
    ['URL shaped', 'wss://mcp.example.test/ws?ticket=' + 'a'.repeat(40)], ['whitespace', 'a'.repeat(20) + ' ' + 'b'.repeat(20)],
    ['newline injection', 'a'.repeat(40) + '\r\nSet-Cookie: x=1'], ['unicode', 'é'.repeat(40)],
    ['equals bearer', ACCESS_TOKEN], ['embeds bearer', 'x' + ACCESS_TOKEN + 'y'], ['fragment of bearer', ACCESS_TOKEN.slice(0, 36)]
  ];
  for (const [name, ticket] of badTickets) {
    test(`malformed ticket fails closed with 502 and echoes nothing: ${name}`, async () => {
      responder = () => json(validTicketBody({ ticket }));
      const result = await postTicket();
      expect(result.status).toBe(502);
      expect(result.text).toBe('');
      expect(String(result.message)).not.toContain(ACCESS_TOKEN);
      if (typeof ticket === 'string' && ticket.length > 8) expect(String(result.message)).not.toContain(ticket);
    });
  }
  const badExpiry: Array<[string, unknown]> = [
    ['missing', undefined], ['null', null], ['epoch number', Math.floor(NOW() / 1000) + 60], ['free text', 'tomorrow'],
    ['already expired', iso(-1000)], ['exactly now', iso(0)], ['beyond 30 second budget', iso(31_000)], ['far future', '2999-01-01T00:00:00Z'],
    ['impossible calendar date', '2999-13-45T25:61:61Z'], ['non UTC offset form', '2999-01-01T00:00:00+07:00']
  ];
  for (const [name, ticketExpiresAt] of badExpiry) {
    test(`unusable expiry fails closed: ${name}`, async () => {
      responder = () => json(validTicketBody({ ticketExpiresAt }));
      expect((await postTicket()).status).toBe(502);
    });
  }
  test('expiry at the TTL budget edge is accepted, one second beyond is not', () => {
    const owner = { sub: 'o', accessToken: ACCESS_TOKEN, exp: 9e9, csrf: CSRF, issuer: ISSUER };
    const now = Date.UTC(2026, 10, 9, 12, 0, 0);
    const at = (ms: number) => ({ ticket: TICKET, ticketExpiresAt: new Date(now + ms).toISOString() });
    expect(bff.ticketResponse(at(bff.TICKET_MAX_TTL_MS), owner, A, now).projectId).toBe(A);
    expect(() => bff.ticketResponse(at(bff.TICKET_MAX_TTL_MS + 1000), owner, A, now)).toThrow();
    expect(() => bff.ticketResponse(at(1), owner, A, now + 1)).toThrow();
  });
  test('ticket scoped to a different project (A requested, B returned) never reaches the browser', async () => {
    responder = () => json(envelope(B, { ticket: TICKET, ticketExpiresAt: iso(15_000) }));
    const result = await postTicket(A);
    expect(result.status).toBe(502);
    expect(result.text).toBe('');
  });
  for (const [name, projectId] of [['missing', undefined], ['null', null], ['number', 1], ['array', [A]], ['object', { id: A }], ['different case', 'PROJECT-A'], ['trailing space', A + ' '], ['empty', '']] as const) {
    test(`malformed upstream projectId fails closed: ${name}`, async () => {
      const body: Record<string, unknown> = { contract: 'se04-owner-mcp-v1', ticket: TICKET, ticketExpiresAt: iso(15_000) };
      if (projectId !== undefined) body.projectId = projectId;
      responder = () => json(body);
      expect((await postTicket(A)).status).toBe(502);
    });
  }
  test('ticket bound to another owner subject is rejected; matching subject accepted', async () => {
    responder = () => json(validTicketBody({ subject: 'auth0|someone-else' }));
    expect((await postTicket()).status).toBe(502);
    responder = () => json(validTicketBody({ subject: 'auth0|owner' }));
    expect((await postTicket()).status).toBe(200);
  });
  test('owner and CSRF controls still run before any service call', async () => {
    responder = () => json(validTicketBody());
    expect((await postTicket(A, { jar: makeJar() })).status).toBe(401);
    expect((await postTicket(A, { csrf: null })).status).toBe(403);
    expect((await postTicket(A, { csrf: 'wrong-csrf' })).status).toBe(403);
    expect((await postTicket(A, { origin: 'https://evil.example.test' })).status).toBe(403);
    expect((await postTicket(A, { origin: null })).status).toBe(403);
    expect((await postTicket(A, { jar: signedInJar({ exp: 1 }) })).status).toBe(401);
    expect((await postTicket(A, { jar: signedInJar({ issuer: 'https://evil.example.test' }) })).status).toBe(401);
    expect((await postTicket(A, { body: { projectId: '../admin' } })).status).toBe(400);
    expect((await postTicket(A, { body: {} })).status).toBe(400);
    expect((await postTicket(A, { rawBody: '{not json' })).status).toBe(400);
    expect((await postTicket(A, { rawBody: JSON.stringify({ projectId: A, pad: 'x'.repeat(9000) }) })).status).toBe(413);
    expect(upstream).toHaveLength(0);
  });
  test('upstream failures stay generic and never expose the ticket or bearer', async () => {
    const cases: Array<[number, Responder, number]> = [
      [401, () => json({ ticket: TICKET }, 401), 401], [403, () => json({ ticket: TICKET }, 403), 403],
      [500, () => json({ ticket: TICKET }, 500), 502],
      [302, () => new Response(null, { status: 302, headers: { location: 'https://evil.example.test/steal' } }), 502],
      [200, () => new Response('not json', { status: 200 }), 502],
      [200, () => json([validTicketBody()]), 502],
      [200, () => json({ ...validTicketBody(), contract: 'se04-owner-mcp-v0' }), 502],
      [200, () => new Response(JSON.stringify(validTicketBody({ pad: 'x'.repeat(33000) })), { status: 200 }), 502]
    ];
    for (const [, handler, expected] of cases) {
      upstream = []; responder = handler;
      const result = await postTicket();
      expect(result.status).toBe(expected);
      expect(result.text).toBe('');
      expect(upstream).toHaveLength(1); // redirects are never followed with the bearer
    }
  });
});

describe('P1-B: project isolation of every service response', () => {
  const view = (project: string, extra: Record<string, unknown> = {}) => envelope(project, {
    phase: 'awaiting-owner-grant', projectName: 'Name of ' + project, capabilities: ['read'], grants: [], pending: [], writer: null,
    seenRevision: 3, renderedRevision: 3, paused: false, requests: [], ...extra
  });
  test('matching project is exposed through the allowlist only (ticket and credentials are stripped)', async () => {
    responder = () => json(view(A, { ticket: TICKET, ticketExpiresAt: iso(15_000), accessToken: 'leak', cookies: ['x'], secret: 's' }));
    const result = await run(routes.session.GET as never, event('/api/mcp/session', { method: 'GET', query: '?project=' + A }));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ projectId: A, projectName: 'Name of ' + A, subject: 'auth0|owner', csrf: CSRF, serviceReady: true });
    for (const leaked of [TICKET, 'ticketExpiresAt', 'leak', 'cookies', '"secret"', ACCESS_TOKEN]) expect(result.text).not.toContain(leaked);
    expect(upstream[0].path).toBe(`/v1/projects/${A}/owner/mcp`);
  });
  test('GET session: upstream A→B view is rejected before any field reaches the UI', async () => {
    responder = () => json(view(B, { pending: [{ id: 'p', agentSubject: 'victim', clientId: 'c', scopes: ['write'] }] }));
    const result = await run(routes.session.GET as never, event('/api/mcp/session', { method: 'GET', query: '?project=' + A }));
    expect(result.status).toBe(502);
    expect(result.text).toBe('');
    expect(String(result.message)).not.toContain(B);
  });
  for (const [name, projectId] of [['missing', undefined], ['null', null], ['number', 7], ['object', {}], ['empty', ''], ['traversal', '../project-a']] as const) {
    test(`GET session: malformed upstream projectId fails closed (${name})`, async () => {
      const body: Record<string, unknown> = view(A); delete body.projectId;
      if (projectId !== undefined) body.projectId = projectId;
      responder = () => json(body);
      expect((await run(routes.session.GET as never, event('/api/mcp/session', { method: 'GET', query: '?project=' + A }))).status).toBe(502);
    });
  }
  test('GET session without a project makes no service call and returns no project data', async () => {
    const result = await run(routes.session.GET as never, event('/api/mcp/session', { method: 'GET' }));
    expect(result.status).toBe(200);
    expect(result.body.phase).toBe('project-selected');
    expect(result.body.projectId).toBeUndefined();
    expect(upstream).toHaveLength(0);
  });
  test('GET requests: wrong-project inbox is rejected', async () => {
    responder = () => json(envelope(B, { requests: [{ id: 'r1', body: 'secret of B', moduleIds: [], status: 'open' }] }));
    const result = await run(routes.requests.GET as never, event('/api/mcp/requests', { method: 'GET', query: '?project=' + A }));
    expect(result.status).toBe(502);
    expect(result.text).toBe('');
  });
  const grantBody = { projectId: A, action: 'approve', grantId: 'g1', agentSubject: 'agent-1', clientId: 'client-1', scopes: ['read'], confirmationCode: 'ABCDEFGH' };
  const mutations: Array<[string, (b?: Record<string, unknown>) => Promise<Result>]> = [
    ['grants', (b = {}) => run(routes.grants.POST as never, event('/api/mcp/grants', { body: { ...grantBody, ...b } }))],
    ['pause', (b = {}) => run(routes.pause.POST as never, event('/api/mcp/pause', { body: { projectId: A, paused: true, ...b } }))],
    ['requests', (b = {}) => run(routes.requests.POST as never, event('/api/mcp/requests', { body: { projectId: A, action: 'create', body: 'Revisi', moduleIds: [], kind: 'instruction', parameters: {}, ...b } }))]
  ];
  for (const [name, call] of mutations) {
    test(`POST ${name}: matching project round-trips; request is addressed to the requested project only`, async () => {
      responder = () => json(envelope(A, { phase: 'writer-active', paused: true }));
      const result = await call();
      expect(result.status).toBe(200);
      expect(result.body.projectId).toBe(A);
      expect(upstream.map(u => u.path)).toEqual([`/v1/projects/${A}/owner/mcp/${name}`]);
    });
    test(`POST ${name}: A requested, B answered → 502 so no wrong-project state can drive the UI`, async () => {
      responder = () => json(envelope(B, { phase: 'writer-active', projectName: 'B', writer: 'agent-of-b' }));
      const result = await call();
      expect(result.status).toBe(502);
      expect(result.text).toBe('');
    });
    test(`POST ${name}: missing or non-string projectId in the answer → 502`, async () => {
      for (const reply of [{ contract: 'se04-owner-mcp-v1' }, { contract: 'se04-owner-mcp-v1', projectId: [A] }, { contract: 'se04-owner-mcp-v1', projectId: null }]) {
        responder = () => json(reply);
        expect((await call()).status).toBe(502);
      }
    });
    test(`POST ${name}: CSRF/origin/session controls remain in force`, async () => {
      responder = () => json(envelope(A));
      const send = (opts: Options) => run((routes as any)[name].POST, event('/api/mcp/' + name, { ...opts, body: opts.body ?? (name === 'grants' ? grantBody : name === 'pause' ? { projectId: A, paused: true } : { projectId: A, action: 'mark-read', requestId: 'r1' }) }));
      expect((await send({ csrf: 'nope' })).status).toBe(403);
      expect((await send({ origin: 'https://evil.example.test' })).status).toBe(403);
      expect((await send({ jar: makeJar() })).status).toBe(401);
      expect(upstream).toHaveLength(0);
    });
  }
  test('owner mutation cannot be re-scoped by an upstream answer: the BFF never derives the project from it', async () => {
    responder = () => json(envelope(B, { phase: 'awaiting-owner-grant' }));
    const view = await run(routes.session.GET as never, event('/api/mcp/session', { method: 'GET', query: '?project=' + A }));
    expect(view.status).toBe(502);
    const action = await run(routes.pause.POST as never, event('/api/mcp/pause', { body: { projectId: A, paused: true } }));
    expect(action.status).toBe(502);
    expect(upstream.every(u => u.path.startsWith(`/v1/projects/${A}/`))).toBe(true);
  });
});
