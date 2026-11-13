/** Starts a synthetic loopback TLS Builder, then tests the actual production BFF and browser. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const repo = path.resolve(import.meta.dir, '../..');
const builder = path.resolve(process.env.SE05_BUILDER_ROOT ?? path.join(repo, '../sibambo-bomc-builder'));
const output = path.resolve(process.env.SE05_OUTPUT_ROOT ?? path.join(os.tmpdir(), 'se05-integration'));
if (process.platform === 'win32' && !/^D:/i.test(output)) throw Error('SE05_OUTPUT_ROOT must be on D:');
await mkdir(output, { recursive: true });
if (existsSync(path.join(output, 'bootstrap.json'))) throw Error('Use a fresh SE05_OUTPUT_ROOT; a bootstrap already exists there.');
const env = { ...process.env, TEMP: output, TMP: output, PYTHONPYCACHEPREFIX: path.join(output, 'pycache'), PIP_CACHE_DIR: path.join(output, 'pip-cache') };
const server = Bun.spawn([process.env.SE05_PYTHON ?? 'python', path.join(builder, 'tests/se05_fixture_server.py'), '--output', output],
  { cwd: builder, env, stdout: Bun.file(path.join(output, 'fixture.log')), stderr: Bun.file(path.join(output, 'fixture-error.log')) });
try {
  const bootstrapPath = path.join(output, 'bootstrap.json');
  for (let i = 0; !existsSync(bootstrapPath); i++) {
    if (i > 300 || server.exitCode !== null) throw Error('Synthetic Builder did not start; see fixture log');
    await Bun.sleep(100);
  }
  const fixture = JSON.parse(await readFile(bootstrapPath, 'utf8'));
  const start = Date.now();
  const child = Bun.spawn([process.execPath, 'x', 'playwright', 'test', '--config', './playwright.se05.config.ts'], {
    cwd: path.join(repo, 'apps/editor'), stdout: 'inherit', stderr: 'inherit', env: {
      ...env, SE05_BOOTSTRAP: bootstrapPath, SE05_OUTPUT_ROOT: output, NODE_EXTRA_CA_CERTS: fixture.certificate,
      SE04_SERVICE_BASE_URL: fixture.base, SE05_DRAFT_WS_ORIGIN: fixture.base.replace('https:', 'wss:'),
      SE04_AUTH_ISSUER: fixture.issuer, SE04_AUTH_CLIENT_ID: 'synthetic-bff', SE04_AUTH_CLIENT_SECRET: 'synthetic-fixture-only',
      SE04_AUTH_AUDIENCE: fixture.audience, SE04_SESSION_KEY: fixture.sessionKey
    }
  });
  const code = await child.exited;
  await writeFile(path.join(output, 'run.json'), JSON.stringify({ schemaVersion: 1, syntheticOnly: true, exitCode: code, elapsedMs: Date.now() - start,
    editorSha: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repo }).stdout.toString().trim(),
    builderSha: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: builder }).stdout.toString().trim(),
    editorDirty: !!Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=no'], { cwd: repo }).stdout.toString().trim(),
    builderDirty: !!Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=no'], { cwd: builder }).stdout.toString().trim() }, null, 2));
  process.exitCode = code;
} finally {
  server.kill(); await server.exited;
  // Bootstrap contains ONLY synthetic short-lived test credentials; discard after the run.
  const { unlink } = await import('node:fs/promises');
  await unlink(path.join(output, 'bootstrap.json')).catch(() => {});
}
