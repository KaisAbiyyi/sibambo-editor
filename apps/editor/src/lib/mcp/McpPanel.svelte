<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { McpConnection, McpScopeError, type McpSessionView, type Agent } from './connection';
  import OwnerRequests from './OwnerRequests.svelte';

  let { open, onClose, onConnect, onLogout, requestStatuses = [] }: { open: boolean; onClose: () => void; onConnect?: (session: McpSessionView) => void; onLogout?: () => void; requestStatuses?: Array<{ id: string; status: string }> } = $props();
  const client = new McpConnection();
  let session = $state<McpSessionView | null>(null);
  let projectId = $state('');
  let errorText = $state('');
  let busy = $state(false);
  let pairingConfirmation = $state<Record<string, string>>({});
  let panel = $state<HTMLElement | null>(null);
  let activeRead = 0;
  const grants = $derived((session?.grants ?? []).filter((x): x is Agent => !!x && !!x.id && !!x.agentSubject && !!x.clientId));
  const pending = $derived((session?.pending ?? []).filter((x): x is Agent => !!x && !!x.id && !!x.agentSubject && !!x.clientId));
  const selectedProject = $derived(session?.projectId ?? '');
  const isSignedIn = $derived(!!session?.csrf);
  const stateName = $derived(session?.phase ?? 'disconnected');
  const isLocalDemo = $derived(!!session?.localDemo);
  const liveRequests = $derived((session?.requests ?? []).map(item => ({ ...item,
    status: (requestStatuses.find(status => status.id === item.id)?.status ?? item.status) as typeof item.status })));

  async function refresh() {
    const seq = ++activeRead;
    errorText = '';
    try {
      const result = await client.session(projectId || undefined);
      if (seq === activeRead) { session = result; if (result.localDemo && result.csrf && result.defaultProject && !projectId) projectId = result.defaultProject; }
    } catch (err) {
      if (seq === activeRead) failClosed(err, 'Gagal memuat sesi.');
    }
  }
  // A wrong-project response must never leave a project view behind that owner actions could target.
  function failClosed(err: unknown, fallback: string) {
    errorText = err instanceof Error ? err.message : fallback;
    if (err instanceof McpScopeError && session) {
      session = { contract: session.contract, phase: 'error', csrf: session.csrf, subject: session.subject, serviceReady: session.serviceReady };
    }
  }
  async function perform(path: 'grants' | 'pause' | 'requests', body: { projectId: string } & Record<string, unknown>) {
    if (!session?.csrf) return;
    busy = true; errorText = '';
    try {
      await client.mutate(path, session.csrf, body);
      await refresh();
    } catch (err) { failClosed(err, 'Aksi ditolak.'); }
    finally { busy = false; }
  }
  async function logout() {
    if (!session?.csrf) return;
    busy = true; errorText = '';
    try {
      await client.logout(session.csrf);
      projectId = ''; session = null;
      await refresh();
    } catch (err) { failClosed(err, 'Aksi ditolak.'); }
    finally { onLogout?.(); busy = false; }
  }
  async function chooseProject() {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(projectId)) { errorText = 'ID proyek 1–64 karakter: huruf, angka, minus, garis bawah.'; return; }
    busy = true;
    try {
      if (session?.csrf) await client.request('session', { method: 'POST', csrf: session.csrf, body: { projectId } });
      await refresh();
    } catch (err) { failClosed(err, 'Gagal membuka proyek.'); } finally { busy = false; }
  }
  function grantAction(agent: Agent, action: 'approve' | 'deny' | 'revoke' | 'remove') {
    const code = (pairingConfirmation[agent.id] ?? '').trim().toUpperCase();
    if (action === 'approve' && (!agent.expiresAt || !Number.isFinite(Date.parse(agent.expiresAt)) || Date.parse(agent.expiresAt) <= Date.now())) {
      errorText = 'Permintaan pairing kedaluwarsa atau tidak mempunyai batas waktu valid. Mulai pairing baru.'; return;
    }
    if (action === 'approve' && !/^[A-Z2-9]{8}$/.test(code)) {
      errorText = 'Cocokkan dan ketik kode pasangan 8 karakter dari aplikasi agent.'; return;
    }
    void perform('grants', { projectId: selectedProject, action, grantId: agent.id,
      agentSubject: agent.agentSubject, clientId: agent.clientId, scopes: agent.scopes,
      ...(action === 'approve' ? { confirmationCode: code } : {}) });
  }
  function close() { onClose(); }
  $effect(() => {
    if (open) {
      void refresh();
      void tick().then(() => panel?.querySelector<HTMLElement>('[data-mcp-first]')?.focus());
    }
  });
  onDestroy(() => { activeRead += 1; client.dispose(); });
</script>

<div bind:this={panel} class="mcp-panel" role="dialog" tabindex="-1" aria-label="MCP Extension" aria-modal="false" hidden={!open} onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
  <div class="mcp-panel-head"><div><p class="mcp-eyebrow">Extensions</p><h2>MCP Extension</h2></div>
    <button type="button" data-mcp-first onclick={close} aria-label="Tutup MCP Extension">Tutup</button>
  </div>
  <p class="mcp-help">Kelola koneksi Claude Code / Codex ke proyek Sibambo. Semua izin harus disetujui owner.</p>
  <div class="mcp-status" role="status" aria-live="polite"><strong>Status: {stateName}</strong>
    {#if session?.paused}<span>Proyek dijeda — semua penulisan harus ditolak oleh server.</span>{/if}
  </div>
  {#if isLocalDemo}<p class="mcp-warning" role="note" data-local-demo>MODE DEMO LOKAL · loopback saja · tanpa Auth0 · bukan konfigurasi remote/produksi</p>{/if}
  {#if errorText}<p role="alert" class="mcp-error">{errorText}</p>{/if}
  {#if !isSignedIn}
    {#if session?.configured}
      {#if isLocalDemo}
        <p>Mode demo lokal: satu klik membuat sesi owner di mesin ini. Tidak ada token disimpan di localStorage.</p>
        <a class="mcp-action" href="/api/mcp/login">Masuk (demo lokal)</a>
      {:else}
      <p>Masuk sebagai owner lewat penyedia identitas yang dikonfigurasi. Tidak ada token disimpan di localStorage.</p>
      <a class="mcp-action" href="/api/mcp/login">Masuk dengan OIDC</a>
      {/if}
    {:else}
      <p class="mcp-warning">OIDC belum dikonfigurasi. Hubungi operator untuk mengatur nonproduction Auth0 terlebih dahulu.</p>
      <button type="button" onclick={() => void refresh()}>Periksa ulang konfigurasi</button>
    {/if}
  {:else}
    <div class="mcp-subsection">
      <p>Akun terverifikasi: <code class="mcp-identity">{session?.subject}</code></p>
      <button type="button" disabled={busy} onclick={() => void logout()}>Keluar dari sesi owner</button>
      <label for="mcp-project">ID proyek (hanya proyek yang diizinkan server)</label>
      <div class="mcp-inline"><input id="mcp-project" bind:value={projectId} maxlength="64" autocomplete="off" placeholder="contoh-proyek-01" />
        <button type="button" disabled={busy || !projectId.trim()} onclick={() => void chooseProject()}>Buka proyek</button></div>
    </div>
    {#if selectedProject}
      <div class="mcp-subsection">
        <h3>{session?.projectName ?? selectedProject}</h3>
        <p>Kapabilitas dari server: {(session?.capabilities ?? []).join(', ') || 'tidak tersedia'}</p>
        <p>Writer aktif: <strong>{session?.writer ?? 'tidak ada'}</strong></p>
        <p>Revisi diterima: {session?.seenRevision ?? '—'} · Revisi tergambar: {session?.renderedRevision ?? '—'}</p>
        {#if session?.draftWebSocketUrl}<button type="button" disabled={busy} onclick={() => session && onConnect?.(session)}>Hubungkan draft live</button>{/if}
        <div class="mcp-inline">
          <button type="button" disabled={busy} onclick={() => void perform('pause', {projectId: selectedProject, paused: !session?.paused})}>{session?.paused ? 'Lanjutkan proyek' : 'Jeda semua perubahan'}</button>
          <button type="button" disabled={busy} onclick={() => void refresh()}>Segarkan status</button>
        </div>
      </div>
      <section class="mcp-subsection" aria-label="Agent meminta izin">
        <h3>Permintaan pasangan dan izin</h3>
        <p>Baca <strong>client ID</strong> dan <strong>subject</strong> asli. Nama tampilan bukan bukti identitas. Kode hanya untuk dibandingkan secara manusia; OAuth dan grant eksplisit tetap wajib.</p>
        {#if pending.length === 0}<p>Belum ada agent menunggu persetujuan.</p>{/if}
        <ul class="mcp-list">
          {#each pending as agent (agent.id)}
            <li><strong>{agent.displayName ?? 'Agent baru'}</strong>
              <small>Subject: <code>{agent.agentSubject}</code></small>
              <small>Client: <code>{agent.clientId}</code></small>
              <small>Scopes: {agent.scopes.join(', ')} · Batas waktu: {agent.expiresAt ?? 'tidak tersedia'}</small>
              {#if !agent.expiresAt || !Number.isFinite(Date.parse(agent.expiresAt)) || Date.parse(agent.expiresAt) <= Date.now()}<small role="status">Pairing kedaluwarsa — minta agent mengulang OAuth.</small>{/if}
              <label for={'mcp-code-' + agent.id}>Kode 8 karakter yang tampil di agent</label>
              <input id={'mcp-code-' + agent.id} value={pairingConfirmation[agent.id] ?? ''} oninput={(e) => pairingConfirmation[agent.id] = e.currentTarget.value} maxlength="8" autocomplete="off" autocapitalize="characters" />
              <div class="mcp-inline">
                <button type="button" disabled={busy || !!session?.paused || !agent.expiresAt || !Number.isFinite(Date.parse(agent.expiresAt)) || Date.parse(agent.expiresAt) <= Date.now()} onclick={() => grantAction(agent,'approve')}>Izinkan scope tepat ini</button>
                <button type="button" disabled={busy} onclick={() => grantAction(agent,'deny')}>Tolak</button>
              </div>
            </li>
          {/each}
        </ul>
      </section>
      <section class="mcp-subsection" aria-label="Agent telah diberi izin">
        <h3>Agent terotorisasi</h3>
        {#if grants.length === 0}<p>Belum ada grant. Write selalu ditolak sampai disetujui server.</p>{/if}
        <ul class="mcp-list">
          {#each grants as agent (agent.id)}
            <li><strong>{agent.displayName ?? 'Agent'}</strong>
              <small>Subject: <code>{agent.agentSubject}</code> · Client: <code>{agent.clientId}</code></small>
              <small>Hak: {agent.scopes.join(', ')} · {agent.state ?? 'status server'}</small>
              <div class="mcp-inline">
                <button type="button" disabled={busy} onclick={() => grantAction(agent,'revoke')}>Cabut akses</button>
                <button type="button" disabled={busy} onclick={() => grantAction(agent,'remove')}>Hapus</button>
              </div>
            </li>
          {/each}
        </ul>
      </section>
      <OwnerRequests {client} projectId={selectedProject} csrf={session?.csrf ?? ''} requests={liveRequests} onChanged={refresh} />
      <section class="mcp-subsection" aria-label="Panduan agent">
        <h3>Cara menghubungkan agent</h3>
        <p>Daftarkan server MCP HTTPS dan lakukan OAuth melalui aplikasi resmi; jangan salin bearer token atau client secret ke command, URL, atau screenshot.</p>
        <a href="https://docs.anthropic.com/en/docs/claude-code/mcp" target="_blank" rel="noreferrer">Panduan Claude Code</a>
        <a href="https://developers.openai.com/codex/mcp/" target="_blank" rel="noreferrer">Panduan Codex MCP</a>
      </section>
    {/if}
  {/if}
</div>
