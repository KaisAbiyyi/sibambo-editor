import { McpConnection } from './connection';
import type { DraftProposal, DraftState, DraftStatus } from './draft-protocol';

export type DraftOptions = {
  projectId: string; csrf: string; url: string;
  render: (proposal: DraftProposal, current: () => boolean) => Promise<void>;
  changed: (status: DraftStatus, state: DraftState | null) => void;
  requests?: (statuses: Array<{ id: string; status: string }>) => void;
};
export class DraftClient {
  state: DraftState | null = null;
  status: DraftStatus = { phase: 'disconnected', role: 'follower', revision: 0, renderedRevision: 0, dirty: false, idleExpiresAt: 0, error: '', ticketLatencyMs: null };
  private worker: Worker;
  private client = new McpConnection();
  private socket: WebSocket | null = null;
  private generation = 0;
  private messageGeneration = 0;
  private disposed = false;
  private attempts = 0;
  private retry = 0;
  private heartbeat = 0;
  private nextId = 0;
  private waiters = new Map<number, { resolve: (reply: any) => void; reject: (reason: Error) => void }>();
  private queue: string[] = [];
  private queuedBytes = 0;
  private pumping = false;
  private needsSnapshot = true;
  private suspended = false;
  constructor(private options: DraftOptions) {
    const url = new URL(options.url);
    if (url.protocol !== 'wss:' || url.pathname !== '/draft' || url.search || url.hash || url.username || url.password) throw Error('URL draft WSS tidak valid.');
    this.worker = new Worker(new URL('./draft.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => { const waiter = this.waiters.get(data.id); this.waiters.delete(data.id); if (data.error) waiter?.reject(Error(data.error)); else waiter?.resolve(data); };
    this.worker.onerror = () => this.fatal('Worker validasi draft gagal. Model terakhir tetap dipertahankan.');
    document.addEventListener('visibilitychange', this.visibility);
    void this.connect();
  }
  private emit() { this.options.changed({ ...this.status }, this.state); }
  private rpc(kind: string, raw?: string): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => { this.waiters.set(id, { resolve, reject }); this.worker.postMessage({ id, kind, raw, projectId: this.options.projectId }); });
  }
  private send(message: object) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  private visibility = () => {
    this.send({ type: 'heartbeat', visible: !this.suspended && document.visibilityState === 'visible' });
    if (!this.suspended && document.visibilityState === 'visible') this.ack();
  };
  private ack() {
    if (!this.suspended && this.state && this.status.role === 'primary' && document.visibilityState === 'visible' && !this.needsSnapshot)
      this.send({ type: 'ACK', revision: this.state.revision, draftSha256: this.state.draftSha256 });
  }
  private async connect() {
    const generation = ++this.generation;
    this.status.phase = this.attempts ? 'reconnecting' : 'connecting'; this.emit();
    try {
      const started = performance.now();
      const ticket = await this.client.ticket(this.options.projectId, this.options.csrf);
      let attachmentTicket: string | null = ticket.ticket;
      if (this.disposed || generation !== this.generation) return;
      this.status.ticketLatencyMs = performance.now() - started;
      const socket = this.socket = new WebSocket(this.options.url); // ticket NEVER goes in a URL/subprotocol/storage
      const isCurrent = () => !this.disposed && generation === this.generation && this.socket === socket;
      socket.onopen = () => {
        if (!isCurrent()) { socket.close(); return; }
        socket.send(JSON.stringify({ type: 'HELLO', ticket: attachmentTicket, projectId: this.options.projectId, epoch: this.state?.epoch ?? null,
          lastAppliedRevision: this.state?.revision ?? 0, lastRenderedRevision: this.status.renderedRevision }));
        attachmentTicket = null; socket.onopen = null;
        this.heartbeat = window.setInterval(this.visibility, 5000);
        this.visibility();
      };
      socket.onmessage = event => {
        if (!isCurrent()) return;
        if (typeof event.data !== 'string') { this.resync(); return; }
        const bytes = new TextEncoder().encode(event.data).length;
        if (bytes > 4 * 1024 * 1024 || this.queue.length >= 64 || this.queuedBytes + bytes > 4 * 1024 * 1024) { this.resync(); return; }
        this.queue.push(event.data); this.queuedBytes += bytes; void this.pump(generation);
      };
      socket.onclose = event => {
        if (!isCurrent()) return;
        if (event.reason === 'EPOCH_CHANGED') this.fatal('Epoch server berubah. Draft terakhir dipertahankan; pemulihan memerlukan persetujuan owner.');
        else this.reconnect();
      };
      socket.onerror = () => { if (isCurrent()) socket.close(); };
    } catch { if (!this.disposed && generation === this.generation) this.reconnect(); }
  }
  private async pump(generation: number) {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.disposed && generation === this.generation) {
        const raw = this.queue.shift()!; this.queuedBytes -= new TextEncoder().encode(raw).length;
        const seq = this.messageGeneration;
        try {
          const reply = await this.rpc('stage', raw);
          const current = () => !this.disposed && generation === this.generation && seq === this.messageGeneration;
          if (!current()) continue;
          if (reply.control) {
            const message = reply.control;
            if (message.type === 'viewer_role') {
              if (!['primary', 'follower'].includes(message.role)) throw Error('DRAFT_ROLE');
              this.status.role = message.role;
            } else if (message.type === 'presence') {
              this.status.idleExpiresAt = Date.now() + 1800_000;
              if (message.phase === 'awaiting_viewer') this.status.phase = 'awaiting_viewer';
              else if (message.phase === 'live') this.status.phase = 'live';
            } else if (message.type === 'resync_required') this.resync();
            else if (message.type === 'owner_request_status') this.options.requests?.(message.requests);
            this.emit(); continue;
          }
          const proposal: DraftProposal = reply.proposal;
          // A bounded replacement snapshot is the only way out of gap/hash failure.
          if (this.needsSnapshot && reply.eventType !== 'snapshot') continue;
          if (!proposal.duplicate) await this.options.render(proposal, current);
          if (!current()) continue;
          await this.rpc('commit');
          if (!current()) continue;
          this.state = proposal.state; this.needsSnapshot = false; this.attempts = 0;
          this.status.revision = this.status.renderedRevision = this.state.revision;
          this.status.dirty = this.state.revision > 0; this.status.phase = 'live'; this.status.error = '';
          this.ack(); this.emit();
        } catch (error) {
          if (this.disposed || generation !== this.generation) break;
          if (error instanceof Error && error.message === 'EPOCH_CHANGED') { this.fatal('Epoch server berubah. Draft terakhir dipertahankan; pemulihan memerlukan persetujuan owner.'); break; }
          this.resync();
        }
      }
    } finally { this.pumping = false; if (this.queue.length && !this.disposed) void this.pump(this.generation); }
  }
  private resync() {
    this.messageGeneration++; this.queue = []; this.queuedBytes = 0; this.needsSnapshot = true;
    this.status.phase = 'paused'; this.status.error = 'Urutan/hash draft tidak cocok. Menunggu snapshot tervalidasi; model terakhir dipertahankan.';
    this.send({ type: 'RESYNC' }); this.emit();
  }
  private reconnect() {
    window.clearInterval(this.heartbeat); this.messageGeneration++; this.queue = []; this.queuedBytes = 0; this.needsSnapshot = true;
    this.status.phase = 'reconnecting'; this.status.error = 'Sambungan terputus. Draft terakhir tetap ada di tab ini.';
    this.status.idleExpiresAt = Date.now() + 1800_000;
    if (++this.attempts > 6) { this.fatal('Batas percobaan sambungan tercapai. Pilih Sambungkan ulang; model terakhir dipertahankan.'); return; }
    this.emit();
    const delay = Math.min(8000, 500 * 2 ** (this.attempts - 1)) * (.5 + Math.random());
    this.retry = window.setTimeout(() => { if (!this.disposed) void this.connect(); }, delay);
  }
  reconnectNow() { window.clearTimeout(this.retry); this.attempts = 0; this.socket?.close(); void this.connect(); }
  suspend() { this.suspended = true; this.messageGeneration++; this.visibility(); }
  resume() { this.suspended = false; this.visibility(); this.resync(); }
  private fatal(error: string) { this.status.phase = 'error'; this.status.error = error; this.emit(); this.generation++; this.socket?.close(); window.clearInterval(this.heartbeat); }
  dispose() {
    this.disposed = true; this.generation++; this.messageGeneration++; window.clearTimeout(this.retry); window.clearInterval(this.heartbeat);
    document.removeEventListener('visibilitychange', this.visibility); this.socket?.close(); this.client.dispose(); this.worker.terminate();
    for (const waiter of this.waiters.values()) waiter.reject(Error('DRAFT_DISPOSED')); this.waiters.clear(); this.queue = [];
  }
}
