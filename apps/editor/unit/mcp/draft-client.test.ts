import { afterEach, expect, test } from 'bun:test';
import { DraftClient } from '../../src/lib/mcp/draft-client';
import type { DraftStatus } from '../../src/lib/mcp/draft-protocol';

const saved = new Map(['fetch', 'Worker', 'window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let client: DraftClient | null = null;
afterEach(() => {
  client?.dispose(); client = null;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

for (const status of [401, 403]) {
  test(`ticket HTTP ${status} stops reconnect retries instead of hiding the authentication failure`, async () => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: class { terminate() {} } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      addEventListener() {}, removeEventListener() {}, visibilityState: 'visible'
    } });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      setTimeout, clearTimeout, setInterval, clearInterval
    } });
    let requests = 0;
    globalThis.fetch = (async () => { requests++; return new Response('{}', { status }); }) as typeof fetch;
    const states: DraftStatus[] = [];
    client = new DraftClient({ projectId: 'project-a', csrf: 'expired', url: 'wss://draft.example.test/draft',
      render: async () => {}, changed: value => states.push(value) });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(states.at(-1)?.phase).toBe('error');
    expect(states.at(-1)?.error).toContain(status === 401 ? 'Masuk ulang' : 'ditolak');
    expect(requests).toBe(1);
    expect(client.state).toBeNull();
  });
}
