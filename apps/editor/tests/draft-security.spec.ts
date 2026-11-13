import { expect, test } from '@playwright/test';

test('owner controls have enforced security headers and still hydrate under CSP', async ({ page, request }) => {
  const violations: string[] = [];
  await page.exposeFunction('recordCspViolation', (directive: string) => violations.push(directive));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => {
    (window as unknown as { recordCspViolation: (value: string) => void }).recordCspViolation(event.violatedDirective);
  }));
  const response = await page.goto('/');
  const headers = response!.headers();
  const policy = headers['content-security-policy'];
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("connect-src 'self'");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("base-uri 'self'");
  expect(policy).not.toContain("'unsafe-eval'");
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
  expect(headers['x-content-type-options']).toBe('nosniff');
  await expect(page.locator('main[data-editor-ready="true"]')).toBeVisible();
  // Existing PNG/WebP decoders compile WASM in workers; do not grant JavaScript eval.
  expect(await page.evaluate(async () => {
    await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    return true;
  })).toBe(true);
  await page.locator('summary').filter({ hasText: 'Extensions' }).click();
  await page.getByRole('button', { name: 'MCP Extension…' }).click();
  await expect(page.getByRole('dialog', { name: 'MCP Extension' })).toBeVisible();
  const session = await request.get('/api/mcp/session');
  expect(session.headers()['referrer-policy']).toBe('no-referrer');
  expect(session.headers()['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
  expect(violations).toEqual([]);
});
