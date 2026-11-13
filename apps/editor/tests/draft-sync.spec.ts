import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { seal } from '../src/lib/server/mcp-oidc';
const fixture = JSON.parse(readFileSync(process.env.SE05_BOOTSTRAP!, 'utf8'));
async function driver(action: string, body: object = {}) {
  const response = await fetch(fixture.base + '/__se05_test/' + action, { method: 'POST', headers: {
    authorization: 'Bearer ' + fixture.driver, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.ok).toBe(true); return response.json();
}
async function open(page: Page) {
  const cookie = seal({ sub: 'owner-1', accessToken: fixture.ownerToken, exp: Date.now() / 1000 + 300, csrf: 'synthetic-csrf', issuer: fixture.issuer }, Buffer.from(fixture.sessionKey, 'base64url'));
  await page.context().addCookies([{ name: '__Host-se04_session', value: cookie, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  await page.goto('/?renderer=webgl2');
  await page.locator('summary').filter({ hasText: 'Extensions' }).click();
  await page.getByRole('button', { name: 'MCP Extension…' }).click();
  await page.getByLabel('ID proyek (hanya proyek yang diizinkan server)').fill('live-test');
  await page.getByRole('button', { name: 'Buka proyek' }).click();
  const ticketResponse = page.waitForResponse(response => response.url().endsWith('/api/mcp/ticket'));
  await page.getByRole('button', { name: 'Hubungkan draft live' }).click();
  const ticket = await ticketResponse;
  expect(ticket.status(), ticket.status() === 200 ? '' : `${await ticket.text()}; origin=${ticket.request().headers()['origin']}; csrfMatches=${ticket.request().headers()['x-se04-csrf'] === 'synthetic-csrf'}`).toBe(200);
  await expect(page.getByRole('region', { name: 'Draft live', exact: true })).toBeVisible();
}
const status = (page: Page) => page.getByRole('region', { name: 'Draft live', exact: true });

test('actual BFF ticket → WSS → worker validation → completed frame ACK; no duplicate after reconnect', async ({ page }) => {
  const socketUrls: string[] = []; page.on('websocket', ws => socketUrls.push(ws.url()));
  await open(page);
  const before = await driver('status');
  await expect.poll(async () => (await driver('status')).acked).toBe(before.revision);
  const result = await driver('operation');
  expect(result.ok).toBe(true);
  await expect(status(page)).toHaveAttribute('data-revision', String(before.revision + 1));
  await expect(status(page)).toHaveAttribute('data-module-count', '1');
  await expect.poll(async () => (await driver('status')).acked).toBe(before.revision + 1);
  const after = await driver('status');
  await driver('close');
  await expect(status(page)).toContainText('reconnecting');
  await expect.poll(async () => (await driver('status')).acked).toBe(after.revision);
  await expect(status(page)).toHaveAttribute('data-module-count', '1');
  expect((await driver('status')).events).toBe(after.events);
  expect(socketUrls.every(url => url.endsWith('/draft') && !url.includes('?'))).toBe(true);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => /draft|token|mcp/i.test(key)))).toEqual([]);
});

test('corrupt/gapped event resync retains model, follower cannot gate, dirty transition can be cancelled', async ({ page, context }) => {
  await open(page);
  await expect.poll(async () => (await driver('status')).acked).toBe((await driver('status')).revision);
  const accepted = await driver('operation'); expect(accepted.ok).toBe(true);
  await expect.poll(async () => (await driver('status')).acked).toBe(accepted.projectRevision);
  await driver('fault', { kind: 'corrupt' });
  await expect(status(page)).toHaveAttribute('data-revision', String(accepted.projectRevision));
  await expect(status(page)).toHaveAttribute('data-module-count', '1');
  const follower = await context.newPage(); await open(follower);
  await expect(status(page)).toContainText('Pengikut baca-saja');
  await expect(status(follower)).toContainText('Viewer utama');
  await status(follower).getByRole('button', { name: 'Tutup draft' }).click();
  await expect(follower.locator('[data-transition-dialog]')).toBeVisible();
  await follower.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(status(follower)).toHaveAttribute('data-module-count', '1');
  await follower.close();
});

test('owner request status is independent of geometry revision and becomes addressed only after render ACK', async ({ page }) => {
  await open(page);
  await expect.poll(async () => (await driver('status')).acked).toBe((await driver('status')).revision);
  const before = await driver('status');
  const created = await page.request.post('/api/mcp/requests', { headers: { origin: 'http://localhost:5175', 'x-se04-csrf': 'synthetic-csrf' },
    data: { projectId: 'live-test', action: 'create', body: 'synthetic revision request', moduleIds: [], kind: 'instruction', parameters: {} } });
  expect(created.ok()).toBe(true);
  const request = (await created.json()).requests.at(-1);
  expect((await driver('status')).revision).toBe(before.revision);
  const result = await driver('operation', { requestId: request.id }); expect(result.ok).toBe(true);
  await expect.poll(async () => (await driver('status')).acked).toBe(result.projectRevision);
  const session = await page.request.get('/api/mcp/session?project=live-test');
  expect((await session.json()).requests.find((item: any) => item.id === request.id).status).toBe('addressed');
});
