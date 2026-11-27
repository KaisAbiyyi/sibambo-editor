#!/usr/bin/env node
// Runs a REAL Claude Code or Codex against the local demo's canonical actor and writes a METADATA-ONLY receipt.
// Raw model output, tool payloads, owner request text, guide and tokens stay in memory and are never logged or saved.
//   node tooling/local-demo/run-agent.mjs <claude|codex> <probe|build|verify|revise-inbox|opening|contention> --run-root <dir> [--out <dir>]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const named = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const [client, testCase] = positional;
if (!['claude', 'codex'].includes(client)) throw new Error('Choose claude or codex.');
const runRoot = path.resolve(named('run-root', process.platform === 'win32' ? 'D:\\projects\\sibambo\\scratch\\local-demo-run' : '.local-demo-run'));
const outDir = path.resolve(named('out', process.platform === 'win32' ? 'D:\\projects\\sibambo\\outputs\\2026-11-14-local-mcp-live-viewer' : path.join(runRoot, 'receipts')));
if (process.platform === 'win32' && (/^c:/i.test(runRoot) || /^c:/i.test(outDir))) throw new Error('Paths must not be on C:.');
fs.mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(runRoot, 'manifest.json'), 'utf8'));
const SERVER = manifest.serverName, project = manifest.project;
const TOOLS = ['read_project', 'inspect_module', 'acquire_writer', 'release_writer', 'apply_operation', 'operation_status', 'validate_draft', 'read_owner_requests'];

// The product must deliver its own guide: the prompt below never contains it.
const common = `This is an authorized synthetic Sibambo local test on project ${project}. Use only the eight tools of the MCP server ${SERVER}. ` +
  'Do not use shell, filesystem, browser, other servers, subagents or memory. In your own answer never repeat model JSON, tokens or the guide text (tool results returned to you are expected and fine). ' +
  'In a new session call read_project with includeGuide=true first and follow that guide. Keep every mutation atomic, use the current revisions and a valid writer fence, ' +
  'and call operation_status before retrying an uncertain write. Release the writer when finished. If the owner has no viewer open (NO_ACTIVE_VIEWER) or writes are paused, stop and report it. ' +
  'Your final answer must be ONE JSON object: outcome ("pass"|"fail"|"blocked"), revision (integer or null), codes (error-code strings seen), moduleIds (ids only), ' +
  'requestIds (ids of owner requests you answered), notes (max 200 chars, no model JSON). ';
const tasks = {
  probe: 'Only read: call read_project (with includeGuide=true) and report the revision and the guide version. Do not mutate anything.',
  build: 'Build ONE empty rectangular room: internal dimensions 4 m by 3 m, wall height 2.7 m, wall thickness 0.15 m, with a floor and four walls, no openings, no furniture, no roof. ' +
    'Use the stable module id room/demo/main-room and the guide\'s recipe. One transaction. Then validate_draft and report revision and ids.',
  verify: 'Do not mutate. Call read_project, inspect_module with includeIr=true for every module, and validate_draft. Report revision, moduleIds and put in notes the module bounds, ' +
    'face count and triangle count you observed.',
  'revise-inbox': 'Call read_project and read_owner_requests. If an open owner request exists, carry it out by revising the existing module (do not create a second room) and pass that request\'s id as requestId ' +
    'in apply_operation. Validate and report revision, moduleIds and requestIds. If there is no open request, change nothing and report outcome "blocked".',
  opening: 'Add exactly ONE window to the existing room: 1.0 m wide, 1.2 m high, sill height 0.9 m, centred on the south wall. Revise the existing module (inspect_module includeIr=true), keep its id, ' +
    'do not create a second module. No requestId. Validate and report revision and ids.',
  contention: 'Attempt acquire_writer once for the selected project. Report the exact error code if it fails. If you get a fence, call release_writer immediately and make no other change.'
};
if (!(testCase in tasks)) throw new Error('Unknown case.');

const start = performance.now(), recordedAt = new Date().toISOString();
const events = [], calls = [], codes = new Set(), open = new Map();
let finalResult = null, firstToolMs = null, cliVersion = '';
const now = () => Math.round(performance.now() - start);
const record = (e) => { if (events.length < 400) events.push({ elapsedMs: now(), ...e }); };
const callStart = (id, tool) => { if (firstToolMs === null) firstToolMs = now(); open.set(id, { tool, startMs: now() }); };
const callEnd = (id, failed) => { const o = open.get(id); if (o) { open.delete(id); calls.push({ tool: o.tool, startMs: o.startMs, endMs: now(), toolMs: now() - o.startMs, failed: !!failed }); } };
const inspectResult = (input, depth = 0) => {
  if (!input || depth > 6) return;
  if (typeof input === 'string') { try { inspectResult(JSON.parse(input), depth + 1); } catch { /* prose */ } return; }
  if (Array.isArray(input)) { for (const x of input) inspectResult(x, depth + 1); return; }
  const code = input.error?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) { codes.add(code); record({ event: 'service-error', code }); }
  const meta = {};
  for (const k of ['projectRevision', 'revision', 'guideVersion', 'faceCount', 'triangleCount', 'epoch']) if (Number.isSafeInteger(input[k])) meta[k] = input[k];
  for (const k of ['valid', 'compiled', 'replayed', 'rendered']) if (typeof input[k] === 'boolean') meta[k] = input[k];
  if (Array.isArray(input.bounds) && input.bounds.length === 6 && input.bounds.every(Number.isFinite)) meta.bounds = input.bounds;
  if (input.guide && typeof input.guide === 'object') meta.guideDelivered = true;
  if (input.module && typeof input.module === 'object') meta.irDelivered = true;
  if (typeof input.status === 'string' && /^[A-Z_]{3,32}$/.test(input.status)) meta.status = input.status;
  if (Object.keys(meta).length) record({ event: 'result-metadata', ...meta });
  for (const k of ['structuredContent', 'structured_content', 'content', 'text']) if (input[k]) inspectResult(input[k], depth + 1);
};
const lastJsonObject = (text) => {
  for (let end = text.lastIndexOf('}'); end >= 0; end = text.lastIndexOf('}', end - 1)) {
    for (let start = text.lastIndexOf('{', end); start >= 0; start = text.lastIndexOf('{', start - 1)) {
      try { const v = JSON.parse(text.slice(start, end + 1)); if (v && typeof v === 'object' && 'outcome' in v) return v; } catch { /* widen */ }
    }
  }
  return null;
};
const acceptFinal = (value) => {
  try {
    const data = typeof value === 'string' ? lastJsonObject(value) : value;
    if (!data || !['pass', 'fail', 'blocked'].includes(data.outcome)) return;
    finalResult = { outcome: data.outcome, revision: Number.isSafeInteger(data.revision) ? data.revision : null,
      codes: (Array.isArray(data.codes) ? data.codes : []).filter((x) => typeof x === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(x)),
      moduleIds: (Array.isArray(data.moduleIds) ? data.moduleIds : []).filter((x) => typeof x === 'string' && /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)+$/.test(x)).slice(0, 16),
      requestIds: (Array.isArray(data.requestIds) ? data.requestIds : []).filter((x) => typeof x === 'string' || Number.isSafeInteger(x)).map(String).slice(0, 8),
      notes: typeof data.notes === 'string' ? data.notes.replace(/[A-Za-z0-9_+/=-]{40,}/g, '[redacted]').slice(0, 200) : '' };
  } catch { /* not the final object */ }
};

const resolveExe = (name, vendor) => {
  if (vendor && fs.existsSync(vendor)) return { command: vendor, shell: false };
  const found = spawnSync('where', [name], { encoding: 'utf8' }).stdout?.split(/\r?\n/).filter(Boolean).find((p) => /\.exe$/i.test(p));
  return found ? { command: found, shell: false } : { command: name, shell: true };
};
const env = { ...process.env, TEMP: path.join(runRoot, 'tmp'), TMP: path.join(runRoot, 'tmp'), ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_SKIP_MCP_DEBUG_LOG_FILES: '1' };
for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete env[k]; // the existing account logins, not a paid API key
let command, shell, argv;
if (client === 'codex') {
  ({ command, shell } = resolveExe('codex', 'C:/Program Files/nodejs/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'));
  const overrides = JSON.parse(fs.readFileSync(path.join(runRoot, 'agents', 'codex.overrides.json'), 'utf8'));
  const disable = (named('codex-disable', 'bomc-builder,node_repl,rea').split(',')).filter(Boolean).map((n) => `mcp_servers.${n}.enabled=false`);
  argv = [...overrides, ...disable, 'features.apps=false', 'features.shell_tool=false', 'features.code_mode_host=true', 'features.browser_use=false',
    'features.computer_use=false', 'features.multi_agent=false', 'features.goals=false', 'features.view_image=false', 'web_search="disabled"', 'history.persistence="none"']
    .flatMap((v) => ['-c', v]);
  argv.push('-a', 'never', 'exec', '--ephemeral', '--json', '--skip-git-repo-check', '-s', 'read-only', '-');
} else {
  ({ command, shell } = resolveExe('claude', path.join(process.env.USERPROFILE ?? '', '.local', 'bin', 'claude.exe')));
  argv = ['--setting-sources', '', '--settings', '{"disableAllHooks":true,"autoMemoryEnabled":false}', '--disable-slash-commands', '--strict-mcp-config',
    '--mcp-config', path.join(runRoot, 'agents', 'claude.mcp.json'), '--tools', '', '--allowedTools', `mcp__${SERVER}__*`,
    '--permission-mode', 'dontAsk', '--no-session-persistence', '--print', '--output-format', 'stream-json', '--verbose'];
}
cliVersion = spawnSync(command, ['--version'], { shell, encoding: 'utf8', env }).stdout?.trim().slice(0, 80) ?? '';
const child = spawn(command, argv, { cwd: path.join(runRoot, 'agent-workspace'), env, shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
record({ event: 'started', client, testCase, cliVersion });

const allowedClaude = new Set(TOOLS.map((t) => `mcp__${SERVER}__${t}`));
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let ev; try { ev = JSON.parse(line); } catch { return; }
  if (ev.type === 'system' && ev.subtype === 'init') record({ event: 'client-init', mcpServers: (ev.mcp_servers ?? []).map((x) => ({ name: x.name, status: x.status })), toolCount: Array.isArray(ev.tools) ? ev.tools.length : 0 });
  const item = ev.item;
  if (['command_execution', 'file_change', 'web_search', 'collab_tool_call'].includes(item?.type)) { record({ event: 'restricted-profile-violation', kind: item.type }); child.kill(); return; }
  if (item?.type === 'mcp_tool_call') {
    if (item.server !== SERVER || !TOOLS.includes(item.tool)) { record({ event: 'restricted-profile-violation', kind: 'other-mcp' }); child.kill(); return; }
    if (ev.type === 'item.started') callStart(item.id, item.tool);
    if (ev.type === 'item.completed') { callEnd(item.id, item.status === 'failed' || !!item.error); inspectResult(item.result); if (item.error) record({ event: 'tool-error', message: String(item.error.message ?? '').replace(/[A-Za-z0-9_+/=-]{40,}/g, '[redacted]').slice(0, 160) }); }
  }
  if (item?.type === 'agent_message') acceptFinal(item.text);
  for (const part of ev.message?.content ?? []) {
    if (part.type === 'tool_use') {
      if (!allowedClaude.has(part.name)) { record({ event: 'restricted-profile-violation', kind: 'non-sibambo-tool' }); child.kill(); return; }
      callStart(part.id, part.name.replace(`mcp__${SERVER}__`, ''));
    }
    if (part.type === 'tool_result') { callEnd(part.tool_use_id, part.is_error); inspectResult(part.content); }
  }
  if (ev.type === 'result') {
    acceptFinal(ev.structured_output ?? ev.result);
    record({ event: 'client-result', isError: !!ev.is_error, clientDurationMs: ev.duration_ms, apiMs: ev.duration_api_ms });
  }
});
readline.createInterface({ input: child.stderr }).on('line', (line) => { if (/MCP.*(failed|error)|needs.?auth|403|401/i.test(line)) record({ event: 'client-diagnostic', http403: /\b403\b/.test(line) }); });
child.on('error', () => record({ event: 'process-start-failed' }));
child.on('close', (exitCode) => {
  const total = now();
  const toolTotal = calls.reduce((s, c) => s + c.toolMs, 0);
  const result = { schemaVersion: 1, recordedAt, client, cliVersion, testCase, project, serverName: SERVER, epoch: manifest.epoch, exitCode, finalResult,
    timingMs: { total, spawnToFirstTool: firstToolMs, inToolCalls: toolTotal, outsideToolCalls: total - toolTotal },
    timingNote: 'toolMs spans tool_use to tool_result as seen by the client stream (transport + server + actor + client overhead); outsideToolCalls is dominated by cloud model inference. Single sample: no percentile claim.',
    codes: [...codes], toolCalls: calls, events, rawOutputSaved: false, inference: 'cloud-hosted model; local MCP/actor/viewer; not air-gapped' };
  const file = path.join(outDir, `${Date.now()}-${client}-${testCase}-metadata.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ event: 'finished', client, testCase, exitCode, totalMs: total, firstToolMs, toolCalls: calls.length, finalResult, receipt: file }));
  process.exitCode = exitCode ?? 1;
});
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill());
child.stdin.end(common + tasks[testCase]);
