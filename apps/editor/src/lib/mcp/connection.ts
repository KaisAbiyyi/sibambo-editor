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
};
export class McpConnection {
  private pending = new Set<AbortController>();
  private closed = false;
  async request<T>(path: string, options: { method?: 'GET' | 'POST'; csrf?: string; body?: unknown } = {}): Promise<T> {
    if (this.closed) throw new Error('MCP panel closed');
    const abort = new AbortController();
    this.pending.add(abort);
    try {
      const response = await fetch('/api/mcp/' + path, {
        method: options.method ?? 'GET', credentials: 'same-origin', signal: abort.signal,
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
  session(project?: string) {
    return this.request<McpSessionView>('session' + (project ? '?project=' + encodeURIComponent(project) : ''));
  }
  mutate(path: 'grants' | 'pause' | 'requests' | 'logout' | 'ticket', csrf: string, body: unknown) {
    return this.request<McpSessionView>(path, { method: 'POST', csrf, body });
  }
  dispose() { this.closed = true; for (const abort of this.pending) abort.abort(); this.pending.clear(); }
}
