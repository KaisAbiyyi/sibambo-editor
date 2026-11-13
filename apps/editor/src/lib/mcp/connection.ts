/** SE-04 browser transport: only same-origin BFF, never stores tokens or secrets. */
export type McpPhase =
  | 'disconnected' | 'signing-in' | 'project-selected' | 'pairing' | 'awaiting-owner-grant'
  | 'connected/read-only' | 'writer-active' | 'paused' | 'reconnecting' | 'expired' | 'error';
export type Agent = {
  id: string; clientId: string; agentSubject: string; displayName?: string;
  scopes: Array<'read' | 'write'>; pairingCode?: string; expiresAt?: string;
  state?: string;
};
export type RevisionRequest = {
  id: string; body: string; moduleIds: string[]; status: 'open' | 'read' | 'addressed' | 'withdrawn';
};
export type McpSessionView = {
  contract: 'se04-owner-mcp-v1'; phase: McpPhase; configured?: boolean; serviceReady?: boolean;
  subject?: string; csrf?: string | null; projectId?: string; projectName?: string;
  capabilities?: string[]; pending?: Agent[]; grants?: Agent[]; writer?: string | null;
  seenRevision?: number; renderedRevision?: number; paused?: boolean;
  requests?: RevisionRequest[]; error?: string;
  draftWebSocketUrl?: string; epoch?: string;
};
/** Raised when a response does not belong to the project the owner asked for. Fail closed. */
export class McpScopeError extends Error {
  constructor() { super('Respons MCP untuk proyek yang berbeda ditolak. Tidak ada aksi owner yang dikirim.'); this.name = 'McpScopeError'; }
}
const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export function assertProjectScope(data: { projectId?: unknown }, expected: string): void {
  if (!PROJECT_ID.test(expected) || data.projectId !== expected) throw new McpScopeError();
}
export type WebSocketTicket = { contract: 'se04-owner-mcp-v1'; projectId: string; ticket: string; ticketExpiresAt: string };
export class McpConnection {
  private pending = new Set<AbortController>();
  private closed = false;
  async request<T>(path: string, options: { method?: 'GET' | 'POST'; csrf?: string; body?: unknown } = {}): Promise<T> {
    if (this.closed) throw new Error('MCP panel closed');
    const abort = new AbortController();
    this.pending.add(abort);
    try {
      const response = await fetch('/api/mcp/' + path, {
        method: options.method ?? 'GET', credentials: 'same-origin', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
        cache: 'no-store', redirect: 'error',
        headers: { accept: 'application/json', ...(options.method === 'POST' ? {
          'content-type': 'application/json', 'x-se04-csrf': options.csrf ?? ''
        } : {}) },
        body: options.method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined
      });
      if (!response.ok) {
        if (response.status === 401) throw new Error('Sesi login habis. Masuk ulang.');
        if (response.status === 403) throw new Error('Izin, asal permintaan, atau kode CSRF ditolak.');
        if (response.status === 503) throw new Error('Layanan MCP belum tersedia / belum dikonfigurasi.');
        throw new Error('Permintaan ditolak (HTTP ' + response.status + ').');
      }
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object') throw new Error('Respons MCP tidak valid.');
      return data as T;
    } finally { this.pending.delete(abort); }
  }
  async session(project?: string) {
    const view = await this.request<McpSessionView>('session' + (project ? '?project=' + encodeURIComponent(project) : ''));
    if (project) assertProjectScope(view, project);
    return view;
  }
  async mutate(path: 'grants' | 'pause' | 'requests', csrf: string, body: { projectId: string } & Record<string, unknown>) {
    const view = await this.request<McpSessionView>(path, { method: 'POST', csrf, body });
    assertProjectScope(view, body.projectId);
    return view;
  }
  logout(csrf: string) { return this.request<{ phase?: string }>('logout', { method: 'POST', csrf, body: {} }); }
  /**
   * Single-use WebSocket ticket for the SE-05 first message. Returned to the caller only: never
   * kept in a field, storage, URL or log by this class.
   */
  async ticket(project: string, csrf: string): Promise<WebSocketTicket> {
    const data = await this.request<Partial<WebSocketTicket>>('ticket', { method: 'POST', csrf, body: { projectId: project } });
    assertProjectScope(data, project);
    if (data.contract !== 'se04-owner-mcp-v1' || typeof data.ticket !== 'string' || !/^[A-Za-z0-9._~-]{32,512}$/.test(data.ticket) ||
        typeof data.ticketExpiresAt !== 'string' || !(Date.parse(data.ticketExpiresAt) > Date.now()) || Date.parse(data.ticketExpiresAt) - Date.now() > 30_000)
      throw new Error('Respons ticket MCP tidak valid.');
    return { contract: data.contract, projectId: project, ticket: data.ticket, ticketExpiresAt: data.ticketExpiresAt };
  }
  dispose() { this.closed = true; for (const abort of this.pending) abort.abort(); this.pending.clear(); }
}
