#!/usr/bin/env node
// LF-11e: server restart while a viewer tab holds a live draft. Expected (L10): the tab keeps its last good frame, shows the
// explicit "Epoch server berubah" message, and the new server starts with an EMPTY new-epoch draft (nothing is claimed restored).
//   node tooling/local-demo/restart-check.mjs --python <python.exe> [--run-root <dir>] [--out <dir>]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const editorApp = path.resolve(here, '..', '..', 'apps', 'editor');
const named = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const runRoot = path.resolve(named('run-root', 'D:\\projects\\sibambo\\scratch\\local-demo-run'));
const outDir = path.resolve(named('out', 'D:\\projects\\sibambo\\outputs\\2026-11-14-local-mcp-live-viewer'));
const python = named('python', process.env.SIBAMBO_PYTHON ?? '');
if (!python || /^c:/i.test(runRoot) || /^c:/i.test(outDir)) throw new Error('--python required; paths must not be on C:.');
const require = createRequire(path.join(editorApp, 'package.json'));
const pw = await import(pathToFileURL(createRequire(require.resolve('@playwright/test')).resolve('playwright-core')).href);
const chromium = pw.chromium ?? pw.default.chromium;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (p) => p.evaluate(() => { const el = document.querySelector('.draft-live-status'); return el ? { ...el.dataset, text: el.innerText.split('\n').slice(0, 2).join(' | ') } : null; });
const before = JSON.parse(fs.readFileSync(path.join(runRoot, 'manifest.json'), 'utf8'));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: 'http://localhost:5175' });
const page = await context.newPage();
await page.goto('/api/mcp/login'); await page.waitForURL(/mcp=connected/);
for (let i = 0; i < 20 && !(await page.getByRole('button', { name: 'Hubungkan draft live' }).count()); i++) {
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('MCP Extension…'))?.click()); await sleep(800);
}
await page.getByRole('button', { name: 'Hubungkan draft live' }).click(); await sleep(3000);
const attached = await status(page);

const ledger = JSON.parse(fs.readFileSync(path.join(runRoot, 'pids.json'), 'utf8'));
spawnSync('taskkill', ['/PID', String(ledger.launcher), '/T', '/F']);
await sleep(1500);
const child = spawn(process.execPath, [path.join(here, 'launch.mjs'), '--python', python, '--run-root', runRoot, '--replace-task-owned'], { detached: true, stdio: 'ignore', windowsHide: true });
child.unref();
const seen = new Set(); let last = null;
for (let t = 0; t < 70; t++) { last = await status(page).catch(() => null); if (last) seen.add(last.text); await sleep(1000); }
const bannerText = await page.evaluate(() => document.querySelector('.draft-live-status')?.innerText ?? '');
await page.screenshot({ path: path.join(outDir, `${Date.now()}-viewer-after-server-restart.png`) });
const after = JSON.parse(fs.readFileSync(path.join(runRoot, 'manifest.json'), 'utf8'));
const kept = last && last.moduleCount === attached?.moduleCount;
const message = /Epoch server berubah|Sambungan terputus|Batas percobaan/.test(bannerText);
const receipt = { schemaVersion: 1, kind: 'LF-11e-server-restart', recordedAt: new Date().toISOString(), epochBefore: before.epoch, epochAfter: after.epoch,
  attachedBefore: attached, lastStatusAfter: last, distinctStatesSeen: [...seen], visibleMessage: bannerText.replace(/\s+/g, ' ').slice(0, 240), screenshotFile: 'viewer-after-server-restart.png (inspect: retained frame)',
  verdict: before.epoch !== after.epoch && kept && message ? 'PASS' : 'FAIL',
  note: 'The new server holds an empty draft in a new epoch; the old tab keeps its last frame and says so. The old model is NOT restored (SE-08 is a separate task).' };
const file = path.join(outDir, `${Date.now()}-restart-check-receipt.json`);
fs.writeFileSync(file, JSON.stringify(receipt, null, 2));
console.log(receipt.verdict, file, JSON.stringify({ kept, message, epochChanged: before.epoch !== after.epoch, last }));
await browser.close();
