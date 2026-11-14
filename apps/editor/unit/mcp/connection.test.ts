import { afterEach, describe, expect, test } from 'bun:test';
import { McpConnection, McpScopeError } from '../../src/lib/mcp/connection';

const realFetch = globalThis.fetch;
const A = 'project-a';
const TICKET = 'tkt_' + 'AbCdEfGh01234567'.repeat(3);
const reply = (value: unknown) => { globalThis.fetch = (async () => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch; };
afterEach(() => { globalThis.fetch = realFetch; });

describe('browser transport re-verifies the project scope of every BFF answer', () => {
  test('session view for another or missing project is rejected', async () => {
    const c = new McpConnection();
    reply({ contract: 'se04-owner-mcp-v1', projectId: 'project-b' });
    await expect(c.session(A)).rejects.toBeInstanceOf(McpScopeError);
    reply({ contract: 'se04-owner-mcp-v1' });
    await expect(c.session(A)).rejects.toBeInstanceOf(McpScopeError);
    reply({ contract: 'se04-owner-mcp-v1', projectId: A });
    expect((await c.session(A)).projectId).toBe(A);
  });
  test('owner mutation answered for another project is rejected', async () => {
    const c = new McpConnection();
    reply({ contract: 'se04-owner-mcp-v1', projectId: 'project-b' });
    await expect(c.mutate('pause', 'csrf', { projectId: A, paused: true })).rejects.toBeInstanceOf(McpScopeError);
  });
  test('ticket is validated, returned to the caller only and never retained', async () => {
    const c = new McpConnection();
    const expires = new Date(Date.now() + 15_000).toISOString();
    reply({ contract: 'se04-owner-mcp-v1', projectId: A, ticket: TICKET, ticketExpiresAt: expires });
    expect(await c.ticket(A, 'csrf')).toEqual({ contract: 'se04-owner-mcp-v1', projectId: A, ticket: TICKET, ticketExpiresAt: expires });
    expect(JSON.stringify(c)).not.toContain(TICKET);
    for (const bad of [{ ticket: 'short' }, { ticket: undefined }, { ticketExpiresAt: new Date(Date.now() - 1000).toISOString() }, { projectId: 'project-b' }]) {
      reply({ contract: 'se04-owner-mcp-v1', projectId: A, ticket: TICKET, ticketExpiresAt: expires, ...bad });
      await expect(c.ticket(A, 'csrf')).rejects.toThrow();
    }
  });
  test('reconnect obtains the current session CSRF before requesting a fresh ticket', async () => {
    const requests: Array<{ url: string; csrf: string | null }> = [];
    globalThis.fetch = (async (url, options) => {
      requests.push({ url: String(url), csrf: new Headers(options?.headers).get('x-se04-csrf') });
      return new Response(JSON.stringify(String(url).includes('session?')
        ? { contract: 'se04-owner-mcp-v1', phase: 'connected/read-only', projectId: A, csrf: 'renewed-session' }
        : { contract: 'se04-owner-mcp-v1', projectId: A, ticket: TICKET, ticketExpiresAt: new Date(Date.now() + 15000).toISOString() }));
    }) as typeof fetch;
    await new McpConnection().ticket(A, 'expired-session', true);
    expect(requests).toEqual([
      { url: '/api/mcp/session?project=project-a', csrf: null },
      { url: '/api/mcp/ticket', csrf: 'renewed-session' }
    ]);
  });
  test('expired or differently scoped reconnect sessions never request a ticket', async () => {
    for (const view of [
      { contract: 'se04-owner-mcp-v1', phase: 'disconnected', csrf: null },
      { contract: 'se04-owner-mcp-v1', phase: 'connected/read-only', projectId: 'project-b', csrf: 'other' }
    ]) {
      const paths: string[] = [];
      globalThis.fetch = (async url => { paths.push(String(url)); return new Response(JSON.stringify(view)); }) as typeof fetch;
      await expect(new McpConnection().ticket(A, 'old', true)).rejects.toThrow();
      expect(paths).toEqual(['/api/mcp/session?project=project-a']);
    }
  });
});
