import { expect, test } from 'bun:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { handle } from '../../src/hooks.server';

const configUrl = pathToFileURL(resolve(import.meta.dir, '../../svelte.config.js')).href;

test('security headers also cover immutable OAuth redirects without breaking Location', async () => {
  const response = await handle({ event: {}, resolve: async () => Response.redirect('https://idp.example.test/login', 303) } as never);
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('https://idp.example.test/login');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
});
async function config(origin: string | undefined) {
  const env = { ...process.env };
  delete env.SE05_DRAFT_WS_ORIGIN;
  if (origin !== undefined) env.SE05_DRAFT_WS_ORIGIN = origin;
  const child = Bun.spawn([process.execPath, '--eval',
    `const c = (await import(${JSON.stringify(configUrl)})).default; console.log(JSON.stringify(c.kit.csp ?? null));`],
    { env, stdout: 'pipe', stderr: 'pipe' });
  return { code: await child.exited, out: await new Response(child.stdout).text(),
    error: await new Response(child.stderr).text() };
}

test('draft CSP defaults to same origin and forbids framing, objects and external base URLs', async () => {
  const result = await config(undefined);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ mode: 'auto', directives: {
    'default-src': ['self'], 'connect-src': ['self'], 'frame-ancestors': ['none'],
    'object-src': ['none'], 'base-uri': ['self'], 'script-src': ['self', 'wasm-unsafe-eval']
  } });
});

test('draft CSP permits only the configured exact WSS origin', async () => {
  const result = await config('wss://draft.example.test:8443');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).directives['connect-src']).toEqual(['self', 'wss://draft.example.test:8443']);
});

for (const origin of ['ws://draft.example.test', 'https://draft.example.test', 'wss://*.example.test',
  'wss://user:secret@draft.example.test', 'wss://draft.example.test/path',
  'wss://draft.example.test?ticket=secret', 'wss://draft.example.test#fragment',
  'wss://draft.example.test wss://other.example.test']) {
  test('draft CSP rejects invalid origin configuration: ' + origin.replace(/secret/g, 'synthetic'), async () => {
    const result = await config(origin);
    expect(result.code).not.toBe(0);
    expect(result.error).toContain('SE05_DRAFT_WS_ORIGIN must be one exact WSS origin');
    expect(result.error).not.toContain('user:secret');
  });
}
