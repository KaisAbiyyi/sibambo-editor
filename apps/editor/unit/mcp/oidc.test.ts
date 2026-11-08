import { describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { pkceChallenge, safeIssuer, sameIssuerEndpoint, seal, token, unseal, verifyIdToken } from '../../src/lib/server/mcp-oidc';

const issuer = 'https://auth.example.test', client = 'se04-web';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', use: 'sig', alg: 'RS256' }] };
function jwt(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const part1 = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: 'test-kid', ...header })).toString('base64url');
  const part2 = Buffer.from(JSON.stringify({ iss: issuer, sub: 'auth0|owner', aud: client, iat: now, exp: now + 300, nonce: 'nonce-01', ...claims })).toString('base64url');
  const msg = part1 + '.' + part2;
  return msg + '.' + sign('RSA-SHA256', Buffer.from(msg), privateKey).toString('base64url');
}
describe('SE-04 mock identity provider cryptographic security', () => {
  test('S256 code challenge and verifier entropy', () => {
    expect(pkceChallenge('verifier')).toBe(createHash('sha256').update('verifier').digest('base64url'));
    expect(token()).not.toBe(token());
  });
  test('encrypted session cookie rejects wrong key and corruption', () => {
    const a = Buffer.alloc(32, 6), b = Buffer.alloc(32, 7);
    const cookie = seal({ sub: 'owner', csrf: 'nonce' }, a);
    expect(unseal<{ sub: string }>(cookie, a)?.sub).toBe('owner');
    expect(unseal(cookie, b)).toBeNull();
    expect(unseal(cookie.slice(0, -2) + 'zz', a)).toBeNull();
  });
  test('OIDC issuer and endpoint host are HTTPS and same-origin', () => {
    expect(safeIssuer(issuer).origin).toBe(issuer);
    expect(sameIssuerEndpoint(issuer, issuer + '/jwks')).toEndWith('/jwks');
    expect(() => safeIssuer('http://auth.example.test')).toThrow();
    expect(() => sameIssuerEndpoint(issuer, 'https://evil.test/jwks')).toThrow();
  });
  test('only exact valid signed RS256 identity is accepted', async () => {
    expect((await verifyIdToken(jwt(), issuer, client, 'nonce-01', jwks)).sub).toBe('auth0|owner');
    for (const claims of [{ nonce: 'other' }, { iss: 'https://evil.test' }, { aud: 'other-client' }, { sub: '' }, { exp: 1 }]) {
      await expect(verifyIdToken(jwt(claims), issuer, client, 'nonce-01', jwks)).rejects.toThrow();
    }
    for (const header of [{ alg: 'none' }, { kid: 'other-key' }]) {
      await expect(verifyIdToken(jwt({}, header), issuer, client, 'nonce-01', jwks)).rejects.toThrow();
    }
    const tokens = jwt().split('.');
    tokens[1] = Buffer.from(JSON.stringify({ iss: issuer, sub: 'attacker', aud: client, iat: 1, exp: 9999999999, nonce: 'nonce-01' })).toString('base64url');
    await expect(verifyIdToken(tokens.join('.'), issuer, client, 'nonce-01', jwks)).rejects.toThrow();
  });
});
