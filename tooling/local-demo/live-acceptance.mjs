#!/usr/bin/env node
// LOCAL-FUNCTIONAL acceptance (master v1.6, rows LF-4…LF-12) with REAL Claude Code and Codex against a RUNNING launcher.
// The viewer is a real headless Chromium (visible page, real WebGL pixels) so presence/ACK rules apply exactly as for a human.
// Every row is recorded PASS/FAIL with metadata only (no model payload, no owner text in logs beyond the fixed test sentence).
//   node tooling/local-demo/live-acceptance.mjs --run-root <dir> [--out <dir>]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const editorApp = path.resolve(here, '..', '..', 'apps', 'editor');
const named = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const runRoot = path.resolve(named('run-root', 'D:\\projects\\sibambo\\scratch\\local-demo-run'));
const outDir = path.resolve(named('out', 'D:\\projects\\sibambo\\outputs\\2026-11-14-local-mcp-live-viewer'));
if (/^c:/i.test(runRoot) || /^c:/i.test(outDir)) throw new Error('Paths must not be on C:.');
fs.mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(runRoot, 'manifest.json'), 'utf8'));
const project = manifest.project;
const stamp = Date.now();
const require = createRequire(path.join(editorApp, 'package.json'));
const pwCore = createRequire(require.resolve('@playwright/test')).resolve('playwright-core');
const pwModule = await import(pathToFileURL(pwCore).href);
const chromium = pwModule.chromium ?? pwModule.default.chromium;

const rows = [];
const row = (id, verdict, detail = {}) => { rows.push({ id, verdict, ...detail }); console.log(`${verdict.padEnd(5)} ${id} ${JSON.stringify(detail).slice(0, 300)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000, step = 100) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return null; await sleep(step); } };

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: 'http://localhost:5175' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

const status = (p) => p.evaluate(() => {
  const el = document.querySelector('.draft-live-status');
  return el ? { ...el.dataset, text: el.innerText.split('\n')[0] } : null;
});
const shot = async (p, name) => { const f = path.join(outDir, `${stamp}-${name}.png`); await p.screenshot({ path: f }); return f; };
const openMcpPanel = (p) => p.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('MCP Extension…'))?.click());
async function signInAndAttach(p) {
  await p.goto('/');
  for (let round = 0; round < 3; round++) {
    const state = await until(async () => {
      await openMcpPanel(p); await sleep(700);
      if (await p.getByRole('button', { name: 'Hubungkan draft live' }).count()) return 'ready';
      if (await p.getByRole('link', { name: 'Masuk (demo lokal)' }).count()) return 'login';
      return null;
    }, 20000, 300);
    if (state === 'login') { await p.getByRole('link', { name: 'Masuk (demo lokal)' }).click(); await p.waitForURL(/mcp=connected/); continue; }
    if (state === 'ready') break;
  }
  await p.getByRole('button', { name: 'Hubungkan draft live' }).click();
  return until(async () => { const s = await status(p); return s && s.revision !== undefined ? s : null; }, 20000);
}
async function reattach(p) {
  
}
function runAgent(client, testCase) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, 'run-agent.mjs'), client, testCase, '--run-root', runRoot, '--out', outDir], { windowsHide: true });
    let result = null, buf = '';
    child.stdout.on('data', (d) => { buf += d; for (const line of buf.split('\n')) { try { const v = JSON.parse(line); if (v.event === 'finished') result = v; } catch { /* partial */ } } });
    child.on('close', () => resolve(result));
  });
}
function bridgeFrame(client, tool, args = {}) {            // scripted holder of the OTHER client's writer lease (support, not proof)
  const cfg = JSON.parse(fs.readFileSync(path.join(runRoot, 'agents', 'claude.mcp.json'), 'utf8')).mcpServers[manifest.serverName].env;
  const [host, port] = cfg.SIBAMBO_BRIDGE_ADDR.split(':');
  const secret = fs.readFileSync(cfg.SIBAMBO_BRIDGE_SECRET_FILE, 'utf8').trim();
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port: Number(port) }, () => s.write(JSON.stringify({ secret, id: 1, tool, args }) + '\n'));
    let buf = ''; s.on('data', (d) => { buf += d; if (buf.includes('\n')) { s.destroy(); try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } } });
    s.on('error', reject); s.setTimeout(8000, () => { s.destroy(); reject(new Error('bridge timeout')); });
  });
}
const requestList = (p) => p.locator('ul[aria-label="Riwayat revisi"]').innerText().catch(() => '');
async function openPanel(p) { await openMcpPanel(p); await sleep(600); }

try {
  // LF-1/2/11 viewer attached over plain loopback WebSocket, no Auth0
  const s0 = await signInAndAttach(page);
  row('LF-1+2 one-click sign-in + attach (no Auth0/TLS)', s0 && s0.revision === '0' && /Viewer utama/.test(s0.text) ? 'PASS' : 'FAIL', { status: s0 });

  // LF-3 generated client configs carry no secret
  const cfgText = ['claude.mcp.json', 'codex.overrides.json'].map((f) => fs.readFileSync(path.join(runRoot, 'agents', f), 'utf8')).join('\n');
  const ownerToken = fs.readFileSync(path.join(runRoot, 'private', 'owner-token'), 'utf8').trim();
  row('LF-3 client configs contain no bridge secret and no owner token', !/[0-9a-f]{64}/.test(cfgText) && !cfgText.includes(ownerToken) ? 'PASS' : 'FAIL', { files: 2 });

  // LF-4 Claude discovers and reads, guide delivered through MCP
  const probe = await runAgent('claude', 'probe');
  row('LF-4 Claude Code discovers eight tools, reads, receives guide v2 via MCP', probe?.finalResult?.outcome === 'pass' ? 'PASS' : 'FAIL', { receipt: probe?.receipt, totalMs: probe?.totalMs, firstToolMs: probe?.firstToolMs });

  // LF-5 Claude builds the room
  const build = await runAgent('claude', 'build');
  const s1 = await until(async () => { const s = await status(page); return s?.renderedRevision === '1' ? s : null; }, 10000);
  await shot(page, 'viewer-rev1-claude-room');
  row('LF-5 Claude Code builds room; viewer shows accepted=rendered=1, one module', build?.finalResult?.outcome === 'pass' && s1 && s1.moduleCount === '1' && s1.revision === '1' ? 'PASS' : 'FAIL', { receipt: build?.receipt, notes: build?.finalResult?.notes, viewer: s1 });

  const ir = await bridgeFrame('claude', 'inspect_module', { moduleId: 'room/demo/main-room', includeIr: true });
  let dims = null;
  if (ir.ok) {
    const walls = ir.result.module.operations.filter((o) => o.kind === 'wall-run'), pts = walls.flatMap((w) => w.path), t = Math.max(...walls.map((w) => w.thickness));
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    dims = { wallThicknessM: t, centrelineSpanM: [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)].map((v) => +v.toFixed(3)),
      internalClearM: [Math.max(...xs) - Math.min(...xs) - t, Math.max(...ys) - Math.min(...ys) - t].map((v) => +v.toFixed(3)), wallHeightM: Math.max(...walls.map((w) => w.height)), openings: ir.result.module.operations.filter((o) => o.kind === 'opening-cut').length };
  }
  const dimOk = dims && Math.abs(dims.wallThicknessM - 0.15) < 0.011 && Math.abs(dims.wallHeightM - 2.7) < 0.011 &&
    ((Math.abs(dims.internalClearM[0] - 4) < 0.011 && Math.abs(dims.internalClearM[1] - 3) < 0.011) || (Math.abs(dims.centrelineSpanM[0] - 4) < 0.011 && Math.abs(dims.centrelineSpanM[1] - 3) < 0.011));
  row('LF-5b measured dimensions from committed IR match 4 x 3 x 2.7 m, t=0.15 (internal-clear or centre-line, as the agent declared)', dimOk ? 'PASS' : 'FAIL', { dims });

  // LF-6 Codex reads/inspects the same room incl. IR
  const verify1 = await runAgent('codex', 'verify');
  row('LF-6 Codex reads+inspects (includeIr) the same canonical room', verify1?.finalResult?.outcome === 'pass' && verify1.finalResult.moduleIds.includes('room/demo/main-room') ? 'PASS' : 'FAIL', { receipt: verify1?.receipt, notes: verify1?.finalResult?.notes });

  // LF-7 inbox → Codex revision with requestId → addressed only after ACK
  await openPanel(page);
  await page.locator('#mcp-request-body').fill('Please make the room 4.5 m long (internal length along X) and keep everything else.');
  await page.locator('#mcp-request-modules').fill('room/demo/main-room');
  await page.getByRole('button', { name: 'Kirim permintaan revisi' }).click();
  const open1 = await until(async () => /open/.test(await requestList(page)), 6000);
  const revise = await runAgent('codex', 'revise-inbox');
  const s2 = await until(async () => { const s = await status(page); return s?.renderedRevision === '2' ? s : null; }, 10000);
  const addressed = await until(async () => /addressed/.test(await requestList(page)), 8000);
  await shot(page, 'viewer-rev2-inbox-revision');
  row('LF-7 Codex answers owner request with requestId; request addressed after render ACK', open1 && revise?.finalResult?.outcome === 'pass' && revise.finalResult.requestIds.length === 1 && addressed && s2 && s2.moduleCount === '1' ? 'PASS' : 'FAIL',
    { receipt: revise?.receipt, requestIds: revise?.finalResult?.requestIds, listBefore: open1, addressedSeen: !!addressed, viewer: s2 });

  // LF-8 opening by Claude on the revised room
  const opening = await runAgent('claude', 'opening');
  const s3 = await until(async () => { const s = await status(page); return s?.renderedRevision === '3' ? s : null; }, 10000);
  await shot(page, 'viewer-rev3-window');
  row('LF-8 Claude Code adds one window; viewer rendered=3, still one module', opening?.finalResult?.outcome === 'pass' && s3 && s3.moduleCount === '1' ? 'PASS' : 'FAIL', { receipt: opening?.receipt, notes: opening?.finalResult?.notes, viewer: s3 });

  // LF-9 both validate same draft
  const v2 = await runAgent('claude', 'verify'), v3 = await runAgent('codex', 'verify');
  row('LF-9 both clients read+validate the same final draft (valid/compiled)', v2?.finalResult?.outcome === 'pass' && v3?.finalResult?.outcome === 'pass' && v2.finalResult.revision === 3 && v3.finalResult.revision === 3 ? 'PASS' : 'FAIL',
    { claude: v2?.receipt, codex: v3?.receipt, claudeNotes: v2?.finalResult?.notes, codexNotes: v3?.finalResult?.notes });

  // LF-10 writer contention: scripted holder = claude principal, real Codex tries
  const held = await bridgeFrame('claude', 'acquire_writer');
  let keep = setInterval(() => bridgeFrame('claude', 'acquire_writer').catch(() => {}), 5000);
  const contention = await runAgent('codex', 'contention');
  clearInterval(keep);
  if (held.ok) await bridgeFrame('claude', 'release_writer', { fence: held.result.fence }).catch(() => {});
  row('LF-10 writer contention: real Codex is refused while the other client holds the lease', held.ok && contention?.finalResult?.codes?.includes('LEASE_HELD') ? 'PASS' : 'FAIL', { holder: held.ok, receipt: contention?.receipt, codes: contention?.finalResult?.codes });

  // LF-11 pause/resume
  await openPanel(page);
  await page.getByRole('button', { name: 'Jeda semua perubahan' }).click(); await sleep(800);
  const paused = await runAgent('codex', 'contention');
  await page.getByRole('button', { name: 'Lanjutkan proyek' }).click(); await sleep(800);
  const resumed = await runAgent('codex', 'contention');
  row('LF-11a pause: real Codex gets PAUSED_BY_OWNER; resume: lease is granted', paused?.finalResult?.codes?.includes('PAUSED_BY_OWNER') && resumed?.finalResult?.outcome === 'pass' ? 'PASS' : 'FAIL',
    { paused: paused?.receipt, resumed: resumed?.receipt, pausedCodes: paused?.finalResult?.codes, resumedCodes: resumed?.finalResult?.codes });

  // LF-11b second tab primary/follower; same counts; no duplicate module
  const page2 = await context.newPage();
  const t2 = await signInAndAttach(page2);
  await sleep(1500);
  const a = await status(page), b = await status(page2);
  await shot(page2, 'viewer-second-tab');
  row('LF-11b two tabs: latest is primary, earlier is read-only follower, both show rev 3 / one module', b && /Viewer utama/.test(b.text) && a && /Pengikut/.test(a.text) && a.revision === '3' && b.revision === '3' && a.moduleCount === '1' && b.moduleCount === '1' ? 'PASS' : 'FAIL', { first: a, second: b });
  await page2.close();

  // LF-11c reload + reattach: snapshot, no duplication
  await sleep(1000);
  await page.reload();
  const s4 = await (async () => { await until(async () => { await openMcpPanel(page); await sleep(700); return page.getByRole('button', { name: 'Hubungkan draft live' }).count(); }, 20000, 300); await page.getByRole('button', { name: 'Hubungkan draft live' }).click(); return until(async () => { const s = await status(page); return s && s.revision === '3' && s.renderedRevision === '3' ? s : null; }, 20000); })();
  await shot(page, 'viewer-after-reload');
  row('LF-11c reload + reattach: server snapshot restores rev 3, one module (no duplicate walls)', s4 && s4.moduleCount === '1' ? 'PASS' : 'FAIL', { viewer: s4 });

  // LF-11d browser network drop and restore (emulated by the browser: not a physical interruption)
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await sleep(7000);
  const offlineView = await status(page);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const recovered = await until(async () => { const s = await status(page); return s && /live/.test(s.text) && s.revision === '3' ? s : null; }, 40000, 300);
  row('LF-11d emulated network drop/restore: last frame kept, recovers to rev 3 / one module (physical interruption stays a manual gate)', recovered && recovered.moduleCount === '1' ? 'PASS' : 'FAIL', { whileOffline: offlineView?.text, recovered });

  // LF-12 counters
  const final = await page.evaluate(() => { const el = document.querySelector('.draft-live-status'); return el ? { ...el.dataset } : null; });
  const panelText = await page.evaluate(() => document.querySelector('.mcp-panel')?.innerText ?? '');
  row('LF-12 accepted == rendered revision at the end', final && final.revision === final.renderedRevision ? 'PASS' : 'FAIL', { final, panelCounters: (panelText.match(/Revisi diterima: \d+ · Revisi tergambar: \d+/) ?? [])[0] });
} catch (e) {
  row('HARNESS-ERROR', 'FAIL', { message: String(e).slice(0, 300) });
} finally {
  const receipt = { schemaVersion: 1, kind: 'local-functional-live-acceptance', recordedAt: new Date(stamp).toISOString(), project, epoch: manifest.epoch,
    viewer: 'headless Chromium (real WebGL), visible page', clients: 'real Claude Code + real Codex, cloud-hosted model inference', pageErrors: errors.slice(0, 5), rows,
    limits: ['single sample per row; no percentile', 'localhost; no cloud/serverless performance claim', 'not air-gapped', 'human visual judgement is a separate owner gate'] };
  const file = path.join(outDir, `${stamp}-live-acceptance-receipt.json`);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2));
  console.log('RECEIPT ' + file);
  await browser.close();
  process.exit(rows.some((r) => r.verdict === 'FAIL') ? 1 : 0);
}
