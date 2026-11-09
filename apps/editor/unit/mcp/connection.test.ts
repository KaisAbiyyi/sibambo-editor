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
    const expires = new Date(Date.now() + 60_000).toISOString();
    reply({ contract: 'se04-owner-mcp-v1', projectId: A, ticket: TICKET, ticketExpiresAt: expires });
    expect(await c.ticket(A, 'csrf')).toEqual({ contract: 'se04-owner-mcp-v1', projectId: A, ticket: TICKET, ticketExpiresAt: expires });
    expect(JSON.stringify(c)).not.toContain(TICKET);
    for (const bad of [{ ticket: 'short' }, { ticket: undefined }, { ticketExpiresAt: new Date(Date.now() - 1000).toISOString() }, { projectId: 'project-b' }]) {
      reply({ contract: 'se04-owner-mcp-v1', projectId: A, ticket: TICKET, ticketExpiresAt: expires, ...bad });
      await expect(c.ticket(A, 'csrf')).rejects.toThrow();
    }
  });
});
