/** Public SE-05 wire types. Canonical JSON strings remain the authoritative browser bytes. */
export type Manifest = Array<[string, number, string | null]>;
export type Projection = {
  moduleId: string; revision: number; worldTransform: number[]; positions: number[][];
  materials: Array<{ materialId: string; rgba: number[]; opacity: number }>;
  faces: Array<{ faceId: string; normal: number[]; triangles: number[][]; frontMaterialId: string | null; backMaterialId: string | null }>;
};
export type DraftModule = { moduleId: string; moduleRevision: number; canonicalIrJson: string; contentSha256: string;
  projectionJson: string; projectionSha256: string; projection: Projection };
export type DraftState = { projectId: string; epoch: string; revision: number; draftSha256: string; manifest: Manifest; modules: DraftModule[] };
export type DraftProposal = { state: DraftState; changed: string[]; removed: string[]; duplicate: boolean };
export type DraftPhase = 'disconnected' | 'connecting' | 'live' | 'reconnecting' | 'paused' | 'awaiting_viewer' | 'expired' | 'error';
export type DraftStatus = { phase: DraftPhase; role: 'primary' | 'follower'; revision: number; renderedRevision: number;
  dirty: boolean; idleExpiresAt: number; error: string; ticketLatencyMs: number | null };

/** Duplicate-key/finite-number JSON parser, bounded by bytes and depth BEFORE allocation-heavy work. */
export function parseJson(raw: string, maxBytes = 4 * 1024 * 1024): any {
  if (new TextEncoder().encode(raw).length > maxBytes) throw Error('DRAFT_BUDGET');
  let i = 0;
  function ws() { while (/\s/.test(raw[i] ?? '') && i < raw.length) i++; }
  function string(): string {
    const start = i++;
    while (i < raw.length) {
      const c = raw[i++];
      if (c === '\\') i++;
      else if (c === '"') return JSON.parse(raw.slice(start, i));
    }
    throw Error('DRAFT_JSON');
  }
  function value(depth: number): any {
    if (depth > 64) throw Error('DRAFT_DEPTH');
    ws();
    if (raw[i] === '"') return string();
    if (raw[i] === '{') {
      i++; ws(); const result = Object.create(null), keys = new Set<string>();
      if (raw[i] === '}') { i++; return result; }
      while (true) {
        ws(); if (raw[i] !== '"') throw Error('DRAFT_JSON'); const key = string(); ws();
        if (keys.has(key) || raw[i++] !== ':') throw Error('DRAFT_DUPLICATE_KEY'); keys.add(key);
        result[key] = value(depth + 1); ws(); const separator = raw[i++];
        if (separator === '}') return result;
        if (separator !== ',') throw Error('DRAFT_JSON');
      }
    }
    if (raw[i] === '[') {
      i++; ws(); const result: any[] = [];
      if (raw[i] === ']') { i++; return result; }
      while (true) { result.push(value(depth + 1)); ws(); const separator = raw[i++];
        if (separator === ']') return result; if (separator !== ',') throw Error('DRAFT_JSON'); }
    }
    for (const [token, decoded] of [['true', true], ['false', false], ['null', null]] as const) {
      if (raw.slice(i, i + token.length) === token) { i += token.length; return decoded; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(i));
    if (!match || !Number.isFinite(Number(match[0]))) throw Error('DRAFT_NUMBER');
    i += match[0].length; return Number(match[0]);
  }
  const result = value(0); ws(); if (i !== raw.length) throw Error('DRAFT_JSON'); return result;
}
export async function hash(raw: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), b => b.toString(16).padStart(2, '0')).join('');
}
export const uint = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
export const moduleId = (id: unknown): id is string => typeof id === 'string' && id.length <= 180 && /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)+$/.test(id);
export const sha = (h: unknown): h is string => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h);
export function validateProjection(p: any, id: string, revision: number): asserts p is Projection {
  const finite = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  const vector = (x: any) => Array.isArray(x) && x.length === 3 && x.every(finite);
  if (!p || p.moduleId !== id || p.revision !== revision || !Array.isArray(p.worldTransform) || p.worldTransform.length !== 16 || !p.worldTransform.every(finite) ||
      !Array.isArray(p.positions) || p.positions.length > 8192 || !p.positions.every(vector) || !Array.isArray(p.faces) || p.faces.length > 4096 ||
      !Array.isArray(p.materials) || p.materials.length > 254) throw Error('DRAFT_PROJECTION');
  const materials = new Set<string>(), faces = new Set<string>(); let triangles = 0;
  for (const m of p.materials) {
    if (typeof m.materialId !== 'string' || materials.has(m.materialId) || !Array.isArray(m.rgba) || m.rgba.length !== 4 ||
        m.rgba.some((x: number) => !Number.isInteger(x) || x < 0 || x > 255) || !finite(m.opacity) || m.opacity < 0 || m.opacity > 1) throw Error('DRAFT_MATERIAL');
    materials.add(m.materialId);
  }
  for (const f of p.faces) {
    if (typeof f.faceId !== 'string' || faces.has(f.faceId) || !vector(f.normal) || !Array.isArray(f.triangles) ||
        (f.frontMaterialId !== null && !materials.has(f.frontMaterialId)) || (f.backMaterialId !== null && !materials.has(f.backMaterialId))) throw Error('DRAFT_FACE');
    faces.add(f.faceId); triangles += f.triangles.length;
    if (triangles > 20000 || f.triangles.some((t: any) => !Array.isArray(t) || t.length !== 3 || new Set(t).size !== 3 || t.some((i: unknown) => !uint(i) || i >= p.positions.length))) throw Error('DRAFT_INDEX');
  }
}
