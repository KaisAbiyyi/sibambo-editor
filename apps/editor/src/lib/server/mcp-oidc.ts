/**
 * SE-04: deliberately small OIDC/PKCE and sealed-cookie primitives.
 * No password handling; fail closed on unknown algorithms, issuers, audiences, and keys.
 */
import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

export const token = (size = 32) => randomBytes(size).toString('base64url');
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
export type IdTokenClaims = { sub: string; iss: string; aud: string | string[]; exp: number; iat: number; nonce: string; azp?: string };
type JsonWebKeySet = { keys: Array<JsonWebKey & { kid?: string; use?: string; alg?: string }> };
function parseObject(value: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw Error('Invalid signed object');
  return decoded as Record<string, unknown>;
}
export function safeIssuer(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('OIDC issuer must be HTTPS');
  return url;
}
export function sameIssuerEndpoint(issuer: string, endpoint: string): string {
  const root = safeIssuer(issuer), url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.origin !== root.origin || url.username || url.password || url.hash) {
    throw Error('Unexpected OIDC endpoint origin');
  }
  return url.toString();
}
export async function verifyIdToken(
  raw: string, issuer: string, clientId: string, expectedNonce: string,
  jwks: JsonWebKeySet, now = Math.floor(Date.now() / 1000)
): Promise<IdTokenClaims> {
  if (raw.length > 12000) throw Error('ID token too large');
  const parts = raw.split('.');
  if (parts.length !== 3) throw Error('Invalid JWT');
  const header = parseObject(parts[0]);
  const claims = parseObject(parts[1]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !/^[\w.-]{1,128}$/.test(header.kid)) throw Error('Disallowed JWT header');
  const key = jwks.keys.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
  if (!key) throw Error('Untrusted signing key');
  if (!verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw Error('Invalid token signature');
  if (claims.iss !== issuer || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 ||
      (claims.aud !== clientId && !(Array.isArray(claims.aud) && claims.aud.includes(clientId))) ||
      (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId) ||
      typeof claims.exp !== 'number' || claims.exp <= now || claims.exp > now + 86400 ||
      typeof claims.iat !== 'number' || claims.iat > now + 60 ||
      claims.nonce !== expectedNonce) throw Error('Invalid OIDC claims');
  return claims as IdTokenClaims;
}
export function seal<T extends object>(value: T, secret: Buffer): string {
  if (secret.length !== 32) throw Error('Invalid session key');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}
export function unseal<T>(cookie: string | undefined, secret: Buffer): T | null {
  if (!cookie || cookie.length > 7000 || secret.length !== 32) return null;
  try {
    const packed = Buffer.from(cookie, 'base64url');
    if (packed.length < 29) return null;
    const cipher = createDecipheriv('aes-256-gcm', secret, packed.subarray(0, 12));
    cipher.setAuthTag(packed.subarray(12, 28));
    const plain = Buffer.concat([cipher.update(packed.subarray(28)), cipher.final()]).toString('utf8');
    return JSON.parse(plain) as T;
  } catch { return null; }
}
