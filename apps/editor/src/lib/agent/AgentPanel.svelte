<script lang="ts">
  /**
   * SIB-MCP-MODELING-001 v2.3 C15 — Agent panel (Extensions → Agent…), local-demo only.
   * Owner connects the open authoring document to the local agent relay, pauses agent writes
   * and sees the writer slot and the last 50 calls. The Denah button arrives with WP9 (C14).
   */
  import { onDestroy, onMount, tick } from 'svelte';
  import { McpConnection, type McpSessionView } from '../mcp/connection';
  import { AgentLink, agentUrlFromDraftUrl, type AgentLinkStatus } from './agent-link';
  import type { AgentHost, AgentHostState } from './agent-host';

  let { open, host, hostState, revision, onClose, onAvailable }: {
    open: boolean;
    host: AgentHost<any>;
    hostState: AgentHostState;
    revision: number | null;
    onClose: () => void;
    onAvailable?: (available: boolean) => void;
  } = $props();

  const connection = new McpConnection();
  let session = $state<McpSessionView | null>(null);
  let link: AgentLink | null = null;
  let linkStatus = $state<AgentLinkStatus | null>(null);
  let busy = $state(false);
  let errorText = $state('');
  let panel = $state<HTMLElement | null>(null);
  let disposed = false;
  const localDemo = $derived(!!session?.localDemo);
  const signedIn = $derived(!!session?.csrf);
  const phase = $derived(linkStatus?.phase ?? 'disconnected');
  const linked = $derived(!!linkStatus && ['connecting', 'connected', 'reconnecting'].includes(linkStatus.phase));
  const recent = $derived([...hostState.activity].reverse());

  async function refresh() {
    try {
      const view = await connection.session();
      if (disposed) return;
      session = view;
      onAvailable?.(!!view.localDemo);
    } catch (cause) {
      if (disposed) return;
      onAvailable?.(false);
      errorText = cause instanceof Error ? cause.message : 'Gagal memuat sesi.';
    }
  }

  async function connect() {
    const view = session;
    if (!view?.localDemo || !view.csrf || !view.defaultProject || linked) return;
    busy = true; errorText = '';
    try {
      // Same idempotent project open the MCP panel uses, then the project view for the relay URL.
      await connection.request('session', { method: 'POST', csrf: view.csrf, body: { projectId: view.defaultProject } });
      const project = await connection.session(view.defaultProject);
      if (!project.localDemo || !project.csrf || !project.draftWebSocketUrl) throw new Error('Layanan lokal Sibambo belum siap. Jalankan launcher lalu coba lagi.');
      link?.dispose();
      link = new AgentLink({
        projectId: view.defaultProject,
        csrf: project.csrf,
        url: agentUrlFromDraftUrl(project.draftWebSocketUrl),
        host,
        changed: (status) => { if (!disposed) linkStatus = status; }
      });
      linkStatus = link.status;
    } catch (cause) {
      errorText = cause instanceof Error ? cause.message : 'Gagal menghubungkan agent.';
    } finally { busy = false; }
  }

  function disconnect() {
    link?.dispose();
    link = null;
  }

  function time(at: number) {
    return new Date(at).toLocaleTimeString('id-ID', { hour12: false });
  }

  onMount(() => { void refresh(); });
  $effect(() => {
    if (open) {
      void refresh();
      void tick().then(() => panel?.querySelector<HTMLElement>('[data-agent-first]')?.focus());
    }
  });
  onDestroy(() => { disposed = true; link?.dispose(); link = null; connection.dispose(); });
</script>

<div bind:this={panel} class="mcp-panel agent-panel" role="dialog" tabindex="-1" aria-label="Agent" aria-modal="false" hidden={!open}
  data-agent-status={phase} data-authoring-revision={revision ?? ''} data-agent-paused={hostState.paused ? 'true' : 'false'}
  onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
  <div class="mcp-panel-head"><div><p class="mcp-eyebrow">Extensions</p><h2>Agent</h2></div>
    <button type="button" data-agent-first onclick={onClose} aria-label="Tutup panel Agent">Tutup</button>
  </div>
  {#if localDemo}<p class="mcp-warning" role="note" data-local-demo>MODE DEMO LOKAL · agent mengedit dokumen yang sedang Anda buka · loopback saja · bukan konfigurasi remote</p>{/if}
  {#if errorText}<p role="alert" class="mcp-error">{errorText}</p>{/if}
  {#if !localDemo}
    <p>Agent add-on hanya tersedia di mode demo lokal (jalankan <code>node tooling/local-demo/launch.mjs</code>).</p>
  {:else if !signedIn}
    <p>Masuk sebagai owner lokal terlebih dahulu. Tidak ada token disimpan di localStorage.</p>
    <a class="mcp-action" href="/api/mcp/login">Masuk (demo lokal)</a>
  {:else}
    <div class="mcp-status" role="status" aria-live="polite">
      <strong>Relay: {phase}</strong>
      {#if linkStatus?.error}<span>{linkStatus.error}</span>{/if}
      <span>Revisi dokumen: {revision ?? '—'} · Panggilan: {linkStatus?.calls ?? 0}{#if linkStatus?.lastCallAt} · terakhir {time(linkStatus.lastCallAt)}{/if}</span>
    </div>
    <div class="mcp-subsection">
      <div class="mcp-inline">
        {#if linked}
          <button type="button" onclick={disconnect}>Putuskan</button>
        {:else}
          <button type="button" disabled={busy} onclick={() => void connect()}>Hubungkan agent</button>
        {/if}
        <button type="button" aria-pressed={hostState.paused} onclick={() => host.setPaused(!hostState.paused)}>{hostState.paused ? 'Lanjutkan agent' : 'Jeda agent'}</button>
      </div>
      <p>{hostState.paused ? 'Agent dijeda: penulisan ditolak, pembacaan tetap boleh.' : 'Agent boleh menulis ke dokumen authoring yang terbuka.'}</p>
      <p>Writer aktif: <strong>{hostState.writer ?? 'tidak ada'}</strong></p>
    </div>
    <section class="mcp-subsection" aria-label="Aktivitas agent">
      <h3>Aktivitas (50 terakhir)</h3>
      {#if recent.length === 0}<p>Belum ada panggilan agent.</p>{/if}
      <ul class="mcp-list" data-agent-activity>
        {#each recent as row, index (index)}
          <li data-outcome={row.outcome}><small>{time(row.at)} · {row.slot || '—'} · {row.tool || '—'} · {row.outcome}{#if row.code} · {row.code}{/if} · {row.ms} ms</small></li>
        {/each}
      </ul>
    </section>
  {/if}
</div>
