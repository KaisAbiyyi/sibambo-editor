<script lang="ts">
  import type { McpConnection, RevisionRequest } from './connection';
  type Props = {
    client: McpConnection; projectId: string; csrf: string; requests: RevisionRequest[];
    onChanged: () => Promise<void>;
  };
  let { client, projectId, csrf, requests, onChanged }: Props = $props();
  let text = $state('');
  let ids = $state('');
  let format = $state<'instruction' | 'typed-parameters'>('instruction');
  let paramText = $state('');
  let sending = $state(false);
  let errorText = $state('');
  function typedParameters(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const item of paramText.split('\n').map(x => x.trim()).filter(Boolean)) {
      const match = /^([a-zA-Z][a-zA-Z0-9_]{0,63})\s*=\s*(-?(?:\d+\.?\d*|\.\d+))$/.exec(item);
      if (!match) throw new Error('Parameter harus berbentuk nama=angka, satu per baris.');
      const value = Number(match[2]);
      if (!Number.isFinite(value) || Math.abs(value) > 1e6 || Object.keys(out).length >= 16)
        throw new Error('Parameter melewati batas 16 nilai, maksimum absolut 1.000.000.');
      out[match[1]] = value;
    }
    if (format === 'typed-parameters' && Object.keys(out).length === 0) throw new Error('Isi minimal satu parameter.');
    return out;
  }
  async function act(action: 'create' | 'withdraw' | 'mark-read' | 'mark-addressed', requestId?: string) {
    sending = true; errorText = '';
    try {
      const moduleIds = ids.split(',').map(s => s.trim()).filter(Boolean);
      if (moduleIds.length > 8 || moduleIds.some(s => !/^[\w-]{1,64}$/.test(s))) throw new Error('Maksimal 8 ID modul yang valid.');
      const payload = action === 'create' ? {
        projectId, action, body: text.trim(), moduleIds, kind: format,
        parameters: format === 'typed-parameters' ? typedParameters() : {}
      } : { projectId, action, requestId };
      await client.mutate('requests', csrf, payload);
      if (action === 'create') { text = ''; ids = ''; paramText = ''; }
      await onChanged();
    } catch (e) { errorText = e instanceof Error ? e.message : 'Gagal membuat permintaan.'; }
    finally { sending = false; }
  }
</script>

<section class="mcp-subsection" aria-label="Inbox revisi owner">
  <h3>Minta revisi ke agent</h3>
  <p>Ini adalah pesan ke inbox agent, bukan izin menulis dan bukan perubahan BOMC otomatis.</p>
  <label for="mcp-request-kind">Jenis revisi</label>
  <select id="mcp-request-kind" bind:value={format}>
    <option value="instruction">Instruksi teks</option>
    <option value="typed-parameters">Parameter bertipe angka</option>
  </select>
  <label for="mcp-request-body">Pesan revisi</label>
  <textarea id="mcp-request-body" bind:value={text} rows="3" maxlength="2000" placeholder="Contoh: pindahkan bukaan ke sisi utara..." />
  <label for="mcp-request-modules">ID modul terkait (opsional, pisahkan koma)</label>
  <input id="mcp-request-modules" bind:value={ids} placeholder="wall-01, window-02" />
  {#if format === 'typed-parameters'}
    <label for="mcp-request-params">Parameter angka (satu nama=angka per baris)</label>
    <textarea id="mcp-request-params" bind:value={paramText} rows="3" placeholder="width=3.5&#10;height=2.8" />
  {/if}
  <button type="button" disabled={sending || !text.trim()} onclick={() => void act('create')}>Kirim permintaan revisi</button>
  {#if errorText}<p class="mcp-error" role="alert">{errorText}</p>{/if}
  <ul class="mcp-list" aria-label="Riwayat revisi">
    {#each requests as item (item.id)}
      <li><span>{item.body}</span><small>{item.status} · {item.moduleIds?.join(', ') ?? 'tanpa modul'}</small>
        {#if item.status === 'open'}<button type="button" disabled={sending} onclick={() => void act('withdraw', item.id)}>Tarik</button>{/if}
      </li>
    {/each}
  </ul>
</section>
