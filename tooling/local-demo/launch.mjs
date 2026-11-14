#!/usr/bin/env node
// Sibambo LOCAL DEMO launcher (master SIB-TWO-PHASE-001 v1.6). One command starts the canonical service,
// the Editor and the per-client MCP configuration. Loopback only; no Auth0, tunnel, hosting or certificate.
//   node tooling/local-demo/launch.mjs [--run-root D:\...] [--python <python.exe>] [--builder <repo>] [--project local-demo]
//                                       [--rebuild] [--no-build] [--replace-task-owned]
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) fail(`Unexpected argument ${a}`);
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) { args.set(a.slice(2), next); i++; } else args.set(a.slice(2), true);
}
const flag = (n) => args.get(n) === true;
const opt = (n, d) => (typeof args.get(n) === 'string' ? args.get(n) : d);
function fail(message) { console.error('LOCAL DEMO: ' + message); process.exit(2); }

export const PORTS = { service: 8765, editor: 5175 };
const project = opt('project', 'local-demo');
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(project)) fail('invalid --project');
const runRoot = path.resolve(opt('run-root', process.platform === 'win32' ? 'D:\\projects\\sibambo\\scratch\\local-demo-run' : path.join(editorRoot, '.local-demo-run')));
if (process.platform === 'win32' && /^c:/i.test(runRoot)) fail('run root must not be on C: (workspace storage rule)');
const builder = path.resolve(opt('builder', path.join(editorRoot, '..', 'sibambo-bomc-builder')));
const python = opt('python', process.env.SIBAMBO_PYTHON ?? '');
if (!python || !fs.existsSync(python)) fail('give --python <interpreter with the Builder service requirements> or set SIBAMBO_PYTHON');
if (!fs.existsSync(path.join(builder, 'service', 'local_demo.py'))) fail('Builder checkout with service/local_demo.py not found: ' + builder);
const editorApp = path.join(editorRoot, 'apps', 'editor');

for (const dir of ['private', 'tmp', 'logs', 'agents', 'agent-workspace']) fs.mkdirSync(path.join(runRoot, dir), { recursive: true });
const secretFile = (name, make) => {
  const file = path.join(runRoot, 'private', name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, make(), { encoding: 'utf8', flag: 'wx' });
  return fs.readFileSync(file, 'utf8').trim();
};
const ownerToken = secretFile('owner-token', () => randomBytes(32).toString('base64url'));
const sessionKey = secretFile('session-key', () => randomBytes(32).toString('base64url'));

const ledgerFile = path.join(runRoot, 'pids.json');
const ledger = () => { try { return JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); } catch { return {}; } };
function ps(command) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}
function portOwner(port) {
  if (process.platform !== 'win32') return null;
  const out = ps(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`);
  const pid = Number(out);
  if (!pid) return null;
  return { pid, commandLine: ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`) };
}
const listening = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false)); s.setTimeout(800, () => { s.destroy(); resolve(false); });
});
for (const [name, port] of Object.entries(PORTS)) {
  if (!(await listening(port))) continue;
  const owner = portOwner(port), recorded = Object.values(ledger()).filter((x) => typeof x === 'number');
  if (owner && recorded.includes(owner.pid) && flag('replace-task-owned')) {
    console.log(`Stopping previous task-owned ${name} (pid ${owner.pid}).`);
    spawnSync('taskkill', ['/PID', String(owner.pid), '/T', '/F']);
    await new Promise((r) => setTimeout(r, 800));
    if (await listening(port)) fail(`port ${port} is still busy after stopping the recorded process`);
  } else {
    fail(`port ${port} (${name}) is busy${owner ? ` — pid ${owner.pid}: ${owner.commandLine.slice(0, 160)}` : ''}. Not a recorded child of this launcher; nothing was touched` +
      (recorded.length ? '. Use --replace-task-owned for a recorded previous run.' : '.'));
  }
}

const wsOrigin = `ws://127.0.0.1:${PORTS.service}`;
const base = { ...process.env, TEMP: path.join(runRoot, 'tmp'), TMP: path.join(runRoot, 'tmp'), TMPDIR: path.join(runRoot, 'tmp') };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete base[k];
const children = [];
const log = (name) => fs.openSync(path.join(runRoot, 'logs', `${name}.log`), 'w');
let stopping = false;
function stopAll(code = 0) {
  if (stopping) return; stopping = true;
  for (const c of children) { try { spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F']); } catch { /* already gone */ } }
  for (const f of ['claude.mcp.json', 'codex.overrides.json']) fs.rmSync(path.join(runRoot, 'agents', f), { force: true });
  for (const f of fs.readdirSync(path.join(runRoot, 'private'))) if (f.startsWith('bridge-')) fs.rmSync(path.join(runRoot, 'private', f), { force: true });
  const manifest = path.join(runRoot, 'manifest.json');
  if (fs.existsSync(manifest)) fs.renameSync(manifest, path.join(runRoot, 'manifest.last.json'));
  fs.rmSync(ledgerFile, { force: true });
  console.log('Stopped. Agent configs and bridge secrets removed.');
  process.exit(code);
}
process.on('SIGINT', () => stopAll(0)); process.on('SIGTERM', () => stopAll(0));

// 1. canonical service + bridges + client configs
fs.rmSync(path.join(runRoot, 'manifest.json'), { force: true });
const serviceLog = log('service');
const service = spawn(python, ['-m', 'service.local_demo', '--run-root', runRoot, '--project', project, '--port', String(PORTS.service)], {
  cwd: builder, windowsHide: true, stdio: ['ignore', 'pipe', serviceLog],
  env: { ...base, PYTHONPATH: builder, PYTHONDONTWRITEBYTECODE: '1', SIBAMBO_LOCAL_OWNER_TOKEN: ownerToken }
});
children.push(service);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('service did not become ready in 60 s (see logs/service.log)')), 60000);
  let buf = '';
  service.stdout.on('data', (d) => { buf += d; if (buf.includes('LOCAL_DEMO_READY')) { clearTimeout(timer); resolve(); } });
  service.on('exit', (c) => { clearTimeout(timer); reject(new Error(`service exited with code ${c} (see logs/service.log)`)); });
}).catch((e) => { console.error('LOCAL DEMO: ' + e.message); stopAll(2); });
service.on('exit', (c) => { if (!stopping) { console.error(`service exited (${c})`); stopAll(2); } });

// 2. Editor build (explicit local build: CSP allows exactly the loopback ws origin)
const git = (...a) => spawnSync('git', ['-C', editorRoot, ...a], { encoding: 'utf8' }).stdout ?? '';
const stampValue = JSON.stringify({ ws: wsOrigin, head: git('rev-parse', 'HEAD').trim(),
  tree: createHash('sha256').update(git('diff', 'HEAD', '--', 'apps/editor/src', 'apps/editor/svelte.config.js', 'packages')).digest('hex') });
const stampFile = path.join(editorApp, 'build', '__local_demo.json');
const upToDate = fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stampValue;
if (!flag('no-build') && (flag('rebuild') || !upToDate)) {
  console.log('Building the Editor in local-demo mode…');
  const built = spawnSync('bun', ['run', 'build'], { cwd: editorApp, shell: true, stdio: ['ignore', fs.openSync(path.join(runRoot, 'logs', 'editor-build.log'), 'w'), 'inherit'],
    env: { ...base, SIBAMBO_LOCAL_DEMO: '1', SE05_DRAFT_WS_ORIGIN: wsOrigin } });
  if (built.status !== 0) { console.error('LOCAL DEMO: Editor build failed (see logs/editor-build.log)'); stopAll(2); }
  fs.writeFileSync(stampFile, stampValue);
}
if (!fs.existsSync(path.join(editorApp, 'build', 'index.js'))) { console.error('LOCAL DEMO: no Editor build; run without --no-build'); stopAll(2); }

// 3. Editor server
const editorLog = log('editor');
const editor = spawn(process.execPath, ['build/index.js'], { cwd: editorApp, windowsHide: true, stdio: ['ignore', editorLog, editorLog],
  env: { ...base, HOST: '127.0.0.1', PORT: String(PORTS.editor), ORIGIN: `http://localhost:${PORTS.editor}`, SE04_LOCAL_DEMO: '1',
    SE04_LOCAL_OWNER_TOKEN: ownerToken, SE04_SESSION_KEY: sessionKey, SE04_SERVICE_BASE_URL: `http://127.0.0.1:${PORTS.service}`,
    SE05_DRAFT_WS_ORIGIN: wsOrigin, SE04_LOCAL_PROJECT: project } });
children.push(editor);
editor.on('exit', (c) => { if (!stopping) { console.error(`Editor exited (${c}); see logs/editor.log`); stopAll(2); } });
for (let i = 0; ; i++) {
  if (i > 120) { console.error('LOCAL DEMO: Editor did not answer within 60 s'); stopAll(2); }
  try { const r = await fetch(`http://127.0.0.1:${PORTS.editor}/`); if (r.ok) break; } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 500));
}
fs.writeFileSync(ledgerFile, JSON.stringify({ launcher: process.pid, service: service.pid, editor: editor.pid }));

const manifest = JSON.parse(fs.readFileSync(path.join(runRoot, 'manifest.json'), 'utf8'));
console.log(`
LOCAL DEMO READY  (loopback only · no Auth0 · model inference by Claude/Codex stays cloud-hosted: this is NOT air-gapped)
  Editor    http://localhost:${PORTS.editor}   → Extensions → MCP Extension… → "Masuk (demo lokal)" → Buka proyek "${project}" → Hubungkan draft live
  Project   ${project}   epoch ${manifest.epoch}
  Agents    ${path.join(runRoot, 'agents', 'claude.mcp.json')}
            ${path.join(runRoot, 'agents', 'codex.overrides.json')}
  Run agent node tooling/local-demo/run-agent.mjs claude|codex <probe|build|verify|revise-inbox|opening|contention> --run-root "${runRoot}"
  Logs      ${path.join(runRoot, 'logs')}
Press Ctrl+C to stop (removes agent configs and bridge secrets).`);
setInterval(() => {}, 1 << 30);
